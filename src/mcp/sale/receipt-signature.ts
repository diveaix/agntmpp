import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { SaleError } from './pricing.js'

const DOMAIN=Buffer.from('AGNT/issuance-receipt/v1\n','utf8')
const MAX_BYTES=4*1024*1024
export interface SignedReceipt {format:'agnt-issuance-receipt-v1';algorithm:'Ed25519';keyId:string;payload:string;signature:string}

function keyId(key:KeyObject){
  if(key.asymmetricKeyType!=='ed25519')throw new SaleError('receipt_key_type_invalid',503)
  const publicKey=key.type==='private'?createPublicKey(key):key
  if(publicKey.type!=='public')throw new SaleError('receipt_key_type_invalid',503)
  return createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')
}

// Internal primitive only. The caller must supply a validated, committed
// issuance payload. No wallet keys, key generation, environment lookup or RPC.
// Persistence and issuance validation belong to the receipt worker, not here.
export function signReceiptBytes(payload:Buffer,privateKey:KeyObject):SignedReceipt{
  if(privateKey.type!=='private')throw new SaleError('receipt_private_key_required',503)
  const id=keyId(privateKey)
  if(payload.length===0||payload.length>MAX_BYTES)throw new SaleError('receipt_payload_size_invalid')
  return {format:'agnt-issuance-receipt-v1',algorithm:'Ed25519',keyId:id,payload:payload.toString('base64'),signature:sign(null,Buffer.concat([DOMAIN,payload]),privateKey).toString('base64')}
}

// Trust must come from outside the downloaded envelope. Never accept an
// embedded public key as proof that ./AGENT issued a receipt. Returns the exact
// authenticated bytes, not a claim about current ownership or tool eligibility.
export function verifyReceiptBytes(envelope:SignedReceipt,trustedPublicKey:KeyObject):Buffer{
  if(trustedPublicKey.type!=='public')throw new SaleError('receipt_public_key_required')
  if(!envelope||envelope.format!=='agnt-issuance-receipt-v1'||envelope.algorithm!=='Ed25519'||envelope.keyId!==keyId(trustedPublicKey)||typeof envelope.payload!=='string'||typeof envelope.signature!=='string')throw new SaleError('receipt_signature_invalid')
  if(envelope.payload.length>Math.ceil(MAX_BYTES/3)*4||envelope.signature.length!==88)throw new SaleError('receipt_signature_invalid')
  const payload=Buffer.from(envelope.payload,'base64'),signature=Buffer.from(envelope.signature,'base64')
  if(!payload.length||payload.length>MAX_BYTES||signature.length!==64||payload.toString('base64')!==envelope.payload||signature.toString('base64')!==envelope.signature||!verify(null,Buffer.concat([DOMAIN,payload]),trustedPublicKey,signature))throw new SaleError('receipt_signature_invalid')
  return payload
}
