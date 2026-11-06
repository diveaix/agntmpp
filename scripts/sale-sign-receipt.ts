import 'dotenv/config'
import { readFile, stat } from 'node:fs/promises'
import { createPrivateKey } from 'node:crypto'
import { Pool } from 'pg'
import { signPurchaseReceipt } from '../src/mcp/sale/receipt-worker.js'

async function main(){
  if(process.env.AGNT_RECEIPT_SIGNER_ENABLED!=='true'){
    console.log('Receipt signer is disabled. No key file or database was opened.')
    return
  }
  const args=process.argv.slice(2)
  if(args.length!==1||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(args[0]))throw new Error('invalid_arguments')
  const path=process.env.AGNT_RECEIPT_SIGNING_KEY_FILE,url=process.env.AGNT_RECEIPT_DATABASE_URL
  if(!path||!url)throw new Error('configuration_missing')
  const info=await stat(path)
  if(!info.isFile()||info.size>65536)throw new Error('invalid_key_file')
  const pem=await readFile(path)
  let key
  try{
    if(pem.length>65536)throw new Error('invalid_key_file')
    key=createPrivateKey(pem)
    if(key.asymmetricKeyType!=='ed25519')throw new Error('wrong_key_type')
  }finally{pem.fill(0)}
  // This identity needs ledger SELECT and signed-receipt INSERT only. Never
  // supply wallet credentials or make this key available to the web server.
  const db=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,statement_timeout:10000})
  try{
    const envelope=await signPurchaseReceipt(db,args[0],key)
    console.log(JSON.stringify({signed:true,keyId:envelope.keyId}))
  }finally{await db.end()}
}
main().catch(()=>{console.error('receipt_signing_failed');process.exitCode=1})
