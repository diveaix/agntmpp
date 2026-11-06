import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { SignerArtifacts, type SignedArtifact } from '../sale/signer-artifacts.js'

test('signer database response failures preserve claims or replay committed bytes without signing twice',async(t)=>{
  for(const boundary of ['wallet-claim','intent','artifact','unlock'] as const){
    for(const timing of ['before','after'] as const){
      await t.test(`${boundary}: failure ${timing} statement commit`,async()=>{
        const db=new PGlite()
        let armed=false,calls=0
        const statement={
          'wallet-claim':'INSERT INTO agnt_wallet_signing_locks',
          intent:'INSERT INTO agnt_signing_intents',
          artifact:'INSERT INTO agnt_signed_artifacts',
          unlock:'DELETE FROM agnt_wallet_signing_locks',
        }[boundary]
        const pool={query:async(sql:string,args?:unknown[])=>{
          if(armed&&sql.startsWith(statement)){
            armed=false
            if(timing==='after')await db.query(sql,args)
            throw new Error('simulated signer database response failure')
          }
          return db.query(sql,args)
        }} as unknown as Pool
        const store=new SignerArtifacts(pool),wallet='11111111-1111-1111-1111-111111111111'
        const intent={reference:'withdrawal:failure',network:'regtest' as const,intentHash:'a'.repeat(64)}
        const result={txid:'b'.repeat(64),rawHex:'01020304',actualFeeZatoshi:'1000'}
        const sign=async()=>{calls++;return result}
        try{
          await store.migrate()
          armed=true
          await assert.rejects(store.signForWallet(wallet,intent,sign),/simulated signer database response failure/)
          const saved=boundary==='unlock'||(boundary==='artifact'&&timing==='after')
          const unclaimed=boundary==='wallet-claim'&&timing==='before'
          assert.equal(calls,boundary==='artifact'||boundary==='unlock'?1:0)
          assert.equal((await db.query('SELECT * FROM agnt_signed_artifacts')).rows.length,saved?1:0)
          assert.equal((await db.query('SELECT * FROM agnt_wallet_signing_locks')).rows.length,unclaimed||(boundary==='unlock'&&timing==='after')?0:1)
          const restarted=new SignerArtifacts(pool)
          if(saved||unclaimed){
            assert.deepEqual(await restarted.signForWallet(wallet,intent,sign),{...intent,...result})
            assert.equal(calls,1,'Only an unclaimed request may sign; saved artifacts must replay')
            assert.equal((await db.query('SELECT * FROM agnt_wallet_signing_locks')).rows.length,0)
          }else{
            const callsBefore=calls
            await assert.rejects(restarted.signForWallet(wallet,intent,sign),/treasury_signing_busy_or_review_required/)
            await assert.rejects(restarted.signForWallet(wallet,{...intent,reference:'withdrawal:replacement'},sign),/treasury_signing_busy_or_review_required/)
            assert.equal(calls,callsBefore,'Ambiguous claims must block retries and replacement intents')
          }
        }finally{await db.close()}
      })
    }
  }
})

test('wallet signing serializes distinct intents and retains ambiguous locks across worker restart',async()=>{
  const db=new PGlite(),pool={query:(sql:string,args?:unknown[])=>db.query(sql,args)} as unknown as Pool
  const store=new SignerArtifacts(pool),wallet='11111111-1111-1111-1111-111111111111'
  const intent=(reference:string)=>({reference,network:'regtest' as const,intentHash:'a'.repeat(64)})
  const result=(char:string)=>({txid:char.repeat(64),rawHex:'00',actualFeeZatoshi:'0'})
  try{
    await store.migrate()
    let entered!:()=>void,release!:()=>void,calls=0
    const started=new Promise<void>(resolve=>{entered=resolve}),pending=new Promise<void>(resolve=>{release=resolve})
    const first=store.signForWallet(wallet,intent('wallet:first'),async()=>{calls++;entered();await pending;return result('b')})
    await started
    try{
      await assert.rejects(store.signForWallet(wallet,intent('wallet:second'),async()=>{calls++;return result('c')}),/treasury_signing_busy/)
      assert.equal(calls,1)
    }finally{release()}
    await first
    await store.signForWallet(wallet,intent('wallet:second'),async()=>{calls++;return result('c')})
    assert.equal(calls,2)
    await assert.rejects(store.signForWallet(wallet,intent('wallet:lost'),async()=>{throw new Error('lost response')}),/lost response/)
    const restarted=new SignerArtifacts(pool)
    await assert.rejects(restarted.signForWallet(wallet,intent('wallet:later'),async()=>result('d')),/treasury_signing_busy/)
    await assert.rejects(restarted.signForWallet(wallet,intent('wallet:lost'),async()=>result('d')),/treasury_signing_busy/)
    assert.equal((await db.query('SELECT * FROM agnt_wallet_signing_locks')).rows.length,1)
    // Model a verified artifact recovered after the wallet completed but the
    // worker lost its response. No live signing or unverified automatic repair.
    await restarted.save({...intent('wallet:lost'),...result('d')})
    await restarted.signForWallet(wallet,intent('wallet:lost'),async()=>{throw new Error('must not re-sign')})
    assert.equal((await db.query('SELECT * FROM agnt_wallet_signing_locks')).rows.length,0)
    await restarted.signForWallet(wallet,intent('wallet:later'),async()=>result('e'))
  }finally{await db.close()}
})

test('signed artifacts are immutable, replayable, identity-bound and integrity checked',async()=>{
  const db=new PGlite()
  const store=new SignerArtifacts({query:(sql:string,args?:unknown[])=>db.query(sql,args)} as unknown as Pool)
  try {
    await store.migrate()
    const artifact:SignedArtifact={reference:'withdrawal:1',network:'regtest',intentHash:'a'.repeat(64),txid:'b'.repeat(64),rawHex:'01020304',actualFeeZatoshi:'1000'}
    assert.equal(await store.load('missing'),null)
    await assert.rejects(store.save(artifact),/signing_intent_conflict/)
    await store.begin(artifact.reference,artifact.network,artifact.intentHash)
    await assert.rejects(store.begin(artifact.reference,artifact.network,artifact.intentHash),/signing_already_started/)
    await assert.rejects(store.begin(artifact.reference,'mainnet',artifact.intentHash),/signing_intent_conflict/)
    assert.deepEqual(await store.save(artifact),artifact)
    assert.deepEqual(await store.save(artifact),artifact)
    assert.deepEqual(await store.signOnce(artifact,async()=>{throw new Error('must not sign again')}),artifact)
    await assert.rejects(store.signOnce({...artifact,network:'mainnet'},async()=>{throw new Error('must not sign')}),/signing_intent_conflict/)
    let attempts=0
    const ambiguous={reference:'withdrawal:unknown',network:'regtest' as const,intentHash:'f'.repeat(64)}
    await assert.rejects(store.signOnce(ambiguous,async()=>{attempts++;throw new Error('simulated lost wallet response')}),/simulated lost wallet response/)
    await assert.rejects(store.signOnce(ambiguous,async()=>{attempts++;return {txid:'e'.repeat(64),rawHex:'0506',actualFeeZatoshi:'1000'}}),/signing_already_started/)
    assert.equal(attempts,1)
    const fresh={reference:'withdrawal:fresh',network:'regtest' as const,intentHash:'f'.repeat(64)}
    const signed=await store.signOnce(fresh,async()=>{
      const claim=await db.query('SELECT reference FROM agnt_signing_intents WHERE reference=$1',[fresh.reference])
      assert.equal(claim.rows.length,1,'Intent must be committed before wallet contact')
      return {txid:'e'.repeat(64),rawHex:'0506',actualFeeZatoshi:'1000'}
    })
    assert.equal(signed.rawHex,'0506')
    for(const changed of [{actualFeeZatoshi:'2000'},{rawHex:'05060708'},{intentHash:'c'.repeat(64)},{network:'testnet' as const},{txid:'d'.repeat(64)},{reference:'withdrawal:2'}]){
      await assert.rejects(store.save({...artifact,...changed}),/signed_artifact_conflict|signing_intent_conflict/)
    }
    assert.deepEqual(await new SignerArtifacts({query:(sql:string,args?:unknown[])=>db.query(sql,args)} as unknown as Pool).load(artifact.reference),artifact)
    for(const changed of [{rawHex:'0'},{rawHex:'xyz'},{rawHex:''},{reference:'../escape'},{txid:'not-a-txid'}]){
      await assert.rejects(store.save({...artifact,...changed}),/invalid_signed_artifact/)
    }
    for(const [column,value] of [['txid','not-a-txid'],['intent_hash','c'.repeat(64)],['network','mainnet']] as const){
      await db.query('BEGIN')
      try{
        await db.query(`UPDATE agnt_signed_artifacts SET ${column}=$2 WHERE reference=$1`,[artifact.reference,value])
        await assert.rejects(store.load(artifact.reference),/signed_artifact_corrupt/)
        await assert.rejects(store.signOnce(artifact,async()=>{assert.fail('Corrupt recovery must not re-sign')}),/signed_artifact_corrupt/)
      }finally{await db.query('ROLLBACK')}
    }
    await db.query('BEGIN')
    try{
      await db.query('DELETE FROM agnt_signing_intents WHERE reference=$1',[artifact.reference])
      await assert.rejects(store.load(artifact.reference),/signed_artifact_corrupt/)
    }finally{await db.query('ROLLBACK')}
    assert.deepEqual(await store.load(artifact.reference),artifact)
    await db.query("UPDATE agnt_signed_artifacts SET raw_hex='05060708' WHERE reference=$1",[artifact.reference])
    await assert.rejects(store.load(artifact.reference),/signed_artifact_corrupt/)
  } finally {await db.close()}
})
