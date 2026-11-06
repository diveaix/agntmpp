import { SaleError, zatoshi } from './pricing.js'
import type { Receipt } from './service.js'

// Format reviewed at zcash/zallet commit f9dcd4d31439feb813c95ac2516814421f5b04df,
// zallet-core/src/components/json_rpc/methods/view_transaction.rs.
// Pure normalization, NOT an RPC client or cryptographic chain verifier.
export interface DepositAssignment {
  userId:string
  network:'mainnet'|'testnet'|'regtest'
  walletAccountUuid:string
  // Exact encodings returned for this receiver by the pinned wallet implementation.
  // A full multi-receiver UA must not be assumed equal to its individual receivers.
  recipientAddresses:string[]
}
export interface CanonicalBlockEvidence {
  network:DepositAssignment['network']
  tipHeight:number
  blockHeight:number
  blockHash:string
  transactionIds:string[]
}
const isHash=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value)
function object(value:unknown):Record<string,unknown>{
  if(!value || typeof value!=='object' || Array.isArray(value))throw new SaleError('invalid_wallet_response',503)
  return value as Record<string,unknown>
}

// Evidence must come from a synchronized, trusted node's current canonical block,
// never a browser-provided block/confirmation count. The caller must reject stale scans.
export function extractConfirmedZalletReceipts(raw:unknown, assignment:DepositAssignment, evidence:CanonicalBlockEvidence):Receipt[]{
  if(evidence.network!==assignment.network)throw new SaleError('deposit_network_mismatch',503)
  if(!assignment.userId || !assignment.walletAccountUuid || !assignment.recipientAddresses.length || assignment.recipientAddresses.some(a=>typeof a!=='string'||!a))throw new SaleError('invalid_deposit_assignment',503)
  const tx=object(raw)
  if(!isHash(tx.txid)||!isHash(tx.blockhash)||!isHash(evidence.blockHash)||tx.status!=='mined')throw new SaleError('deposit_not_mined',503)
  if(!Number.isSafeInteger(evidence.tipHeight)||!Number.isSafeInteger(evidence.blockHeight)||evidence.blockHeight<0||evidence.tipHeight<evidence.blockHeight)throw new SaleError('invalid_chain_evidence',503)
  const confirmations=evidence.tipHeight-evidence.blockHeight+1
  if(!Number.isSafeInteger(confirmations)||tx.blockhash!==evidence.blockHash||!evidence.transactionIds.includes(tx.txid)||tx.confirmations!==confirmations)throw new SaleError('deposit_chain_evidence_mismatch',503)
  if(!Array.isArray(tx.outputs)||!Array.isArray(tx.spends))throw new SaleError('invalid_wallet_response',503)
  // Treasury self-payments must not mint another customer liability.
  if(tx.generated===true || tx.spends.some(spend=>typeof object(spend).account_uuid==='string'))throw new SaleError('treasury_or_coinbase_deposit_rejected',503)
  const receipts:Receipt[]=[]
  const identities=new Set<string>()
  for(const rawOutput of tx.outputs){
    const output=object(rawOutput)
    if(output.walletInternal!==false || output.outgoing!==false)continue
    if(output.account_uuid!==assignment.walletAccountUuid || typeof output.address!=='string' || !assignment.recipientAddresses.includes(output.address))continue
    let index:unknown
    if(output.pool==='transparent')index=output.tOut
    else if(output.pool==='sapling')index=output.output
    else if(output.pool==='orchard'||output.pool==='ironwood')index=output.action
    else throw new SaleError('unsupported_deposit_pool',503)
    if(!Number.isSafeInteger(index)||(index as number)<0||(index as number)>65535)throw new SaleError('invalid_output_identity',503)
    if(typeof output.valueZat!=='number'||!Number.isSafeInteger(output.valueZat)||output.valueZat<0)throw new SaleError('invalid_output_amount',503)
    const amount=zatoshi(String(output.valueZat))
    if(amount===0n)continue
    const receiptId=`${assignment.network}:${tx.txid}:${output.pool}:${index}`
    if(identities.has(receiptId))throw new SaleError('duplicate_wallet_output',503)
    identities.add(receiptId)
    receipts.push({receiptId,txid:tx.txid,amountZatoshi:String(amount),canonical:true,confirmations,blockHash:evidence.blockHash,blockHeight:evidence.blockHeight})
  }
  return receipts
}
