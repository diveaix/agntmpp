import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { SaleService } from '../sale/service.js'
import { CURVE_VERSION, SCHEDULE_HASH } from '../sale/pricing.js'
import { recordWithdrawalApproval } from '../sale/withdrawal-approvals.js'
import { reconcileSale } from '../sale/reconcile.js'

test('treasury caps include fee reserves and ambiguous payouts; only settled payouts release outstanding capacity',async()=>{
  const db=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool)
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    for(const actor of ['first','second'])await query('INSERT INTO agnt_treasury_operators(actor_id,enabled,authorization_version) VALUES($1,true,$2)',[actor,randomUUID()])
    await service.observe('customer',{receiptId:'limits-fixture',txid:'a'.repeat(64),amountZatoshi:'100',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const prepare=async(amount:string,fee:string)=>{
      const hold=await service.holdWithdrawal('customer',{destination:'synthetic-recipient',amountZatoshi:amount,feeLimitZatoshi:fee,idempotencyKey:randomUUID()})
      for(const actor of ['first','second'])await recordWithdrawalApproval(pool,actor,hold.id,'Limit fixture review')
      return hold
    }
    const first=await prepare('9','1')
    await assert.rejects(service.approveWithdrawal('customer',first.id),/treasury_limits_unconfigured/)
    assert.equal((await service.withdrawalStatus('customer',first.id)).withdrawal.state,'HELD')
    await query('INSERT INTO agnt_treasury_limits(id,max_payout,max_outstanding) VALUES(1,10,15)')
    const tooLarge=await prepare('10','1')
    await assert.rejects(service.approveWithdrawal('customer',tooLarge.id),/treasury_payout_limit_exceeded/)
    await service.cancelWithdrawal('customer',tooLarge.id)
    const approved=await service.approveWithdrawal('customer',first.id)
    const second=await prepare('5','0')
    await service.approveWithdrawal('customer',second.id)
    const third=await prepare('1','0')
    for(const state of ['APPROVED','SIGNED','BROADCAST','REVIEW']){
      // Synthetic state exercise, not a production recovery action.
      await query('UPDATE agnt_sale_withdrawals SET state=$2 WHERE id=$1',[first.id,state])
      await assert.rejects(service.approveWithdrawal('customer',third.id),/treasury_outstanding_limit_exceeded/)
      assert.equal((await service.withdrawalStatus('customer',third.id)).withdrawal.state,'HELD')
    }
    await query("UPDATE agnt_sale_withdrawals SET state='APPROVED' WHERE id=$1",[first.id])
    await service.recordSignedWithdrawal('customer',first.id,{signerReference:approved.signer_reference!,txid:'c'.repeat(64),actualFeeZatoshi:'0'})
    await service.settleWithdrawal('customer',first.id,{txid:'c'.repeat(64),canonical:true,confirmations:3,blockHash:'d'.repeat(64),blockHeight:1},3)
    assert.equal((await service.approveWithdrawal('customer',third.id)).state,'APPROVED')
    assert.equal((await reconcileSale(pool)).ok,true)
  }finally{await db.close()}
})
