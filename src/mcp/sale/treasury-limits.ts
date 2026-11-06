import type { Pool, PoolClient } from 'pg'
import { SaleError } from './pricing.js'

// No defaults: provisioning requires approved treasury risk values. These are
// authorization-exposure caps, not a statement of wallet assets or solvency.
export async function enforceTreasuryLimits(db:Pool|PoolClient,payment:{amount:string;fee_limit:string},newApproval:boolean){
  // The transition caller must retain this row lock until approval commits.
  // Different customer account locks alone cannot protect a treasury-wide cap.
  const limits=(await db.query(`SELECT max_payout,max_outstanding FROM agnt_treasury_limits WHERE id=1${newApproval?' FOR UPDATE':''}`)).rows[0]
  if(!limits)throw new SaleError('treasury_limits_unconfigured',503)
  const payout=BigInt(payment.amount)+BigInt(payment.fee_limit)
  if(payout>BigInt(limits.max_payout))throw new SaleError('treasury_payout_limit_exceeded',409)
  // Keep unknown/ambiguous signing and review exposure reserved indefinitely.
  // HELD requests are not yet authorized; PAID settlement has consumed the funds.
  const outstanding=BigInt((await db.query(`SELECT COALESCE(sum(amount::numeric+fee_limit),0)::text AS total
    FROM agnt_sale_withdrawals WHERE state IN ('APPROVED','SIGNED','BROADCAST','REVIEW')`)).rows[0].total)
  if(outstanding+(newApproval?payout:0n)>BigInt(limits.max_outstanding))throw new SaleError('treasury_outstanding_limit_exceeded',409)
}
