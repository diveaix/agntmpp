import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'pg'
import { PGlite } from '@electric-sql/pglite'
import express from 'express'
import { saleRouter } from '../sale/routes.js'
import { SaleService } from '../sale/service.js'
import { approveFixtureWithdrawal } from '../../../scripts/test-sale-approvals.js'
import { configureSaleAccess } from '../sale/access-policy.js'
import { CURVE_VERSION, SCHEDULE_HASH, SaleError } from '../sale/pricing.js'
import { reconcileSale } from '../sale/reconcile.js'
import { signPurchaseReceipt } from '../sale/receipt-worker.js'
import { verifyReceiptBytes } from '../sale/receipt-signature.js'

test('HTTP purchase and withdrawal recovery use committed owner-scoped ledger state',async()=>{
  const db=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{
    const result=await db.query(sql,args)
    return {...result,rowCount:result.rows.length||result.affectedRows||0}
  }
  // Requests below are sequential. Multi-connection races have a separate Docker test.
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool)
  let locked=false
  const app=express()
  app.use('/sale',saleRouter((req,res,next)=>{
    if(!['alice','bob'].includes(req.get('x-test-user')??'')){res.sendStatus(401);return}
    next()
  },req=>(req as express.Request).get('x-test-user')!,()=>['https://agntmpp.xyz'],{
    service:()=>service,
    assertLaunchReady:()=>{if(locked)throw new SaleError('real_money_sale_not_ready',503)},
    validateDestination:async address=>{if(address!=='synthetic-test-recipient')throw new SaleError('invalid_destination')},
  }))
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/sale`
  const request=async(path:string,body?:unknown,user='alice')=>{
    const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'x-test-user':user,Origin:'https://agntmpp.xyz','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
    return {status:response.status,body:await response.json()}
  }
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'CLOSED',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    await configureSaleAccess(pool,30,5) // Test-only terms, not approved launch terms.
    await query("UPDATE agnt_sale SET state='OPEN' WHERE id=1")
    // Trusted observer fixture, not a client-supplied deposit assertion.
    await service.observe('alice',{receiptId:'regtest:fixture:orchard:0',txid:'a'.repeat(64),amountZatoshi:'5000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const quote=await request('/quote',{quantity:1})
    assert.equal(quote.status,200)
    const purchase={ownerId:'alice',quoteId:quote.body.id,quantity:1,maxTotalZatoshi:quote.body.totalZatoshi,curveVersion:CURVE_VERSION,idempotencyKey:randomUUID()}
    const bought=await request('/purchases',purchase)
    assert.equal(bought.status,200)
    assert.equal(bought.body.access_policy_version,quote.body.accessPolicy.version)
    assert.equal((await request('/account/export')).body.purchases[0].access_policy_version,quote.body.accessPolicy.version)
    for(const field of ['request_hash','user_id','idempotency_key'])assert.equal(Object.hasOwn(bought.body,field),false)
    // Simulate a lost response by retrying the original payload after quote expiry.
    await query("UPDATE agnt_sale_quotes SET expires_at=now()-interval '1 hour'")
    assert.equal((await request('/purchases',purchase)).body.id,bought.body.id)
    assert.equal((await request('/account')).body.balance.available,'3000000')
    assert.equal((await request('/account')).body.passes.length,1)
    assert.equal((await request('/account')).body.collectibleAccess.source,'collectible_pass')
    assert.equal((await request('/account',undefined,'bob')).body.passes.length,0)
    const lookup={kind:'purchase',idempotencyKey:purchase.idempotencyKey}
    locked=true
    assert.equal((await request('/purchases',purchase)).status,503)
    const receipt=await request(`/purchases/${bought.body.id}`)
    assert.equal(receipt.status,200)
    assert.equal(receipt.body.userId,'alice')
    assert.deepEqual(receipt.body.purchase,bought.body)
    assert.deepEqual(receipt.body.accessPolicy,quote.body.accessPolicy)
    assert.equal(receipt.body.metadataVerified,true)
    assert.equal(receipt.body.signature,null)
    assert.equal(receipt.body.signatureVerification,'not_signed')
    const receiptKey=generateKeyPairSync('ed25519')
    await signPurchaseReceipt(pool,bought.body.id,receiptKey.privateKey)
    const signedDownload=(await request(`/purchases/${bought.body.id}`)).body
    assert.equal(signedDownload.signatureVerification,'requires_trusted_public_key')
    const signedPayload=JSON.parse(verifyReceiptBytes(signedDownload.signature,receiptKey.publicKey).toString('utf8'))
    assert.equal(signedPayload.userId,'alice')
    assert.equal(signedPayload.purchaseId,bought.body.id)
    assert.equal(signedPayload.totalZatoshi,bought.body.total)
    assert.equal(receipt.body.passes[0].serial,1)
    assert.deepEqual(receipt.body.passes[0].metadata.accessPolicy,quote.body.accessPolicy)
    assert.equal(createHash('sha256').update(JSON.stringify(receipt.body.passes[0].metadata)).digest('hex'),receipt.body.passes[0].metadata_hash)
    assert.equal((await request(`/purchases/${bought.body.id}`,undefined,'bob')).status,404)
    assert.equal((await request(`/purchases/${randomUUID()}`)).status,404)
    assert.equal((await request('/purchases/not-a-uuid')).status,400)
    const anonymous=await fetch(url+`/purchases/${bought.body.id}`)
    assert.equal(anonymous.status,401)
    assert.equal(anonymous.headers.get('cache-control'),'no-store')
    assert.equal((await request('/request-status',lookup)).body.receipt.id,bought.body.id)
    assert.equal((await request('/request-status',lookup)).body.receipt.access_policy_version,quote.body.accessPolicy.version)
    assert.equal((await request('/request-status',lookup,'bob')).body.status,'UNKNOWN')
    locked=false
    const withdrawal={ownerId:'alice',destination:'synthetic-test-recipient',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:randomUUID()}
    const held=await request('/withdrawals',withdrawal)
    assert.equal(held.status,200)
    assert.equal((await request('/withdrawals',withdrawal)).body.id,held.body.id)
    assert.equal((await request('/account')).body.balance.held,'1010000')
    assert.equal((await request(`/withdrawals/${held.body.id}/cancel`,{},'bob')).status,404)
    locked=true
    assert.equal((await request('/request-status',{kind:'withdrawal',idempotencyKey:withdrawal.idempotencyKey})).body.receipt.state,'HELD')
    const payoutStatus=await request(`/withdrawals/${held.body.id}`)
    assert.equal(payoutStatus.status,200)
    assert.equal(payoutStatus.body.userId,'alice')
    assert.equal(payoutStatus.body.withdrawal.state,'HELD')
    assert.equal(payoutStatus.body.withdrawal.amount,'1000000')
    assert.equal(payoutStatus.body.withdrawal.actual_fee,null)
    for(const field of ['signer_reference','request_hash','idempotency_key'])assert.equal(Object.hasOwn(payoutStatus.body.withdrawal,field),false)
    assert.equal((await request(`/withdrawals/${held.body.id}`,undefined,'bob')).status,404)
    assert.equal((await request(`/withdrawals/${randomUUID()}`)).status,404)
    assert.equal((await request('/withdrawals/invalid')).status,400)
    assert.equal((await fetch(url+`/withdrawals/${held.body.id}`)).status,401)
    assert.equal((await request(`/withdrawals/${held.body.id}/cancel`,{})).status,200)
    assert.equal((await request(`/withdrawals/${held.body.id}/cancel`,{})).status,200)
    const account=(await request('/account')).body
    assert.equal(account.balance.available,'3000000')
    assert.equal(account.balance.held,'0')
    assert.equal(account.withdrawals[0].state,'CANCELED')
    assert.equal((await request(`/withdrawals/${held.body.id}`)).body.withdrawal.state,'CANCELED')
    assert.equal((await reconcileSale(pool)).ok,true)
    const canceledKey=randomUUID()
    assert.equal((await request('/cancel-pending-request',{ownerId:'alice',kind:'purchase',idempotencyKey:canceledKey})).body.status,'CANCELED')
    assert.equal((await request('/cancel-pending-request',{ownerId:'alice',kind:'purchase',idempotencyKey:canceledKey})).body.status,'CANCELED')
    assert.equal((await request('/cancel-pending-request',{kind:'purchase',idempotencyKey:purchase.idempotencyKey})).body.receipt.id,bought.body.id)
    locked=false
    assert.equal((await request('/purchases',{...purchase,idempotencyKey:canceledKey})).body.error,'request_canceled')
    const canceledWithdrawalKey=randomUUID()
    await request('/cancel-pending-request',{kind:'withdrawal',idempotencyKey:canceledWithdrawalKey})
    assert.equal((await request('/withdrawals',{...withdrawal,idempotencyKey:canceledWithdrawalKey})).body.error,'request_canceled')
    assert.equal((await request('/request-status',{kind:'withdrawal',idempotencyKey:canceledWithdrawalKey},'bob')).body.status,'UNKNOWN')
    assert.equal((await request('/account')).body.balance.available,'3000000')
    locked=false
    const second={...withdrawal,idempotencyKey:randomUUID()}
    const approvedHold=await request('/withdrawals',second)
    await approveFixtureWithdrawal(service,pool,'alice',approvedHold.body.id)
    const approvedRetry=await request('/withdrawals',second)
    assert.equal(approvedRetry.body.state,'APPROVED')
    for(const field of ['signer_reference','request_hash','user_id','idempotency_key'])assert.equal(Object.hasOwn(approvedRetry.body,field),false)
    assert.equal((await request(`/withdrawals/${approvedHold.body.id}/cancel`,{})).status,409)
    assert.equal((await reconcileSale(pool)).ok,true)
  }finally{
    server.closeAllConnections()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    await db.close()
  }
})
