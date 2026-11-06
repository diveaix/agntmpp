import 'dotenv/config'
import { salePool } from '../src/mcp/sale/database.js'
import { saleOperationsStatus } from '../src/mcp/sale/operations-status.js'

async function main(){
  const db=salePool()
  try{
    const report=await saleOperationsStatus(db)
    console.log(JSON.stringify(report))
    if(report.requiresReview)process.exitCode=1
  }finally{await db.end()}
}
main().catch(()=>{console.error('sale_operations_status_unavailable');process.exitCode=1})
