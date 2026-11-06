import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { SaleService } from '../sale/service.js'
import { saleRouter } from '../sale/routes.js'

test('account export includes full history, exact amounts and only the authenticated owner',async()=>{
  const db=new PGlite(),statements:string[]=[]
  const query=async(sql:string,args?:unknown[])=>{statements.push(sql);return db.query(sql,args)}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await db.exec(`INSERT INTO agnt_sale_accounts(user_id,available) VALUES('alice',2000000),('bob',3000000);
      INSERT INTO agnt_sale_deposits(receipt_id,user_id,txid,amount,confirmations,state)
        SELECT 'receipt-'||n,'alice','test-tx-'||n,1,3,'CREDITED' FROM generate_series(1,101) n;
      INSERT INTO agnt_sale_purchases(id,user_id,idempotency_key,request_hash,first_serial,quantity,total,curve_version)
        SELECT md5(n::text)::uuid,'alice','request-'||n,'hidden-hash',n,1,2000000,'test-fixture' FROM generate_series(1,101) n;
      INSERT INTO agnt_sale_passes(serial,owner_id,purchase_id,metadata_hash) VALUES(1,'alice',md5('1')::uuid,'metadata');
      INSERT INTO agnt_sale_withdrawals(id,user_id,idempotency_key,request_hash,destination,amount,fee_limit,signer_reference)
        SELECT md5(('withdrawal-'||n))::uuid,'alice','request-'||n,'hidden-hash','test-recipient',1,1,'treasury-secret-'||n FROM generate_series(1,101) n;
      INSERT INTO agnt_sale_deposits(receipt_id,user_id,txid,amount,confirmations,state) VALUES('bob-secret','bob','bob-tx',9,3,'CREDITED');`)
    const service=new SaleService(pool)
    assert.equal((await service.account('alice')).deposits.length,100)
    statements.length=0
    const data=await service.exportAccount('alice')
    assert.equal(statements[0],'BEGIN')
    assert.equal(statements[1],'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    assert.equal(statements.at(-1),'COMMIT')
    assert.equal(data.balance.available,'2000000')
    assert.equal(data.amountUnit,'zatoshi')
    assert.equal(data.passes.length,1)
    for(const rows of [data.deposits,data.purchases,data.withdrawals])assert.equal(rows.length,101)
    const json=JSON.stringify(data)
    for(const hidden of ['bob-secret','bob-tx','treasury-secret','hidden-hash','idempotency_key','signer_reference'])assert.ok(!json.includes(hidden))
    const empty=await service.exportAccount('new-user')
    assert.equal(empty.balance.available,'0')
    assert.equal(empty.purchases.length,0)
  }finally{await db.close()}
})

test('history export requires auth, ignores owner hints and stays available with launch closed',async()=>{
  const owners:string[]=[]
  const service={exportAccount:async(user:string)=>{owners.push(user);return {userId:user,formatVersion:1}}} as unknown as SaleService
  const app=express()
  app.use('/sale',saleRouter((req,res,next)=>{if(req.get('x-test-auth')!=='alice'){res.sendStatus(401);return}next()},()=> 'alice',()=>[],{service:()=>service}))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale/account/export?userId=bob`
  try{
    assert.equal((await fetch(url)).status,401)
    assert.deepEqual(owners,[])
    const response=await fetch(url,{headers:{'x-test-auth':'alice'}})
    assert.equal(response.status,200)
    assert.equal(response.headers.get('cache-control'),'no-store')
    assert.match(response.headers.get('content-disposition')!,/attachment/)
    assert.equal((await response.json()).userId,'alice')
    assert.deepEqual(owners,['alice'])
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
