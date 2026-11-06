import { createHash } from 'node:crypto'
import { CURVE_VERSION } from './pricing.js'
import type { SaleAccessPolicy } from './access-policy.js'

// Preserve the issuance field order: these exact JSON bytes define the hash.
// This describes an account-bound pass, not artwork or a native-chain NFT.
export function passMetadata(serial:number,policy:SaleAccessPolicy){
  return {collection:CURVE_VERSION,serial,model:'database-managed',transferable:false,accessPolicy:{version:policy.version,durationDays:policy.durationDays,dailyCalls:policy.dailyCalls}}
}
export function passMetadataHash(serial:number,policy:SaleAccessPolicy){
  return createHash('sha256').update(JSON.stringify(passMetadata(serial,policy))).digest('hex')
}
