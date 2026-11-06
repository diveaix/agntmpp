import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { reviewAssignedDeposit } from './deposit-worker.js'
import { canonicalTransactionEvidence, type ChainPolicy, type ZcashRpc } from './zcash-observer.js'
import { SaleError } from './pricing.js'
import { transaction } from './database.js'

// Rewind/replay never constitutes clearance to reopen a sale or unfreeze credit.
// Missing node history and changing chain snapshots require operator review.
export async function recoverDepositCursor(db:Pool,node:ZcashRpc,policy:ChainPolicy,userId:string,requiredConfirmations:number,nowSeconds?:number){
  if(!Number.isSafeInteger(requiredConfirmations)||requiredConfirmations<1)throw new SaleError('invalid_confirmations')
  const cursor=(await db.query('SELECT * FROM agnt_deposit_scan_cursors WHERE user_id=$1 AND network=$2',[userId,policy.network])).rows[0]
  if(!cursor?.previous_hash)return {rewound:false}
  if(cursor.genesis_hash!==policy.genesisHash)throw new SaleError('observer_network_mismatch',503)
  const tip=await node('getblockchaininfo') as any
  const block=await node('getblock',[tip?.bestblockhash,1]) as any
  await canonicalTransactionEvidence(node,policy,block?.tx?.[0],tip?.bestblockhash,nowSeconds)
  const canonical=await node('getblockhash',[cursor.next_height-1])
  if(typeof canonical!=='string'||!/^[a-f0-9]{64}$/.test(canonical))throw new SaleError('invalid_node_response',503)
  if(canonical===cursor.previous_hash)return {rewound:false}
  const paused=await db.query("UPDATE agnt_sale SET state='PAUSED' WHERE id=1 RETURNING id")
  if(!paused.rows.length)throw new SaleError('sale_not_initialized',503)
  const transactions=(await db.query(`SELECT DISTINCT txid FROM agnt_sale_deposits
    WHERE user_id=$1 AND receipt_id LIKE $2`,[userId,`${policy.network}:%`])).rows
  for(const row of transactions)await reviewAssignedDeposit(db,node,policy,userId,row.txid,requiredConfirmations,nowSeconds)
  const after=await node('getblockchaininfo') as any
  if(after?.bestblockhash!==tip.bestblockhash||after?.blocks!==tip.blocks||await node('getblockhash',[cursor.next_height-1])!==canonical)throw new SaleError('observer_tip_changed',503)
  return transaction(async client=>{
    const updated=await client.query(`UPDATE agnt_deposit_scan_cursors SET next_height=start_height,previous_hash=NULL
      WHERE user_id=$1 AND network=$2 AND next_height=$3 AND previous_hash=$4 RETURNING next_height`,[userId,policy.network,cursor.next_height,cursor.previous_hash])
    if(!updated.rows.length)throw new SaleError('scanner_checkpoint_changed',409)
    await client.query(`INSERT INTO agnt_sale_events(id,kind,user_id,reference) VALUES($1,'SCAN_REWIND',$2,$3)
      ON CONFLICT(kind,reference) DO NOTHING`,[randomUUID(),userId,`${policy.network}:${userId}:${cursor.previous_hash}`])
    return {rewound:true,nextHeight:updated.rows[0].next_height,reviewedTransactions:transactions.length}
  },db)
}
