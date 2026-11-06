import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { salePool, transaction } from './database.js'
import { CURVE_VERSION, SCHEDULE_HASH, SaleError, totalPrice } from './pricing.js'
import { parseAccessPolicy, type SaleAccessPolicy } from './access-policy.js'
import { passMetadataHash } from './pass-metadata.js'

export interface ReconciliationIssue { code:string; userId?:string }

// Internal accounting check only. A separate verified wallet inventory is required
// to establish treasury solvency. Never repair ledger history or reopen a sale here.
export async function reconcileSale(db:Pool=salePool()) {
  return transaction(async c=>{
    // New accounts/deposits may appear while existing accounts are locked.
    // Compare source rows and journals from one snapshot, not mixed commits.
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    const sale=(await c.query('SELECT * FROM agnt_sale WHERE id=1 FOR UPDATE')).rows[0]
    if(!sale)throw new SaleError('sale_not_initialized',503)
    const accounts=(await c.query('SELECT user_id,available,held FROM agnt_sale_accounts ORDER BY user_id FOR UPDATE')).rows
    const issues:ReconciliationIssue[]=[]
    if(sale.curve_version!==CURVE_VERSION || sale.schedule_hash!==SCHEDULE_HASH)issues.push({code:'curve_mismatch'})
    const entries=(await c.query(`SELECT account,sum(delta)::text AS balance FROM (
      SELECT credit_account AS account,amount AS delta FROM agnt_sale_ledger
      UNION ALL SELECT debit_account AS account,-amount AS delta FROM agnt_sale_ledger
    ) entries GROUP BY account`)).rows
    const ledger=new Map<string,bigint>(entries.map(row=>[row.account,BigInt(row.balance)]))
    const holds=(await c.query("SELECT user_id,sum(amount+fee_limit)::text AS held FROM agnt_sale_withdrawals WHERE state NOT IN ('PAID','CANCELED') GROUP BY user_id")).rows
    const expectedHolds=new Map<string,bigint>(holds.map(row=>[row.user_id,BigInt(row.held)]))
    for(const account of accounts){
      for(const bucket of ['available','held'] as const){
        if(BigInt(account[bucket])!==(ledger.get(`customer:${account.user_id}:${bucket}`)??0n))issues.push({code:`${bucket}_ledger_mismatch`,userId:account.user_id})
      }
      if(BigInt(account.held)!==(expectedHolds.get(account.user_id)??0n))issues.push({code:'withdrawal_hold_mismatch',userId:account.user_id})
    }
    const purchases=(await c.query('SELECT * FROM agnt_sale_purchases ORDER BY first_serial')).rows
    const journalRows=(await c.query('SELECT reference,debit_account,credit_account,amount FROM agnt_sale_ledger')).rows
    const unmatched=new Map(journalRows.map(row=>[row.reference,row]))
    function expectEntry(reference:string,userId:string,debit:string,credit:string,amount:bigint){
      const row=unmatched.get(reference)
      unmatched.delete(reference)
      if(amount===0n&&!row)return // Zero fee/release entries are deliberately omitted.
      if(!row||row.debit_account!==debit||row.credit_account!==credit||BigInt(row.amount)!==amount)
        issues.push({code:'source_journal_mismatch',userId})
    }
    for(const deposit of (await c.query('SELECT receipt_id,user_id,amount FROM agnt_sale_deposits WHERE credited')).rows)
      expectEntry(`deposit:${deposit.receipt_id}`,deposit.user_id,'treasury:received',`customer:${deposit.user_id}:available`,BigInt(deposit.amount))
    for(const purchase of purchases)
      expectEntry(`purchase:${purchase.id}`,purchase.user_id,`customer:${purchase.user_id}:available`,'sale:proceeds',BigInt(purchase.total))
    for(const withdrawal of (await c.query('SELECT id,user_id,amount,fee_limit,actual_fee,state FROM agnt_sale_withdrawals')).rows){
      const amount=BigInt(withdrawal.amount),reserve=BigInt(withdrawal.fee_limit)
      const available=`customer:${withdrawal.user_id}:available`,held=`customer:${withdrawal.user_id}:held`
      expectEntry(`withdrawal-hold:${withdrawal.id}`,withdrawal.user_id,available,held,amount+reserve)
      if(withdrawal.state==='CANCELED')expectEntry(`withdrawal-cancel:${withdrawal.id}`,withdrawal.user_id,held,available,amount+reserve)
      if(withdrawal.state==='PAID'){
        if(withdrawal.actual_fee===null||BigInt(withdrawal.actual_fee)<0n||BigInt(withdrawal.actual_fee)>reserve){
          issues.push({code:'withdrawal_fee_mismatch',userId:withdrawal.user_id})
          continue
        }
        const fee=BigInt(withdrawal.actual_fee)
        expectEntry(`withdrawal-paid:${withdrawal.id}`,withdrawal.user_id,held,'treasury:paid',amount)
        expectEntry(`withdrawal-fee:${withdrawal.id}`,withdrawal.user_id,held,'treasury:network-fees',fee)
        expectEntry(`withdrawal-fee-release:${withdrawal.id}`,withdrawal.user_id,held,available,reserve-fee)
      }
    }
    // Unknown entries have no attributable business source; freeze globally.
    // Future compensating-entry policies must be modeled explicitly, not ignored.
    if(unmatched.size)issues.push({code:'unattributed_journal_entry'})
    let accessPolicy:SaleAccessPolicy|null=null
    if(purchases.length){
      try{accessPolicy=parseAccessPolicy(sale)}catch{issues.push({code:'issued_access_policy_invalid'})}
    }
    const passes=(await c.query('SELECT serial,owner_id,purchase_id,metadata_hash FROM agnt_sale_passes ORDER BY serial')).rows
    if(accessPolicy)for(const pass of passes){
      if(pass.metadata_hash!==passMetadataHash(pass.serial,accessPolicy))issues.push({code:'pass_metadata_mismatch',userId:pass.owner_id})
    }
    let expectedSerial=1
    let proceeds=0n
    for(const purchase of purchases){
      if(!accessPolicy||purchase.access_policy_version!==accessPolicy.version)issues.push({code:'purchase_access_policy_mismatch',userId:purchase.user_id})
      if(purchase.first_serial!==expectedSerial || purchase.curve_version!==CURVE_VERSION)issues.push({code:'purchase_sequence_mismatch'})
      try{
        if(BigInt(purchase.total)!==totalPrice(purchase.first_serial-1,purchase.quantity))issues.push({code:'purchase_price_mismatch',userId:purchase.user_id})
      }catch{issues.push({code:'purchase_range_invalid'})}
      const issued=passes.filter(pass=>pass.purchase_id===purchase.id)
      if(issued.length!==purchase.quantity || issued.some((pass,index)=>pass.serial!==purchase.first_serial+index || pass.owner_id!==purchase.user_id))issues.push({code:'purchase_issuance_mismatch'})
      proceeds+=BigInt(purchase.total)
      expectedSerial=purchase.first_serial+purchase.quantity
    }
    if(passes.length!==sale.sold || expectedSerial-1!==sale.sold || passes.some((pass,index)=>pass.serial!==index+1))issues.push({code:'inventory_mismatch'})
    if((ledger.get('sale:proceeds')??0n)!==proceeds)issues.push({code:'sale_proceeds_mismatch'})
    const orphans=(await c.query("SELECT DISTINCT user_id FROM agnt_sale_deposits WHERE credited=true AND state='ORPHANED'")).rows
    for(const row of orphans)issues.push({code:'orphaned_credit_requires_review',userId:row.user_id})
    if(issues.length){
      await c.query("UPDATE agnt_sale SET state='PAUSED' WHERE id=1")
      if(issues.some(issue=>!issue.userId))await c.query('UPDATE agnt_sale_accounts SET frozen=true')
      else await c.query('UPDATE agnt_sale_accounts SET frozen=true WHERE user_id=ANY($1::text[])',[[...new Set(issues.map(issue=>issue.userId!))]])
      await c.query("INSERT INTO agnt_sale_events(id,kind,user_id,reference) VALUES($1,'RECONCILIATION_FAILED','system',$2)",[randomUUID(),randomUUID()])
    }
    return {ok:issues.length===0,checkedAccounts:accounts.length,checkedPurchases:purchases.length,issues,treasurySolvencyVerified:false as const}
  },db)
}
