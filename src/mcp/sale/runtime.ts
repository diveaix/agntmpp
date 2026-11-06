import { SaleError } from './pricing.js'
import { SaleService } from './service.js'

// Display only: dispatch must still call enforcePassAccess and atomically
// consume quota. Never authorize a tool using a cached dashboard response.
export async function describePassAccess(user:string,service?:SaleService) {
  const enforced=process.env.AGNT_PASS_ACCESS_REQUIRED==='true'
  try{
    const snapshot=await (service??new SaleService()).accessSnapshot(user)
    return {...snapshot,enforced,scope:'Supported tools only; not admin rights, gas, third-party fees or wallet-spending authorization.'}
  }catch{
    return {source:'collectible_pass' as const,enforced,policyVersion:null,eligible:false,reason:'pass_state_unavailable',passes:null}
  }
}

export function saleReadiness() {
  const blockers = ['Zcash observer and treasury signer have not been connected and verified.']
  if (!process.env.AGNT_SALE_DATABASE_URL) blockers.push('PostgreSQL is not configured.')
  blockers.push('Stored pass terms and launch policies require operator verification.')
  return { launchEnabled:false, fundingEnabled:false, withdrawalsEnabled:false, blockers }
}
export function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,6}$/.test(value)) return null
  return Number(value)
}
export function requireSaleLaunch(): never {
  // Deliberate hard gate: an environment toggle alone must not activate an unverified treasury.
  throw new SaleError('real_money_sale_not_ready',503)
}
export async function enforcePassAccess(user: string | undefined, tool: string): Promise<void> {
  if (process.env.AGNT_PASS_ACCESS_REQUIRED !== 'true') return
  if (!user) throw new SaleError('account_required',401)
  if (tool==='account') return
  if (tool==='skill_manager') throw new SaleError('pass_does_not_grant_admin_access',403)
  await new SaleService().consumeAccess(user)
}
