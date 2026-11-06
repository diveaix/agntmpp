import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { SaleService } from '../sale/service.js'
import { CURVE_VERSION, SCHEDULE_HASH } from '../sale/pricing.js'
import { recordWithdrawalApproval } from '../sale/withdrawal-approvals.js'
import { SignerArtifacts } from '../sale/signer-artifacts.js'
import { signApprovedWithdrawal } from '../sale/withdrawal-worker.js'
import { provisionFixtureTreasuryLimits } from '../../../scripts/test-sale-approvals.js'

test('approval votes bind exact payment and distinct enabled operators, remain immutable, and do not sign or approve',async()=>{
  const db=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{
    const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}
  }
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await provisionFixtureTreasuryLimits(pool)
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    const service=new SaleService(pool)
    await service.observe('customer',{receiptId:'approval-fixture',txid:'a'.repeat(64),amountZatoshi:'10000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const hold=await service.holdWithdrawal('customer',{destination:'synthetic-destination',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:randomUUID()})
    await assert.rejects(service.approveWithdrawal('customer',hold.id),/two_treasury_approvals_required/)
    await assert.rejects(recordWithdrawalApproval(pool,'operator-a',hold.id,'Reviewed'),/treasury_operator_required/)
    for(const actor of ['operator-a','operator-b','customer'])await query('INSERT INTO agnt_treasury_operators(actor_id,enabled,authorization_version) VALUES($1,true,$2)',[actor,randomUUID()])
    await assert.rejects(recordWithdrawalApproval(pool,'customer',hold.id,'Reviewed'),/self_approval_forbidden/)
    const first=await recordWithdrawalApproval(pool,'operator-a',hold.id,'Reviewed')
    assert.equal(first.validApprovals,1)
    await assert.rejects(service.approveWithdrawal('customer',hold.id),/two_treasury_approvals_required/)
    assert.deepEqual(await recordWithdrawalApproval(pool,'operator-a',hold.id,'Reviewed'),first)
    await assert.rejects(recordWithdrawalApproval(pool,'operator-a',hold.id,'Different reason'),/approval_conflict/)
    const second=await recordWithdrawalApproval(pool,'operator-b',hold.id,'Reviewed')
    assert.equal(second.validApprovals,2)
    assert.equal(second.state,'HELD')
    assert.equal((await service.withdrawalStatus('customer',hold.id)).withdrawal.state,'HELD')
    assert.equal((await service.account('customer')).balance.held,'1010000')
    await assert.rejects(query("UPDATE agnt_withdrawal_approval_votes SET reason='overwrite'"),/approval_vote_is_immutable/)
    await assert.rejects(query('DELETE FROM agnt_withdrawal_approval_votes'),/approval_vote_is_immutable/)
    const originalVersion=(await db.query<{authorization_version:string}>("SELECT authorization_version FROM agnt_treasury_operators WHERE actor_id='operator-a'")).rows[0].authorization_version
    await query("UPDATE agnt_treasury_operators SET enabled=false WHERE actor_id='operator-a'")
    assert.equal((await recordWithdrawalApproval(pool,'operator-b',hold.id,'Reviewed')).validApprovals,1)
    await assert.rejects(recordWithdrawalApproval(pool,'operator-a',hold.id,'Reviewed'),/treasury_operator_required/)
    await assert.rejects(query("UPDATE agnt_treasury_operators SET enabled=true WHERE actor_id='operator-a'"),/reauthorization_requires_new_version/)
    await query("UPDATE agnt_treasury_operators SET enabled=true,authorization_version=$1 WHERE actor_id='operator-a'",[randomUUID()])
    await assert.rejects(query("UPDATE agnt_treasury_operators SET authorization_version=$1 WHERE actor_id='operator-a'",[originalVersion]),/authorization_version_reused/)
    assert.equal((await recordWithdrawalApproval(pool,'operator-b',hold.id,'Reviewed')).validApprovals,1)
    await assert.rejects(recordWithdrawalApproval(pool,'operator-a',hold.id,'Reviewed'),/approval_conflict/)
    await query("UPDATE agnt_sale_withdrawals SET destination='different-destination' WHERE id=$1",[hold.id])
    await assert.rejects(recordWithdrawalApproval(pool,'operator-b',hold.id,'Reviewed'),/approval_conflict/)
    await query("UPDATE agnt_sale_withdrawals SET destination='synthetic-destination' WHERE id=$1",[hold.id])
    await query("UPDATE agnt_sale_accounts SET frozen=true WHERE user_id='customer'")
    await assert.rejects(recordWithdrawalApproval(pool,'operator-b',hold.id,'Reviewed'),/account_frozen/)
    await service.cancelWithdrawal('customer',hold.id)
    await query("UPDATE agnt_sale_accounts SET frozen=false WHERE user_id='customer'")
    await assert.rejects(recordWithdrawalApproval(pool,'operator-b',hold.id,'Reviewed'),/not_awaiting_approval/)
    assert.equal((await query('SELECT * FROM agnt_withdrawal_approval_votes')).rows.length,2,'Cancellation retains audit evidence')
    const next=await service.holdWithdrawal('customer',{destination:'synthetic-destination',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:randomUUID()})
    for(const actor of ['operator-a','operator-b'])await recordWithdrawalApproval(pool,actor,next.id,'Reviewed')
    assert.equal((await service.approveWithdrawal('customer',next.id)).state,'APPROVED')
    assert.equal((await service.approveWithdrawal('customer',next.id)).state,'APPROVED')
    await query("UPDATE agnt_treasury_operators SET enabled=false WHERE actor_id='operator-a'")
    const artifacts=new SignerArtifacts(pool)
    await artifacts.migrate()
    await assert.rejects(signApprovedWithdrawal(pool,artifacts,'customer',next.id,'regtest',randomUUID(),async()=>{
      assert.fail('Revoked approval must stop new signing even after APPROVED')
    }),/two_treasury_approvals_required/)
    assert.equal((await service.account('customer')).balance.held,'1010000')
  }finally{await db.close()}
})
