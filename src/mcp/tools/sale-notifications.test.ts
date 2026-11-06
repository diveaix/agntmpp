import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { deliverSaleNotifications, saleNotifications, markSaleNotificationRead } from '../sale/notifications.js'

test('inbox delivery is atomic, replay-safe, owner-bound and retries without changing financial records',async()=>{
  const db=new PGlite(),query=(sql:string,args?:unknown[])=>db.query<Record<string,any>>(sql,args)
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const event=randomUUID()
  try{
    await db.exec(await readFile(new URL('../sale/schema.sql',import.meta.url),'utf8'))
    await query("INSERT INTO agnt_sale_events(id,kind,user_id,reference) VALUES($1,'PURCHASE','alice','receipt-id')",[event])
    await query('INSERT INTO agnt_sale_outbox(event_id) VALUES($1)',[event])
    await db.exec("CREATE FUNCTION fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private diagnostic'; END $$; CREATE TRIGGER fail_inbox BEFORE INSERT ON agnt_sale_notifications FOR EACH ROW EXECUTE FUNCTION fail_inbox();")
    assert.deepEqual(await deliverSaleNotifications(pool),{delivered:0,retried:1})
    assert.equal((await saleNotifications(pool,'alice')).length,0)
    assert.deepEqual((await query('SELECT state,attempts FROM agnt_sale_outbox')).rows[0],{state:'RETRY',attempts:1})
    assert.deepEqual(await deliverSaleNotifications(pool),{delivered:0,retried:0},'Backoff must prevent immediate retry')
    await db.exec('DROP TRIGGER fail_inbox ON agnt_sale_notifications; DROP FUNCTION fail_inbox(); UPDATE agnt_sale_outbox SET next_retry_at=now();')
    assert.deepEqual(await deliverSaleNotifications(pool),{delivered:1,retried:0})
    assert.deepEqual(await deliverSaleNotifications(pool),{delivered:0,retried:0})
    assert.equal((await saleNotifications(pool,'alice')).length,1)
    assert.equal((await saleNotifications(pool,'bob')).length,0)
    await assert.rejects(markSaleNotificationRead(pool,'bob',event),/notification_not_found/)
    const first=await markSaleNotificationRead(pool,'alice',event)
    assert.deepEqual(await markSaleNotificationRead(pool,'alice',event),first)
    assert.deepEqual((await query('SELECT state,attempts FROM agnt_sale_outbox')).rows[0],{state:'DELIVERED',attempts:2})
    assert.equal((await query('SELECT count(*)::int AS count FROM agnt_sale_ledger')).rows[0].count,0)
    const failed=randomUUID()
    await query("INSERT INTO agnt_sale_events(id,kind,user_id,reference) VALUES($1,'PURCHASE','alice','second-receipt')",[failed])
    await query('INSERT INTO agnt_sale_outbox(event_id,attempts) VALUES($1,9)',[failed])
    await db.exec("CREATE FUNCTION fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private diagnostic'; END $$; CREATE TRIGGER fail_inbox BEFORE INSERT ON agnt_sale_notifications FOR EACH ROW EXECUTE FUNCTION fail_inbox();")
    await deliverSaleNotifications(pool)
    assert.deepEqual((await query('SELECT state,attempts FROM agnt_sale_outbox WHERE event_id=$1',[failed])).rows[0],{state:'FAILED',attempts:10})
    assert.deepEqual(await deliverSaleNotifications(pool),{delivered:0,retried:0})
  }finally{await db.close()}
})
