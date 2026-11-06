import type { Pool } from 'pg'
import { DepositAssignments } from './deposit-assignments.js'
import { observeAssignedDeposit, reviewAssignedDeposit } from './deposit-worker.js'
import { canonicalTransactionEvidence, ZcashRpcError, type ChainPolicy, type ZcashRpc } from './zcash-observer.js'
import { SaleError } from './pricing.js'

const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new SaleError('invalid_scanner_response',503)
  return value as Record<string,unknown>
}

// One bounded worker step. startHeight is an operator-verified account birthday,
// never a browser parameter. Call repeatedly from the eventual scheduled worker.
export async function scanAssignedBlock(db:Pool,wallet:ZcashRpc,node:ZcashRpc,policy:ChainPolicy,
  userId:string,startHeight:number,requiredConfirmations:number,nowSeconds?:number){
  if(!Number.isSafeInteger(startHeight)||startHeight<0||startHeight>2147483646||
    !Number.isSafeInteger(requiredConfirmations)||requiredConfirmations<1)throw new SaleError('invalid_scanner_policy')
  const assignment=await new DepositAssignments(db).load(userId,policy.network)
  if(!assignment)throw new SaleError('deposit_assignment_missing',409)
  const walletAccounts=await wallet('z_listaccounts')
  if(!Array.isArray(walletAccounts)||!walletAccounts.some(raw=>object(raw).account_uuid===assignment.walletAccountUuid))throw new SaleError('observer_wallet_account_mismatch',503)
  if(!hash(policy.genesisHash)||await node('getblockhash',[0])!==policy.genesisHash)throw new SaleError('observer_network_mismatch',503)
  await db.query(`INSERT INTO agnt_deposit_scan_cursors(user_id,network,wallet_account_uuid,genesis_hash,start_height,next_height)
    VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING`,[userId,policy.network,assignment.walletAccountUuid,policy.genesisHash,startHeight])
  const cursor=(await db.query('SELECT * FROM agnt_deposit_scan_cursors WHERE user_id=$1 AND network=$2',[userId,policy.network])).rows[0]
  if(cursor.wallet_account_uuid!==assignment.walletAccountUuid||cursor.genesis_hash!==policy.genesisHash||cursor.start_height!==startHeight)throw new SaleError('scanner_configuration_changed',409)
  if(cursor.previous_hash){
    const checkpointHash=await node('getblockhash',[cursor.next_height-1])
    // An invalid provider response is not evidence of a chain reorganization.
    if(!hash(checkpointHash))throw new SaleError('invalid_scanner_response',503)
    if(checkpointHash!==cursor.previous_hash)throw new SaleError('scanner_reorg_review_required',503)
  }
  const tip=object(await node('getblockchaininfo'))
  if(!Number.isSafeInteger(tip.blocks)||!hash(tip.bestblockhash))throw new SaleError('invalid_scanner_response',503)
  if(cursor.next_height>(tip.blocks as number))return {state:'waiting' as const}
  const blockHash=await node('getblockhash',[cursor.next_height])
  if(!hash(blockHash))throw new SaleError('invalid_scanner_response',503)
  const block=object(await node('getblock',[blockHash,1]))
  if(!Array.isArray(block.tx)||!hash(block.tx[0]))throw new SaleError('invalid_scanner_response',503)
  const proof=await canonicalTransactionEvidence(node,policy,block.tx[0],blockHash,nowSeconds)
  if(proof.blockHeight!==cursor.next_height||proof.tipHeight!==tip.blocks)throw new SaleError('observer_tip_changed',503)
  const status=object(await wallet('getwalletstatus'))
  const walletTip=object(status.wallet_tip),walletNodeTip=object(status.node_tip)
  if(status.fully_synced_height!==tip.blocks||walletTip.height!==tip.blocks||walletTip.blockhash!==tip.bestblockhash||
    walletNodeTip.height!==tip.blocks||walletNodeTip.blockhash!==tip.bestblockhash)throw new SaleError('observer_wallet_not_synced',503)
  // An unconfirmed checkpoint is deliberately revisited. If its block was
  // replaced, clear the old confirming receipt only after independent proof;
  // an RPC failure must not turn an observed payment into an orphan assertion.
  const pending=(await db.query(`SELECT DISTINCT txid FROM agnt_sale_deposits
    WHERE user_id=$1 AND state='CONFIRMING' AND block_height=$2 AND block_hash<>$3
    AND receipt_id LIKE $4`,[userId,cursor.next_height,blockHash,`${policy.network}:%`])).rows
  for(const receipt of pending)await reviewAssignedDeposit(db,node,policy,userId,receipt.txid,requiredConfirmations,nowSeconds)
  // Enumerate the validated block, not z_listtransactions: beta.3's experimental
  // history RPC can fail an entire page when one memo is not valid UTF-8.
  if(proof.transactionIds.length>10000)throw new SaleError('scanner_block_limit_exceeded',503)
  const ids=new Set(proof.transactionIds)
  for(const txid of ids){
    try{
      const viewed=await wallet('z_viewtransaction',[txid])
      const cachedWallet:ZcashRpc=(method,params)=>method==='z_viewtransaction'&&params?.[0]===txid?Promise.resolve(viewed):wallet(method,params)
      await observeAssignedDeposit(db,cachedWallet,node,policy,userId,txid,requiredConfirmations,nowSeconds)
    }
    catch(error){
      // Pinned beta.3 emits this exact typed error for an unknown wallet tx.
      // Never interpret an RPC transport/database error as "not ours".
      if(error instanceof ZcashRpcError && error.method==='z_viewtransaction' && error.rpcCode===-5 && error.detail==='Invalid or non-wallet transaction id')continue
      // These transactions cannot create customer credit; malformed responses
      // and all other failures retain the checkpoint for investigation/retry.
      if(!(error instanceof SaleError)||error.code!=='treasury_or_coinbase_deposit_rejected')throw error
    }
  }
  const after=object(await node('getblockchaininfo'))
  if(after.blocks!==tip.blocks||after.bestblockhash!==tip.bestblockhash||await node('getblockhash',[cursor.next_height])!==blockHash)throw new SaleError('observer_tip_changed',503)
  const confirmations=proof.tipHeight-proof.blockHeight+1
  // Persist verified CONFIRMING receipts, but retain the checkpoint so they
  // are reverified and credited exactly once after the required depth arrives.
  if(confirmations<requiredConfirmations)return {state:'confirming' as const,height:cursor.next_height,confirmations,transactions:ids.size}
  const updated=await db.query(`UPDATE agnt_deposit_scan_cursors SET next_height=next_height+1,previous_hash=$3
    WHERE user_id=$1 AND network=$2 AND next_height=$4 RETURNING next_height`,[userId,policy.network,blockHash,cursor.next_height])
  return {state:updated.rows.length?'advanced' as const:'replayed' as const,height:cursor.next_height,transactions:ids.size}
}
