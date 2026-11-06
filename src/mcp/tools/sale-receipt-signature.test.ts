import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { signReceiptBytes, verifyReceiptBytes } from '../sale/receipt-signature.js'

test('receipt signatures authenticate exact bytes using an externally trusted dedicated key',()=>{
  // Ephemeral test keys only; never persisted or used for wallet operations.
  const {privateKey,publicKey}=generateKeyPairSync('ed25519')
  const other=generateKeyPairSync('ed25519')
  const payload=Buffer.from(JSON.stringify({purchaseId:'fixture',totalZatoshi:'2000000'}))
  const receipt=signReceiptBytes(payload,privateKey)
  assert.deepEqual(verifyReceiptBytes(receipt,publicKey),payload)
  assert.deepEqual(signReceiptBytes(payload,privateKey),receipt,'Signing the same bytes is deterministic')
  assert.throws(()=>verifyReceiptBytes(receipt,other.publicKey),/signature_invalid/)
  assert.throws(()=>verifyReceiptBytes({...receipt,payload:Buffer.from('changed').toString('base64')},publicKey),/signature_invalid/)
  assert.throws(()=>verifyReceiptBytes({...receipt,signature:sign(null,payload,privateKey).toString('base64')},publicKey),/signature_invalid/,'A signature outside the receipt domain is rejected')
  assert.throws(()=>verifyReceiptBytes({...receipt,payload:receipt.payload+'\n'},publicKey),/signature_invalid/)
  assert.throws(()=>verifyReceiptBytes({...receipt,signature:'A'.repeat(88)},publicKey),/signature_invalid/)
  assert.throws(()=>signReceiptBytes(payload,publicKey),/private_key_required/)
  assert.throws(()=>signReceiptBytes(Buffer.alloc(0),privateKey),/size_invalid/)
  assert.throws(()=>signReceiptBytes(Buffer.alloc(4*1024*1024+1),privateKey),/size_invalid/)
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
  assert.throws(()=>signReceiptBytes(payload,ec.privateKey),/key_type_invalid/)
})
