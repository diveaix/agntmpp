import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { zcashSaleProviders } from '../sale/zcash-providers.js'
import { ZcashRpcError, type ZcashRpc } from '../sale/zcash-observer.js'
import { configuredSaleProviders } from '../sale/provider-config.js'
import { requireSaleLaunch } from '../sale/runtime.js'

test('provider composition is inert by default and cannot unlock the sale',()=>{
  const previous=process.env.AGNT_SALE_PROVIDERS_ENABLED,network=process.env.AGNT_ZCASH_NETWORK
  try{
    process.env.AGNT_SALE_PROVIDERS_ENABLED='false'
    assert.deepEqual(configuredSaleProviders(),{})
    process.env.AGNT_SALE_PROVIDERS_ENABLED='true'
    process.env.AGNT_ZCASH_NETWORK=''
    assert.throws(configuredSaleProviders,/sale_provider_configuration_missing/)
    assert.throws(requireSaleLaunch,/real_money_sale_not_ready/)
  }finally{
    if(previous===undefined)delete process.env.AGNT_SALE_PROVIDERS_ENABLED;else process.env.AGNT_SALE_PROVIDERS_ENABLED=previous
    if(network===undefined)delete process.env.AGNT_ZCASH_NETWORK;else process.env.AGNT_ZCASH_NETWORK=network
  }
})

test('withdrawal provider validates fresh wallet/network binding and Orchard receivers without signing',async()=>{
  const hash='a'.repeat(64),genesis='b'.repeat(64),account='11111111-1111-1111-1111-111111111111',address='synthetic-unified-address'.padEnd(80,'x')
  let receivers:unknown={orchard:address},synced=true,knownAccount=true
  const calls:string[]=[]
  const node:ZcashRpc=async(method,params)=>{
    if(method==='getblockchaininfo')return {chain:'test',blocks:100,bestblockhash:hash}
    if(method==='getblock')return {hash,height:100,time:1000,tx:['c'.repeat(64)]}
    if(method==='getblockhash')return params?.[0]===0?genesis:hash
    throw new Error('Unexpected node call')
  }
  const wallet:ZcashRpc=async(method,params)=>{
    calls.push(method)
    if(method==='getwalletstatus')return {fully_synced_height:synced?100:99,wallet_tip:{height:100,blockhash:hash},node_tip:{height:100,blockhash:hash}}
    if(method==='z_listaccounts')return knownAccount?[{account_uuid:account}]:[]
    assert.equal(method,'z_listunifiedreceivers')
    assert.deepEqual(params,[address])
    if(receivers instanceof Error)throw receivers
    return receivers
  }
  const providers=zcashSaleProviders({} as Pool,wallet,node,{network:'regtest',genesisHash:genesis,maxTipAgeSeconds:300},account,1000)
  await providers.validateDestination(address)
  receivers={sapling:'synthetic-sapling'}
  await assert.rejects(providers.validateDestination(address),/orchard_unified_address_required/)
  receivers={orchard:address,unexpected:'receiver'}
  await assert.rejects(providers.validateDestination(address),/invalid_address_validation/)
  receivers=new ZcashRpcError('z_listunifiedreceivers',-8,'RPC request rejected')
  await assert.rejects(providers.validateDestination(address),/invalid_destination/)
  receivers=new Error('wallet unavailable')
  await assert.rejects(providers.validateDestination(address),/wallet unavailable/)
  synced=false
  await assert.rejects(providers.validateDestination(address),/observer_wallet_not_synced/)
  synced=true;knownAccount=false
  await assert.rejects(providers.depositAddress('alice'),/observer_wallet_account_mismatch/)
  assert.ok(calls.every(method=>['getwalletstatus','z_listaccounts','z_listunifiedreceivers'].includes(method)))
})
