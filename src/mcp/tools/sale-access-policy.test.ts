import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { accessPolicy, parseAccessPolicy, configureSaleAccess, readAccessPolicy } from '../sale/access-policy.js'
import { SaleService } from '../sale/service.js'
import { CURVE_VERSION, SCHEDULE_HASH } from '../sale/pricing.js'
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto'
import { reconcileSale } from '../sale/reconcile.js'
import { passMetadataHash } from '../sale/pass-metadata.js'
import { issuancePayload } from '../sale/receipt-payload.js'
import { signReceiptBytes, verifyReceiptBytes } from '../sale/receipt-signature.js'
import { signPurchaseReceipt } from '../sale/receipt-worker.js'

test('metadata hashing preserves issued format and ignores caller object key order',()=>{
  const policy=accessPolicy(30,5)
  const original=createHash('sha256').update(JSON.stringify({collection:CURVE_VERSION,serial:1,model:'database-managed',transferable:false,accessPolicy:policy})).digest('hex')
  assert.equal(passMetadataHash(1,policy),original)
  assert.equal(passMetadataHash(1,{dailyCalls:5,durationDays:30,version:policy.version}),original)
  assert.notEqual(passMetadataHash(2,policy),original)
  assert.notEqual(passMetadataHash(1,accessPolicy(30,6)),original)
})

test('reconciliation pauses and freezes an issued purchase with missing policy binding',async()=>{
  const db=new PGlite(),query=(sql:string,args?:unknown[])=>db.query(sql,args)
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool)
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query('INSERT INTO agnt_sale(id,curve_version,schedule_hash) VALUES(1,$1,$2)',[CURVE_VERSION,SCHEDULE_HASH])
    assert.equal((await reconcileSale(pool)).ok,true,'An unissued, unconfigured closed collection is valid')
    await configureSaleAccess(pool,30,5)
    await db.exec("UPDATE agnt_sale SET state='OPEN'")
    await service.observe('alice',{receiptId:'fixture',txid:'a'.repeat(64),amountZatoshi:'3000000',confirmations:3,blockHash:'b'.repeat(64),canonical:true},3)
    const quote=await service.quote('alice',1)
    const purchase=await service.purchase('alice',{quoteId:quote.id,quantity:1,maxTotalZatoshi:quote.totalZatoshi,curveVersion:quote.curveVersion,idempotencyKey:randomUUID()})
    assert.equal((await reconcileSale(pool)).ok,true)
    const issued=await service.purchaseReceipt('alice',purchase.id)
    const payload=issuancePayload(issued)
    assert.equal(JSON.parse(payload.toString()).totalZatoshi,'2000000')
    assert.deepEqual(issuancePayload(await service.purchaseReceipt('alice',purchase.id)),payload)
    const signingKey=generateKeyPairSync('ed25519') // Ephemeral test key only.
    assert.deepEqual(verifyReceiptBytes(signReceiptBytes(payload,signingKey.privateKey),signingKey.publicKey),payload)
    const signed=await signPurchaseReceipt(pool,purchase.id,signingKey.privateKey)
    assert.deepEqual(verifyReceiptBytes(signed,signingKey.publicKey),payload)
    assert.deepEqual(await signPurchaseReceipt(pool,purchase.id,signingKey.privateKey),signed)
    await assert.rejects(signPurchaseReceipt(pool,purchase.id,generateKeyPairSync('ed25519').privateKey),/signature_invalid/)
    await assert.rejects(query('UPDATE agnt_sale_signed_receipts SET envelope=$1 WHERE purchase_id=$2',['{}',purchase.id]),/signed_receipt_is_immutable/)
    await assert.rejects(query('DELETE FROM agnt_sale_signed_receipts WHERE purchase_id=$1',[purchase.id]),/signed_receipt_is_immutable/)
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    assert.deepEqual(await signPurchaseReceipt(pool,purchase.id,signingKey.privateKey),signed,'Migration replay preserves signature bytes')
    assert.throws(()=>issuancePayload({...issued,purchase:{...issued.purchase,total:'1'}}),/integrity_failed/)
    assert.throws(()=>issuancePayload({...issued,passes:[]}),/integrity_failed/)
    assert.throws(()=>issuancePayload({...issued,passes:[{...issued.passes[0],metadata_hash:'changed'}]}),/integrity_failed/)
    assert.throws(()=>issuancePayload({...issued,purchase:{...issued.purchase,access_policy_version:'changed'}}),/integrity_failed/)
    await query('UPDATE agnt_sale_purchases SET access_policy_version=NULL WHERE id=$1',[purchase.id])
    const result=await reconcileSale(pool)
    assert.equal(result.ok,false)
    assert.deepEqual(result.issues,[{code:'purchase_access_policy_mismatch',userId:'alice'}])
    assert.equal((await service.summary()).state,'PAUSED')
    assert.equal((await service.account('alice')).balance.frozen,true)
    assert.equal((await service.account('alice')).balance.available,'1000000','Review never rewrites the financial history')
    assert.equal((await service.purchaseReceipt('alice',purchase.id)).purchase.access_policy_version,null,'Reconciliation does not invent replacement terms')
    await query('UPDATE agnt_sale_passes SET metadata_hash=$1 WHERE owner_id=$2',['tampered','alice'])
    const corrupted=await reconcileSale(pool)
    assert.ok(corrupted.issues.some(issue=>issue.code==='pass_metadata_mismatch'&&issue.userId==='alice'))
    assert.equal((await service.account('alice')).passes[0].metadata_hash,'tampered','Report corruption without replacing the evidence')
    const damaged=await service.purchaseReceipt('alice',purchase.id)
    assert.equal(damaged.metadataVerified,false)
    assert.equal(damaged.accessPolicy,null)
    assert.equal(damaged.passes[0].metadata,null)
    assert.equal(damaged.passes[0].metadata_hash,'tampered')
    assert.equal(damaged.signature,null)
    assert.equal(damaged.signatureVerification,'stored_signature_mismatch')
    assert.throws(()=>issuancePayload(damaged),/integrity_failed/)
  }finally{await db.close()}
})

test('purchase binds quoted terms and cannot debit unset or changed policies',async()=>{
  const db=new PGlite(),query=(sql:string,args?:unknown[])=>db.query(sql,args)
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new SaleService(pool)
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query('INSERT INTO agnt_sale(id,curve_version,schedule_hash) VALUES(1,$1,$2)',[CURVE_VERSION,SCHEDULE_HASH])
    await db.exec("INSERT INTO agnt_sale_accounts(user_id,available) VALUES('alice',10000000)")
    const preview=await service.quote('alice',1)
    assert.equal(preview.accessPolicy,null)
    assert.equal((await service.accessSnapshot('alice')).reason,'access_terms_unconfigured')
    await assert.rejects(service.consumeAccess('alice'),/access_terms_unconfigured/)
    const request=(quote:typeof preview)=>({quoteId:quote.id,quantity:1,maxTotalZatoshi:quote.totalZatoshi,curveVersion:quote.curveVersion,idempotencyKey:randomUUID()})
    await db.exec("UPDATE agnt_sale SET state='OPEN'")
    await assert.rejects(service.purchase('alice',request(preview)),/access_terms_unconfigured/)
    await db.exec("UPDATE agnt_sale SET state='CLOSED'")
    const original=await configureSaleAccess(pool,30,5)
    const oldQuote=await service.quote('alice',1)
    assert.deepEqual(oldQuote.accessPolicy,original)
    const replacement=await configureSaleAccess(pool,60,5)
    await db.exec("UPDATE agnt_sale SET state='OPEN'")
    await assert.rejects(service.purchase('alice',request(oldQuote)),/access_policy_changed/)
    await assert.rejects(service.purchase('alice',request(preview)),/access_policy_changed/)
    assert.equal((await service.account('alice')).balance.available,'10000000')
    assert.equal((await service.summary()).sold,0)
    const fresh=await service.quote('alice',1),input=request(fresh)
    const purchase=await service.purchase('alice',input)
    assert.equal(purchase.access_policy_version,replacement.version)
    await db.exec("UPDATE agnt_sale SET state='CLOSED'")
    await assert.rejects(configureSaleAccess(pool,90,5),/configuration_locked/)
    await assert.rejects(db.exec('UPDATE agnt_sale SET access_daily_calls=6'),/issued_access_policy_is_immutable/)
    assert.equal((await service.purchase('alice',input)).id,purchase.id,'Replay returns the original issued receipt even after closure')
    assert.equal((await service.account('alice')).balance.available,'8000000')
    assert.equal((await service.accessSnapshot('alice')).policyVersion,replacement.version)
    assert.equal((await service.accessSnapshot('alice')).durationDays,60)
    // Legacy/unbound rows never inherit rights from the collection policy.
    await query('UPDATE agnt_sale_purchases SET access_policy_version=NULL WHERE id=$1',[purchase.id])
    assert.equal((await service.accessSnapshot('alice')).eligible,false)
    await assert.rejects(service.consumeAccess('alice'),/access_pass_required/)
    await query('UPDATE agnt_sale_purchases SET access_policy_version=$2,created_at=now()-interval \'61 days\' WHERE id=$1',[purchase.id,replacement.version])
    assert.equal((await service.accessSnapshot('alice')).eligible,false)
    await assert.rejects(service.consumeAccess('alice'),/access_pass_required/)
    await query('UPDATE agnt_sale_purchases SET created_at=now() WHERE id=$1',[purchase.id])
    for(let i=0;i<5;i++)await service.consumeAccess('alice')
    await assert.rejects(service.consumeAccess('alice'),/daily_tool_limit/)
    assert.equal((await service.accessSnapshot('alice')).remainingToday,0)
  }finally{await db.close()}
})

test('collection terms require explicit values and cannot change after issuance',async()=>{
  const db=new PGlite(),query=(sql:string,args?:unknown[])=>db.query(sql,args)
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await db.exec("INSERT INTO agnt_sale(id,curve_version,schedule_hash) VALUES(1,'fixture','fixture')")
    await assert.rejects(readAccessPolicy(pool),/access_terms_unconfigured/)
    for(const value of [0,-1,1.1,NaN,Infinity,10000000])assert.throws(()=>accessPolicy(value,1),/access_terms_unconfigured/)
    const policy=await configureSaleAccess(pool,30,5) // Explicit test terms only.
    assert.deepEqual(await readAccessPolicy(pool),policy)
    assert.notEqual(accessPolicy(30,6).version,policy.version)
    assert.throws(()=>parseAccessPolicy({access_policy_version:'tampered',access_duration_days:30,access_daily_calls:5}),/integrity_mismatch/)
    await db.exec("UPDATE agnt_sale SET state='OPEN'")
    await assert.rejects(configureSaleAccess(pool,31,5),/configuration_locked/)
    await db.exec("UPDATE agnt_sale SET sold=1,state='CLOSED'")
    await assert.rejects(configureSaleAccess(pool,31,5),/configuration_locked/)
    await assert.rejects(db.exec('UPDATE agnt_sale SET access_duration_days=31'),/issued_access_policy_is_immutable/)
    assert.deepEqual(await readAccessPolicy(pool),policy)
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    assert.deepEqual(await readAccessPolicy(pool),policy,'Migration rerun must not replace stored terms')
  }finally{await db.close()}
})
