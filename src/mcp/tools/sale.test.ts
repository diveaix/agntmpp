import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { CURVE_VERSION, SCHEDULE_HASH, SUPPLY, totalPrice, zatoshi } from '../sale/pricing.js'
import { SaleService } from '../sale/service.js'
import { approveFixtureWithdrawal } from '../../../scripts/test-sale-approvals.js'
import { configureSaleAccess } from '../sale/access-policy.js'
import { requireSaleLaunch, saleReadiness } from '../sale/runtime.js'
import { reconcileSale } from '../sale/reconcile.js'

test('exact curve and atomic units',()=>{
  assert.equal(totalPrice(0,1),2000000n)
  assert.equal(totalPrice(4443,1),14399274n)
  assert.equal(totalPrice(0,4444),27915557929n)
  let sum=0n,previous=0n
  for(let i=0;i<SUPPLY;i++){const price=totalPrice(i,1);assert.ok(price>=previous);sum+=price;previous=price}
  assert.equal(sum,totalPrice(0,SUPPLY))
  for(const bad of [1,'1.1','-1','01','1e8',null])assert.throws(()=>zatoshi(bad))
  assert.throws(()=>totalPrice(4444,1))
  assert.throws(()=>totalPrice(0,1.1))
})
test('real-money launch is locked without verified settlement infrastructure',()=>{
  assert.equal(saleReadiness().launchEnabled,false)
  assert.throws(requireSaleLaunch,/not_ready/)
})

test('PostgreSQL ledger: idempotency, curve races, reorgs, isolation and holds',async()=>{
  const db=new PGlite()
  // PGlite is real PostgreSQL in WASM, but one connection. Serialize transaction leases;
  // production multi-connection row-lock contention must also be tested on hosted PostgreSQL.
  let tail=Promise.resolve()
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length || result.affectedRows || 0}}
  const pool={query,connect:async()=>{
    const old=tail;let unlock!:()=>void;tail=new Promise<void>(resolve=>{unlock=resolve});await old
    return {query,release:unlock}
  }} as unknown as Pool
  try {
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    await configureSaleAccess(pool,30,1) // Test-only terms, not approved launch terms.
    await query("UPDATE agnt_sale SET state='OPEN' WHERE id=1")
    const service=new SaleService(pool)
    const receipt={receiptId:'testnet:tx:output-0',txid:'a'.repeat(64),amountZatoshi:'100000000',confirmations:1,blockHash:'b'.repeat(64),canonical:true}
    await service.observe('alice',receipt,3)
    assert.equal((await service.account('alice')).deposits[0].required_confirmations,3)
    assert.equal((await service.exportAccount('alice')).deposits[0].required_confirmations,3)
    await service.observe('alice',receipt,4)
    assert.equal((await service.account('alice')).deposits[0].required_confirmations,4,'Persist the actual threshold used by the latest observer check')
    assert.equal((await service.account('alice')).balance.available,'0')
    await service.observe('alice',{...receipt,confirmations:3},3)
    await service.observe('alice',{...receipt,confirmations:3},3)
    assert.equal((await service.account('alice')).balance.available,'100000000')
    await assert.rejects(service.observe('bob',{...receipt,confirmations:3},3),/receipt_conflict/)
    const q=await service.quote('alice',2)
    assert.equal(q.soldCountSnapshot,0)
    assert.equal(q.availableSupply,4444)
    const request={quoteId:q.id,quantity:2,maxTotalZatoshi:q.totalZatoshi,curveVersion:CURVE_VERSION,idempotencyKey:randomUUID()}
    const [a,b]=await Promise.all([service.purchase('alice',request),service.purchase('alice',request)])
    assert.equal(a.id,b.id)
    assert.equal(((await query("SELECT count(*)::int AS count FROM agnt_sale_outbox o JOIN agnt_sale_events e ON e.id=o.event_id WHERE e.kind='PURCHASE' AND e.reference=$1",[a.id])).rows[0] as {count:number}).count,1)
    assert.equal((await service.requestStatus('alice','purchase',request.idempotencyKey)).receipt.id,a.id)
    assert.deepEqual(await service.requestStatus('bob','purchase',request.idempotencyKey),{userId:'bob',kind:'purchase',status:'UNKNOWN',receipt:null})
    assert.equal((await service.requestStatus('alice','purchase',randomUUID())).status,'UNKNOWN')
    await assert.rejects(service.requestStatus('alice','purchase','bad'),/invalid_idempotency_key/)
    assert.equal((await service.summary()).sold,2)
    assert.equal((await service.account('alice')).passes.length,2)
    const access=await service.accessSnapshot('alice')
    assert.equal(access.source,'collectible_pass')
    assert.equal(access.eligible,true)
    assert.equal(access.remainingToday,1)
    assert.equal(access.passes.length,2)
    assert.ok(access.passes[0].expires_at)
    assert.equal((await service.accessSnapshot('alice')).usedToday,0)
    assert.equal((await service.accessSnapshot('bob')).reason,'access_pass_required')
    await service.consumeAccess('alice')
    assert.equal((await service.accessSnapshot('alice')).reason,'daily_tool_limit')
    assert.equal((await service.accessSnapshot('alice')).remainingToday,0)
    await query('DELETE FROM agnt_sale_usage WHERE user_id=$1',['alice'])
    await assert.rejects(service.purchase('alice',{...request,quantity:3}),/idempotency_conflict/)
    assert.equal((await service.account('bob')).passes.length,0)
    const stale=await service.quote('alice',1)
    assert.equal(stale.soldCountSnapshot,2)
    assert.equal(stale.availableSupply,4442)
    const buy={quoteId:stale.id,quantity:1,maxTotalZatoshi:stale.totalZatoshi,curveVersion:CURVE_VERSION,idempotencyKey:randomUUID()}
    await service.purchase('alice',buy)
    await assert.rejects(service.purchase('alice',{...buy,idempotencyKey:randomUUID()}),/price_changed/)
    const w={destination:'test-destination-not-a-live-address',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:randomUUID()}
    const hold=await service.holdWithdrawal('alice',w)
    assert.equal((await service.requestStatus('alice','withdrawal',w.idempotencyKey)).receipt.id,hold.id)
    assert.equal((await service.requestStatus('bob','withdrawal',w.idempotencyKey)).status,'UNKNOWN')
    assert.equal((await service.holdWithdrawal('alice',w)).id,hold.id)
    assert.equal((await service.account('alice')).balance.held,'1010000')
    await assert.rejects(service.cancelWithdrawal('bob',hold.id),/withdrawal_not_found/)
    await service.cancelWithdrawal('alice',hold.id)
    await service.cancelWithdrawal('alice',hold.id)
    assert.equal((await service.account('alice')).balance.held,'0')
    await assert.rejects(service.approveWithdrawal('alice',hold.id),/invalid_withdrawal_state/)
    const payout=await service.holdWithdrawal('alice',{...w,idempotencyKey:randomUUID()})
    const approved=await approveFixtureWithdrawal(service,pool,'alice',payout.id)
    assert.equal((await service.approveWithdrawal('alice',payout.id)).signer_reference,approved.signer_reference)
    await assert.rejects(service.cancelWithdrawal('alice',payout.id),/withdrawal_cannot_cancel/)
    const signed={signerReference:approved.signer_reference,txid:'c'.repeat(64),actualFeeZatoshi:'5000'}
    await assert.rejects(service.recordSignedWithdrawal('alice',payout.id,{...signed,actualFeeZatoshi:'10001'}),/withdrawal_fee_exceeded/)
    await service.recordSignedWithdrawal('alice',payout.id,signed)
    await service.recordSignedWithdrawal('alice',payout.id,signed)
    await assert.rejects(service.recordSignedWithdrawal('alice',payout.id,{...signed,txid:'d'.repeat(64)}),/signed_transaction_conflict/)
    await assert.rejects(service.cancelWithdrawal('alice',payout.id),/withdrawal_cannot_cancel/)
    const proof={txid:signed.txid,canonical:true,confirmations:3}
    await assert.rejects(service.settleWithdrawal('alice',payout.id,{...proof,confirmations:1},3),/withdrawal_unconfirmed/)
    const before=BigInt((await service.account('alice')).balance.available)
    // No broadcast acknowledgment: reconcile the known signed transaction, not a new payout.
    await service.settleWithdrawal('alice',payout.id,proof,3)
    await service.settleWithdrawal('alice',payout.id,proof,3)
    assert.equal((await service.account('alice')).balance.held,'0')
    assert.equal((await service.account('alice')).balance.available,String(before+5000n))
    const broadcastPayout=await service.holdWithdrawal('alice',{...w,idempotencyKey:randomUUID()})
    const secondApproval=await approveFixtureWithdrawal(service,pool,'alice',broadcastPayout.id)
    const secondSigned={...signed,signerReference:secondApproval.signer_reference,txid:'e'.repeat(64)}
    await service.recordSignedWithdrawal('alice',broadcastPayout.id,secondSigned)
    await service.recordWithdrawalBroadcast('alice',broadcastPayout.id,secondSigned.txid)
    await service.recordWithdrawalBroadcast('alice',broadcastPayout.id,secondSigned.txid)
    await service.settleWithdrawal('alice',broadcastPayout.id,{...proof,txid:secondSigned.txid},3)
    const ledger=await query("SELECT COALESCE(sum(CASE WHEN credit_account=$1 THEN amount ELSE 0 END),0)-COALESCE(sum(CASE WHEN debit_account=$1 THEN amount ELSE 0 END),0) AS balance FROM agnt_sale_ledger",['customer:alice:available'])
    assert.equal(String((ledger.rows[0] as {balance:string}).balance),(await service.account('alice')).balance.available)
    await assert.rejects(service.holdWithdrawal('alice',{...w,amountZatoshi:'999999999',idempotencyKey:randomUUID()}),/insufficient_credit/)
    await service.consumeAccess('alice')
    await assert.rejects(service.consumeAccess('alice'),/daily_tool_limit/)
    assert.equal((await reconcileSale(pool)).ok,true)
    // Aggregate balances alone cannot detect a renamed source reference.
    await query("UPDATE agnt_sale_ledger SET credit_account='treasury:paid' WHERE reference=$1",[`withdrawal-fee:${broadcastPayout.id}`])
    const feeMismatch=await reconcileSale(pool)
    assert.ok(feeMismatch.issues.some(issue=>issue.code==='source_journal_mismatch'&&issue.userId==='alice'))
    assert.ok(!feeMismatch.issues.some(issue=>issue.code==='available_ledger_mismatch'||issue.code==='held_ledger_mismatch'))
    await query("UPDATE agnt_sale_ledger SET credit_account='treasury:network-fees' WHERE reference=$1",[`withdrawal-fee:${broadcastPayout.id}`])
    await query("UPDATE agnt_sale_ledger SET reference='fabricated-source' WHERE reference=$1",[`deposit:${receipt.receiptId}`])
    const sourceMismatch=await reconcileSale(pool)
    assert.ok(sourceMismatch.issues.some(issue=>issue.code==='source_journal_mismatch'&&issue.userId==='alice'))
    assert.ok(sourceMismatch.issues.some(issue=>issue.code==='unattributed_journal_entry'))
    assert.ok(!sourceMismatch.issues.some(issue=>issue.code==='available_ledger_mismatch'||issue.code==='held_ledger_mismatch'))
    await query("UPDATE agnt_sale_ledger SET reference=$1 WHERE reference='fabricated-source'",[`deposit:${receipt.receiptId}`])
    // Deliberate fixture restoration only; reconciliation never edits journals.
    assert.equal((await reconcileSale(pool)).ok,true)
    // Deliberate corruption in the isolated test database must stop the sale.
    await query("UPDATE agnt_sale_accounts SET available=available+1 WHERE user_id='alice'")
    const mismatch=await reconcileSale(pool)
    assert.equal(mismatch.ok,false)
    assert.ok(mismatch.issues.some(issue=>issue.code==='available_ledger_mismatch' && issue.userId==='alice'))
    assert.equal((await service.summary()).state,'PAUSED')
    assert.equal((await service.account('alice')).balance.frozen,true)
    // Restore only the synthetic fault to test the independent inventory check.
    await query("UPDATE agnt_sale_accounts SET available=available-1 WHERE user_id='alice'")
    await query('UPDATE agnt_sale SET sold=sold+1 WHERE id=1')
    assert.ok((await reconcileSale(pool)).issues.some(issue=>issue.code==='inventory_mismatch'))
    await query('UPDATE agnt_sale SET sold=sold-1 WHERE id=1')
    assert.equal((await reconcileSale(pool)).ok,true)
    assert.equal((await service.account('alice')).balance.frozen,true)
    assert.equal((await service.summary()).state,'PAUSED')
    await service.observe('alice',{...receipt,canonical:false,confirmations:0,blockHash:null},3)
    assert.equal((await service.account('alice')).balance.frozen,true)
    assert.ok((await reconcileSale(pool)).issues.some(issue=>issue.code==='orphaned_credit_requires_review'))
    await assert.rejects(service.consumeAccess('alice'),/account_frozen/)
    assert.equal((await service.accessSnapshot('alice')).reason,'account_frozen')
    const rows=await query('SELECT count(*)::integer AS count FROM agnt_sale_ledger WHERE reference=$1',[`deposit:${receipt.receiptId}`])
    assert.equal((rows.rows[0] as {count:number}).count,1)
  }finally{await db.close()}
})
