import { createPublicKey, type KeyObject } from 'node:crypto'
import type { Pool } from 'pg'
import { SaleService } from './service.js'
import { SaleError } from './pricing.js'
import { issuancePayload } from './receipt-payload.js'
import { signReceiptBytes, verifyReceiptBytes, type SignedReceipt } from './receipt-signature.js'

// Trusted worker composition only. Owner is derived from the committed row,
// never supplied with a client payload. Dedicated receipt key, no wallet RPC.
export async function signPurchaseReceipt(db:Pool,purchaseId:string,privateKey:KeyObject):Promise<SignedReceipt>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(purchaseId))throw new SaleError('invalid_purchase_id')
  const purchase=(await db.query('SELECT user_id FROM agnt_sale_purchases WHERE id=$1',[purchaseId])).rows[0]
  if(!purchase)throw new SaleError('purchase_not_found',404)
  const payload=issuancePayload(await new SaleService(db).purchaseReceipt(purchase.user_id,purchaseId))
  const publicKey=createPublicKey(privateKey)
  const validate=(envelope:SignedReceipt)=>{
    if(!verifyReceiptBytes(envelope,publicKey).equals(payload))throw new SaleError('signed_receipt_payload_conflict',409)
    return envelope
  }
  const existing=(await db.query('SELECT envelope FROM agnt_sale_signed_receipts WHERE purchase_id=$1',[purchaseId])).rows[0]
  if(existing)return validate(existing.envelope)
  const envelope=signReceiptBytes(payload,privateKey)
  // Concurrent workers may compute the same signature, but one immutable
  // record wins. A different payload/key never replaces the winning record.
  await db.query('INSERT INTO agnt_sale_signed_receipts(purchase_id,envelope) VALUES($1,$2::jsonb) ON CONFLICT(purchase_id) DO NOTHING',[purchaseId,JSON.stringify(envelope)])
  const stored=(await db.query('SELECT envelope FROM agnt_sale_signed_receipts WHERE purchase_id=$1',[purchaseId])).rows[0]
  if(!stored)throw new SaleError('signed_receipt_unavailable',503)
  return validate(stored.envelope)
}
