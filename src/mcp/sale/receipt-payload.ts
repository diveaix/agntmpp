import { accessPolicy, type SaleAccessPolicy } from './access-policy.js'
import { passMetadata, passMetadataHash } from './pass-metadata.js'
import { CURVE_VERSION, SCHEDULE_HASH, totalPrice, zatoshi, SaleError } from './pricing.js'
import { isDeepStrictEqual } from 'node:util'

// Only the trusted worker should call this with a freshly read committed
// receipt. Validation is not proof that arbitrary caller data exists in the DB.
export interface IssuanceReceiptSource {
  formatVersion:number;userId:string;ownershipModel:string;metadataVerified:boolean;accessPolicy:SaleAccessPolicy|null
  purchase:{id:string;first_serial:number;quantity:number;total:string;curve_version:string;access_policy_version:string|null;created_at:string|Date}
  passes:{serial:number;metadata_hash:string;metadata:unknown}[]
}
export function issuancePayload(receipt:IssuanceReceiptSource):Buffer{
  const fail=()=>{throw new SaleError('issuance_receipt_integrity_failed',409)}
  const purchase=receipt?.purchase,stored=receipt?.accessPolicy
  if(!receipt||receipt.formatVersion!==1||receipt.ownershipModel!=='database-managed, account-bound'||typeof receipt.userId!=='string'||!receipt.userId||receipt.metadataVerified!==true||!purchase||!stored)fail()
  if(typeof purchase.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(purchase.id)||purchase.curve_version!==CURVE_VERSION)fail()
  const policy=accessPolicy(stored!.durationDays,stored!.dailyCalls)
  if(!isDeepStrictEqual(stored,policy)||policy.version!==purchase.access_policy_version)fail()
  const total=totalPrice(purchase.first_serial-1,purchase.quantity)
  if(zatoshi(purchase.total)!==total||!Array.isArray(receipt.passes)||receipt.passes.length!==purchase.quantity)fail()
  if(!(purchase.created_at instanceof Date)&&typeof purchase.created_at!=='string')fail()
  const created=new Date(purchase.created_at)
  if(!Number.isFinite(created.getTime()))fail()
  const passes=receipt.passes.map((pass,index)=>{
    const serial=purchase.first_serial+index
    const expected=passMetadataHash(serial,policy)
    const metadata=passMetadata(serial,policy)
    if(pass.serial!==serial||pass.metadata_hash!==expected||!isDeepStrictEqual(pass.metadata,metadata))fail()
    return {serial,metadataHash:expected,metadata}
  })
  // Explicit projection excludes transient eligibility, mutable status,
  // timestamps of retrieval, and any unknown/request-supplied fields.
  return Buffer.from(JSON.stringify({format:'agnt-issuance-payload-v1',ownershipModel:'database-managed, account-bound',userId:receipt.userId,purchaseId:purchase.id,issuedAt:created.toISOString(),curveVersion:CURVE_VERSION,scheduleHash:SCHEDULE_HASH,firstSerial:purchase.first_serial,quantity:purchase.quantity,totalZatoshi:String(total),accessPolicy:policy,passes}),'utf8')
}
