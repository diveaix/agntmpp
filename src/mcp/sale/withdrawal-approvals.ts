import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './database.js'
import { SaleError } from './pricing.js'

export interface ApprovalPayment {
  id:string;user_id:string;destination:string;amount:string;fee_limit:string
}
export function withdrawalApprovalHash(payment:ApprovalPayment){
  return createHash('sha256').update(JSON.stringify({policy:'two-person-withdrawal-v1',
    id:payment.id,userId:payment.user_id,destination:payment.destination,
    amountZatoshi:String(payment.amount),feeLimitZatoshi:String(payment.fee_limit)})).digest('hex')
}

// Call only with a server-authenticated actor, never an actor ID from a request
// body. Operator provisioning is separate; migration grants no one authority.
// This records evidence only. It neither approves nor signs a withdrawal.
export async function recordWithdrawalApproval(db:Pool,actorId:string,withdrawalId:string,reason:string,expectedPayloadHash?:string){
  if(typeof actorId!=='string'||!actorId||actorId.length>200||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(withdrawalId)||
    typeof reason!=='string'||!reason.trim()||reason.length>1000||
    (expectedPayloadHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedPayloadHash)))throw new SaleError('invalid_withdrawal_approval')
  return transaction(async c=>{
    const owner=(await c.query('SELECT user_id FROM agnt_sale_withdrawals WHERE id=$1',[withdrawalId])).rows[0]
    if(!owner)throw new SaleError('withdrawal_not_found',404)
    const account=(await c.query('SELECT frozen FROM agnt_sale_accounts WHERE user_id=$1 FOR UPDATE',[owner.user_id])).rows[0]
    const row=(await c.query('SELECT * FROM agnt_sale_withdrawals WHERE id=$1 FOR UPDATE',[withdrawalId])).rows[0]
    if(!account||account.frozen)throw new SaleError('account_frozen',409)
    if(row.user_id!==owner.user_id||!['HELD','APPROVED','SIGNED','BROADCAST','PAID'].includes(row.state))throw new SaleError('withdrawal_not_awaiting_approval',409)
    const operator=(await c.query('SELECT enabled,authorization_version FROM agnt_treasury_operators WHERE actor_id=$1 FOR SHARE',[actorId])).rows[0]
    if(!operator?.enabled)throw new SaleError('treasury_operator_required',403)
    if(actorId===row.user_id)throw new SaleError('withdrawal_self_approval_forbidden',403)
    const payloadHash=withdrawalApprovalHash(row)
    if(expectedPayloadHash!==undefined&&expectedPayloadHash!==payloadHash)throw new SaleError('withdrawal_approval_preview_changed',409)
    const previous=(await c.query('SELECT * FROM agnt_withdrawal_approval_votes WHERE withdrawal_id=$1 AND actor_id=$2',[withdrawalId,actorId])).rows[0]
    if(!previous&&row.state!=='HELD')throw new SaleError('withdrawal_not_awaiting_approval',409)
    if(previous){
      if(previous.payload_hash!==payloadHash||previous.authorization_version!==operator.authorization_version||previous.reason!==reason.trim())
        throw new SaleError('withdrawal_approval_conflict',409)
    }else await c.query(`INSERT INTO agnt_withdrawal_approval_votes(withdrawal_id,actor_id,authorization_version,payload_hash,reason)
      VALUES($1,$2,$3,$4,$5)`,[withdrawalId,actorId,operator.authorization_version,payloadHash,reason.trim()])
    return {withdrawalId,payloadHash,validApprovals:await validWithdrawalApprovals(c,row),state:row.state as string}
  },db)
}

// The eventual state transition must use this inside its locked transaction.
export async function validWithdrawalApprovals(c:PoolClient|Pool,payment:ApprovalPayment):Promise<number>{
  const rows=(await c.query(`SELECT v.actor_id FROM agnt_withdrawal_approval_votes v
    JOIN agnt_treasury_operators o ON o.actor_id=v.actor_id AND o.enabled AND o.authorization_version=v.authorization_version
    WHERE v.withdrawal_id=$1 AND v.payload_hash=$2 AND v.actor_id<>$3 FOR SHARE OF o`,
  [payment.id,withdrawalApprovalHash(payment),payment.user_id])).rows
  return rows.length
}
