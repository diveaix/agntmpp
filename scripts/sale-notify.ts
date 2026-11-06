import 'dotenv/config'
import { salePool } from '../src/mcp/sale/database.js'
import { deliverSaleNotifications } from '../src/mcp/sale/notifications.js'

async function main(){
  if(process.env.AGNT_SALE_NOTIFICATIONS_ENABLED!=='true'){
    console.log('Sale notification worker is disabled. No database connection was opened.')
    return
  }
  const db=salePool()
  try{
    const result=await deliverSaleNotifications(db)
    console.log(JSON.stringify(result))
    if(result.retried)process.exitCode=1
  }finally{await db.end()}
}
main().catch(()=>{console.error('sale_notification_worker_failed');process.exitCode=1})
