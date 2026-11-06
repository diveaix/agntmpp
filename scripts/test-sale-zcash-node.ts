import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { testRegtestWallet } from './zcash-regtest-wallet.js'
import { canonicalTransactionEvidence } from '../src/mcp/sale/zcash-observer.js'
import { recoverDepositCursor } from '../src/mcp/sale/deposit-recovery.js'
import { reviewAssignedDeposit } from '../src/mcp/sale/deposit-worker.js'
import { SaleService } from '../src/mcp/sale/service.js'
import { SignerArtifacts } from '../src/mcp/sale/signer-artifacts.js'
import { reviewPaidWithdrawal } from '../src/mcp/sale/withdrawal-worker.js'

const exec=promisify(execFile)
const name=`agnt-zcash-test-${randomUUID()}`
const label='com.agnt.zcash-test'
let networkId:string|undefined
let containerId:string|undefined
let forkId:string|undefined
try{
  console.log('Starting isolated Zebra regtest. No public-chain access or real funds.')
  networkId=(await exec('docker',['network','create','--internal','--label',`${label}=true`,name])).stdout.trim()
  assert.match(networkId,/^[a-f0-9]{64}$/)
  assert.equal((await exec('docker',['network','inspect','--format','{{.Internal}}',networkId])).stdout.trim(),'true')
  const startNode=async(nodeName:string,alias:string)=>(await exec('docker',['run','--rm','--detach','--name',nodeName,'--label',`${label}=true`,'--network',networkId!,'--network-alias',alias,'--memory','2g','--cpus','2',
    '--tmpfs','/home/zebra/.cache/zebra:rw,size=512m','--tmpfs','/var/run/auth:rw,size=1m',
    '--mount',`type=bind,source=${resolve('integration/zcash-regtest/zebra.toml')},target=/home/zebra/.config/zebrad.toml,readonly`,
    '-e','ZEBRA_NETWORK__NETWORK=Regtest','-e','ZEBRA_RPC__LISTEN_ADDR=0.0.0.0:18232','-e','ZEBRA_RPC__ENABLE_COOKIE_AUTH=false',
    '-e','ZEBRA_STATE__CACHE_DIR=/home/zebra/.cache/zebra','-e','ZEBRA_HEALTH__MIN_CONNECTED_PEERS=0',
    '-e','ZEBRA_MINING__MINER_ADDRESS=tmSRd1r8gs77Ja67Fw1JcdoXytxsyrLTPJm',
    'zfnd/zebra:6.2.3'],{timeout:240000})).stdout.trim()
  containerId=await startNode(name,'zebra')
  assert.match(containerId,/^[a-f0-9]{64}$/)
  async function rpc(method:string,params:unknown[]=[],target=containerId!){
    const id=randomUUID()
    // Internal Docker networks do not publish host ports. Call the node's loopback
    // from inside its container; this leaves the RPC unexposed even to the host LAN.
    const response=await new Promise<string>((resolve,reject)=>{
      const child=execFile('docker',['exec','-i',target,'curl','--fail','--silent','--show-error','--max-time','45','-H','Content-Type: application/json','--data-binary','@-','http://127.0.0.1:18232'],{timeout:50000,maxBuffer:16*1024*1024},(error,stdout)=>error?reject(new Error(`Regtest transport failed: ${error.code}`)):resolve(stdout))
      child.stdin!.on('error',()=>{})
      child.stdin!.end(JSON.stringify({jsonrpc:'2.0',id,method,params}))
    })
    const body=JSON.parse(response)
    assert.equal(body.id,id)
    if(body.error)throw new Error(`Regtest RPC ${method} failed: ${body.error.code}`)
    return body.result
  }
  let info:{chain:string;blocks:number}|undefined
  for(let attempt=0;attempt<60;attempt++){
    try{info=await rpc('getblockchaininfo');break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}
  }
  assert.ok(info,'Regtest RPC did not become ready')
  // Zebra 6.2.3 labels regtest as "test" in this RPC. Verify the distinct
  // regtest genesis too; the label alone must never authorize a mining call.
  assert.equal(info.chain,'test')
  assert.equal(await rpc('getblockhash',[0]),'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327')
  assert.equal(info.blocks,0)
  const hashes=await rpc('generate',[2])
  assert.equal(hashes.length,2)
  assert.equal((await rpc('getblockchaininfo')).blocks,2)
  const block=await rpc('getblock',[hashes[1],1])
  assert.equal(block.hash,hashes[1])
  assert.equal(block.height,2)
  assert.equal(block.confirmations,1)
  assert.ok(Array.isArray(block.tx) && block.tx.length>0)
  const policy={network:'regtest' as const,genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300}
  // Zebra regtest mining starts at a historical timestamp. Verify freshness
  // rejection with the real clock, then use the explicit regtest clock.
  await assert.rejects(canonicalTransactionEvidence(rpc,policy,block.tx[0],hashes[1]),/observer_stale_tip/)
  const evidence=await canonicalTransactionEvidence(rpc,policy,block.tx[0],hashes[1],block.time)
  assert.equal(evidence.tipHeight,2)
  assert.equal(evidence.blockHeight,2)
  console.log('PASS: isolated regtest identity, local mining, canonical block hash, height, confirmations, and transaction membership.')
  if(process.argv.includes('--fork')){
    forkId=await startNode(`${name}-fork`,'zebra-fork')
    assert.match(forkId,/^[a-f0-9]{64}$/)
    const forkRpc=(method:string,params:unknown[]=[])=>rpc(method,params,forkId!)
    let ready=false
    for(let attempt=0;attempt<60;attempt++){
      try{await forkRpc('getblockchaininfo');ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}
    }
    assert.ok(ready,'Fork node did not become ready')
    assert.equal(await forkRpc('getblockhash',[0]),policy.genesisHash)
    await forkRpc('submitblock',[await rpc('getblock',[hashes[0],0])])
    assert.equal((await forkRpc('getblockchaininfo')).blocks,1)
    // A fresh shielded coinbase recipient makes the competing block distinct.
    await testRegtestWallet(networkId,containerId,rpc,async wallet=>{
      const competing=await forkRpc('generatetoaddress',[2,wallet.address])
      assert.equal(competing.length,2)
      assert.notEqual(competing[0],hashes[1])
      for(const hash of competing)await rpc('submitblock',[await forkRpc('getblock',[hash,0])])
      assert.equal((await rpc('getblockchaininfo')).blocks,3)
      assert.equal(await rpc('getblockhash',[2]),competing[0])
      const forkTip=await rpc('getblock',[competing[1],1])
      await assert.rejects(canonicalTransactionEvidence(rpc,policy,block.tx[0],hashes[1],forkTip.time),error=>{
        const message=(error as Error).message
        assert.ok(message==='observer_orphaned_block'||/^Regtest RPC getblock failed: -(5|8)$/.test(message),message)
        console.log(`Orphan evidence response: ${message}`)
        return true
      })
      await assert.rejects(canonicalTransactionEvidence(rpc,policy,block.tx[0],hashes[1],forkTip.time,evidence.blockHeight),/observer_orphaned_block/)
      console.log('PASS: persisted verified height proves orphaning even when the old block body is unavailable.')
      console.log('PASS: two real nodes adopt a longer competing branch; previously canonical transaction evidence is rejected after the fork.')
    })
  }
  async function replaceFundedBlock(depositBlock:{hash:string;height:number}){
    assert.equal(forkId,undefined,'Only one competing branch may be created per run')
    forkId=await startNode(`${name}-funded-fork`,'zebra-funded-fork')
    assert.match(forkId,/^[a-f0-9]{64}$/)
    const forkRpc=(method:string,params:unknown[]=[])=>rpc(method,params,forkId!)
    let ready=false
    for(let attempt=0;attempt<60;attempt++){
      try{await forkRpc('getblockchaininfo');ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}
    }
    assert.ok(ready,'Funded fork node did not become ready')
    assert.equal(await forkRpc('getblockhash',[0]),policy.genesisHash)
    console.log('Copying the common chain prefix into the isolated fork node.')
    for(let height=1;height<depositBlock.height;height++){
      await forkRpc('submitblock',[await rpc('getblock',[await rpc('getblockhash',[height]),0])])
      if(height%25===0)console.log(`Common fork prefix verified through height ${height}.`)
    }
    const oldTip=await rpc('getblockchaininfo')
    const competing=await forkRpc('generate',[oldTip.blocks-depositBlock.height+2])
    assert.notEqual(competing[0],depositBlock.hash)
    for(const hash of competing)await rpc('submitblock',[await forkRpc('getblock',[hash,0])])
    const newTip=await rpc('getblockchaininfo')
    assert.equal(newTip.blocks,oldTip.blocks+1)
    assert.notEqual(await rpc('getblockhash',[depositBlock.height]),depositBlock.hash)
    return (await rpc('getblock',[newTip.bestblockhash,1])).time as number
  }
  if(process.argv.includes('--wallet'))await testRegtestWallet(networkId,containerId,rpc,undefined,process.argv.includes('--fork-deposit')?async(db,depositBlock,txid)=>{
    const clock=await replaceFundedBlock(depositBlock)
    const service=new SaleService(db),before=await service.account('regtest-customer')
    const recovery=await recoverDepositCursor(db,rpc,policy,'regtest-customer',3,clock)
    assert.equal(recovery.rewound,true)
    const after=await service.account('regtest-customer')
    assert.equal(after.balance.available,before.balance.available)
    assert.equal(after.balance.held,'0')
    assert.equal(after.balance.frozen,true)
    assert.equal(after.passes[0].state,'SUSPENDED')
    assert.equal(after.deposits[0].state,'ORPHANED')
    assert.equal((await service.summary()).state,'PAUSED')
    await assert.rejects(service.consumeAccess('regtest-customer'),/account_frozen/)
    await assert.rejects(service.holdWithdrawal('regtest-customer',{destination:'synthetic-never-sent',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()}),/account_frozen/)
    await reviewAssignedDeposit(db,rpc,policy,'regtest-customer',txid,3,clock)
    const creditReviews=(await service.exportAccount('regtest-customer')).creditReviews
    assert.equal(creditReviews.length,1)
    assert.equal(creditReviews[0].credited_amount,'5000000')
    assert.equal(creditReviews[0].coverage_state,'ORPHANED')
    assert.equal((await service.account('regtest-customer')).balance.available,before.balance.available)
    assert.deepEqual(await recoverDepositCursor(db,rpc,policy,'regtest-customer',3,clock),{rewound:false})
    console.log('PASS: actual funded-deposit fork records one exact gross-credit review, pauses the sale, freezes unchanged credit, suspends the purchased pass, blocks access/withdrawal and replays review without duplicate credit.')
  }:undefined,process.argv.includes('--fork-paid')?async(db,paidBlock,withdrawalId)=>{
    const clock=await replaceFundedBlock(paidBlock)
    const service=new SaleService(db),artifacts=new SignerArtifacts(db)
    const before=await service.account('regtest-customer')
    assert.equal(before.withdrawals[0].state,'PAID')
    for(let repeat=0;repeat<2;repeat++)assert.deepEqual(await reviewPaidWithdrawal(db,artifacts,rpc,policy,'regtest-customer',withdrawalId,clock),{reviewRequired:true})
    const after=await service.account('regtest-customer')
    assert.equal(after.balance.available,before.balance.available)
    assert.equal(after.balance.held,'0')
    assert.equal(after.balance.frozen,true)
    assert.equal(after.passes[0].state,'SUSPENDED')
    assert.equal(after.withdrawals.length,1)
    assert.equal(after.withdrawals[0].state,'PAID')
    assert.equal((await service.summary()).state,'PAUSED')
    assert.equal((await db.query('SELECT settlement_review FROM agnt_sale_withdrawals WHERE id=$1',[withdrawalId])).rows[0].settlement_review,true)
    console.log('PASS: actual paid-withdrawal fork flags review, pauses/freezes access and preserves paid accounting without a refund or replacement withdrawal.')
  }:undefined)
}finally{
  if(forkId){
    assert.equal((await exec('docker',['inspect','--format',`{{index .Config.Labels "${label}"}}`,forkId])).stdout.trim(),'true')
    await exec('docker',['stop','--time','5',forkId])
  }
  if(containerId){
    assert.equal((await exec('docker',['inspect','--format',`{{index .Config.Labels "${label}"}}`,containerId])).stdout.trim(),'true')
    await exec('docker',['stop','--time','5',containerId])
  }
  if(networkId){
    assert.equal((await exec('docker',['network','inspect','--format',`{{index .Labels "${label}"}}`,networkId])).stdout.trim(),'true')
    await exec('docker',['network','rm',networkId])
  }
  console.log('Removed disposable regtest resources; downloaded images remain cached.')
}
