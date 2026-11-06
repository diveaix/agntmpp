import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { SignerArtifacts, type SignedArtifact } from '../src/mcp/sale/signer-artifacts.js'

const exec=promisify(execFile)

// A real PostgreSQL commit, followed by container restart and a new client.
// Only a disposable labeled database volume is created; no production URL is read.
export async function persistAndRecoverRegtestArtifact(intent: Pick<SignedArtifact,'reference'|'network'|'intentHash'>,
  sign: (db:Pool) => Promise<Pick<SignedArtifact,'txid'|'rawHex'|'actualFeeZatoshi'>>,
  afterRecovery?: (db:Pool,artifact:SignedArtifact)=>Promise<void>) {
  assert.equal(intent.network,'regtest')
  const password=randomUUID()
  const label='com.agnt.signer-test'
  const volume=`agnt-signer-test-${randomUUID()}`
  let volumeCreated=false
  let id:string|undefined, pool:Pool|undefined
  try {
    await exec('docker',['volume','create','--label',`${label}=true`,volume])
    volumeCreated=true
    id=(await exec('docker',['run','--rm','--detach','--label',`${label}=true`,'--memory','512m','--cpus','1',
      '--mount',`type=volume,source=${volume},target=/var/lib/postgresql/data`,'-e',`POSTGRES_PASSWORD=${password}`,
      '-p','127.0.0.1::5432','postgres:16-alpine'])).stdout.trim()
    assert.match(id,/^[a-f0-9]{64}$/)
    const connect=async()=>{
      const port=(await exec('docker',['port',id!,'5432/tcp'])).stdout.trim()
      assert.match(port,/^127\.0\.0\.1:\d+$/)
      pool=new Pool({host:'127.0.0.1',port:Number(port.split(':')[1]),user:'postgres',password,connectionTimeoutMillis:1000})
      for(let attempt=0;attempt<30;attempt++){
        try{await pool.query('SELECT 1');return}catch{await new Promise(resolve=>setTimeout(resolve,500))}
      }
      throw new Error('Disposable artifact database unavailable')
    }
    await connect()
    const store=new SignerArtifacts(pool!)
    await store.migrate()
    const artifact=await store.signOnce(intent,()=>sign(pool!))
    await store.signOnce(intent,async()=>{throw new Error('Replay must not contact wallet')})
    await assert.rejects(store.save({...artifact,rawHex:artifact.rawHex+'00'}),/signed_artifact_conflict/)
    await pool!.end()
    pool=undefined
    await exec('docker',['restart','--time','5',id])
    await connect()
    const recovered=await new SignerArtifacts(pool!).load(artifact.reference)
    assert.ok(recovered)
    assert.ok(recovered.rawHex===artifact.rawHex,'Stored raw transaction changed across database restart')
    console.log('PASS: committed signed artifact survives PostgreSQL process restart; replacement bytes are rejected.')
    if(afterRecovery)await afterRecovery(pool!,recovered)
    return recovered
  } finally {
    if(pool)await pool.end()
    if(id){
      assert.equal((await exec('docker',['inspect','--format',`{{index .Config.Labels "${label}"}}`,id])).stdout.trim(),'true')
      await exec('docker',['stop','--time','5',id])
    }
    if(volumeCreated){
      assert.equal((await exec('docker',['volume','inspect','--format',`{{index .Labels "${label}"}}`,volume])).stdout.trim(),'true')
      await exec('docker',['volume','rm',volume])
    }
  }
}
