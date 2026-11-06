import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './database.js'
import { SaleError } from './pricing.js'

export interface SaleAccessPolicy {version:string;durationDays:number;dailyCalls:number}

export function accessPolicy(durationDays:number,dailyCalls:number):SaleAccessPolicy {
  if(!Number.isSafeInteger(durationDays)||durationDays<1||durationDays>9999999||!Number.isSafeInteger(dailyCalls)||dailyCalls<1||dailyCalls>9999999)throw new SaleError('access_terms_unconfigured',503)
  const version=createHash('sha256').update(JSON.stringify({source:'collectible_pass',durationDays,dailyCalls,quotaTimezone:'UTC',quotaModel:'one_account_allowance',version:1})).digest('hex')
  return {version,durationDays,dailyCalls}
}

export function parseAccessPolicy(row:{access_policy_version?:unknown;access_duration_days?:unknown;access_daily_calls?:unknown}|undefined):SaleAccessPolicy {
  if(!row||typeof row.access_duration_days!=='number'||typeof row.access_daily_calls!=='number')throw new SaleError('access_terms_unconfigured',503)
  const policy=accessPolicy(row.access_duration_days,row.access_daily_calls)
  if(policy.version!==row.access_policy_version)throw new SaleError('access_policy_integrity_mismatch',503)
  return policy
}

export async function readAccessPolicy(db:Pool|PoolClient){
  return parseAccessPolicy((await db.query('SELECT access_policy_version,access_duration_days,access_daily_calls FROM agnt_sale WHERE id=1')).rows[0])
}

// Trusted operator composition only; no public route. This records explicit
// terms, never opens the sale, and cannot change issued collection promises.
export async function configureSaleAccess(db:Pool,durationDays:number,dailyCalls:number){
  const policy=accessPolicy(durationDays,dailyCalls)
  return transaction(async c=>{
    const sale=(await c.query('SELECT state,sold FROM agnt_sale WHERE id=1 FOR UPDATE')).rows[0]
    if(!sale||sale.state!=='CLOSED'||sale.sold!==0)throw new SaleError('access_policy_configuration_locked',409)
    if((await c.query('SELECT 1 FROM agnt_sale_purchases LIMIT 1')).rows.length)throw new SaleError('access_policy_configuration_locked',409)
    await c.query('UPDATE agnt_sale SET access_policy_version=$1,access_duration_days=$2,access_daily_calls=$3 WHERE id=1',[policy.version,policy.durationDays,policy.dailyCalls])
    return policy
  },db)
}
