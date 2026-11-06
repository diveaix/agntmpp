import { SaleError } from './pricing.js'
import { extractConfirmedZalletReceipts, type CanonicalBlockEvidence, type DepositAssignment } from './zallet-receipts.js'

export type ZcashRpc = (method: string, params?: unknown[]) => Promise<unknown>
export class ZcashRpcError extends Error {
  constructor(readonly method:string,readonly rpcCode:number,readonly detail:string){
    super(`Zcash RPC ${method} failed (${rpcCode}): ${detail}`)
  }
}
export interface ChainPolicy {
  network: DepositAssignment['network']
  genesisHash: string
  maxTipAgeSeconds: number
}
const hash=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value)
function record(value:unknown):Record<string,unknown>{
  if(!value || typeof value!=='object' || Array.isArray(value))throw new SaleError('invalid_node_response',503)
  return value as Record<string,unknown>
}

// Trust boundary: RPC must address an operator-controlled, fully validating node.
// This checks node consistency, not an independent proof of consensus. A moving
// tip fails closed; the scanner can retry later without writing customer credit.
export async function canonicalTransactionEvidence(rpc:ZcashRpc,policy:ChainPolicy,txid:string,blockHash:string,
  nowSeconds=Math.floor(Date.now()/1000),knownBlockHeight?:number):Promise<CanonicalBlockEvidence>{
  if(!hash(policy.genesisHash)||!hash(txid)||!hash(blockHash)||!['mainnet','testnet','regtest'].includes(policy.network)||
    !Number.isSafeInteger(policy.maxTipAgeSeconds)||policy.maxTipAgeSeconds<1||!Number.isSafeInteger(nowSeconds)||
    (knownBlockHeight!==undefined&&(!Number.isSafeInteger(knownBlockHeight)||knownBlockHeight<0)))throw new SaleError('invalid_observer_policy',503)
  if(await rpc('getblockhash',[0])!==policy.genesisHash)throw new SaleError('observer_network_mismatch',503)
  const tip=record(await rpc('getblockchaininfo'))
  const expectedChain=policy.network==='mainnet'?'main':'test' // Zebra labels regtest as test; genesis distinguishes it.
  if(tip.chain!==expectedChain)throw new SaleError('observer_network_mismatch',503)
  if(!Number.isSafeInteger(tip.blocks)||(tip.blocks as number)<0||!hash(tip.bestblockhash)||tip.initialblockdownload===true)throw new SaleError('observer_node_not_ready',503)
  const tipBlock=record(await rpc('getblock',[tip.bestblockhash,1]))
  if(tipBlock.hash!==tip.bestblockhash||tipBlock.height!==tip.blocks||!Number.isSafeInteger(tipBlock.time)||
    (tipBlock.time as number)>nowSeconds+120 || nowSeconds-(tipBlock.time as number)>policy.maxTipAgeSeconds)throw new SaleError('observer_stale_tip',503)
  if(knownBlockHeight!==undefined){
    // Only use a height persisted from earlier verified membership, never a
    // client hint. Zebra may no longer serve an orphaned block by hash.
    if(knownBlockHeight>(tip.blocks as number))throw new SaleError('observer_node_not_ready',503)
    const current=await rpc('getblockhash',[knownBlockHeight])
    if(!hash(current))throw new SaleError('invalid_node_response',503)
    const stable=record(await rpc('getblockchaininfo'))
    if(stable.bestblockhash!==tip.bestblockhash||stable.blocks!==tip.blocks)throw new SaleError('observer_tip_changed',503)
    if(current!==blockHash)throw new SaleError('observer_orphaned_block',503)
  }
  const block=record(await rpc('getblock',[blockHash,1]))
  if(block.hash!==blockHash||!Number.isSafeInteger(block.height)||(knownBlockHeight!==undefined&&block.height!==knownBlockHeight)||(block.height as number)<0||(block.height as number)>(tip.blocks as number)||
    !Array.isArray(block.tx)||!block.tx.every(hash)||!block.tx.includes(txid))throw new SaleError('observer_transaction_not_in_block',503)
  const canonicalHash=await rpc('getblockhash',[block.height])
  if(!hash(canonicalHash))throw new SaleError('invalid_node_response',503)
  const after=record(await rpc('getblockchaininfo'))
  if(after.bestblockhash!==tip.bestblockhash||after.blocks!==tip.blocks)throw new SaleError('observer_tip_changed',503)
  if(canonicalHash!==blockHash)throw new SaleError('observer_orphaned_block',503)
  return {network:policy.network,tipHeight:tip.blocks as number,blockHeight:block.height as number,blockHash,transactionIds:block.tx as string[]}
}

export async function verifyZalletDeposit(wallet:ZcashRpc,node:ZcashRpc,policy:ChainPolicy,assignment:DepositAssignment,txid:string,nowSeconds?:number){
  if(policy.network!==assignment.network||!hash(txid))throw new SaleError('deposit_network_mismatch',503)
  const tx=record(await wallet('z_viewtransaction',[txid]))
  if(tx.txid!==txid||!hash(tx.blockhash))throw new SaleError('deposit_not_mined',503)
  const evidence=await canonicalTransactionEvidence(node,policy,txid,tx.blockhash,nowSeconds)
  const status=record(await wallet('getwalletstatus'))
  const walletTip=record(status.wallet_tip),nodeTip=record(status.node_tip)
  if(status.fully_synced_height!==evidence.tipHeight||walletTip.height!==evidence.tipHeight||nodeTip.height!==evidence.tipHeight||
    !hash(walletTip.blockhash)||walletTip.blockhash!==nodeTip.blockhash||await node('getblockhash',[evidence.tipHeight])!==walletTip.blockhash)throw new SaleError('observer_wallet_not_synced',503)
  return extractConfirmedZalletReceipts(tx,assignment,evidence)
}
