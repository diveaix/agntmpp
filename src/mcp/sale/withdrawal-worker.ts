import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { SaleError, zatoshi } from './pricing.js'
import { SaleService } from './service.js'
import { SignerArtifacts, type SignedArtifact } from './signer-artifacts.js'
import { canonicalTransactionEvidence, type ChainPolicy, type ZcashRpc } from './zcash-observer.js'
import { validWithdrawalApprovals } from './withdrawal-approvals.js'
import { enforceTreasuryLimits } from './treasury-limits.js'

export interface WithdrawalIntent {
  reference:string; network:SignedArtifact['network']; walletAccountUuid:string
  destination:string; amountZatoshi:string; feeLimitZatoshi:string
}

// Internal worker boundary. The caller supplies an isolated, validated signer,
// not a browser callback. This does not approve withdrawals or broadcast funds.
export async function signApprovedWithdrawal(db:Pool,artifacts:SignerArtifacts,userId:string,id:string,
  network:SignedArtifact['network'],walletAccountUuid:string,
  signValidated:(intent:Readonly<WithdrawalIntent>)=>Promise<Pick<SignedArtifact,'txid'|'rawHex'|'actualFeeZatoshi'>>){
  if(!['mainnet','testnet','regtest'].includes(network)||!/^[a-f0-9-]{36}$/.test(walletAccountUuid))throw new SaleError('invalid_signer_configuration',503)
  const row=(await db.query(`SELECT w.*,a.frozen FROM agnt_sale_withdrawals w
    JOIN agnt_sale_accounts a ON a.user_id=w.user_id WHERE w.id=$1 AND w.user_id=$2`,[id,userId])).rows[0]
  if(!row)throw new SaleError('withdrawal_not_found',404)
  if(!['APPROVED','SIGNED','BROADCAST','PAID'].includes(row.state)||!row.signer_reference)throw new SaleError('invalid_withdrawal_state',409)
  const intent:WithdrawalIntent={reference:row.signer_reference,network,walletAccountUuid,destination:row.destination,amountZatoshi:String(row.amount),feeLimitZatoshi:String(row.fee_limit)}
  const intentHash=createHash('sha256').update(JSON.stringify(intent)).digest('hex')
  const saved=await artifacts.load(intent.reference)
  if(!saved && (row.frozen||row.state!=='APPROVED'))throw new SaleError('withdrawal_signing_requires_review',409)
  const artifact=await artifacts.signForWallet(walletAccountUuid,{reference:intent.reference,network,intentHash},async()=>{
    // Queue pickup is not signing authorization. Re-read after acquiring the
    // durable signer claim, immediately before invoking the wallet adapter.
    // This cannot revoke a wallet operation once it has started.
    const current=(await db.query(`SELECT w.*,a.frozen FROM agnt_sale_withdrawals w
      JOIN agnt_sale_accounts a ON a.user_id=w.user_id WHERE w.id=$1 AND w.user_id=$2`,[id,userId])).rows[0]
    if(!current||current.frozen||current.state!=='APPROVED'||current.signer_reference!==intent.reference||
      current.destination!==intent.destination||String(current.amount)!==intent.amountZatoshi||String(current.fee_limit)!==intent.feeLimitZatoshi)
      throw new SaleError('withdrawal_signing_requires_review',409)
    if(await validWithdrawalApprovals(db,current)<2)throw new SaleError('two_treasury_approvals_required',409)
    await enforceTreasuryLimits(db,current,false)
    const result=await signValidated(Object.freeze(intent))
    // The signer MUST enforce this cap before signing. Recheck its report here;
    // a violation leaves the durable claim for review, never automatic retry.
    if(zatoshi(result.actualFeeZatoshi)>zatoshi(intent.feeLimitZatoshi))throw new SaleError('withdrawal_fee_exceeded',409)
    return result
  })
  if(zatoshi(artifact.actualFeeZatoshi)>zatoshi(intent.feeLimitZatoshi))throw new SaleError('withdrawal_fee_exceeded',409)
  await new SaleService(db).recordSignedWithdrawal(userId,id,{signerReference:artifact.reference,txid:artifact.txid,actualFeeZatoshi:artifact.actualFeeZatoshi})
  return {txid:artifact.txid,actualFeeZatoshi:artifact.actualFeeZatoshi}
}

export async function broadcastSignedWithdrawal(db:Pool,artifacts:SignerArtifacts,node:ZcashRpc,policy:ChainPolicy,
  userId:string,id:string,walletAccountUuid:string,nowSeconds?:number){
  const row=(await db.query(`SELECT w.*,a.frozen FROM agnt_sale_withdrawals w
    JOIN agnt_sale_accounts a ON a.user_id=w.user_id WHERE w.id=$1 AND w.user_id=$2`,[id,userId])).rows[0]
  if(!row)throw new SaleError('withdrawal_not_found',404)
  if(!['SIGNED','BROADCAST','PAID'].includes(row.state)||!row.signer_reference)throw new SaleError('invalid_withdrawal_state',409)
  const intent:WithdrawalIntent={reference:row.signer_reference,network:policy.network,walletAccountUuid,destination:row.destination,amountZatoshi:String(row.amount),feeLimitZatoshi:String(row.fee_limit)}
  const intentHash=createHash('sha256').update(JSON.stringify(intent)).digest('hex')
  const artifact=await artifacts.load(intent.reference)
  if(!artifact||artifact.intentHash!==intentHash||artifact.network!==policy.network||artifact.txid!==row.txid||artifact.actualFeeZatoshi!==String(row.actual_fee))throw new SaleError('withdrawal_artifact_mismatch',409)
  if(row.state==='PAID'||row.state==='BROADCAST')return {txid:artifact.txid,state:row.state}
  if(row.frozen)throw new SaleError('account_frozen',409)
  const tip=await node('getblockchaininfo') as any
  const block=await node('getblock',[tip?.bestblockhash,1]) as any
  await canonicalTransactionEvidence(node,policy,block?.tx?.[0],tip?.bestblockhash,nowSeconds)
  const mempool=await node('getrawmempool')
  if(!Array.isArray(mempool)||mempool.some(txid=>typeof txid!=='string'||!/^[a-f0-9]{64}$/.test(txid)))throw new SaleError('invalid_node_response',503)
  if(!mempool.includes(artifact.txid)){
    const current=(await db.query(`SELECT w.*,a.frozen FROM agnt_sale_withdrawals w
      JOIN agnt_sale_accounts a ON a.user_id=w.user_id WHERE w.id=$1 AND w.user_id=$2`,[id,userId])).rows[0]
    if(!current||current.frozen||current.state!=='SIGNED'||current.signer_reference!==intent.reference||
      current.txid!==artifact.txid||String(current.actual_fee)!==artifact.actualFeeZatoshi||current.destination!==intent.destination||
      String(current.amount)!==intent.amountZatoshi||String(current.fee_limit)!==intent.feeLimitZatoshi)
      throw new SaleError('withdrawal_broadcast_requires_review',409)
    // A timeout leaves SIGNED intact. Never release its hold or create a replacement.
    const sent=await node('sendrawtransaction',[artifact.rawHex])
    if(sent!==artifact.txid)throw new SaleError('withdrawal_broadcast_unknown',503)
  }
  await new SaleService(db).recordWithdrawalBroadcast(userId,id,artifact.txid)
  return {txid:artifact.txid,state:'BROADCAST'}
}

export async function settleConfirmedWithdrawal(db:Pool,artifacts:SignerArtifacts,node:ZcashRpc,policy:ChainPolicy,userId:string,id:string,
  candidateBlockHash:string,requiredConfirmations:number,nowSeconds?:number){
  if(!Number.isSafeInteger(requiredConfirmations)||requiredConfirmations<1)throw new SaleError('invalid_confirmations')
  const row=(await db.query('SELECT * FROM agnt_sale_withdrawals WHERE id=$1 AND user_id=$2',[id,userId])).rows[0]
  if(!row)throw new SaleError('withdrawal_not_found',404)
  if(!row.txid||!['SIGNED','BROADCAST','PAID'].includes(row.state))throw new SaleError('invalid_withdrawal_state',409)
  const artifact=row.signer_reference?await artifacts.load(row.signer_reference):null
  if(!artifact||artifact.network!==policy.network||artifact.txid!==row.txid||artifact.actualFeeZatoshi!==String(row.actual_fee))throw new SaleError('withdrawal_artifact_mismatch',409)
  // The block hash is merely a lookup hint. Node membership/canonical checks,
  // not the caller's assertion, establish the confirmation evidence.
  const proof=await canonicalTransactionEvidence(node,policy,row.txid,candidateBlockHash,nowSeconds)
  return new SaleService(db).settleWithdrawal(userId,id,{txid:row.txid,canonical:true,confirmations:proof.tipHeight-proof.blockHeight+1,blockHash:proof.blockHash,blockHeight:proof.blockHeight,
    expectedPayment:{signerReference:row.signer_reference,destination:row.destination,amountZatoshi:String(row.amount),feeLimitZatoshi:String(row.fee_limit),actualFeeZatoshi:String(row.actual_fee)}},requiredConfirmations)
}

export async function reviewPaidWithdrawal(db:Pool,artifacts:SignerArtifacts,node:ZcashRpc,policy:ChainPolicy,userId:string,id:string,nowSeconds?:number){
  const row=(await db.query('SELECT * FROM agnt_sale_withdrawals WHERE id=$1 AND user_id=$2',[id,userId])).rows[0]
  if(!row||row.state!=='PAID'||!row.settlement_block_hash)throw new SaleError('withdrawal_settlement_evidence_missing',409)
  const artifact=row.signer_reference?await artifacts.load(row.signer_reference):null
  if(!artifact||artifact.network!==policy.network||artifact.txid!==row.txid||artifact.actualFeeZatoshi!==String(row.actual_fee))throw new SaleError('withdrawal_artifact_mismatch',409)
  try{
    await canonicalTransactionEvidence(node,policy,row.txid,row.settlement_block_hash,nowSeconds,row.settlement_block_height??undefined)
    // A reappearing payment does not clear an earlier operator-review decision.
    return {reviewRequired:row.settlement_review===true}
  }catch(error){
    if(!(error instanceof SaleError)||error.code!=='observer_orphaned_block')throw error
    return new SaleService(db).flagPaidWithdrawalReorg(userId,id,row.settlement_block_hash)
  }
}
