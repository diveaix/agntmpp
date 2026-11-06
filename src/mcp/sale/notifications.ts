import type { Pool } from 'pg'
import { transaction } from './database.js'
import { SaleError } from './pricing.js'

// Delivery is to a private database inbox only: no wallet, signing, email or
// webhook authority. A unique event key makes retries safe across worker crashes.
export async function deliverSaleNotifications(db:Pool,limit=20){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new SaleError('invalid_notification_batch')
  let delivered=0,retried=0
  for(let index=0;index<limit;index++){
    let eventId:string|undefined
    try{
      const found=await transaction(async c=>{
        const row=(await c.query(`SELECT o.event_id,e.user_id,e.kind,e.reference FROM agnt_sale_outbox o
          JOIN agnt_sale_events e ON e.id=o.event_id WHERE o.state IN ('PENDING','RETRY') AND o.next_retry_at<=now()
          ORDER BY o.next_retry_at,o.event_id FOR UPDATE OF o SKIP LOCKED LIMIT 1`)).rows[0]
        if(!row)return false
        eventId=row.event_id
        await c.query(`INSERT INTO agnt_sale_notifications(event_id,user_id,kind,reference) VALUES($1,$2,$3,$4)
          ON CONFLICT(event_id) DO NOTHING`,[row.event_id,row.user_id,row.kind,row.reference])
        await c.query("UPDATE agnt_sale_outbox SET state='DELIVERED',attempts=attempts+1,delivered_at=now() WHERE event_id=$1",[row.event_id])
        return true
      },db)
      if(!found)break
      delivered++
    }catch(error){
      if(!eventId)throw error
      // Inbox insertion and DELIVERED commit together. Failure rolls both back;
      // record bounded backoff separately without saving private error details.
      await db.query(`UPDATE agnt_sale_outbox SET attempts=attempts+1,
        state=CASE WHEN attempts+1>=10 THEN 'FAILED' ELSE 'RETRY' END,
        next_retry_at=now()+(LEAST(3600,30*power(2,LEAST(attempts,7))) * interval '1 second')
        WHERE event_id=$1 AND state IN ('PENDING','RETRY')`,[eventId])
      retried++
    }
  }
  return {delivered,retried}
}

export async function saleNotifications(db:Pool,user:string){
  return (await db.query('SELECT event_id,kind,reference,created_at,read_at FROM agnt_sale_notifications WHERE user_id=$1 ORDER BY created_at DESC,event_id LIMIT 100',[user])).rows
}

export async function markSaleNotificationRead(db:Pool,user:string,id:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new SaleError('invalid_notification')
  const row=(await db.query('UPDATE agnt_sale_notifications SET read_at=COALESCE(read_at,now()) WHERE event_id=$1 AND user_id=$2 RETURNING event_id,read_at',[id,user])).rows[0]
  if(!row)throw new SaleError('notification_not_found',404)
  return row
}
