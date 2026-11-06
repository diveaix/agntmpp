import 'dotenv/config'
import { salePool } from '../src/mcp/sale/database.js'
import { reconcileSale } from '../src/mcp/sale/reconcile.js'

const pool=salePool()
try{
  const report=await reconcileSale(pool)
  // Account identifiers and payment history are intentionally omitted from CLI logs.
  console.log(JSON.stringify({ok:report.ok,checkedAccounts:report.checkedAccounts,checkedPurchases:report.checkedPurchases,issueCodes:[...new Set(report.issues.map(issue=>issue.code))],treasurySolvencyVerified:false}))
  if(!report.ok)process.exitCode=1
}finally{await pool.end()}
