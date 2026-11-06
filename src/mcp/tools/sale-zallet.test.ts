import test from 'node:test'
import assert from 'node:assert/strict'
import { extractConfirmedZalletReceipts, type DepositAssignment, type CanonicalBlockEvidence } from '../sale/zallet-receipts.js'

// Synthetic responses following reviewed upstream structs, not captured live-wallet fixtures.
const txid='a'.repeat(64),blockHash='b'.repeat(64)
const assignment:DepositAssignment={userId:'alice',network:'regtest',walletAccountUuid:'wallet-account',recipientAddresses:['assigned-receiver']}
const evidence:CanonicalBlockEvidence={network:'regtest',tipHeight:102,blockHeight:100,blockHash,transactionIds:[txid]}
const output={pool:'orchard',action:0,account_uuid:'wallet-account',address:'assigned-receiver',outgoing:false,walletInternal:false,valueZat:2000000}
const transaction={txid,status:'mined',confirmations:3,blockhash:blockHash,spends:[],outputs:[output]}

test('Zallet normalization attributes exact recipients, excludes change, and preserves output identity',()=>{
  const receipts=extractConfirmedZalletReceipts({...transaction,outputs:[output,{...output,action:1},{...output,action:2,address:'someone-else'},{...output,action:3,walletInternal:true},{...output,action:4,outgoing:true},{...output,action:5,account_uuid:'different-wallet-account'}]},assignment,evidence)
  assert.equal(receipts.length,2)
  assert.equal(receipts[0].receiptId,`regtest:${txid}:orchard:0`)
  assert.equal(receipts[1].receiptId,`regtest:${txid}:orchard:1`)
  assert.equal(receipts[0].amountZatoshi,'2000000')
  assert.equal(receipts[0].confirmations,3)
  const pools=extractConfirmedZalletReceipts({...transaction,outputs:[output,{...output,pool:'ironwood'}]},assignment,evidence)
  assert.equal(pools.length,2)
  assert.notEqual(pools[0].receiptId,pools[1].receiptId)
  assert.equal(pools[1].receiptId,`regtest:${txid}:ironwood:0`)
})

test('Zallet normalization rejects mismatched chain evidence, self-funding, unsupported pools and malformed amounts',()=>{
  for(const badEvidence of [{...evidence,network:'mainnet' as const},{...evidence,transactionIds:[]},{...evidence,blockHash:'c'.repeat(64)},{...evidence,tipHeight:103},{...evidence,blockHeight:103}])assert.throws(()=>extractConfirmedZalletReceipts(transaction,assignment,badEvidence))
  assert.throws(()=>extractConfirmedZalletReceipts({...transaction,status:'waiting'},assignment,evidence),/deposit_not_mined/)
  assert.throws(()=>extractConfirmedZalletReceipts({...transaction,generated:true},assignment,evidence),/treasury_or_coinbase/)
  assert.throws(()=>extractConfirmedZalletReceipts({...transaction,spends:[{account_uuid:'other-treasury-account'}]},assignment,evidence),/treasury_or_coinbase/)
  for(const valueZat of [0.1,-1,'2000000',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>extractConfirmedZalletReceipts({...transaction,outputs:[{...output,valueZat}]},assignment,evidence),/invalid_output_amount/)
  assert.throws(()=>extractConfirmedZalletReceipts({...transaction,outputs:[{...output,pool:'unknown'}]},assignment,evidence),/unsupported_deposit_pool/)
  assert.throws(()=>extractConfirmedZalletReceipts({...transaction,outputs:[output,output]},assignment,evidence),/duplicate_wallet_output/)
  assert.throws(()=>extractConfirmedZalletReceipts({...transaction,outputs:[{...output,action:undefined}]},assignment,evidence),/invalid_output_identity/)
})
