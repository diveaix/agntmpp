import 'dotenv/config'
import { Pool } from 'pg'
import { signerOperationsStatus } from '../src/mcp/sale/signer-status.js'

async function main(){
  const connectionString=process.env.AGNT_SALE_SIGNER_DATABASE_URL
  if(!connectionString)throw new Error('unconfigured')
  const db=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:10000})
  try{
    const report=await signerOperationsStatus(db)
    console.log(JSON.stringify(report))
    if(report.unresolvedSigning||report.integrityReviewRequired)process.exitCode=1
  }finally{await db.end()}
}
main().catch(()=>{console.error('sale_signer_status_unavailable');process.exitCode=1})
