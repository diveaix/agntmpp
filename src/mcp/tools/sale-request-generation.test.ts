import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { SaleService } from '../sale/service.js'
import { configureSaleAccess } from '../sale/access-policy.js'
import { CURVE_VERSION, SCHEDULE_HASH } from '../sale/pricing.js'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { saleRouter } from '../sale/routes.js'
import { recentSaleAuth } from '../sale/recent-auth.js'

test('HTTP recovery is owner-scoped, recent-auth protected and available while launch is locked',async()=>{
  const db=new PGlite(),query=(sql:string,args?:unknown[])=>db.query(sql,args)
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool),app=express()
  const auth:express.RequestHandler=(req,res,next)=>{
    if(req.get('x-test-user')!=='alice'){res.status(401).json({error:'unauthorized'});return}
    recentSaleAuth(()=>req.get('x-test-created'))(req,res,next)
  }
  app.use('/sale',saleRouter(auth,()=> 'alice',()=>['https://agntmpp.xyz'],{service:()=>service}))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale/request-recovery`
  const request=async(body?:unknown,headers:Record<string,string>={})=>{
    const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:'https://agntmpp.xyz','x-test-user':'alice','x-test-created':new Date().toISOString(),...headers},body:body===undefined?undefined:JSON.stringify(body)})
    assert.equal(response.headers.get('cache-control'),'no-store')
    return {status:response.status,body:await response.json()}
  }
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query('INSERT INTO agnt_sale(id,curve_version,schedule_hash) VALUES(1,$1,$2)',[CURVE_VERSION,SCHEDULE_HASH])
    assert.equal((await request(undefined,{'x-test-user':'bob'})).status,401)
    assert.deepEqual((await request()).body,{userId:'alice',requestGeneration:0})
    assert.equal((await request({expectedGeneration:0},{'x-test-created':'invalid'})).status,401)
    assert.equal((await request({expectedGeneration:0},{Origin:'https://untrusted.invalid'})).status,403)
    assert.equal((await request({ownerId:'bob',expectedGeneration:0})).status,409)
    for(const body of [{},{expectedGeneration:null},{expectedGeneration:'0'},{expectedGeneration:0,actorId:'bob'}])assert.equal((await request(body)).status,400)
    const reset=await request({ownerId:'alice',expectedGeneration:0})
    assert.equal(reset.status,200)
    assert.equal(reset.body.requestGeneration,1)
    assert.equal((await request({expectedGeneration:0})).status,409,'Lost response retries cannot invalidate fresh requests again')
    assert.equal((await request()).body.requestGeneration,1)
    assert.equal((await service.requestRecoveryState('bob')).requestGeneration,0)
    assert.equal((await service.account('alice')).withdrawals.length,0)
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
    await db.close()
  }
})

test('recovery fence rejects old uncommitted requests but preserves committed receipts and holds',async()=>{
  const db=new PGlite(),query=(sql:string,args?:unknown[])=>db.query(sql,args)
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool)
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query('INSERT INTO agnt_sale(id,curve_version,schedule_hash) VALUES(1,$1,$2)',[CURVE_VERSION,SCHEDULE_HASH])
    await configureSaleAccess(pool,30,5)
    await db.exec("UPDATE agnt_sale SET state='OPEN'")
    await service.observe('alice',{receiptId:'fixture:fence',txid:'a'.repeat(64),amountZatoshi:'10000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const quote=await service.quote('alice',1)
    const purchase={quoteId:quote.id,quantity:1,maxTotalZatoshi:'10000000',curveVersion:quote.curveVersion,idempotencyKey:randomUUID()}
    const withdrawal={destination:'synthetic-destination',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:randomUUID()}
    const issued=await service.purchase('alice',purchase)
    const held=await service.holdWithdrawal('alice',withdrawal)
    const before=await service.account('alice')
    assert.deepEqual(await service.resetPendingRequests('alice',0),{userId:'alice',requestGeneration:1,recordedRequestsPreserved:true})
    assert.deepEqual(await service.account('alice'),before)
    assert.equal((await service.purchase('alice',purchase)).id,issued.id)
    assert.equal((await service.holdWithdrawal('alice',withdrawal)).id,held.id)
    await assert.rejects(service.purchase('alice',{...purchase,idempotencyKey:randomUUID()}),/request_generation_changed/)
    await assert.rejects(service.holdWithdrawal('alice',{...withdrawal,idempotencyKey:randomUUID()}),/request_generation_changed/)
    await assert.rejects(service.resetPendingRequests('alice',0),/request_generation_changed/)
    assert.deepEqual(await service.account('alice'),before)
    const fresh=await service.holdWithdrawal('alice',{...withdrawal,idempotencyKey:randomUUID(),requestGeneration:1})
    assert.notEqual(fresh.id,held.id)
    await assert.rejects(service.holdWithdrawal('alice',{...withdrawal,idempotencyKey:randomUUID(),requestGeneration:-1}),/invalid_request_generation/)
    assert.equal((await service.resetPendingRequests('bob',0)).requestGeneration,1,'Recovery is owner-scoped, including an unfunded account')
    assert.equal((await service.resetPendingRequests('alice',1)).requestGeneration,2)
    await db.exec("UPDATE agnt_sale SET state='PAUSED'")
    assert.equal((await service.resetPendingRequests('alice',2)).requestGeneration,3,'Recovery remains available when purchases are paused')
    assert.equal((await service.purchase('alice',purchase)).id,issued.id,'Closed-sale replay still returns committed issuance')
    assert.equal((await service.account('alice')).withdrawals.length,2)
  }finally{await db.close()}
})
