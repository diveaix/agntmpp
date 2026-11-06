import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { SignerArtifacts } from '../sale/signer-artifacts.js'
import { signerOperationsStatus } from '../sale/signer-status.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('signer status CLI fails unavailable without a configured signer database',async()=>{
  await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx/esm','scripts/sale-signer-status.ts'],{
    env:{...process.env,AGNT_SALE_SIGNER_DATABASE_URL:''},timeout:15000,
  }),error=>{
    const result=error as Error&{stdout:string;stderr:string;code:number}
    assert.equal(result.code,1)
    assert.equal(result.stdout,'')
    assert.equal(result.stderr.trim(),'sale_signer_status_unavailable')
    return true
  })
})

test('signer status distinguishes unresolved claims, saved artifacts and conflicting records without exposing authority',async()=>{
  const db=new PGlite(),queries:string[]=[]
  const query=async(sql:string,args?:unknown[])=>{queries.push(sql);return db.query(sql,args)}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const store=new SignerArtifacts(pool)
  try{
    await store.migrate()
    const empty=await signerOperationsStatus(pool)
    assert.equal(empty.unresolvedSigning,false)
    assert.equal(empty.integrityReviewRequired,false)
    assert.equal(empty.intents.oldest_unresolved_seconds,null)
    await query("INSERT INTO agnt_wallet_signing_locks(network,wallet_account_uuid,reference) VALUES('regtest','private-wallet','private-reference')")
    const claimed=await signerOperationsStatus(pool)
    assert.equal(claimed.locks.without_intent,1)
    assert.equal(claimed.unresolvedSigning,true)
    await store.begin('private-reference','regtest','a'.repeat(64))
    const pending=await signerOperationsStatus(pool)
    assert.equal(pending.intents.without_artifact,1)
    assert.equal(pending.locks.without_intent,0)
    await store.save({reference:'private-reference',network:'regtest',intentHash:'a'.repeat(64),txid:'b'.repeat(64),rawHex:'010203',actualFeeZatoshi:'1000'})
    queries.length=0
    const saved=await signerOperationsStatus(pool)
    assert.equal(saved.locks.with_artifact,1)
    assert.equal(saved.intents.without_artifact,0)
    assert.equal(saved.unresolvedSigning,true,'Artifact saved before lock cleanup is still unresolved')
    assert.equal(saved.artifactBytesVerified,false)
    assert.ok(!JSON.stringify(saved).includes('private-'))
    assert.ok(!JSON.stringify(saved).includes('010203'))
    assert.ok(queries.every(sql=>!/^(INSERT|UPDATE|DELETE|ALTER)/.test(sql)))
    await query("UPDATE agnt_signing_intents SET network='mainnet' WHERE reference='private-reference'")
    const mismatch=await signerOperationsStatus(pool)
    assert.equal(mismatch.integrityReviewRequired,true)
    assert.equal(mismatch.artifacts.intent_mismatches,1)
    assert.equal(mismatch.lockMismatches,1)
    assert.equal((await query('SELECT * FROM agnt_wallet_signing_locks')).rows.length,1)
  }finally{await db.close()}
})
