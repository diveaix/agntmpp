import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { salePool, transaction } from './database.js'
import { CURVE_VERSION, SCHEDULE_HASH, SUPPLY, SaleError, totalPrice, zatoshi, idempotencyKey } from './pricing.js'
import { saleNotifications, markSaleNotificationRead } from './notifications.js'
import { parseAccessPolicy, readAccessPolicy, type SaleAccessPolicy } from './access-policy.js'
import { passMetadata, passMetadataHash } from './pass-metadata.js'
import { issuancePayload } from './receipt-payload.js'
import type { SignedReceipt } from './receipt-signature.js'
import { validWithdrawalApprovals, recordWithdrawalApproval, withdrawalApprovalHash } from './withdrawal-approvals.js'
import { enforceTreasuryLimits } from './treasury-limits.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function requestGeneration(value:number|undefined){
  if(value===undefined)return 0 // Legacy requests predate the first recovery fence.
  if(!Number.isSafeInteger(value)||value<0||value>2147483647)throw new SaleError('invalid_request_generation')
  return value
}
async function event(c: PoolClient, kind: string, user: string, ref: string) {
  const inserted=await c.query('INSERT INTO agnt_sale_events(id,kind,user_id,reference) VALUES($1,$2,$3,$4) ON CONFLICT(kind,reference) DO NOTHING RETURNING id', [randomUUID(),kind,user,ref])
  if(inserted.rows.length)await c.query('INSERT INTO agnt_sale_outbox(event_id) VALUES($1)',[inserted.rows[0].id])
}
async function journal(c: PoolClient, ref: string, debit: string, credit: string, amount: bigint) {
  if (amount === 0n) return
  await c.query('INSERT INTO agnt_sale_ledger(id,reference,debit_account,credit_account,amount) VALUES($1,$2,$3,$4,$5)', [randomUUID(),ref,debit,credit,String(amount)])
}
async function lockAccount(c: PoolClient, user: string) {
  await c.query('INSERT INTO agnt_sale_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user])
  return (await c.query('SELECT * FROM agnt_sale_accounts WHERE user_id=$1 FOR UPDATE', [user])).rows[0]
}
export interface Receipt {
  receiptId: string; txid: string; amountZatoshi: string; confirmations: number
  blockHash: string | null; canonical: boolean; blockHeight?:number
}
interface WithdrawalRow {
  id:string; user_id:string; destination:string; amount:string; fee_limit:string; state:string
  signer_reference:string|null; txid:string|null; actual_fee:string|null
  settlement_block_hash:string|null; settlement_review:boolean
}

export class SaleService {
  constructor(private db: Pool = salePool()) {}
  async operatorWithdrawal(actorId:string,id:string){
    const operator=(await this.db.query('SELECT enabled FROM agnt_treasury_operators WHERE actor_id=$1',[actorId])).rows[0]
    if(!operator?.enabled)throw new SaleError('treasury_operator_required',403)
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))throw new SaleError('invalid_withdrawal')
    const row=(await this.db.query('SELECT id,user_id,destination,amount,fee_limit,state FROM agnt_sale_withdrawals WHERE id=$1',[id])).rows[0]
    if(!row)throw new SaleError('withdrawal_not_found',404)
    return {operatorId:actorId,withdrawal:{id:row.id,ownerId:row.user_id,destination:row.destination,
      amountZatoshi:String(row.amount),feeLimitZatoshi:String(row.fee_limit),state:row.state},payloadHash:withdrawalApprovalHash(row)}
  }
  async operatorApproveWithdrawal(actorId:string,id:string,input:{reason:string;payloadHash:string}){
    if(typeof input?.payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(input.payloadHash))throw new SaleError('invalid_withdrawal_approval')
    const preview=await this.operatorWithdrawal(actorId,id)
    const vote=await recordWithdrawalApproval(this.db,actorId,id,input.reason,input.payloadHash)
    const state=vote.validApprovals>=2?(await this.approveWithdrawal(preview.withdrawal.ownerId,id)).state:vote.state
    return {...vote,state,operatorId:actorId}
  }
  async notifications(user:string){return saleNotifications(this.db,user)}
  async readNotification(user:string,id:string){return markSaleNotificationRead(this.db,user,id)}
  async purchaseReceipt(user:string,id:string){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new SaleError('invalid_purchase_id')
    return transaction(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      const row=(await c.query('SELECT id,first_serial,quantity,total::text,curve_version,access_policy_version,created_at FROM agnt_sale_purchases WHERE id=$1 AND user_id=$2',[id,user])).rows[0]
      if(!row)throw new SaleError('purchase_not_found',404)
      let policy:SaleAccessPolicy|null=null
      const sale=(await c.query('SELECT access_policy_version,access_duration_days,access_daily_calls FROM agnt_sale WHERE id=1')).rows[0]
      try{const stored=parseAccessPolicy(sale);if(stored.version===row.access_policy_version)policy=stored}catch(error){if(!(error instanceof SaleError))throw error}
      const passes=(await c.query('SELECT serial,metadata_hash FROM agnt_sale_passes WHERE purchase_id=$1 AND owner_id=$2 ORDER BY serial',[id,user])).rows.map(pass=>{
        const verified=policy!==null&&pass.metadata_hash===passMetadataHash(pass.serial,policy)
        return {...pass,metadata:verified?passMetadata(pass.serial,policy!):null,metadataVerified:verified}
      })
      const metadataVerified=policy!==null&&row.curve_version===CURVE_VERSION&&passes.length===row.quantity&&passes.every((pass,index)=>pass.metadataVerified&&pass.serial===row.first_serial+index)
      // Snapshot consistency and hashes are not an independent signature or
      // proof of current eligibility. Corrupt data stays visible for recovery.
      const receipt={formatVersion:1,userId:user,ownershipModel:'database-managed, account-bound',purchase:row,accessPolicy:policy,passes,metadataVerified}
      const stored=(await c.query('SELECT envelope FROM agnt_sale_signed_receipts WHERE purchase_id=$1',[id])).rows[0]
      let signature:SignedReceipt|null=null
      let signatureVerification='not_signed'
      if(stored){
        signatureVerification='stored_signature_mismatch'
        const envelope=stored.envelope
        if(metadataVerified&&envelope?.format==='agnt-issuance-receipt-v1'&&envelope.algorithm==='Ed25519'&&typeof envelope.keyId==='string'&&/^[a-f0-9]{64}$/.test(envelope.keyId)&&typeof envelope.signature==='string'&&/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)&&envelope.payload===issuancePayload(receipt).toString('base64')){
          signature={format:envelope.format,algorithm:envelope.algorithm,keyId:envelope.keyId,payload:envelope.payload,signature:envelope.signature}
          signatureVerification='requires_trusted_public_key'
        }
      }
      return {...receipt,signature,signatureVerification}
    },this.db)
  }
  async requestStatus(user:string,kind:'purchase'|'withdrawal',key:string) {
    return this.readRequestStatus(this.db,user,kind,key)
  }
  async withdrawalStatus(user:string,id:string){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new SaleError('invalid_withdrawal')
    const row=(await this.db.query('SELECT id,destination,amount::text,fee_limit::text,actual_fee::text,state,txid,settlement_review,confirmations,required_confirmations,confirmation_checked_at,created_at FROM agnt_sale_withdrawals WHERE id=$1 AND user_id=$2',[id,user])).rows[0]
    if(!row)throw new SaleError('withdrawal_not_found',404)
    return {userId:user,withdrawal:row}
  }
  private async readRequestStatus(db:Pool|PoolClient,user:string,kind:'purchase'|'withdrawal',key:string) {
    idempotencyKey(key)
    if(kind!=='purchase'&&kind!=='withdrawal')throw new SaleError('invalid_request_kind')
    const sql=kind==='purchase'
      ? 'SELECT id,first_serial,quantity,access_policy_version,total::text FROM agnt_sale_purchases WHERE user_id=$1 AND idempotency_key=$2'
      : 'SELECT id,amount::text,fee_limit::text,state,txid FROM agnt_sale_withdrawals WHERE user_id=$1 AND idempotency_key=$2'
    const receipt=(await db.query(sql,[user,key])).rows[0]
    const canceled=!receipt&&(await db.query('SELECT 1 FROM agnt_sale_canceled_requests WHERE user_id=$1 AND kind=$2 AND idempotency_key=$3',[user,kind,key])).rows.length>0
    // Absence is not rejection: a concurrent request may still commit later.
    return {userId:user,kind,status:receipt?'RECORDED':canceled?'CANCELED':'UNKNOWN',receipt:receipt??null}
  }
  async cancelPendingRequest(user:string,kind:'purchase'|'withdrawal',key:string) {
    idempotencyKey(key)
    if(kind!=='purchase'&&kind!=='withdrawal')throw new SaleError('invalid_request_kind')
    return transaction(async c=>{
      // Same serialization boundary as submission. A queued original request
      // either commits first or sees the durable cancellation before spending.
      if(kind==='purchase'){
        if(!(await c.query('SELECT id FROM agnt_sale WHERE id=1 FOR UPDATE')).rows.length)throw new SaleError('sale_not_initialized',503)
      }else await lockAccount(c,user)
      const status=await this.readRequestStatus(c,user,kind,key)
      if(status.status!=='UNKNOWN')return status
      await c.query('INSERT INTO agnt_sale_canceled_requests(user_id,kind,idempotency_key) VALUES($1,$2,$3)',[user,kind,key])
      await event(c,'REQUEST_CANCELED',user,hash({user,kind,key}))
      return {userId:user,kind,status:'CANCELED',receipt:null}
    },this.db)
  }
  async summary() {
    const row = (await this.db.query('SELECT * FROM agnt_sale WHERE id=1')).rows[0]
    if (!row || row.curve_version !== CURVE_VERSION || row.schedule_hash !== SCHEDULE_HASH) throw new SaleError('sale_not_initialized',503)
    return { state: row.state, sold: row.sold, supply: SUPPLY, curveVersion: CURVE_VERSION, scheduleHash: SCHEDULE_HASH,
      nextPriceZatoshi: row.sold === SUPPLY ? null : String(totalPrice(row.sold,1)), firstPriceZatoshi:'2000000',
      lastPriceZatoshi:String(totalPrice(SUPPLY-1,1)), totalSaleZatoshi:String(totalPrice(0,SUPPLY)) }
  }
  async resetPendingRequests(user:string,expectedGeneration:number){
    if(expectedGeneration===undefined)throw new SaleError('invalid_request_generation')
    const expected=requestGeneration(expectedGeneration)
    return transaction(async c=>{
      // Same lock order as purchases. Earlier submissions either commit first
      // or encounter the new generation before any debit or hold is created.
      if(!(await c.query('SELECT id FROM agnt_sale WHERE id=1 FOR UPDATE')).rows.length)throw new SaleError('sale_not_initialized',503)
      const account=await lockAccount(c,user)
      if(account.request_generation!==expected)throw new SaleError('request_generation_changed',409)
      if(expected===2147483647)throw new SaleError('request_generation_exhausted',409)
      const next=expected+1
      await c.query('UPDATE agnt_sale_accounts SET request_generation=$2 WHERE user_id=$1',[user,next])
      await event(c,'REQUESTS_RESET',user,hash({user,generation:next}))
      return {userId:user,requestGeneration:next,recordedRequestsPreserved:true}
    },this.db)
  }
  async requestRecoveryState(user:string){
    const row=(await this.db.query('SELECT request_generation FROM agnt_sale_accounts WHERE user_id=$1',[user])).rows[0]
    return {userId:user,requestGeneration:row?.request_generation??0}
  }
  async account(user: string) {
    const [balance,passes,deposits,purchases,withdrawals] = await Promise.all([
      this.db.query('SELECT available::text,held::text,frozen FROM agnt_sale_accounts WHERE user_id=$1',[user]),
      this.db.query('SELECT serial,state,metadata_hash FROM agnt_sale_passes WHERE owner_id=$1 ORDER BY serial',[user]),
      this.db.query('SELECT receipt_id,txid,amount::text,confirmations,required_confirmations,state FROM agnt_sale_deposits WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100',[user]),
      this.db.query('SELECT id,first_serial,quantity,access_policy_version,total::text,created_at FROM agnt_sale_purchases WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[user]),
      this.db.query('SELECT id,destination,amount::text,fee_limit::text,state,txid,settlement_review,confirmations,required_confirmations,confirmation_checked_at FROM agnt_sale_withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[user]),
    ])
    return { userId:user, balance:balance.rows[0] ?? {available:'0',held:'0',frozen:false}, passes:passes.rows, deposits:deposits.rows, purchases:purchases.rows, withdrawals:withdrawals.rows }
  }
  async exportAccount(user:string) {
    return transaction(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      const snapshot=(await c.query('SELECT transaction_timestamp() AS at')).rows[0].at
      const balance=(await c.query('SELECT available::text,held::text,frozen FROM agnt_sale_accounts WHERE user_id=$1',[user])).rows[0]??{available:'0',held:'0',frozen:false}
      // Explicit projections exclude treasury identifiers, signing data and
      // other users. Unlike dashboard previews, these histories are complete.
      const passes=(await c.query('SELECT serial,purchase_id,state,metadata_hash FROM agnt_sale_passes WHERE owner_id=$1 ORDER BY serial',[user])).rows
      const deposits=(await c.query('SELECT receipt_id,txid,amount::text,confirmations,required_confirmations,state,updated_at FROM agnt_sale_deposits WHERE user_id=$1 ORDER BY updated_at,receipt_id',[user])).rows
      const purchases=(await c.query('SELECT id,first_serial,quantity,access_policy_version,total::text,curve_version,created_at FROM agnt_sale_purchases WHERE user_id=$1 ORDER BY created_at,id',[user])).rows
      const withdrawals=(await c.query('SELECT id,destination,amount::text,fee_limit::text,actual_fee::text,state,txid,settlement_review,confirmations,required_confirmations,confirmation_checked_at,created_at FROM agnt_sale_withdrawals WHERE user_id=$1 ORDER BY created_at,id',[user])).rows
      const usage=(await c.query('SELECT day,calls FROM agnt_sale_usage WHERE user_id=$1 ORDER BY day',[user])).rows
      const creditReviews=(await c.query('SELECT receipt_id,credited_amount::text,coverage_state,confirmations,required_confirmations,first_detected_at,checked_at FROM agnt_sale_credit_reviews WHERE user_id=$1 ORDER BY first_detected_at,receipt_id',[user])).rows
      return {formatVersion:1,userId:user,exportedAt:snapshot,amountUnit:'zatoshi',ownershipModel:'database-managed, account-bound; not a transferable Zcash NFT',balance,passes,deposits,purchases,withdrawals,usage,creditReviews}
    },this.db)
  }
  async quote(user: string, quantity: number) {
    const sale = await this.summary()
    const total = totalPrice(sale.sold,quantity)
    let accessPolicy:SaleAccessPolicy|null=null
    try{accessPolicy=await readAccessPolicy(this.db)}catch(error){
      if(!(error instanceof SaleError)||error.message!=='access_terms_unconfigured')throw error
    }
    const quote = {id:randomUUID(), quantity, soldCountSnapshot:sale.sold, availableSupply:SUPPLY-sale.sold, totalZatoshi:String(total), curveVersion:CURVE_VERSION, accessPolicy, expiresAt:new Date(Date.now()+120000).toISOString()}
    await this.db.query('INSERT INTO agnt_sale_quotes(id,user_id,quantity,curve_version,total,expires_at,access_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[quote.id,user,quantity,CURVE_VERSION,String(total),quote.expiresAt,accessPolicy?.version??null])
    return quote
  }
  async purchase(user: string, input: {quoteId:string;quantity:number;maxTotalZatoshi:string;curveVersion:string;idempotencyKey:string;requestGeneration?:number}) {
    const generation=requestGeneration(input.requestGeneration)
    const key = idempotencyKey(input.idempotencyKey)
    const max = zatoshi(input.maxTotalZatoshi)
    if (!/^[0-9a-f-]{36}$/i.test(input.quoteId)) throw new SaleError('invalid_quote')
    const requestHash = hash(input)
    return transaction(async c => {
      // A single sale lock gives deterministic pricing and idempotent retries even at sellout.
      const sale = (await c.query('SELECT * FROM agnt_sale WHERE id=1 FOR UPDATE')).rows[0]
      const previous = (await c.query('SELECT * FROM agnt_sale_purchases WHERE user_id=$1 AND idempotency_key=$2',[user,key])).rows[0]
      if (previous) {
        if (previous.request_hash !== requestHash) throw new SaleError('idempotency_conflict',409)
        return previous
      }
      if((await c.query("SELECT 1 FROM agnt_sale_canceled_requests WHERE user_id=$1 AND kind='purchase' AND idempotency_key=$2",[user,key])).rows.length)throw new SaleError('request_canceled',409)
      if (!sale || sale.state !== 'OPEN') throw new SaleError('sale_closed',409)
      if (input.curveVersion !== CURVE_VERSION || sale.curve_version !== CURVE_VERSION || sale.schedule_hash !== SCHEDULE_HASH) throw new SaleError('curve_changed',409)
      const quote = (await c.query('SELECT * FROM agnt_sale_quotes WHERE id=$1 AND user_id=$2 AND expires_at>now()',[input.quoteId,user])).rows[0]
      if (!quote || quote.quantity !== input.quantity || quote.curve_version !== CURVE_VERSION) throw new SaleError('quote_expired_or_invalid',409)
      const policy=parseAccessPolicy(sale)
      if(quote.access_policy_version!==policy.version)throw new SaleError('access_policy_changed',409)
      const total = totalPrice(sale.sold,input.quantity)
      if (total > max) throw new SaleError('price_changed',409)
      const account = await lockAccount(c,user)
      if(account.request_generation!==generation)throw new SaleError('request_generation_changed',409)
      if (account.frozen) throw new SaleError('account_frozen',409)
      if (BigInt(account.available) < total) throw new SaleError('insufficient_credit',409)
      const id = randomUUID()
      const purchase = (await c.query('INSERT INTO agnt_sale_purchases(id,user_id,idempotency_key,request_hash,first_serial,quantity,total,curve_version,access_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[id,user,key,requestHash,sale.sold+1,input.quantity,String(total),CURVE_VERSION,policy.version])).rows[0]
      await c.query('UPDATE agnt_sale_accounts SET available=available-$2 WHERE user_id=$1',[user,String(total)])
      await journal(c,`purchase:${id}`,`customer:${user}:available`,'sale:proceeds',total)
      for (let n=sale.sold+1;n<=sale.sold+input.quantity;n++) {
        await c.query('INSERT INTO agnt_sale_passes(serial,owner_id,purchase_id,metadata_hash) VALUES($1,$2,$3,$4)',[n,user,id,passMetadataHash(n,policy)])
      }
      await c.query('UPDATE agnt_sale SET sold=sold+$1 WHERE id=1',[input.quantity])
      await event(c,'PURCHASE',user,id)
      return purchase
    },this.db)
  }
  // Trusted observer only. No public HTTP route accepts receipt/confirmation assertions.
  async observe(user: string, receipt: Receipt, required: number) {
    const amount = zatoshi(receipt.amountZatoshi)
    if (!amount || !Number.isInteger(required) || required<1 || !Number.isInteger(receipt.confirmations) || receipt.confirmations<0 || !/^[0-9a-f]{64}$/i.test(receipt.txid) || receipt.receiptId.length>300 || !receipt.receiptId) throw new SaleError('invalid_receipt')
    if (receipt.canonical && receipt.confirmations>0 && !/^[0-9a-f]{64}$/i.test(receipt.blockHash || '')) throw new SaleError('invalid_block_hash')
    if(receipt.blockHeight!==undefined&&(!Number.isSafeInteger(receipt.blockHeight)||receipt.blockHeight<0||receipt.blockHeight>2147483647))throw new SaleError('invalid_block_height')
    return transaction(async c => {
      await lockAccount(c,user)
      // Claim the unique receipt before reading it: a missing row cannot be locked.
      // Concurrent observers for different accounts must resolve ownership first.
      await c.query("INSERT INTO agnt_sale_deposits(receipt_id,user_id,txid,amount,confirmations,block_hash,state,credited) VALUES($1,$2,$3,$4,0,NULL,'CONFIRMING',false) ON CONFLICT(receipt_id) DO NOTHING",[receipt.receiptId,user,receipt.txid,String(amount)])
      const existing = (await c.query('SELECT * FROM agnt_sale_deposits WHERE receipt_id=$1 FOR UPDATE',[receipt.receiptId])).rows[0]
      if (existing && (existing.user_id!==user || BigInt(existing.amount)!==amount || existing.txid!==receipt.txid)) throw new SaleError('receipt_conflict',409)
      const credit = receipt.canonical && receipt.confirmations>=required
      const lost = existing?.credited && !credit
      const state = lost || !receipt.canonical ? 'ORPHANED' : credit ? 'CREDITED' : 'CONFIRMING'
      const height=receipt.blockHeight??(existing.block_hash===receipt.blockHash?existing.block_height:null)
      await c.query('INSERT INTO agnt_sale_deposits(receipt_id,user_id,txid,amount,confirmations,block_hash,state,credited) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(receipt_id) DO UPDATE SET confirmations=$5,block_hash=$6,state=$7,credited=$8,updated_at=now()', [receipt.receiptId,user,receipt.txid,String(amount),receipt.confirmations,receipt.blockHash,state,Boolean(existing?.credited || credit)])
      await c.query('UPDATE agnt_sale_deposits SET block_height=$2,required_confirmations=$3 WHERE receipt_id=$1',[receipt.receiptId,height??null,required])
      const coverage=receipt.canonical?(credit?'RESTORED':'UNCONFIRMED'):'ORPHANED'
      if(lost){
        // Gross credited value requiring reconciliation, not an automatic debt
        // assigned to the customer. Preserve the original receipt and balances.
        await c.query(`INSERT INTO agnt_sale_credit_reviews(receipt_id,user_id,credited_amount,coverage_state,confirmations,required_confirmations)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(receipt_id) DO UPDATE SET
          coverage_state=$4,confirmations=$5,required_confirmations=$6,checked_at=now()`,[receipt.receiptId,user,String(amount),coverage,receipt.confirmations,required])
      }else{
        // Restored evidence updates the review, but never deletes it or clears
        // suspended rights. Customer treatment still requires approved policy.
        await c.query('UPDATE agnt_sale_credit_reviews SET coverage_state=$2,confirmations=$3,required_confirmations=$4,checked_at=now() WHERE receipt_id=$1',[receipt.receiptId,coverage,receipt.confirmations,required])
      }
      if (lost) {
        await c.query('UPDATE agnt_sale_accounts SET frozen=true WHERE user_id=$1',[user])
        await c.query("UPDATE agnt_sale_passes SET state='SUSPENDED' WHERE owner_id=$1",[user])
        await event(c,'REORG_REVIEW',user,receipt.receiptId)
      } else if (credit && !existing?.credited) {
        await c.query('UPDATE agnt_sale_accounts SET available=available+$2 WHERE user_id=$1',[user,String(amount)])
        await journal(c,`deposit:${receipt.receiptId}`,'treasury:received',`customer:${user}:available`,amount)
        await event(c,'DEPOSIT_CREDIT',user,receipt.receiptId)
      }
      // Recovered receipts do not auto-unfreeze: review must resolve any deficit first.
      return {state}
    },this.db)
  }
  async holdWithdrawal(user: string, input: {destination:string;amountZatoshi:string;feeLimitZatoshi:string;idempotencyKey:string;requestGeneration?:number}) {
    const generation=requestGeneration(input.requestGeneration)
    const amount=zatoshi(input.amountZatoshi), fee=zatoshi(input.feeLimitZatoshi), key=idempotencyKey(input.idempotencyKey)
    if (amount===0n || input.destination.length<10 || input.destination.length>512) throw new SaleError('invalid_withdrawal')
    return transaction(async c => {
      const account=await lockAccount(c,user)
      const old=(await c.query('SELECT * FROM agnt_sale_withdrawals WHERE user_id=$1 AND idempotency_key=$2',[user,key])).rows[0]
      if(old){if(old.request_hash!==hash(input))throw new SaleError('idempotency_conflict',409);return old}
      if(account.request_generation!==generation)throw new SaleError('request_generation_changed',409)
      if((await c.query("SELECT 1 FROM agnt_sale_canceled_requests WHERE user_id=$1 AND kind='withdrawal' AND idempotency_key=$2",[user,key])).rows.length)throw new SaleError('request_canceled',409)
      if(account.frozen)throw new SaleError('account_frozen',409)
      if(BigInt(account.available)<amount+fee)throw new SaleError('insufficient_credit',409)
      const id=randomUUID()
      const result=(await c.query('INSERT INTO agnt_sale_withdrawals(id,user_id,idempotency_key,request_hash,destination,amount,fee_limit) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,user,key,hash(input),input.destination,String(amount),String(fee)])).rows[0]
      await c.query('UPDATE agnt_sale_accounts SET available=available-$2,held=held+$2 WHERE user_id=$1',[user,String(amount+fee)])
      await journal(c,`withdrawal-hold:${id}`,`customer:${user}:available`,`customer:${user}:held`,amount+fee)
      await event(c,'WITHDRAWAL_HELD',user,id)
      return result
    },this.db)
  }
  async accessSnapshot(user:string) {
    return transaction(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      let policy:SaleAccessPolicy|null=null
      try{policy=await readAccessPolicy(c)}catch(error){
        if(!(error instanceof SaleError)||error.message!=='access_terms_unconfigured')throw error
      }
      const dailyLimit=policy?.dailyCalls??null,durationDays=policy?.durationDays??null,configured=policy!==null
      const frozen=Boolean((await c.query('SELECT frozen FROM agnt_sale_accounts WHERE user_id=$1',[user])).rows[0]?.frozen)
      const passes=(await c.query("SELECT p.serial,p.state,b.access_policy_version,b.created_at AS issued_at,CASE WHEN b.access_policy_version=$3 THEN b.created_at + ($2::integer * interval '1 day') END AS expires_at,COALESCE(b.access_policy_version=$3 AND p.state='ACTIVE' AND b.created_at + ($2::integer * interval '1 day') > now(),false) AS eligible FROM agnt_sale_passes p JOIN agnt_sale_purchases b ON p.purchase_id=b.id WHERE p.owner_id=$1 ORDER BY p.serial",[user,durationDays,policy?.version??null])).rows
      const used=Number((await c.query("SELECT calls FROM agnt_sale_usage WHERE user_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date",[user])).rows[0]?.calls??0)
      const eligible=passes.some(p=>p.eligible)
      const reason=!configured?'access_terms_unconfigured':frozen?'account_frozen':!eligible?'access_pass_required':used>=dailyLimit!?'daily_tool_limit':null
      return {source:'collectible_pass' as const,policyVersion:policy?.version??null,eligible:reason===null,reason,passes,dailyLimit,usedToday:used,remainingToday:configured?Math.max(0,dailyLimit!-used):null,quotaTimezone:'UTC',durationDays}
    },this.db)
  }
  async consumeAccess(user: string) {
    return transaction(async c => {
      const account=await lockAccount(c,user)
      if(account.frozen)throw new SaleError('account_frozen',403)
      const policy=await readAccessPolicy(c),dailyLimit=policy.dailyCalls
      const eligible=await c.query("SELECT p.serial FROM agnt_sale_passes p JOIN agnt_sale_purchases b ON p.purchase_id=b.id WHERE p.owner_id=$1 AND b.access_policy_version=$3 AND p.state='ACTIVE' AND b.created_at + ($2::integer * interval '1 day') > now() LIMIT 1",[user,policy.durationDays,policy.version])
      if(!eligible.rowCount)throw new SaleError('access_pass_required',403)
      const used=await c.query('INSERT INTO agnt_sale_usage(user_id,day,calls) VALUES($1,(now() AT TIME ZONE \'UTC\')::date,1) ON CONFLICT(user_id,day) DO UPDATE SET calls=agnt_sale_usage.calls+1 WHERE agnt_sale_usage.calls<$2 RETURNING calls',[user,dailyLimit])
      if(!used.rowCount)throw new SaleError('daily_tool_limit',429)
    },this.db)
  }

  private async withWithdrawal<T>(user: string, id: string, fn: (c: PoolClient, row: WithdrawalRow, account: {frozen:boolean}) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new SaleError('invalid_withdrawal')
    return transaction(async c => {
      // Same lock order as holds and deposit reorg freezes.
      const account=await lockAccount(c,user)
      const row=(await c.query('SELECT * FROM agnt_sale_withdrawals WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user])).rows[0]
      if(!row)throw new SaleError('withdrawal_not_found',404)
      return fn(c,row,account)
    },this.db)
  }

  async cancelWithdrawal(user: string, id: string) {
    return this.withWithdrawal(user,id,async(c,row)=>{
      if(row.state==='CANCELED')return row
      // APPROVED means a signer may already be processing the durable intent.
      // Never release its funds, even if the signer call timed out.
      if(row.state!=='HELD')throw new SaleError('withdrawal_cannot_cancel',409)
      const reserve=BigInt(row.amount)+BigInt(row.fee_limit)
      await c.query('UPDATE agnt_sale_accounts SET available=available+$2,held=held-$2 WHERE user_id=$1',[user,String(reserve)])
      await journal(c,`withdrawal-cancel:${id}`,`customer:${user}:held`,`customer:${user}:available`,reserve)
      await event(c,'WITHDRAWAL_CANCELED',user,id)
      return (await c.query("UPDATE agnt_sale_withdrawals SET state='CANCELED' WHERE id=$1 RETURNING *",[id])).rows[0]
    })
  }

  // Trusted treasury worker only. Commit this stable intent BEFORE contacting a signer.
  // The eventual signer must durably deduplicate by this reference across restarts.
  async approveWithdrawal(user: string, id: string) {
    return this.withWithdrawal(user,id,async(c,row,account)=>{
      if(account.frozen)throw new SaleError('account_frozen',409)
      if(['APPROVED','SIGNED','BROADCAST','PAID'].includes(row.state))return row
      if(row.state!=='HELD')throw new SaleError('invalid_withdrawal_state',409)
      if(await validWithdrawalApprovals(c,row)<2)throw new SaleError('two_treasury_approvals_required',409)
      await enforceTreasuryLimits(c,row,true)
      await event(c,'WITHDRAWAL_APPROVED',user,id)
      return (await c.query("UPDATE agnt_sale_withdrawals SET state='APPROVED',signer_reference=$2 WHERE id=$1 RETURNING *",[id,`agnt-withdrawal:${id}`])).rows[0]
    })
  }

  // The isolated signer stores the signed payload durably before returning this record.
  // This is accounting, not proof that a signature or destination was chain-validated.
  async recordSignedWithdrawal(user: string, id: string, input: {signerReference:string;txid:string;actualFeeZatoshi:string}) {
    const fee=zatoshi(input.actualFeeZatoshi)
    if(!/^[0-9a-f]{64}$/.test(input.txid))throw new SaleError('invalid_transaction_id')
    return this.withWithdrawal(user,id,async(c,row)=>{
      if(row.signer_reference!==input.signerReference)throw new SaleError('signer_reference_conflict',409)
      if(['SIGNED','BROADCAST','PAID'].includes(row.state)){
        if(row.txid!==input.txid || row.actual_fee===null || BigInt(row.actual_fee)!==fee)throw new SaleError('signed_transaction_conflict',409)
        return row
      }
      if(row.state!=='APPROVED')throw new SaleError('invalid_withdrawal_state',409)
      if(fee>BigInt(row.fee_limit))throw new SaleError('withdrawal_fee_exceeded',409)
      // Record even if frozen after approval: a signed transaction may already exist.
      await event(c,'WITHDRAWAL_SIGNED',user,id)
      return (await c.query("UPDATE agnt_sale_withdrawals SET state='SIGNED',txid=$2,actual_fee=$3 WHERE id=$1 RETURNING *",[id,input.txid,String(fee)])).rows[0]
    })
  }

  async recordWithdrawalBroadcast(user: string, id: string, txid: string) {
    return this.withWithdrawal(user,id,async(c,row)=>{
      if(!row.txid || row.txid!==txid)throw new SaleError('signed_transaction_conflict',409)
      if(['BROADCAST','PAID'].includes(row.state))return row
      if(row.state!=='SIGNED')throw new SaleError('invalid_withdrawal_state',409)
      await event(c,'WITHDRAWAL_BROADCAST',user,id)
      return (await c.query("UPDATE agnt_sale_withdrawals SET state='BROADCAST' WHERE id=$1 RETURNING *",[id])).rows[0]
    })
  }

  // Trusted canonical-chain observer only; never accept these assertions from a browser.
  async settleWithdrawal(user: string, id: string, proof: {txid:string;canonical:boolean;confirmations:number;blockHash?:string;blockHeight?:number;
    expectedPayment?:{signerReference:string;destination:string;amountZatoshi:string;feeLimitZatoshi:string;actualFeeZatoshi:string}}, required: number) {
    if(!Number.isInteger(required)||required<1||!Number.isInteger(proof.confirmations)||proof.confirmations<0)throw new SaleError('invalid_confirmations')
    if(proof.blockHash!==undefined&&!/^[a-f0-9]{64}$/.test(proof.blockHash))throw new SaleError('invalid_block_hash')
    if(proof.blockHeight!==undefined&&(!proof.blockHash||!Number.isSafeInteger(proof.blockHeight)||proof.blockHeight<0||proof.blockHeight>2147483647))throw new SaleError('invalid_block_height')
    const settled=await this.withWithdrawal(user,id,async(c,row)=>{
      if(!row.txid || row.txid!==proof.txid)throw new SaleError('signed_transaction_conflict',409)
      const expected=proof.expectedPayment
      if(expected&&(row.signer_reference!==expected.signerReference||row.destination!==expected.destination||
        String(row.amount)!==expected.amountZatoshi||String(row.fee_limit)!==expected.feeLimitZatoshi||String(row.actual_fee)!==expected.actualFeeZatoshi))
        throw new SaleError('withdrawal_settlement_intent_changed',409)
      if(!proof.canonical)throw new SaleError('withdrawal_unconfirmed',409)
      if(row.state==='PAID'){
        if(proof.confirmations<required)throw new SaleError('withdrawal_unconfirmed',409)
        return row
      }
      // Confirmation can arrive after an ambiguous broadcast timeout while state is SIGNED.
      if(!['SIGNED','BROADCAST'].includes(row.state))throw new SaleError('invalid_withdrawal_state',409)
      if(row.actual_fee===null)throw new SaleError('missing_signed_fee',409)
      await c.query('UPDATE agnt_sale_withdrawals SET confirmations=$2,required_confirmations=$3,confirmation_checked_at=now() WHERE id=$1',[id,proof.confirmations,required])
      // Commit verified progress without releasing held funds. Report the
      // unconfirmed outcome only after this nonfinancial update commits.
      if(proof.confirmations<required)return null
      const amount=BigInt(row.amount),fee=BigInt(row.actual_fee),reserve=BigInt(row.fee_limit)
      await c.query('UPDATE agnt_sale_accounts SET held=held-$2,available=available+$3 WHERE user_id=$1',[user,String(amount+reserve),String(reserve-fee)])
      await journal(c,`withdrawal-paid:${id}`,`customer:${user}:held`,'treasury:paid',amount)
      await journal(c,`withdrawal-fee:${id}`,`customer:${user}:held`,'treasury:network-fees',fee)
      await journal(c,`withdrawal-fee-release:${id}`,`customer:${user}:held`,`customer:${user}:available`,reserve-fee)
      await event(c,'WITHDRAWAL_PAID',user,id)
      return (await c.query("UPDATE agnt_sale_withdrawals SET state='PAID',settlement_block_hash=$2,settlement_block_height=$3 WHERE id=$1 RETURNING *",[id,proof.blockHash??null,proof.blockHeight??null])).rows[0]
    })
    if(settled===null)throw new SaleError('withdrawal_unconfirmed',409)
    return settled
  }
  // Trusted reviewer only, after canonical-node evidence proves an orphan.
  // Preserve PAID accounting: a reorg is not a refund or permission to pay again.
  async flagPaidWithdrawalReorg(user:string,id:string,blockHash:string){
    return transaction(async c=>{
      // Purchases lock sale then account; reviewers must use the same order.
      if(!(await c.query('SELECT id FROM agnt_sale WHERE id=1 FOR UPDATE')).rows.length)throw new SaleError('sale_not_initialized',503)
      await lockAccount(c,user)
      const row=(await c.query('SELECT * FROM agnt_sale_withdrawals WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user])).rows[0]
      if(!row)throw new SaleError('withdrawal_not_found',404)
      if(row.state!=='PAID'||!row.settlement_block_hash||row.settlement_block_hash!==blockHash)throw new SaleError('withdrawal_review_evidence_mismatch',409)
      await c.query("UPDATE agnt_sale SET state='PAUSED' WHERE id=1")
      await c.query('UPDATE agnt_sale_accounts SET frozen=true WHERE user_id=$1',[user])
      await c.query("UPDATE agnt_sale_passes SET state='SUSPENDED' WHERE owner_id=$1",[user])
      await c.query('UPDATE agnt_sale_withdrawals SET settlement_review=true WHERE id=$1',[id])
      await event(c,'WITHDRAWAL_REORG_REVIEW',user,id)
      return {reviewRequired:true}
    },this.db)
  }
}
