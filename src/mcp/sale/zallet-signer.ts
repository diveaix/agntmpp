import { SaleError, zatoshi } from './pricing.js'
import { canonicalTransactionEvidence, type ChainPolicy, type ZcashRpc } from './zcash-observer.js'
import type { WithdrawalIntent } from './withdrawal-worker.js'

export function zecJsonAmount(value:string):unknown {
  const amount=zatoshi(value)
  const decimal=`${amount/100000000n}.${String(amount%100000000n).padStart(8,'0')}`
  const raw=(JSON as unknown as {rawJSON?:(value:string)=>unknown}).rawJSON
  if(!raw)throw new SaleError('exact_json_numbers_unavailable',503)
  return raw(decimal)
}
function object(value:unknown):Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new SaleError('invalid_signer_response',503)
  return value as Record<string,any>
}
function inspectIntent(raw:unknown,intent:Readonly<WithdrawalIntent>){
  const result=object(raw)
  if(result.wallet_created!==true||result.privacy_policy!=='FullPrivacy'||
    !Array.isArray(result.transparent?.inputs)||result.transparent.inputs.length||
    !Array.isArray(result.transparent?.outputs)||result.transparent.outputs.length)throw new SaleError('withdrawal_privacy_mismatch',503)
  if(!Number.isSafeInteger(result.fee_zat)||result.fee_zat<0||BigInt(result.fee_zat)>zatoshi(intent.feeLimitZatoshi))throw new SaleError('withdrawal_fee_exceeded',409)
  const bundles=['sapling','orchard','ironwood'].map(pool=>object(result[pool]))
  if(bundles.some(bundle=>!Array.isArray(bundle.outputs)))throw new SaleError('invalid_signer_response',503)
  const outputs=bundles.flatMap(bundle=>bundle.outputs).map(object)
  const recipient=outputs.filter(output=>output.user_address===intent.destination)
  if(recipient.length!==1||!Number.isSafeInteger(recipient[0].value_zat)||BigInt(recipient[0].value_zat)!==zatoshi(intent.amountZatoshi)||
    outputs.some(output=>output.user_address!==undefined&&output.user_address!==null&&output.user_address!==intent.destination))throw new SaleError('withdrawal_recipient_mismatch',503)
  // Inspection metadata is not an independent proof of change ownership. This
  // adapter accepts ONLY PCZTs it just created in the trusted treasury wallet.
  const commitment=JSON.stringify({version:result.tx_version,branch:result.consensus_branch_id,expiry:result.expiry_height,
    fee:result.fee_zat,bundles:bundles.map(bundle=>({outputs:bundle.outputs,valueBalance:bundle.value_balance_zat}))})
  return {fee:String(result.fee_zat),commitment}
}

// Run only behind a committed signOnce intent, in the isolated signer process.
// No broadcast occurs. JSON transports MUST preserve JSON.rawJSON amount values.
export async function signZalletWithdrawal(wallet:ZcashRpc,node:ZcashRpc,policy:ChainPolicy,
  intent:Readonly<WithdrawalIntent>,nowSeconds?:number){
  if(intent.network!==policy.network||zatoshi(intent.amountZatoshi)===0n)throw new SaleError('invalid_withdrawal_intent',503)
  const tip=object(await node('getblockchaininfo'))
  const block=object(await node('getblock',[tip.bestblockhash,1]))
  if(!Array.isArray(block.tx)||!block.tx.length)throw new SaleError('invalid_signer_response',503)
  const evidence=await canonicalTransactionEvidence(node,policy,block.tx[0],tip.bestblockhash,nowSeconds)
  const status=object(await wallet('getwalletstatus'))
  if(status.fully_synced_height!==evidence.tipHeight||status.wallet_tip?.blockhash!==tip.bestblockhash||status.node_tip?.blockhash!==tip.bestblockhash)throw new SaleError('observer_wallet_not_synced',503)
  const created=object(await wallet('pczt_create',[intent.walletAccountUuid,[{address:intent.destination,amount:zecJsonAmount(intent.amountZatoshi)}],1,'FullPrivacy']))
  if(typeof created.pczt!=='string'||!created.pczt)throw new SaleError('invalid_signer_response',503)
  const before=inspectIntent(await wallet('pczt_inspect',[created.pczt]),intent)
  const proven=object(await wallet('pczt_prove',[created.pczt]))
  if(typeof proven.pczt!=='string'||!proven.pczt)throw new SaleError('invalid_signer_response',503)
  const after=inspectIntent(await wallet('pczt_inspect',[proven.pczt]),intent)
  if(before.commitment!==after.commitment)throw new SaleError('withdrawal_proposal_changed',503)
  const signed=object(await wallet('pczt_sign',[proven.pczt,'FullPrivacy',true]))
  if(typeof signed.pczt!=='string'||!signed.pczt||['transparent','sapling','orchard','ironwood'].some(pool=>!Array.isArray(signed[`unsigned_${pool}`])||signed[`unsigned_${pool}`].length))throw new SaleError('withdrawal_signature_incomplete',503)
  const extracted=object(await wallet('pczt_extract',[signed.pczt]))
  if(extracted.stored!==true||typeof extracted.txid!=='string'||!/^[a-f0-9]{64}$/.test(extracted.txid)||
    typeof extracted.hex!=='string'||!/^(?:[a-f0-9]{2})+$/.test(extracted.hex))throw new SaleError('invalid_signed_transaction',503)
  // Zebra does not expose this RPC; use Zallet's decoder. This is a consistency
  // check within the trusted wallet, not independent consensus verification.
  const decoded=object(await wallet('decoderawtransaction',[extracted.hex]))
  if(decoded.txid!==extracted.txid)throw new SaleError('signed_transaction_id_mismatch',503)
  return {txid:extracted.txid as string,rawHex:extracted.hex as string,actualFeeZatoshi:after.fee}
}
