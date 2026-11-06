import type { Pool } from 'pg'
import { transaction } from './database.js'
import { CURVE_VERSION, SCHEDULE_HASH, SaleError } from './pricing.js'

// Aggregate operational signals only. This neither reconciles nor changes
// financial state, and cannot establish wallet solvency or launch readiness.
export async function saleOperationsStatus(db:Pool){
  return transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const sale=(await c.query('SELECT state,sold,curve_version,schedule_hash FROM agnt_sale WHERE id=1')).rows[0]
    if(!sale||sale.curve_version!==CURVE_VERSION||sale.schedule_hash!==SCHEDULE_HASH)throw new SaleError('sale_not_initialized',503)
    const accounts=(await c.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE frozen)::int AS frozen FROM agnt_sale_accounts')).rows[0]
    const liabilities=(await c.query(`SELECT COALESCE(sum(available),0)::text AS available,
      COALESCE(sum(held),0)::text AS held,COALESCE(sum(available::numeric+held),0)::text AS total
      FROM agnt_sale_accounts`)).rows[0]
    const unsettledReserves=(await c.query(`SELECT state,count(*)::int AS count,
      sum(amount)::text AS principal,sum(fee_limit)::text AS fee_reserve,
      sum(amount::numeric+fee_limit)::text AS total
      FROM agnt_sale_withdrawals WHERE state NOT IN ('PAID','CANCELED') GROUP BY state ORDER BY state`)).rows
    const limits=(await c.query('SELECT max_payout::text,max_outstanding::text FROM agnt_treasury_limits WHERE id=1')).rows[0]
    const outstanding=unsettledReserves.filter(row=>row.state!=='HELD').reduce((sum,row)=>sum+BigInt(row.total),0n)
    const oversized=limits?Number((await c.query(`SELECT count(*)::int AS count FROM agnt_sale_withdrawals
      WHERE state IN ('APPROVED','SIGNED','BROADCAST','REVIEW') AND amount::numeric+fee_limit>$1::numeric`,[limits.max_payout])).rows[0].count):null
    const overLimit=limits?outstanding>BigInt(limits.max_outstanding):null
    const remaining=limits?BigInt(limits.max_outstanding)-outstanding:null
    // Compare per owner: offsetting account errors must not cancel in an aggregate.
    const holdMismatches=Number((await c.query(`SELECT count(*)::int AS count FROM agnt_sale_accounts a
      LEFT JOIN (SELECT user_id,sum(amount::numeric+fee_limit) AS expected FROM agnt_sale_withdrawals
        WHERE state NOT IN ('PAID','CANCELED') GROUP BY user_id) w ON w.user_id=a.user_id
      WHERE a.held<>COALESCE(w.expected,0)`)).rows[0].count)
    const deposits=(await c.query("SELECT count(*) FILTER(WHERE state='CONFIRMING')::int AS confirming,count(*) FILTER(WHERE state='ORPHANED' AND credited)::int AS orphaned_credit FROM agnt_sale_deposits")).rows[0]
    const withdrawals=(await c.query('SELECT state,count(*)::int AS count FROM agnt_sale_withdrawals GROUP BY state ORDER BY state')).rows
    const creditReview=(await c.query("SELECT count(*)::int AS receipts,COALESCE(sum(credited_amount),0)::text AS total_credited_under_review,COALESCE(sum(credited_amount) FILTER(WHERE coverage_state<>'RESTORED'),0)::text AS insufficiently_confirmed_credit FROM agnt_sale_credit_reviews")).rows[0]
    const missingCreditReviews=Number((await c.query("SELECT count(*)::int AS count FROM agnt_sale_deposits d LEFT JOIN agnt_sale_credit_reviews r ON r.receipt_id=d.receipt_id WHERE d.credited AND d.state='ORPHANED' AND r.receipt_id IS NULL")).rows[0].count)
    const payoutReview=Number((await c.query('SELECT count(*)::int AS count FROM agnt_sale_withdrawals WHERE settlement_review')).rows[0].count)
    const oldestUnsettledSeconds=(await c.query("SELECT EXTRACT(EPOCH FROM now()-min(created_at))::bigint::text AS age FROM agnt_sale_withdrawals WHERE state NOT IN ('PAID','CANCELED')")).rows[0].age
    const notifications=(await c.query('SELECT state,count(*)::int AS count FROM agnt_sale_outbox GROUP BY state ORDER BY state')).rows
    const receiptSigning=(await c.query(`SELECT count(*) FILTER(WHERE s.purchase_id IS NULL)::int AS unsigned_purchases,
      count(*) FILTER(WHERE s.purchase_id IS NOT NULL)::int AS stored_signatures,
      EXTRACT(EPOCH FROM now()-min(p.created_at) FILTER(WHERE s.purchase_id IS NULL))::bigint::text AS oldest_unsigned_seconds
      FROM agnt_sale_purchases p LEFT JOIN agnt_sale_signed_receipts s ON s.purchase_id=p.id`)).rows[0]
    const due=(await c.query("SELECT count(*)::int AS count,EXTRACT(EPOCH FROM now()-min(next_retry_at))::bigint::text AS oldest_age FROM agnt_sale_outbox WHERE state IN ('PENDING','RETRY') AND next_retry_at<=now()")).rows[0]
    const issues:string[]=[]
    if(accounts.frozen)issues.push('frozen_accounts')
    if(holdMismatches)issues.push('withdrawal_hold_mismatch')
    if(!limits&&outstanding>0n)issues.push('treasury_limits_unconfigured')
    if(overLimit||oversized)issues.push('treasury_authorization_limit_exceeded')
    if(deposits.orphaned_credit)issues.push('orphaned_credited_deposits')
    if(missingCreditReviews)issues.push('credited_review_missing')
    if(creditReview.receipts)issues.push('credited_value_review_required')
    if(payoutReview||withdrawals.some(row=>row.state==='REVIEW'&&row.count>0))issues.push('withdrawal_review_required')
    if(notifications.some(row=>row.state==='FAILED'&&row.count>0))issues.push('notification_delivery_failed')
    return {observedAt:(await c.query('SELECT transaction_timestamp() AS at')).rows[0].at,
      sale:{state:sale.state,sold:sale.sold},accounts,deposits,creditReview,missingCreditReviews,reviewAmountUnit:'zatoshi',withdrawals,payoutReview,oldestUnsettledSeconds,
      customerLiabilities:{...liabilities,unit:'zatoshi',unsettledReserves,holdMismatches,
        walletCoverageVerified:false},
      treasuryLimits:{configured:Boolean(limits),maxPayoutZatoshi:limits?.max_payout??null,maxOutstandingZatoshi:limits?.max_outstanding??null,
        outstandingZatoshi:String(outstanding),remainingAuthorizationZatoshi:remaining===null?null:String(remaining>0n?remaining:0n),
        overOutstandingLimit:overLimit,oversizedPayouts:oversized,notWalletLiquidity:true},
      notifications,notificationsDue:due.count,oldestNotificationDelaySeconds:due.oldest_age,
      receiptSigning:{...receiptSigning,signaturesVerified:false,livenessVerified:false},
      requiresReview:issues.length>0,issues,productionReady:false,treasurySolvencyVerified:false,
      observerLivenessVerified:false,signerLivenessVerified:false}
  },db)
}
