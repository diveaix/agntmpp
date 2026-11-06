import test from 'node:test'
import assert from 'node:assert/strict'
import { observeWalletInventory } from '../sale/wallet-inventory.js'
import type { ZcashRpc } from '../sale/zcash-observer.js'

test('wallet inventory uses explicit depth, exact pool amounts and stable synced evidence without asserting solvency',async()=>{
  const hash='a'.repeat(64),genesis='b'.repeat(64),account='11111111-1111-1111-1111-111111111111'
  let response:unknown={minimum_confirmations:3,pools:{orchard:{valueZat:2000000},ironwood:{valueZat:1}}}
  let changed=false,stale=false,known=true
  const calls:string[]=[]
  const node:ZcashRpc=async(method,params)=>{
    if(method==='getblockchaininfo')return {chain:'test',blocks:100,bestblockhash:changed?'d'.repeat(64):hash}
    if(method==='getblock')return {hash,height:100,time:1000,tx:['c'.repeat(64)]}
    if(method==='getblockhash')return params?.[0]===0?genesis:hash
    throw Error('unexpected node RPC')
  }
  let moveDuringRead=false,desyncDuringRead=false
  let alterDetails=(value:any):any=>value
  const wallet:ZcashRpc=async(method,params)=>{
    calls.push(method)
    if(method==='getwalletstatus')return {fully_synced_height:stale?99:100,wallet_tip:{height:100,blockhash:hash},node_tip:{height:100,blockhash:hash}}
    if(method==='z_listaccounts')return known?[{account_uuid:account}]:[]
    if(method==='z_getbalances'){
      assert.deepEqual(params,[3])
      const values=(response as {pools:Record<string,{valueZat:number}>}).pools
      const detail:any={account_uuid:account,total:{spendable:{valueZat:Object.values(values).reduce((sum,row)=>sum+row.valueZat,0)}}}
      for(const [pool,value] of Object.entries(values))detail[pool]={spendable:value}
      if(values.orchard){
        detail.orchard.pending=detail.total.pending={valueZat:7}
        detail.orchard.dust=detail.total.dust={valueZat:2}
      }
      return alterDetails({accounts:[detail]})
    }
    assert.equal(method,'z_getbalanceforaccount');assert.deepEqual(params,[account,3])
    if(moveDuringRead)changed=true
    if(desyncDuringRead)stale=true
    return response
  }
  const observe=()=>observeWalletInventory(wallet,node,{network:'regtest',genesisHash:genesis,maxTipAgeSeconds:300},account,3,1000)
  const result=await observe()
  assert.deepEqual(result.spendable,{transparent:'0',sapling:'0',orchard:'2000000',ironwood:'1'})
  assert.equal(result.spendableTotalZatoshi,'2000001')
  assert.equal(result.treasurySolvencyVerified,false)
  assert.equal(result.spendingAuthorityVerified,false)
  assert.equal(result.pendingFundsIncluded,false)
  assert.equal(result.pendingZatoshi,'7')
  assert.equal(result.dustZatoshi,'2')
  assert.equal(result.lockedZatoshi,null)
  for(const corrupt of [
    (value:any)=>{value.accounts[0].total.pending={valueZat:8};return value},
    (value:any)=>{value.accounts[0].orchard.spendable={valueZat:1};return value},
    (value:any)=>{value.accounts[0].orchard.locked={valueZat:0};return value},
    (value:any)=>{value.accounts[0].transparent_watchonly=[{}];return value},
    (value:any)=>{value.accounts.push(value.accounts[0]);return value},
  ]){alterDetails=corrupt;await assert.rejects(observe())}
  response={minimum_confirmations:3,pools:{transparent:{valueZat:11},sapling:{valueZat:3}}}
  alterDetails=()=>({accounts:[{account_uuid:account,
    transparent:{regular:{spendable:{valueZat:7},pending:{valueZat:5},dust:{valueZat:1}},
      coinbase:{spendable:{valueZat:4},pending:{valueZat:10},dust:{valueZat:2}}},
    sapling:{spendable:{valueZat:3},pending:{valueZat:2}},
    total:{spendable:{valueZat:14},pending:{valueZat:17},dust:{valueZat:3}}}]})
  const transparent=await observe()
  assert.equal(transparent.spendableTotalZatoshi,'14')
  assert.equal(transparent.pendingZatoshi,'17')
  assert.equal(transparent.dustZatoshi,'3','Transparent dust must be counted once, not again through the account total')
  alterDetails=value=>value
  for(const bad of [null,{minimum_confirmations:1,pools:{}},{minimum_confirmations:3,pools:{unknown:{valueZat:1}}},
    {minimum_confirmations:3,pools:{orchard:{valueZat:2100000000000000},sapling:{valueZat:1}}},
    ...[-1,0.5,'1',Number.MAX_SAFE_INTEGER+1,null].map(valueZat=>({minimum_confirmations:3,pools:{orchard:{valueZat}}}))]){
    response=bad;await assert.rejects(observe())
  }
  response={minimum_confirmations:3,pools:{}}
  assert.equal((await observe()).spendableTotalZatoshi,'0')
  stale=true;await assert.rejects(observe(),/observer_wallet_not_synced/);stale=false
  known=false;await assert.rejects(observe(),/observer_wallet_account_mismatch/);known=true
  desyncDuringRead=true;await assert.rejects(observe(),/observer_wallet_not_synced/);desyncDuringRead=false;stale=false
  moveDuringRead=true;await assert.rejects(observe(),/observer_tip_changed/)
  assert.ok(calls.every(method=>['getwalletstatus','z_listaccounts','z_getbalanceforaccount','z_getbalances'].includes(method)))
})

test('inventory rejects implicit or invalid confirmation policy before making RPC calls',async()=>{
  const rpc:ZcashRpc=async()=>{assert.fail('Invalid policy must not reach RPC')}
  for(const depth of [0,-1,1.5,NaN,2147483648]){
    await assert.rejects(observeWalletInventory(rpc,rpc,{network:'regtest',genesisHash:'b'.repeat(64),maxTipAgeSeconds:300},
      '11111111-1111-1111-1111-111111111111',depth),/invalid_wallet_inventory_policy/)
  }
})
