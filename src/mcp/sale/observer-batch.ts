import type { Pool } from 'pg'
import type { ChainPolicy, ZcashRpc } from './zcash-observer.js'
import { scanAssignedBlock } from './deposit-scanner.js'
import { recoverDepositCursor } from './deposit-recovery.js'
import { SaleError } from './pricing.js'

// Shared by the operator CLI and integration tests. No scheduling or credentials
// are created here; one invocation handles at most ten persisted assignments.
export async function runObserverBatch(db:Pool,wallet:ZcashRpc,node:ZcashRpc,policy:ChainPolicy,startHeight:number,confirmations:number){
  if(!Number.isSafeInteger(startHeight)||startHeight<0||startHeight>2147483646||
    !Number.isSafeInteger(confirmations)||confirmations<1)throw new SaleError('observer_configuration_invalid',503)
  const accounts=(await db.query(`SELECT a.user_id FROM agnt_deposit_assignments a
    LEFT JOIN agnt_deposit_scan_cursors c ON c.user_id=a.user_id AND c.network=a.network
    WHERE a.network=$1 AND a.address IS NOT NULL
    ORDER BY COALESCE(c.next_height,$2),a.user_id LIMIT 10`,[policy.network,startHeight])).rows
  let advanced=0
  for(const account of accounts){
    try{
      const result=await scanAssignedBlock(db,wallet,node,policy,account.user_id,startHeight,confirmations)
      if(result.state==='advanced')advanced++
    }catch(error){
      if(error instanceof SaleError&&error.code==='scanner_reorg_review_required'){
        await db.query("UPDATE agnt_sale SET state='PAUSED' WHERE id=1")
        await recoverDepositCursor(db,node,policy,account.user_id,confirmations)
        throw new SaleError('observer_rewound_operator_review_required',503)
      }
      throw error
    }
  }
  return {checked:accounts.length,advanced}
}
