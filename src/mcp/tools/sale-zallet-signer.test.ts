import test from 'node:test'
import assert from 'node:assert/strict'
import { signZalletWithdrawal, zecJsonAmount } from '../sale/zallet-signer.js'
import type { ZcashRpc } from '../sale/zcash-observer.js'

const block='a'.repeat(64),genesis='b'.repeat(64),txid='c'.repeat(64)
const intent={reference:'test',network:'regtest' as const,walletAccountUuid:'11111111-1111-1111-1111-111111111111',destination:'receiver',amountZatoshi:'2000000',feeLimitZatoshi:'10000'}
const policy={network:'regtest' as const,genesisHash:genesis,maxTipAgeSeconds:300}
test('ZEC JSON amounts preserve every zatoshi without floating point conversion',()=>{
  assert.equal(JSON.stringify({amount:zecJsonAmount('1')}),'{"amount":0.00000001}')
  assert.equal(JSON.stringify({amount:zecJsonAmount('2099999999999999')}),'{"amount":20999999.99999999}')
  assert.throws(()=>zecJsonAmount('0.01'))
})
function fixture(change:Record<string,unknown>={},mutateProven=false){
  const calls:string[]=[]
  const node:ZcashRpc=async(method,params=[])=>{
    if(method==='getblockchaininfo')return {chain:'test',blocks:100,bestblockhash:block}
    if(method==='getblock')return {hash:block,height:100,time:1000,tx:[txid]}
    if(method==='getblockhash')return params[0]===0?genesis:block
    if(method==='decoderawtransaction')return {txid}
    throw new Error('Unexpected node method')
  }
  const wallet:ZcashRpc=async(method,params=[])=>{
    calls.push(method)
    if(method==='getwalletstatus')return {fully_synced_height:100,wallet_tip:{blockhash:block},node_tip:{blockhash:block}}
    if(method==='pczt_create'){
      assert.ok(JSON.stringify(params).includes('"amount":0.02000000'))
      return {pczt:'created'}
    }
    if(method==='pczt_inspect')return {wallet_created:true,privacy_policy:'FullPrivacy',fee_zat:1000,
      tx_version:6,consensus_branch_id:'branch',expiry_height:150,
      transparent:{inputs:[],outputs:[]},sapling:{outputs:[],value_balance_zat:0},
      orchard:{outputs:[{user_address:'receiver',value_zat:2000000}],value_balance_zat:mutateProven&&params[0]==='proven'?1:0},
      ironwood:{outputs:[],value_balance_zat:0},...change}
    if(method==='pczt_prove')return {pczt:'proven'}
    if(method==='pczt_sign')return {pczt:'signed',unsigned_transparent:[],unsigned_sapling:[],unsigned_orchard:[],unsigned_ironwood:[]}
    if(method==='pczt_extract')return {stored:true,txid,hex:'0102'}
    if(method==='decoderawtransaction')return {txid}
    throw new Error('Unexpected wallet method')
  }
  return {node,wallet,calls}
}
test('wallet adapter validates intent before signing and returns extracted fee/bytes without broadcasting',async()=>{
  const good=fixture()
  assert.deepEqual(await signZalletWithdrawal(good.wallet,good.node,policy,intent,1000),{txid,rawHex:'0102',actualFeeZatoshi:'1000'})
  for(const change of [{fee_zat:10001},{privacy_policy:'NoPrivacy'},{orchard:{outputs:[{user_address:'wrong',value_zat:2000000}],value_balance_zat:0}}]){
    const bad=fixture(change)
    await assert.rejects(signZalletWithdrawal(bad.wallet,bad.node,policy,intent,1000))
    assert.equal(bad.calls.includes('pczt_sign'),false)
  }
  const altered=fixture({},true)
  await assert.rejects(signZalletWithdrawal(altered.wallet,altered.node,policy,intent,1000),/withdrawal_proposal_changed/)
  assert.equal(altered.calls.includes('pczt_sign'),false)
})
