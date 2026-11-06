import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { saleOperationsStatus } from '../sale/operations-status.js'
import { CURVE_VERSION, SCHEDULE_HASH } from '../sale/pricing.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('operations CLI reports unavailable, not healthy zeros, without a database',async()=>{
  await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx/esm','scripts/sale-status.ts'],{
    env:{...process.env,AGNT_SALE_DATABASE_URL:''},timeout:15000,
  }),error=>{
    const result=error as Error&{stdout:string;stderr:string;code:number}
    assert.equal(result.code,1)
    assert.equal(result.stdout,'')
    assert.equal(result.stderr.trim(),'sale_operations_status_unavailable')
    return true
  })
})

test('operations report flags review states without modifying records or exposing identities',async()=>{
  const db=new PGlite(),queries:string[]=[]
  const query=async(sql:string,args?:unknown[])=>{queries.push(sql);return db.query(sql,args)}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await assert.rejects(saleOperationsStatus(pool),/sale_not_initialized/)
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    const empty=await saleOperationsStatus(pool)
    assert.equal(empty.requiresReview,false)
    assert.equal(empty.productionReady,false)
    assert.equal(empty.treasurySolvencyVerified,false)
    assert.deepEqual(empty.customerLiabilities,{available:'0',held:'0',total:'0',unit:'zatoshi',unsettledReserves:[],holdMismatches:0,walletCoverageVerified:false})
    assert.equal(empty.oldestUnsettledSeconds,null)
    assert.deepEqual(empty.receiptSigning,{unsigned_purchases:0,stored_signatures:0,oldest_unsigned_seconds:null,signaturesVerified:false,livenessVerified:false})
    await db.exec(`INSERT INTO agnt_sale_accounts(user_id,frozen) VALUES('private-alice',true);
      INSERT INTO agnt_sale_deposits(receipt_id,user_id,txid,amount,confirmations,state,credited) VALUES('private-receipt','private-alice','private-tx',1,0,'ORPHANED',true);
      INSERT INTO agnt_sale_events(id,user_id,kind,reference) VALUES('11111111-1111-1111-1111-111111111111','private-alice','PURCHASE','private-purchase');
      INSERT INTO agnt_sale_outbox(event_id,state,attempts) VALUES('11111111-1111-1111-1111-111111111111','FAILED',10);`)
    queries.length=0
    const report=await saleOperationsStatus(pool)
    assert.equal(report.requiresReview,true)
    assert.deepEqual(report.issues,['frozen_accounts','orphaned_credited_deposits','credited_review_missing','notification_delivery_failed'])
    assert.equal(report.missingCreditReviews,1)
    assert.equal(report.accounts.frozen,1)
    assert.ok(!JSON.stringify(report).includes('private-'))
    assert.equal(queries[1],'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    assert.ok(queries.every(sql=>!/^(INSERT|UPDATE|DELETE|ALTER)/.test(sql)))
    assert.equal(report.observerLivenessVerified,false)
    assert.equal(report.signerLivenessVerified,false)
    await query("INSERT INTO agnt_sale_credit_reviews(receipt_id,user_id,credited_amount,coverage_state,confirmations,required_confirmations) VALUES('private-receipt','private-alice',1,'ORPHANED',0,3)")
    const exposed=await saleOperationsStatus(pool)
    assert.equal(exposed.creditReview.total_credited_under_review,'1')
    assert.equal(exposed.missingCreditReviews,0)
    assert.equal(exposed.creditReview.insufficiently_confirmed_credit,'1')
    assert.ok(exposed.issues.includes('credited_value_review_required'))
    await query("UPDATE agnt_sale_credit_reviews SET coverage_state='RESTORED',confirmations=3")
    const restored=await saleOperationsStatus(pool)
    assert.equal(restored.creditReview.total_credited_under_review,'1')
    assert.equal(restored.creditReview.insufficiently_confirmed_credit,'0')
    assert.ok(restored.issues.includes('credited_value_review_required'))
    await query("INSERT INTO agnt_sale_purchases(id,user_id,idempotency_key,request_hash,first_serial,quantity,total,curve_version,created_at) VALUES('22222222-2222-2222-2222-222222222222','private-alice','private-key','private-hash',1,1,2000000,$1,now()-interval '2 minutes')",[CURVE_VERSION])
    const pending=await saleOperationsStatus(pool)
    assert.equal(pending.receiptSigning.unsigned_purchases,1)
    assert.ok(Number(pending.receiptSigning.oldest_unsigned_seconds)>=120)
    await query("INSERT INTO agnt_sale_signed_receipts(purchase_id,envelope) VALUES('22222222-2222-2222-2222-222222222222','{}')")
    const signed=await saleOperationsStatus(pool)
    assert.equal(signed.receiptSigning.unsigned_purchases,0)
    assert.equal(signed.receiptSigning.stored_signatures,1)
    assert.equal(signed.receiptSigning.oldest_unsigned_seconds,null)
    assert.equal(signed.receiptSigning.signaturesVerified,false,'Presence of a row is not signature verification')
    assert.ok(!JSON.stringify(signed).includes('private-'))
  }finally{await db.close()}
})

test('liability report retains all unsettled principal and fee holds, with exact aggregate arithmetic',async()=>{
  const db=new PGlite()
  const query=(sql:string,args?:unknown[])=>db.query(sql,args)
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    await db.exec(`INSERT INTO agnt_sale_accounts(user_id,available,held) VALUES
      ('private-owner',9007199254740993,550),('private-other',7,0);`)
    const states=['HELD','APPROVED','SIGNED','BROADCAST','REVIEW','PAID','CANCELED']
    for(const [index,state] of states.entries()){
      await query(`INSERT INTO agnt_sale_withdrawals(id,user_id,idempotency_key,request_hash,destination,amount,fee_limit,state)
        VALUES($1,'private-owner',$2,'private-hash','private-address',100,10,$3)`,
      [`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,`key-${index}`,state])
    }
    const report=await saleOperationsStatus(pool)
    assert.deepEqual(report.customerLiabilities,{
      available:'9007199254741000',held:'550',total:'9007199254741550',unit:'zatoshi',
      unsettledReserves:['APPROVED','BROADCAST','HELD','REVIEW','SIGNED'].map(state=>({state,count:1,principal:'100',fee_reserve:'10',total:'110'})),
      holdMismatches:0,walletCoverageVerified:false,
    })
    assert.equal(report.treasurySolvencyVerified,false)
    assert.equal(report.treasuryLimits.configured,false)
    assert.equal(report.treasuryLimits.remainingAuthorizationZatoshi,null)
    assert.equal(report.treasuryLimits.outstandingZatoshi,'440','Unsigned HELD requests do not consume approval capacity')
    assert.ok(report.issues.includes('treasury_limits_unconfigured'))
    await query('INSERT INTO agnt_treasury_limits(id,max_payout,max_outstanding) VALUES(1,110,440)')
    const exactLimit=await saleOperationsStatus(pool)
    assert.equal(exactLimit.treasuryLimits.remainingAuthorizationZatoshi,'0')
    assert.equal(exactLimit.treasuryLimits.overOutstandingLimit,false)
    assert.equal(exactLimit.treasuryLimits.oversizedPayouts,0)
    await query('UPDATE agnt_treasury_limits SET max_payout=100,max_outstanding=400 WHERE id=1')
    const exceeded=await saleOperationsStatus(pool)
    assert.equal(exceeded.treasuryLimits.remainingAuthorizationZatoshi,'0')
    assert.equal(exceeded.treasuryLimits.overOutstandingLimit,true)
    assert.equal(exceeded.treasuryLimits.oversizedPayouts,4)
    assert.ok(exceeded.issues.includes('treasury_authorization_limit_exceeded'))
    assert.equal(exceeded.treasuryLimits.notWalletLiquidity,true)
    assert.ok(!JSON.stringify(report).includes('private-'))
    // The total stays correct, but ownership of one zatoshi of holds is wrong.
    await db.exec("UPDATE agnt_sale_accounts SET held=549 WHERE user_id='private-owner'; UPDATE agnt_sale_accounts SET held=1 WHERE user_id='private-other'")
    const mismatch=await saleOperationsStatus(pool)
    assert.equal(mismatch.customerLiabilities.held,'550')
    assert.equal(mismatch.customerLiabilities.holdMismatches,2)
    assert.ok(mismatch.issues.includes('withdrawal_hold_mismatch'))
    assert.equal(mismatch.requiresReview,true)
    assert.equal((await db.query<{state:string}>('SELECT state FROM agnt_sale')).rows[0].state,'CLOSED','Status is read-only; reconciliation handles state changes')
  }finally{await db.close()}
})
