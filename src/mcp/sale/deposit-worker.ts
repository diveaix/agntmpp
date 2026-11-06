import type { Pool } from 'pg'
import { DepositAssignments } from './deposit-assignments.js'
import { SaleService } from './service.js'
import { SaleError } from './pricing.js'
import { canonicalTransactionEvidence, verifyZalletDeposit, type ChainPolicy, type ZcashRpc } from './zcash-observer.js'

// Internal observer entry point, NOT an HTTP handler. Candidate discovery and
// durable scanning/reorg replay must supply txids; RPC failures never mean orphaned.
export async function observeAssignedDeposit(db:Pool,wallet:ZcashRpc,node:ZcashRpc,policy:ChainPolicy,
  userId:string,txid:string,requiredConfirmations:number,nowSeconds?:number){
  if(!Number.isSafeInteger(requiredConfirmations)||requiredConfirmations<1)throw new SaleError('invalid_confirmations')
  const assignment=await new DepositAssignments(db).load(userId,policy.network)
  if(!assignment)throw new SaleError('deposit_assignment_missing',409)
  // Verify the entire response before any accounting writes. Ownership comes
  // from our immutable assignment, not an incoming wallet notification payload.
  const receipts=await verifyZalletDeposit(wallet,node,policy,assignment,txid,nowSeconds)
  const service=new SaleService(db)
  const results=[]
  for(const receipt of receipts)results.push(await service.observe(userId,receipt,requiredConfirmations))
  // A partial database failure is replayable: each output has a unique receipt ID.
  return {receipts:receipts.length,states:results.map(result=>result.state)}
}

// Recheck one known transaction, including after it disappears from the wallet's
// mined view. Use stored output identities/amounts; never fabricate a new receipt.
export async function reviewAssignedDeposit(db:Pool,node:ZcashRpc,policy:ChainPolicy,userId:string,txid:string,requiredConfirmations:number,nowSeconds?:number){
  if(!Number.isSafeInteger(requiredConfirmations)||requiredConfirmations<1||!/^[a-f0-9]{64}$/.test(txid))throw new SaleError('invalid_deposit_review')
  if(!await new DepositAssignments(db).load(userId,policy.network))throw new SaleError('deposit_assignment_missing',409)
  const rows=(await db.query(`SELECT receipt_id,txid,amount::text,block_hash,block_height FROM agnt_sale_deposits
    WHERE user_id=$1 AND txid=$2 AND receipt_id LIKE $3 AND block_hash IS NOT NULL`,[userId,txid,`${policy.network}:%`])).rows
  const proofs=new Map<string,{canonical:boolean;confirmations:number}>()
  // Verify every referenced block before changing accounting. An unavailable or
  // stale node aborts review and leaves credit/freeze state untouched.
  for(const row of rows){
    if(proofs.has(row.block_hash))continue
    try{
      const evidence=await canonicalTransactionEvidence(node,policy,txid,row.block_hash,nowSeconds,row.block_height??undefined)
      proofs.set(row.block_hash,{canonical:true,confirmations:evidence.tipHeight-evidence.blockHeight+1})
    }catch(error){
      if(!(error instanceof SaleError)||error.code!=='observer_orphaned_block')throw error
      proofs.set(row.block_hash,{canonical:false,confirmations:0})
    }
  }
  const service=new SaleService(db)
  for(const row of rows){
    const proof=proofs.get(row.block_hash)!
    await service.observe(userId,{receiptId:row.receipt_id,txid:row.txid,amountZatoshi:row.amount,blockHash:row.block_hash,...proof},requiredConfirmations)
  }
  return {reviewed:rows.length,orphaned:rows.filter(row=>!proofs.get(row.block_hash)!.canonical).length}
}
