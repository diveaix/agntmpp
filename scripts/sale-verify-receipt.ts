import { readFile, stat } from 'node:fs/promises'
import { createPublicKey } from 'node:crypto'
import { verifyReceiptBytes } from '../src/mcp/sale/receipt-signature.js'
import { issuancePayload } from '../src/mcp/sale/receipt-payload.js'

async function boundedFile(path:string,limit:number){
  const info=await stat(path)
  if(!info.isFile()||info.size>limit)throw new Error('invalid_file')
  const bytes=await readFile(path)
  if(bytes.length>limit)throw new Error('invalid_file')
  return bytes.toString('utf8')
}
async function main(){
  const args=process.argv.slice(2)
  if(args.length!==2)throw new Error('invalid_arguments')
  const receipt=JSON.parse(await boundedFile(args[0],12*1024*1024))
  const pem=await boundedFile(args[1],65536)
  if(!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----'))throw new Error('public_key_required')
  const payload=verifyReceiptBytes(receipt.signature,createPublicKey(pem))
  if(!payload.equals(issuancePayload(receipt)))throw new Error('receipt_snapshot_mismatch')
  console.log(JSON.stringify({verified:true,keyId:receipt.signature.keyId,meaning:'Issuance signature and receipt contents match the supplied trusted key. Not proof of current ownership, access, or treasury solvency.'}))
}
// No dotenv, network, database, wallet, private key input or history output.
main().catch(()=>{console.error('receipt_verification_failed');process.exitCode=1})
