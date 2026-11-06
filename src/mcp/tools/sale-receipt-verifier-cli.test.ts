import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accessPolicy } from '../sale/access-policy.js'
import { CURVE_VERSION } from '../sale/pricing.js'
import { passMetadataHash, passMetadata } from '../sale/pass-metadata.js'
import { issuancePayload } from '../sale/receipt-payload.js'
import { signReceiptBytes } from '../sale/receipt-signature.js'

test('offline verifier accepts trusted receipt and rejects wrong key or altered outer contents',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agnt-receipt-verifier-'))
  const receiptFile=join(dir,'receipt.json'),keyFile=join(dir,'public.pem')
  const key=generateKeyPairSync('ed25519'),policy=accessPolicy(30,5)
  const data={formatVersion:1,ownershipModel:'database-managed, account-bound',userId:'synthetic-owner',metadataVerified:true,accessPolicy:policy,purchase:{id:'11111111-1111-1111-1111-111111111111',first_serial:1,quantity:1,total:'2000000',curve_version:CURVE_VERSION,access_policy_version:policy.version,created_at:'2026-01-01T00:00:00.000Z'},passes:[{serial:1,metadata_hash:passMetadataHash(1,policy),metadata:passMetadata(1,policy)}]}
  const receipt={...data,signature:signReceiptBytes(issuancePayload(data),key.privateKey)}
  const run=()=>promisify(execFile)(process.execPath,['--import','tsx/esm',fileURLToPath(new URL('../../../scripts/sale-verify-receipt.ts',import.meta.url)),receiptFile,keyFile],{timeout:15000})
  try{
    await writeFile(receiptFile,JSON.stringify(receipt))
    await writeFile(keyFile,key.publicKey.export({type:'spki',format:'pem'}))
    const result=await run()
    assert.equal(JSON.parse(result.stdout).verified,true)
    assert.ok(!result.stdout.includes('synthetic-owner'))
    await writeFile(receiptFile,JSON.stringify({...receipt,userId:'changed-owner'}))
    await assert.rejects(run(),error=>(error as {stderr:string}).stderr.trim()==='receipt_verification_failed')
    await writeFile(receiptFile,JSON.stringify({...receipt,passes:[{...receipt.passes[0],metadata:{...receipt.passes[0].metadata,transferable:true}}]}))
    await assert.rejects(run(),error=>(error as {stderr:string}).stderr.trim()==='receipt_verification_failed')
    // JSON property order does not change metadata meaning.
    await writeFile(receiptFile,JSON.stringify({...receipt,passes:[{...receipt.passes[0],metadata:Object.fromEntries(Object.entries(receipt.passes[0].metadata).reverse())}]}))
    assert.equal(JSON.parse((await run()).stdout).verified,true)
    await writeFile(receiptFile,JSON.stringify(receipt))
    await writeFile(keyFile,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}))
    await assert.rejects(run(),error=>(error as {stderr:string}).stderr.trim()==='receipt_verification_failed')
  }finally{
    await unlink(receiptFile).catch(()=>{})
    await unlink(keyFile).catch(()=>{})
    await rmdir(dir)
  }
})
