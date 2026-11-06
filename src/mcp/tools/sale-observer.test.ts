import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalTransactionEvidence, verifyZalletDeposit, type ZcashRpc } from '../sale/zcash-observer.js'

const genesis='0'.repeat(64),tipHash='1'.repeat(64),blockHash='2'.repeat(64),txid='3'.repeat(64)
const policy={network:'regtest' as const,genesisHash:genesis,maxTipAgeSeconds:300}
function fixture(change:Record<string,unknown>={}):ZcashRpc{
  let tipReads=0
  return async(method,params=[])=>{
    if(method==='getblockchaininfo')return {chain:'test',blocks:100,bestblockhash:tipHash,...(tipReads++>0?change:{})}
    if(method==='getblockhash')return params[0]===0?(change.genesis??genesis):params[0]===100?tipHash:(change.canonical??blockHash)
    if(method==='getblock')return params[0]===tipHash?{hash:tipHash,height:100,time:1000,...change.tip as object}:{hash:blockHash,height:98,tx:[txid],...change.block as object}
    throw new Error(`Unexpected RPC ${method}`)
  }
}
test('observer derives confirmations from a stable canonical node snapshot',async()=>{
  const proof=await canonicalTransactionEvidence(fixture(),policy,txid,blockHash,1100)
  assert.equal(proof.tipHeight-proof.blockHeight+1,3)
  assert.deepEqual(proof.transactionIds,[txid])
})

test('persisted verified height permits orphan review without a retained block body',async()=>{
  let oldBlockReads=0
  const source=fixture({canonical:tipHash})
  const pruned:ZcashRpc=async(method,params)=>{
    if(method==='getblock'&&params?.[0]===blockHash){oldBlockReads++;throw new Error('old block unavailable')}
    return source(method,params)
  }
  await assert.rejects(canonicalTransactionEvidence(pruned,policy,txid,blockHash,1100,98),/observer_orphaned_block/)
  assert.equal(oldBlockReads,0)
  await assert.rejects(canonicalTransactionEvidence(fixture({canonical:'invalid'}),policy,txid,blockHash,1100,98),/invalid_node_response/)
  await assert.rejects(canonicalTransactionEvidence(fixture({canonical:tipHash,bestblockhash:blockHash}),policy,txid,blockHash,1100,98),/observer_tip_changed/)
  await assert.rejects(canonicalTransactionEvidence(fixture(),policy,txid,blockHash,1100,101),/observer_node_not_ready/)
  await assert.rejects(canonicalTransactionEvidence(fixture(),policy,txid,blockHash,1100,-1),/invalid_observer_policy/)
})

test('deposit verifier requires wallet sync and binds the requested transaction to the assignment',async()=>{
  const assignment={userId:'alice',network:'regtest' as const,walletAccountUuid:'account',recipientAddresses:['receiver']}
  const tx={txid,status:'mined',blockhash:blockHash,confirmations:3,spends:[],outputs:[{pool:'orchard',action:0,account_uuid:'account',address:'receiver',walletInternal:false,outgoing:false,valueZat:2000000}]}
  const status={fully_synced_height:100,wallet_tip:{height:100,blockhash:tipHash},node_tip:{height:100,blockhash:tipHash}}
  const node=()=>fixture({tip:{time:Math.floor(Date.now()/1000)}})
  const wallet:ZcashRpc=async(method)=>method==='z_viewtransaction'?tx:status
  assert.equal((await verifyZalletDeposit(wallet,node(),policy,assignment,txid))[0].amountZatoshi,'2000000')
  await assert.rejects(verifyZalletDeposit(async(method)=>method==='z_viewtransaction'?tx:{...status,fully_synced_height:99},node(),policy,assignment,txid),/observer_wallet_not_synced/)
  await assert.rejects(verifyZalletDeposit(async()=>({...tx,txid:genesis}),node(),policy,assignment,txid),/deposit_not_mined/)
})
test('observer rejects wrong network, stale tip, orphaned block, missing transaction and moving tip',async()=>{
  await assert.rejects(canonicalTransactionEvidence(fixture({canonical:tipHash,bestblockhash:blockHash}),policy,txid,blockHash,1100),/observer_tip_changed/)
  await assert.rejects(canonicalTransactionEvidence(fixture({canonical:'malformed'}),policy,txid,blockHash,1100),/invalid_node_response/)
  for(const change of [{genesis:tipHash},{tip:{time:100}},{tip:{time:1300}},{canonical:tipHash},{block:{tx:[]}},{bestblockhash:blockHash},{blocks:101}]){
    await assert.rejects(canonicalTransactionEvidence(fixture(change),policy,txid,blockHash,1100))
  }
})
