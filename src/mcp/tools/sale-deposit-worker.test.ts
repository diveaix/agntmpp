import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { readFile } from 'node:fs/promises'
import { DepositAssignments } from '../sale/deposit-assignments.js'
import { observeAssignedDeposit, reviewAssignedDeposit } from '../sale/deposit-worker.js'
import { SaleService } from '../sale/service.js'
import { ZcashRpcError, type ZcashRpc } from '../sale/zcash-observer.js'
import { scanAssignedBlock } from '../sale/deposit-scanner.js'
import { recoverDepositCursor } from '../sale/deposit-recovery.js'
import { runObserverBatch } from '../sale/observer-batch.js'
import { CURVE_VERSION, SCHEDULE_HASH } from '../sale/pricing.js'

test('scanner persists confirmation progress without early credit and reviews replaced pending blocks',async()=>{
  const db=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{const r=await db.query<Record<string,unknown>>(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0}}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const account='11111111-1111-1111-1111-111111111111',address='pending-test-receiver'.padEnd(80,'x')
  const txid='a'.repeat(64),original='b'.repeat(64),replacement='f'.repeat(64),genesis='d'.repeat(64),unrelated='e'.repeat(64)
  let tipHeight=100,replaced=false
  const blockHash=()=>replaced?replacement:original
  const tipHash=()=>tipHeight===100?blockHash():String(tipHeight).padStart(64,'0')
  const node:ZcashRpc=async(method,params=[])=>{
    if(method==='getblockchaininfo')return {chain:'test',blocks:tipHeight,bestblockhash:tipHash()}
    if(method==='getblockhash')return params[0]===0?genesis:params[0]===100?blockHash():String(params[0]).padStart(64,'0')
    if(method==='getblock')return {hash:params[0],height:params[0]===original||params[0]===replacement?100:tipHeight,time:Math.floor(Date.now()/1000),tx:params[0]===original?[txid]:[unrelated]}
    throw new Error('Unexpected node method')
  }
  const wallet:ZcashRpc=async(method,params=[])=>{
    if(method==='z_listaccounts')return [{account_uuid:account}]
    if(method==='getwalletstatus')return {fully_synced_height:tipHeight,node_tip:{height:tipHeight,blockhash:tipHash()},wallet_tip:{height:tipHeight,blockhash:tipHash()}}
    if(method==='z_viewtransaction'&&params[0]===txid)return {txid,status:'mined',blockhash:original,confirmations:tipHeight-99,spends:[],outputs:[{pool:'orchard',action:0,account_uuid:account,address,walletInternal:false,outgoing:false,valueZat:2000000}]}
    throw new ZcashRpcError(method,-5,'Invalid or non-wallet transaction id')
  }
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    const assignments=new DepositAssignments(pool),service=new SaleService(pool)
    await assignments.migrate()
    await assignments.allocate('alice','regtest',account,async(_method,params=[])=>({account_uuid:account,diversifier_index:params[2],receiver_types:['orchard'],address}))
    const policy={network:'regtest' as const,genesisHash:genesis,maxTipAgeSeconds:300}
    const scan=()=>scanAssignedBlock(pool,wallet,node,policy,'alice',100,3)
    for(let retry=0;retry<2;retry++)assert.equal((await scan()).state,'confirming')
    assert.equal((await service.account('alice')).balance.available,'0')
    assert.equal((await service.account('alice')).deposits[0].state,'CONFIRMING')
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,100)
    replaced=true
    assert.equal((await scan()).state,'confirming')
    assert.equal((await service.account('alice')).deposits[0].state,'ORPHANED')
    assert.equal((await service.account('alice')).balance.frozen,false)
    assert.equal((await service.account('alice')).balance.available,'0')
    assert.equal((await service.exportAccount('alice')).creditReviews.length,0,'Never-credited receipts do not create credited-value exposure')
    replaced=false;tipHeight=101
    assert.equal((await scan()).state,'confirming')
    assert.equal((await service.account('alice')).deposits[0].confirmations,2)
    assert.equal((await service.account('alice')).balance.available,'0')
    tipHeight=102
    assert.equal((await scan()).state,'advanced')
    assert.equal((await service.account('alice')).balance.available,'2000000')
    assert.equal((await service.account('alice')).deposits[0].state,'CREDITED')
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,101)
    assert.equal((await query('SELECT count(*)::int AS count FROM agnt_sale_ledger')).rows[0].count,1)
  }finally{await db.close()}
})

test('deposit worker credits only persisted recipients after node verification and replays exactly once',async()=>{
  const db=new PGlite()
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query<Record<string,unknown>>(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}}
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const txid='a'.repeat(64),block='b'.repeat(64),tip='c'.repeat(64),genesis='d'.repeat(64)
  const unrelatedTx='e'.repeat(64)
  const nextBlock='f'.repeat(64)
  const account='11111111-1111-1111-1111-111111111111',address='synthetic-receiver'.padEnd(80,'x')
  const policy={network:'regtest' as const,genesisHash:genesis,maxTipAgeSeconds:300}
  let canonical=true
  const node:ZcashRpc=async(method,params=[])=>{
    if(method==='getblockhash')return params[0]===0?genesis:params[0]===100?tip:params[0]===99?nextBlock:canonical?block:genesis
    if(method==='getblockchaininfo')return {chain:'test',blocks:100,bestblockhash:tip}
    if(method==='getblock')return params[0]===tip?{hash:tip,height:100,time:Math.floor(Date.now()/1000),tx:[unrelatedTx]}:params[0]===nextBlock?{hash:nextBlock,height:99,tx:[unrelatedTx]}:{hash:block,height:98,tx:[txid,unrelatedTx]}
    throw new Error('Unexpected node RPC')
  }
  const wallet:ZcashRpc=async(method)=>method==='z_listaccounts'?[{account_uuid:account}]:method==='getwalletstatus'?{fully_synced_height:100,node_tip:{height:100,blockhash:tip},wallet_tip:{height:100,blockhash:tip}}:
    {txid,status:'mined',blockhash:block,confirmations:3,spends:[],outputs:[{pool:'orchard',action:0,account_uuid:account,address,walletInternal:false,outgoing:false,valueZat:2000000}]}
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale(id,state,curve_version,schedule_hash) VALUES(1,'OPEN',$1,$2)",[CURVE_VERSION,SCHEDULE_HASH])
    const assignments=new DepositAssignments(pool),service=new SaleService(pool)
    await assignments.migrate()
    await assignments.allocate('alice','regtest',account,async(_method,params=[])=>({account_uuid:account,diversifier_index:params[2],receiver_types:['orchard'],address}))
    await assert.rejects(observeAssignedDeposit(pool,wallet,node,policy,'bob',txid,3),/assignment_missing/)
    canonical=false
    await assert.rejects(observeAssignedDeposit(pool,wallet,node,policy,'alice',txid,3),/orphaned_block/)
    assert.equal((await service.account('alice')).balance.available,'0')
    canonical=true
    assert.deepEqual(await observeAssignedDeposit(pool,wallet,node,policy,'alice',txid,4),{receipts:1,states:['CONFIRMING']})
    assert.equal((await service.account('alice')).balance.available,'0')
    await observeAssignedDeposit(pool,wallet,node,policy,'alice',txid,3)
    await observeAssignedDeposit(pool,wallet,node,policy,'alice',txid,3)
    assert.equal((await service.account('alice')).balance.available,'2000000')
    assert.equal((await service.account('bob')).balance.available,'0')
    await assert.rejects(reviewAssignedDeposit(pool,async()=>{throw new Error('node timeout')},policy,'alice',txid,3),/node timeout/)
    assert.equal((await service.account('alice')).balance.frozen,false)
    canonical=false
    assert.deepEqual(await reviewAssignedDeposit(pool,node,policy,'alice',txid,3),{reviewed:1,orphaned:1})
    assert.equal((await service.account('alice')).balance.frozen,true)
    assert.equal((await service.account('alice')).deposits[0].state,'ORPHANED')
    const creditReview=(await service.exportAccount('alice')).creditReviews
    assert.equal(creditReview.length,1)
    assert.equal(creditReview[0].credited_amount,'2000000')
    assert.equal(creditReview[0].coverage_state,'ORPHANED')
    assert.equal((await service.exportAccount('bob')).creditReviews.length,0)
    canonical=true
    await reviewAssignedDeposit(pool,node,policy,'alice',txid,3)
    assert.equal((await service.account('alice')).balance.frozen,true,'Reappearing deposit must not auto-unfreeze account')
    assert.equal((await service.account('alice')).balance.available,'2000000','Reappearing deposit must not credit twice')
    assert.equal((await service.exportAccount('alice')).creditReviews[0].coverage_state,'RESTORED')
    const scannerWallet:ZcashRpc=async(method,params)=>{
      if(method==='z_viewtransaction'&&params?.[0]===unrelatedTx)throw new ZcashRpcError(method,-5,'Invalid or non-wallet transaction id')
      return wallet(method,params)
    }
    await assert.rejects(scanAssignedBlock(pool,async(method,params)=>method==='z_listaccounts'?[]:scannerWallet(method,params),node,policy,'alice',98,3),/observer_wallet_account_mismatch/)
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows.length,0)
    await assert.rejects(scanAssignedBlock(pool,async(method,params)=>{
      if(method==='z_viewtransaction')throw new Error('discovery timeout')
      return scannerWallet(method,params)
    },node,policy,'alice',98,3),/discovery timeout/)
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,98)
    await assert.rejects(scanAssignedBlock(pool,async(method,params)=>{
      if(params?.[0]===unrelatedTx)throw new ZcashRpcError(method,-5,'unexpected wallet failure')
      return scannerWallet(method,params)
    },node,policy,'alice',98,3),/unexpected wallet failure/)
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,98)
    assert.deepEqual(await scanAssignedBlock(pool,scannerWallet,node,policy,'alice',98,3),{state:'advanced',height:98,transactions:2})
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,99)
    assert.deepEqual(await scanAssignedBlock(pool,scannerWallet,node,policy,'alice',98,3),{state:'confirming',height:99,confirmations:2,transactions:1})
    for(const invalidHash of [null,{},'invalid']){
      await assert.rejects(scanAssignedBlock(pool,scannerWallet,async(method,params)=>{
        if(method==='getblockhash'&&params?.[0]===98)return invalidHash
        return node(method,params)
      },policy,'alice',98,3),/invalid_scanner_response/)
      assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,99)
      assert.equal((await service.summary()).state,'OPEN')
    }
    assert.equal((await service.account('alice')).balance.available,'2000000')
    await assert.rejects(scanAssignedBlock(pool,scannerWallet,node,policy,'alice',97,3),/configuration_changed/)
    canonical=false
    await assert.rejects(scanAssignedBlock(pool,scannerWallet,node,policy,'alice',98,3),/scanner_reorg_review_required/)
    await assert.rejects(recoverDepositCursor(pool,async()=>{throw new Error('recovery node unavailable')},policy,'alice',3),/recovery node unavailable/)
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,99)
    assert.deepEqual(await recoverDepositCursor(pool,node,policy,'alice',3),{rewound:true,nextHeight:98,reviewedTransactions:1})
    assert.equal((await service.summary()).state,'PAUSED')
    assert.equal((await service.account('alice')).balance.frozen,true)
    assert.equal((await service.account('alice')).balance.available,'2000000')
    assert.deepEqual(await recoverDepositCursor(pool,node,policy,'alice',3),{rewound:false})
    canonical=true
    assert.deepEqual(await runObserverBatch(pool,scannerWallet,node,policy,98,3),{checked:1,advanced:1})
    assert.deepEqual(await runObserverBatch(pool,scannerWallet,node,policy,98,3),{checked:1,advanced:0})
    canonical=false
    await assert.rejects(runObserverBatch(pool,scannerWallet,node,policy,98,3),/observer_rewound_operator_review_required/)
    assert.equal((await query('SELECT next_height FROM agnt_deposit_scan_cursors')).rows[0].next_height,98)
    assert.equal((await service.summary()).state,'PAUSED')
    assert.equal((await service.account('alice')).balance.available,'2000000')
    assert.equal((await service.account('alice')).balance.frozen,true)
    canonical=true
    await observeAssignedDeposit(pool,wallet,node,policy,'alice',txid,4)
    const unconfirmed=(await service.exportAccount('alice')).creditReviews
    assert.equal(unconfirmed.length,1)
    assert.equal(unconfirmed[0].coverage_state,'UNCONFIRMED')
    assert.equal(unconfirmed[0].credited_amount,'2000000')
    assert.equal((await service.account('alice')).balance.available,'2000000')
  }finally{await db.close()}
})
