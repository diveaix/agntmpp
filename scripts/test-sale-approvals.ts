// Synthetic fixture provisioning only. Never imported by application code.
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { SaleService } from '../src/mcp/sale/service.js'
import { recordWithdrawalApproval } from '../src/mcp/sale/withdrawal-approvals.js'

export async function provisionFixtureTreasuryLimits(db:Pool){
  await db.query('INSERT INTO agnt_treasury_limits(id,max_payout,max_outstanding) VALUES(1,10000000000,100000000000) ON CONFLICT DO NOTHING')
}

export async function approveFixtureWithdrawal(service:SaleService,db:Pool,user:string,id:string){
  await provisionFixtureTreasuryLimits(db)
  const row=(await db.query('SELECT state FROM agnt_sale_withdrawals WHERE id=$1',[id])).rows[0]
  if(row?.state==='HELD')for(const actor of ['fixture-treasury-a','fixture-treasury-b']){
    await db.query(`INSERT INTO agnt_treasury_operators(actor_id,enabled,authorization_version)
      VALUES($1,true,$2) ON CONFLICT DO NOTHING`,[actor,randomUUID()])
    await recordWithdrawalApproval(db,actor,id,'Synthetic integration fixture approval')
  }
  return service.approveWithdrawal(user,id)
}
