import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { saleRouter } from '../sale/routes.js'
import type { SaleService } from '../sale/service.js'
import { SaleError } from '../sale/pricing.js'
import { zecToZatoshi } from '../../client/sale-amount.js'

test('inbox HTTP routes bind owner, protect read mutations and remain available while launch is closed',async()=>{
  const calls:unknown[][]=[]
  const service={notifications:async(user:string)=>{calls.push(['list',user]);return []},readNotification:async(user:string,id:string)=>{calls.push(['read',user,id]);return {event_id:id,read_at:'test-time'}}} as unknown as SaleService
  const app=express()
  app.use('/sale',saleRouter((req,res,next)=>{if(req.get('x-test-auth')!=='alice'){res.sendStatus(401);return}next()},()=> 'alice',()=>['https://agntmpp.xyz'],{service:()=>service}))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale/notifications`
  const headers={'x-test-auth':'alice',Origin:'https://agntmpp.xyz','Content-Type':'application/json'}
  try{
    assert.equal((await fetch(url)).status,401)
    const listed=await fetch(`${url}?userId=bob`,{headers})
    assert.equal(listed.headers.get('cache-control'),'no-store')
    assert.deepEqual(await listed.json(),{userId:'alice',notifications:[]})
    const post=(owner:string,origin=headers.Origin)=>fetch(`${url}/test-event/read`,{method:'POST',headers:{...headers,Origin:origin},body:JSON.stringify({ownerId:owner})})
    assert.equal((await post('alice','https://attacker.invalid')).status,403)
    assert.equal((await post('bob')).status,409)
    assert.equal((await post('alice')).status,200)
    assert.deepEqual(calls,[['list','alice'],['read','alice','test-event']])
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('frontend amount parsing is exact and rejects ambiguous decimals',()=>{
  assert.equal(zecToZatoshi('0.00000001'),'1')
  assert.equal(zecToZatoshi('0.05'),'5000000')
  for(const input of ['1e-8','-1','0.000000001','01','NaN','21000001',''])assert.throws(()=>zecToZatoshi(input))
})

test('request recovery remains owner-bound and available behind the launch lock',async()=>{
  const calls:unknown[][]=[]
  const service={requestStatus:async(...args:unknown[])=>{calls.push(args);return {userId:'alice',kind:'purchase',status:'UNKNOWN',receipt:null}}} as unknown as SaleService
  const app=express()
  app.use('/sale',saleRouter((req,res,next)=>{if(req.get('x-test-auth')!=='alice'){res.sendStatus(401);return}next()},()=> 'alice',()=>['https://agntmpp.xyz'],{service:()=>service}))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale/request-status`
  const headers={'x-test-auth':'alice',Origin:'https://agntmpp.xyz','Content-Type':'application/json'}
  const body={ownerId:'alice',kind:'purchase',idempotencyKey:'test-request-key-1234'}
  try{
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401)
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://attacker.invalid'},body:JSON.stringify(body)})).status,403)
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...body,ownerId:'bob'})})).status,409)
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...body,kind:'deposit'})})).status,400)
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)})
    assert.equal(response.status,200)
    assert.equal(response.headers.get('cache-control'),'no-store')
    assert.equal((await response.json()).status,'UNKNOWN')
    assert.deepEqual(calls,[['alice','purchase',body.idempotencyKey]])
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('composed sale HTTP writes bind authenticated owner and hide treasury metadata',async()=>{
  const app=express(),writes:{user:string;kind:string;input:any}[]=[]
  const service={purchase:async(user:string,input:unknown)=>{writes.push({user,kind:'purchase',input});return {id:'purchase'}},
    holdWithdrawal:async(user:string,input:unknown)=>{writes.push({user,kind:'hold',input});return {id:'hold',state:'HELD'}}} as unknown as SaleService
  app.use('/sale',saleRouter((_req,_res,next)=>next(),()=> 'alice',()=>['https://agntmpp.xyz'],{
    assertLaunchReady:()=>{},service:()=>service,
    depositAddress:async userId=>({userId,network:'regtest',walletAccountUuid:'private-wallet-account',recipientAddresses:['synthetic-address']}),
    validateDestination:async address=>{if(address!=='valid-test-destination')throw new SaleError('invalid_destination')},
  }))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale`
  const post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{Origin:'https://agntmpp.xyz','Content-Type':'application/json'},body:JSON.stringify(body)})
  try{
    const deposit=await post('/deposit-address',{userId:'victim'})
    assert.deepEqual(await deposit.json(),{network:'regtest',address:'synthetic-address'})
    assert.equal((await post('/purchases',{quoteId:'q',quantity:1,maxTotalZatoshi:'2000000',curveVersion:'v',idempotencyKey:'key',userId:'victim'})).status,200)
    assert.equal(writes[0].user,'alice')
    assert.equal(writes[0].input.userId,undefined)
    assert.equal((await post('/withdrawals',{destination:'bad',amountZatoshi:'1',feeLimitZatoshi:'1',idempotencyKey:'key'})).status,400)
    assert.equal(writes.length,1)
    assert.equal((await post('/withdrawals',{destination:'valid-test-destination',amountZatoshi:'1',feeLimitZatoshi:'1',idempotencyKey:'key',userId:'victim'})).status,200)
    assert.equal(writes[1].user,'alice')
    assert.equal((await post('/purchases',{ownerId:'bob',quoteId:'q',quantity:1,maxTotalZatoshi:'1',curveVersion:'v',idempotencyKey:'key'})).status,409)
    assert.equal(writes.length,2)
    assert.equal((await post('/purchases',{quantity:'1'})).status,400)
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('sale HTTP boundary requires auth/origin, rejects malformed input, and cannot accept funds',async()=>{
  const previous=process.env.AGNT_SALE_DATABASE_URL
  delete process.env.AGNT_SALE_DATABASE_URL
  const app=express()
  // This tests router behavior with a controlled auth seam, not dashboard login itself.
  app.use('/api/sale',saleRouter((req,res,next)=>{
    if(req.get('x-test-auth')!=='alice'){res.status(401).json({error:'unauthorized'});return}
    next()
  },()=> 'alice',()=>['https://agntmpp.xyz']))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sale`
  const headers={'x-test-auth':'alice','Origin':'https://agntmpp.xyz','Content-Type':'application/json'}
  try{
    const summary=await fetch(url)
    assert.equal(summary.status,200)
    assert.equal(summary.headers.get('cache-control'),'no-store')
    const body=await summary.json()
    assert.equal(body.sold,null)
    assert.equal(body.launchEnabled,false)
    assert.equal(body.fundingEnabled,false)
    assert.equal(body.withdrawalsEnabled,false)
    assert.equal((await fetch(`${url}/account`)).status,401)
    for(const path of ['/quote','/purchases','/deposit-address','/withdrawals','/withdrawals/00000000-0000-0000-0000-000000000000/cancel']){
      assert.equal((await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401)
      assert.equal((await fetch(url+path,{method:'POST',headers:{...headers,Origin:'https://attacker.invalid'},body:'{}'})).status,403)
      assert.equal((await fetch(url+path,{method:'POST',headers:{'x-test-auth':'alice','Content-Type':'application/json'},body:'{}'})).status,403)
    }
    for(const path of ['/purchases','/deposit-address','/withdrawals']){
      const response=await fetch(url+path,{method:'POST',headers,body:'{}'})
      assert.equal(response.status,503)
      assert.equal((await response.json()).error,'real_money_sale_not_ready')
    }
    for(const quantity of [null,0,-1,1.5,'1',4445]){
      const response=await fetch(`${url}/quote`,{method:'POST',headers,body:JSON.stringify({quantity})})
      assert.equal(response.status,400)
      assert.equal((await response.json()).error,'invalid_quantity')
    }
    const malformed=await fetch(`${url}/quote`,{method:'POST',headers,body:'{broken'})
    assert.equal(malformed.status,400)
    assert.equal((await malformed.json()).error,'invalid_json')
    const oversized=await fetch(`${url}/quote`,{method:'POST',headers,body:JSON.stringify({padding:'x'.repeat(9000)})})
    assert.equal(oversized.status,413)
  }finally{
    server.closeAllConnections()
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
    if(previous===undefined)delete process.env.AGNT_SALE_DATABASE_URL
    else process.env.AGNT_SALE_DATABASE_URL=previous
  }
})
