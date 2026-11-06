import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'pg'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { SaleService } from '../sale/service.js'
import { saleRouter } from '../sale/routes.js'
import { recentSaleAuth } from '../sale/recent-auth.js'
import { CURVE_VERSION, SCHEDULE_HASH, SaleError } from '../sale/pricing.js'
import { provisionFixtureTreasuryLimits } from '../../../scripts/test-sale-approvals.js'
import { startEmailLogin, signupDashboardVerified, resolveDashboardSession, logoutDashboardSession, loginDashboard, type DashboardSessionContext } from '../dashboard-auth.js'

test('operator approvals resolve real dashboard sessions and reject logged-out tokens',async()=>{
  const storePath=join(tmpdir(),`agnt-operator-sessions-${randomUUID()}.enc`)
  const db=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool),app=express(),contexts=new WeakMap<express.Request,DashboardSessionContext>()
  const recent=recentSaleAuth(req=>contexts.get(req)?.session.createdAt)
  app.use('/sale',saleRouter((req,res,next)=>{
    const context=resolveDashboardSession(req.get('x-agnt-dashboard-session'),storePath)
    if(!context){res.sendStatus(401);return}
    contexts.set(req,context);recent(req,res,next)
  },req=>contexts.get(req as express.Request)!.user.id,()=>['https://agntmpp.xyz'],{
    service:()=>service,assertLaunchReady:()=>{}, // Isolated database only; production hard gate is unchanged.
  }))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale/operator/withdrawals/`
  async function request(id:string,token:string,input?:unknown){
    const response=await fetch(base+id+(input===undefined?'':'/approve'),{method:input===undefined?'GET':'POST',
      headers:{'x-agnt-dashboard-session':token,Origin:'https://agntmpp.xyz','Content-Type':'application/json'},
      body:input===undefined?undefined:JSON.stringify(input)})
    const text=await response.text()
    return {status:response.status,body:text.startsWith('{')?JSON.parse(text):null}
  }
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await provisionFixtureTreasuryLimits(pool)
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    const accounts=['first','second','customer'].map(name=>{
      const email=`${name}@operator-fixture.example`,started=startEmailLogin(email,storePath)
      return signupDashboardVerified({email,code:started.devCode!,password:'local-fixture-password-123'},storePath)
    })
    for(const account of accounts.slice(0,2))await query('INSERT INTO agnt_treasury_operators(actor_id,enabled,authorization_version) VALUES($1,true,$2)',[account.user.id,randomUUID()])
    const customer=accounts[2].user.id
    await service.observe(customer,{receiptId:'session-fixture',txid:'a'.repeat(64),amountZatoshi:'5000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const hold=await service.holdWithdrawal(customer,{destination:'synthetic-session-recipient',amountZatoshi:'1000000',feeLimitZatoshi:'1000',idempotencyKey:randomUUID()})
    assert.equal((await request(hold.id,'invalid-token')).status,401)
    assert.equal((await request(hold.id,accounts[2].sessionToken)).status,403)
    const preview=await request(hold.id,accounts[0].sessionToken)
    assert.equal(preview.body.operatorId,accounts[0].user.id)
    const input={reason:'Reviewed session fixture',payloadHash:preview.body.payloadHash}
    assert.equal((await request(hold.id,accounts[0].sessionToken,input)).body.validApprovals,1)
    assert.equal(logoutDashboardSession(accounts[1].sessionToken,storePath),true)
    assert.equal((await request(hold.id,accounts[1].sessionToken,input)).status,401)
    assert.equal((await service.withdrawalStatus(customer,hold.id)).withdrawal.state,'HELD')
    const relogged=loginDashboard({email:'second@operator-fixture.example',password:'local-fixture-password-123'},storePath)
    assert.equal(relogged.user.id,accounts[1].user.id)
    const approved=await request(hold.id,relogged.sessionToken,input)
    assert.equal(approved.status,200);assert.equal(approved.body.state,'APPROVED')
    const voters=(await query('SELECT actor_id FROM agnt_withdrawal_approval_votes ORDER BY actor_id')).rows as {actor_id:string}[]
    assert.deepEqual(voters.map(row=>row.actor_id),accounts.slice(0,2).map(account=>account.user.id).sort())
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
    await db.close();await unlink(storePath).catch(()=>{})
  }
})

test('operator HTTP uses authenticated identity, fresh sessions and exact previews; launch stays gated',async()=>{
  const db=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool),app=express()
  let locked=true,sessionCreated=new Date().toISOString()
  const recent=recentSaleAuth(()=>sessionCreated)
  // Synthetic authentication fixture only; production uses requireDashboardAuth.
  app.use('/sale',saleRouter((req,res,next)=>{
    if(!['op-a','op-b','customer'].includes(req.get('x-test-user')??'')){res.sendStatus(401);return}
    recent(req,res,next)
  },req=>(req as express.Request).get('x-test-user')!,()=>['https://agntmpp.xyz'],{
    service:()=>service,assertLaunchReady:()=>{if(locked)throw new SaleError('real_money_sale_not_ready',503)},
  }))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale/operator/withdrawals/`
  const request=async(id:string,user:string,body?:unknown,origin='https://agntmpp.xyz')=>{
    const res=await fetch(base+id+(body===undefined?'':'/approve'),{method:body===undefined?'GET':'POST',
      headers:{'x-test-user':user,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
    const text=await res.text()
    return {status:res.status,cache:res.headers.get('cache-control'),body:text.startsWith('{')?JSON.parse(text):null}
  }
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await provisionFixtureTreasuryLimits(pool)
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    for(const actor of ['op-a','op-b'])await query('INSERT INTO agnt_treasury_operators(actor_id,enabled,authorization_version) VALUES($1,true,$2)',[actor,randomUUID()])
    await service.observe('customer',{receiptId:'http-op-fixture',txid:'a'.repeat(64),amountZatoshi:'5000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const hold=await service.holdWithdrawal('customer',{destination:'synthetic-recipient',amountZatoshi:'1000000',feeLimitZatoshi:'1000',idempotencyKey:randomUUID()})
    assert.equal((await request(hold.id,'anonymous')).status,401)
    assert.equal((await request(hold.id,'customer')).status,403)
    const preview=await request(hold.id,'op-a')
    assert.equal(preview.status,200);assert.equal(preview.cache,'no-store')
    assert.equal(preview.body.withdrawal.ownerId,'customer')
    assert.equal(preview.body.withdrawal.signer_reference,undefined)
    const input={reason:'Reviewed exact recipient and fee cap',payloadHash:preview.body.payloadHash}
    assert.equal((await request(hold.id,'op-a',input)).status,503)
    locked=false
    assert.equal((await request(hold.id,'op-a',{...input,actorId:'op-b'})).status,400)
    assert.equal((await request(hold.id,'op-a',input,'https://untrusted.invalid')).status,403)
    sessionCreated=new Date(Date.now()-16*60000).toISOString()
    assert.equal((await request(hold.id,'op-a',input)).status,401)
    sessionCreated=new Date().toISOString()
    await query("UPDATE agnt_sale_withdrawals SET destination='changed-recipient' WHERE id=$1",[hold.id])
    assert.equal((await request(hold.id,'op-a',input)).body.error,'withdrawal_approval_preview_changed')
    assert.equal((await query('SELECT * FROM agnt_withdrawal_approval_votes')).rows.length,0)
    await query("UPDATE agnt_sale_withdrawals SET destination='synthetic-recipient' WHERE id=$1",[hold.id])
    assert.equal((await request(hold.id,'op-a',input)).body.validApprovals,1)
    const approved=await request(hold.id,'op-b',input)
    assert.equal(approved.status,200);assert.equal(approved.body.state,'APPROVED')
    assert.equal((await request(hold.id,'op-b',input)).body.state,'APPROVED')
    assert.equal((await query('SELECT * FROM agnt_withdrawal_approval_votes')).rows.length,2)
    assert.equal((await service.account('customer')).balance.held,'1001000')
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await db.close()}
})
