import test from 'node:test'
import assert from 'node:assert/strict'
import { saleApi, isDefinitiveSaleRejection, SaleApiError, readPurchaseReceipt } from '../../client/sale-api.js'

test('receipt download verifies account and purchase identity without mutating requests',async()=>{
  const valid={userId:'alice',purchase:{id:'receipt',total:'2000000'}}
  const send=(data:unknown)=>(async(input:unknown,init?:RequestInit)=>{
    assert.equal(input,'/api/sale/purchases/receipt')
    assert.equal(init?.credentials,'include')
    assert.equal(init?.method,undefined)
    assert.equal(init?.body,undefined)
    return new Response(JSON.stringify(data),{status:200})
  }) as typeof fetch
  assert.deepEqual(await readPurchaseReceipt('alice','receipt',send(valid)),valid)
  for(const invalid of [null,{}, {...valid,userId:'bob'}, {...valid,purchase:{id:'other'}}]){
    await assert.rejects(readPurchaseReceipt('alice','receipt',send(invalid)),/does not match/)
  }
})
import { loadPendingSale, savePendingSale, clearPendingSale, recoverPendingSale } from '../../client/sale-pending.js'

test('pending drafts retain their original recovery generation and reject invalid generations',()=>{
  const data=new Map<string,string>()
  const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}
  const draft={ownerId:'alice',destination:'test-address',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:'original-key',requestGeneration:3}
  savePendingSale('alice','withdrawal',draft,storage)
  assert.deepEqual(loadPendingSale('alice','withdrawal',storage),draft)
  assert.throws(()=>savePendingSale('alice','withdrawal',{...draft,requestGeneration:4},storage),/existing pending/)
  clearPendingSale('alice','withdrawal',storage)
  for(const requestGeneration of [-1,1.5,2147483648,NaN])assert.throws(()=>savePendingSale('alice','withdrawal',{...draft,requestGeneration},storage),/Invalid pending/)
})

test('pending purchase preserves quoted terms and accepts legacy recovery without inventing terms',()=>{
  const data=new Map<string,string>()
  const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}
  const draft={ownerId:'alice',quoteId:'quote',quantity:1,maxTotalZatoshi:'2000000',curveVersion:'curve',idempotencyKey:'original',expiresAt:new Date().toISOString()}
  const accessPolicy={version:'a'.repeat(64),durationDays:30,dailyCalls:5}
  savePendingSale('alice','purchase',{...draft,accessPolicy},storage)
  assert.deepEqual(loadPendingSale('alice','purchase',storage),{...draft,accessPolicy})
  assert.throws(()=>savePendingSale('alice','purchase',{...draft,accessPolicy:{...accessPolicy,dailyCalls:6}},storage),/existing pending/)
  clearPendingSale('alice','purchase',storage)
  assert.throws(()=>savePendingSale('alice','purchase',{...draft,accessPolicy:{...accessPolicy,durationDays:0}},storage),/Invalid pending/)
  savePendingSale('alice','purchase',draft,storage)
  assert.deepEqual(loadPendingSale('alice','purchase',storage),draft)
})

test('recovery preserves uncertain drafts and only clears authenticated recorded receipts',async()=>{
  const data=new Map<string,string>()
  const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}
  const draft={ownerId:'alice',destination:'test-address',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:'original-key'}
  savePendingSale('alice','withdrawal',draft,storage)
  assert.equal((await recoverPendingSale('alice',async()=>{throw new Error('offline')},storage)).length,1)
  assert.deepEqual(loadPendingSale('alice','withdrawal',storage),draft)
  await recoverPendingSale('alice',async()=>({userId:'alice',kind:'withdrawal',status:'UNKNOWN',receipt:null}),storage)
  assert.deepEqual(loadPendingSale('alice','withdrawal',storage),draft)
  for(const response of [null,{userId:'bob',kind:'withdrawal',status:'RECORDED',receipt:{id:'foreign'}},{userId:'alice',kind:'withdrawal',status:'RECORDED',receipt:{}}]){
    await assert.rejects(recoverPendingSale('alice',async()=>response,storage))
    assert.deepEqual(loadPendingSale('alice','withdrawal',storage),draft)
  }
  await recoverPendingSale('alice',async body=>{
    assert.deepEqual(body,{ownerId:'alice',kind:'withdrawal',idempotencyKey:draft.idempotencyKey})
    return {userId:'alice',kind:'withdrawal',status:'RECORDED',receipt:{id:'saved-hold'}}
  },storage)
  assert.equal(loadPendingSale('alice','withdrawal',storage),null)
})

test('pending requests survive reload reads, stay account scoped and cannot be overwritten',()=>{
  const data=new Map<string,string>()
  const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}
  const draft={ownerId:'alice',destination:'test-address',amountZatoshi:'1000000',feeLimitZatoshi:'10000',idempotencyKey:'original-key'}
  savePendingSale('alice','withdrawal',draft,storage)
  assert.deepEqual(loadPendingSale('alice','withdrawal',storage),draft)
  assert.equal(loadPendingSale('bob','withdrawal',storage),null)
  assert.throws(()=>savePendingSale('alice','withdrawal',{...draft,idempotencyKey:'replacement-key'},storage),/existing pending request/)
  assert.throws(()=>savePendingSale('bob','withdrawal',draft,storage),/Invalid pending/)
  const [key]=data.keys()
  storage.setItem(key,'broken JSON')
  assert.throws(()=>loadPendingSale('alice','withdrawal',storage),/unreadable/)
  clearPendingSale('alice','withdrawal',storage)
  assert.equal(loadPendingSale('alice','withdrawal',storage),null)
  assert.equal(isDefinitiveSaleRejection(new SaleApiError('sale_account_changed',409)),false)
  assert.equal(isDefinitiveSaleRejection(new SaleApiError('idempotency_conflict',409)),false)
})

test('malformed or missing mutation receipts remain ambiguous and retain retry identity',async()=>{
  const request={idempotencyKey:'same-key',quantity:1}
  const bodies:unknown[]=[]
  const send:typeof fetch=async(_input,options)=>{
    bodies.push(options?.body)
    return bodies.length===1?new Response('<html>proxy failure</html>',{status:200}):Response.json({id:'saved-purchase'})
  }
  await assert.rejects(saleApi('/purchases',request,send),error=>{
    assert.equal(isDefinitiveSaleRejection(error),false)
    return true
  })
  assert.deepEqual(await saleApi('/purchases',request,send),{id:'saved-purchase'})
  assert.equal(bodies[0],bodies[1])
  await assert.rejects(saleApi('/withdrawals',request,async()=>Response.json({error:'missing receipt'})),/Missing transaction receipt/)
})

test('timeouts, rate limiting and server failures cannot reset an ambiguous request',()=>{
  for(const status of [408,429,500,502,503])assert.equal(isDefinitiveSaleRejection(new SaleApiError('error',status)),false)
  for(const status of [400,401,403,409])assert.equal(isDefinitiveSaleRejection(new SaleApiError('error',status)),true)
  assert.equal(isDefinitiveSaleRejection(new TypeError('network failed')),false)
})
