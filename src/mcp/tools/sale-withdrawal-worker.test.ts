import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { SaleService } from '../sale/service.js'
import { approveFixtureWithdrawal } from '../../../scripts/test-sale-approvals.js'
import { SignerArtifacts } from '../sale/signer-artifacts.js'
import { signApprovedWithdrawal, broadcastSignedWithdrawal, settleConfirmedWithdrawal, reviewPaidWithdrawal } from '../sale/withdrawal-worker.js'
import type { ZcashRpc } from '../sale/zcash-observer.js'
import { CURVE_VERSION, SCHEDULE_HASH } from '../sale/pricing.js'

test('signer rechecks a queued withdrawal after its durable claim and before wallet invocation',async()=>{
  const db=new PGlite(),signerDb=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{
    const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}
  }
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const store=new SignerArtifacts({query:(sql:string,args?:unknown[])=>signerDb.query(sql,args)} as unknown as Pool)
  const original=store.signForWallet.bind(store)
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'OPEN',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    await store.migrate()
    const service=new SaleService(pool)
    for(const change of ['freeze','destination','review']){
      await service.observe(change,{receiptId:`regtest:${change}`,txid:'a'.repeat(64),amountZatoshi:'10000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
      const hold=await service.holdWithdrawal(change,{destination:'synthetic-destination',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:randomUUID()})
      await approveFixtureWithdrawal(service,pool,change,hold.id)
      store.signForWallet=async(account,intent,sign)=>{
        // Happens after the worker's initial authorization read.
        if(change==='freeze')await query('UPDATE agnt_sale_accounts SET frozen=true WHERE user_id=$1',[change])
        if(change==='destination')await query("UPDATE agnt_sale_withdrawals SET destination='changed-destination' WHERE id=$1",[hold.id])
        if(change==='review')await query("UPDATE agnt_sale_withdrawals SET state='REVIEW' WHERE id=$1",[hold.id])
        return original(account,intent,sign)
      }
      await assert.rejects(signApprovedWithdrawal(pool,store,change,hold.id,'regtest',randomUUID(),async()=>{
        assert.fail('Changed authorization must not invoke wallet signing')
      }),/withdrawal_signing_requires_review/)
      assert.equal((await service.account(change)).balance.held,'1010000')
      assert.equal((await signerDb.query('SELECT * FROM agnt_signed_artifacts')).rows.length,0)
    }
    assert.equal((await signerDb.query('SELECT * FROM agnt_signing_intents')).rows.length,3,'Failed claims are retained, not automatically retried')
  }finally{await db.close();await signerDb.close()}
})

test('approved withdrawal recovers stored bytes/fee after accounting failure without re-signing',async()=>{
  const db=new PGlite(),signerDb=new PGlite()
  let failRecord=false
  let failSettlementCommit:'before'|'after'|null=null
  const query=async(sql:string,args?:unknown[])=>{
    if(failRecord && sql.includes("SET state='SIGNED'")){failRecord=false;throw new Error('simulated accounting failure')}
    if(sql==='COMMIT' && failSettlementCommit){
      const failure=failSettlementCommit
      failSettlementCommit=null
      if(failure==='after')await db.query(sql,args)
      throw new Error(`simulated settlement commit failure ${failure}`)
    }
    const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}
  }
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const store=new SignerArtifacts({query:(sql:string,args?:unknown[])=>signerDb.query(sql,args)} as unknown as Pool)
  const account='11111111-1111-1111-1111-111111111111'
  let signingCalls=0
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'OPEN',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    await store.migrate()
    const service=new SaleService(pool)
    await service.observe('alice',{receiptId:'regtest:test',txid:'a'.repeat(64),amountZatoshi:'10000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const hold=await service.holdWithdrawal('alice',{destination:'synthetic-destination',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:randomUUID()})
    const signer=async(intent:{amountZatoshi:string;destination:string})=>{
      signingCalls++
      assert.equal(intent.amountZatoshi,'1000000')
      assert.equal(intent.destination,'synthetic-destination')
      return {txid:'c'.repeat(64),rawHex:'01020304',actualFeeZatoshi:'1000'}
    }
    await assert.rejects(signApprovedWithdrawal(pool,store,'bob',hold.id,'regtest',account,signer),/withdrawal_not_found/)
    await assert.rejects(signApprovedWithdrawal(pool,store,'alice',hold.id,'regtest',account,signer),/invalid_withdrawal_state/)
    await approveFixtureWithdrawal(service,pool,'alice',hold.id)
    failRecord=true
    await assert.rejects(signApprovedWithdrawal(pool,store,'alice',hold.id,'regtest',account,signer),/simulated accounting failure/)
    assert.equal((await service.account('alice')).withdrawals[0].state,'APPROVED')
    const result=await signApprovedWithdrawal(pool,store,'alice',hold.id,'regtest',account,signer)
    assert.equal(signingCalls,1)
    assert.equal(result.actualFeeZatoshi,'1000')
    assert.equal((await service.account('alice')).withdrawals[0].state,'SIGNED')
    assert.equal((await service.account('alice')).balance.held,'1010000')
    await assert.rejects(signApprovedWithdrawal(pool,store,'alice',hold.id,'mainnet',account,signer),/signing_intent_conflict/)
    const block='d'.repeat(64),genesis='e'.repeat(64)
    const policy={network:'regtest' as const,genesisHash:genesis,maxTipAgeSeconds:300}
    let inMempool=false,broadcastCalls=0,member=false
    const node:ZcashRpc=async(method,params=[])=>{
      if(method==='getblockchaininfo')return {chain:'test',blocks:100,bestblockhash:block}
      if(method==='getblock')return {hash:block,height:100,time:1000,tx:member?['f'.repeat(64),result.txid]:['f'.repeat(64)]}
      if(method==='getblockhash')return params[0]===0?genesis:block
      if(method==='getrawmempool')return inMempool?[result.txid]:[]
      if(method==='sendrawtransaction'){
        broadcastCalls++
        assert.equal(params[0],'01020304')
        inMempool=true
        throw new Error('simulated lost broadcast response')
      }
      throw new Error('Unexpected RPC')
    }
    const freezeDuringChecks:ZcashRpc=async(method,params)=>{
      if(method==='getrawmempool')await query("UPDATE agnt_sale_accounts SET frozen=true WHERE user_id='alice'")
      return node(method,params)
    }
    await assert.rejects(broadcastSignedWithdrawal(pool,store,freezeDuringChecks,policy,'alice',hold.id,account,1000),/withdrawal_broadcast_requires_review/)
    assert.equal(broadcastCalls,0)
    assert.equal((await service.account('alice')).withdrawals[0].state,'SIGNED')
    assert.equal((await service.account('alice')).balance.held,'1010000')
    // Fixture reset only; no production automatic-unfreeze path exists.
    await query("UPDATE agnt_sale_accounts SET frozen=false WHERE user_id='alice'")
    await assert.rejects(broadcastSignedWithdrawal(pool,store,node,policy,'alice',hold.id,account,1000),/lost broadcast response/)
    assert.equal((await service.account('alice')).withdrawals[0].state,'SIGNED')
    await broadcastSignedWithdrawal(pool,store,node,policy,'alice',hold.id,account,1000)
    assert.equal(broadcastCalls,1,'Mempool recovery must not submit another transaction')
    assert.equal((await service.account('alice')).withdrawals[0].state,'BROADCAST')
    await assert.rejects(settleConfirmedWithdrawal(pool,store,node,policy,'alice',hold.id,block,1,1000),/observer_transaction_not_in_block/)
    assert.equal((await service.withdrawalStatus('alice',hold.id)).withdrawal.confirmations,null)
    assert.equal((await service.account('alice')).balance.held,'1010000')
    member=true
    for(const [column,value] of [['destination','changed-after-observation'],['amount','1000001'],['fee_limit','10001'],['actual_fee','1001'],['signer_reference','changed-reference']] as const){
      const original=(await db.query<Record<string,unknown>>('SELECT * FROM agnt_sale_withdrawals WHERE id=$1',[hold.id])).rows[0][column]
      let changed=false
      const changedDuringEvidence:ZcashRpc=async(method,params)=>{
        if(!changed){
          changed=true
          // Simulated inconsistent maintenance write after the worker's read,
          // before its canonical proof reaches the locked settlement transaction.
          await query(`UPDATE agnt_sale_withdrawals SET ${column}=$2 WHERE id=$1`,[hold.id,value])
        }
        return node(method,params)
      }
      try{
        await assert.rejects(settleConfirmedWithdrawal(pool,store,changedDuringEvidence,policy,'alice',hold.id,block,1,1000),/withdrawal_settlement_intent_changed/)
        assert.equal((await service.account('alice')).balance.held,'1010000')
        assert.equal((await service.account('alice')).balance.available,'8990000')
        assert.equal((await service.withdrawalStatus('alice',hold.id)).withdrawal.confirmations,null)
        assert.equal((await query('SELECT * FROM agnt_sale_ledger WHERE reference=$1',[`withdrawal-paid:${hold.id}`])).rows.length,0)
      }finally{
        // Test-fixture restoration, not a production repair mechanism.
        await query(`UPDATE agnt_sale_withdrawals SET ${column}=$2 WHERE id=$1`,[hold.id,original])
      }
    }
    await assert.rejects(settleConfirmedWithdrawal(pool,store,node,policy,'alice',hold.id,block,3,1000),/withdrawal_unconfirmed/)
    const progress=(await service.withdrawalStatus('alice',hold.id)).withdrawal
    assert.equal(progress.confirmations,1)
    assert.equal(progress.required_confirmations,3)
    assert.ok(progress.confirmation_checked_at)
    assert.equal(progress.state,'BROADCAST')
    assert.equal((await service.account('alice')).balance.held,'1010000')
    failSettlementCommit='before'
    await assert.rejects(settleConfirmedWithdrawal(pool,store,node,policy,'alice',hold.id,block,1,1000),/settlement commit failure before/)
    assert.equal((await service.account('alice')).withdrawals[0].state,'BROADCAST')
    assert.equal((await service.account('alice')).balance.held,'1010000')
    assert.equal((await service.account('alice')).balance.available,'8990000')
    assert.equal((await query('SELECT * FROM agnt_sale_ledger WHERE reference=$1',[`withdrawal-paid:${hold.id}`])).rows.length,0)
    failSettlementCommit='after'
    await assert.rejects(settleConfirmedWithdrawal(pool,store,node,policy,'alice',hold.id,block,1,1000),/settlement commit failure after/)
    assert.equal((await service.account('alice')).withdrawals[0].state,'PAID')
    assert.equal((await service.account('alice')).balance.held,'0')
    assert.equal((await service.account('alice')).balance.available,'8999000')
    await settleConfirmedWithdrawal(pool,store,node,policy,'alice',hold.id,block,1,1000)
    assert.equal((await service.account('alice')).balance.held,'0')
    assert.equal((await service.account('alice')).balance.available,'8999000')
    assert.equal((await service.account('alice')).withdrawals[0].state,'PAID')
    for(const kind of ['paid','fee','fee-release']){
      assert.equal((await query('SELECT * FROM agnt_sale_ledger WHERE reference=$1',[`withdrawal-${kind}:${hold.id}`])).rows.length,1,'Settlement retry must retain exactly one journal entry per effect')
    }
    assert.equal(signingCalls,1,'Settlement recovery must not invoke the signer again')
    assert.equal(broadcastCalls,1,'Settlement recovery must not submit another payout')
    assert.deepEqual(await reviewPaidWithdrawal(pool,store,node,policy,'alice',hold.id,1000),{reviewRequired:false})
    await assert.rejects(reviewPaidWithdrawal(pool,store,async()=>{throw new Error('node unavailable')},policy,'alice',hold.id,1000),/node unavailable/)
    assert.equal((await service.account('alice')).balance.frozen,false)
    const orphanNode:ZcashRpc=(method,params)=>method==='getblockhash'&&params?.[0]===100?Promise.resolve('9'.repeat(64)):node(method,params)
    assert.deepEqual(await reviewPaidWithdrawal(pool,store,orphanNode,policy,'alice',hold.id,1000),{reviewRequired:true})
    assert.deepEqual(await reviewPaidWithdrawal(pool,store,node,policy,'alice',hold.id,1000),{reviewRequired:true})
    assert.equal((await service.account('alice')).balance.frozen,true)
    assert.equal((await service.account('alice')).withdrawals[0].settlement_review,true)
    assert.equal((await service.summary()).state,'PAUSED')
    assert.equal((await service.account('alice')).balance.available,'8999000')
    assert.equal((await service.account('alice')).balance.held,'0')
    assert.equal((await service.account('alice')).withdrawals[0].state,'PAID')
  }finally{await db.close();await signerDb.close()}
})
