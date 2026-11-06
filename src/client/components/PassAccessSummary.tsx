export interface PassAccess {
  source:string;enforced:boolean;eligible:boolean;reason:string|null;policyVersion:string|null
  dailyLimit?:number|null;usedToday?:number;remainingToday?:number|null;durationDays?:number|null
}

export default function PassAccessSummary({access}:{access?:PassAccess}){
  const reasons:Record<string,string>={access_terms_unconfigured:'Pass terms are not configured.',account_frozen:'Access is suspended for settlement review.',access_pass_required:'No currently eligible pass.',daily_tool_limit:'Daily tool allowance used up.',pass_state_unavailable:'Pass access status is unavailable.'}
  if(!access||access.source!=='collectible_pass')return <p>Pass access status is unavailable. Ownership alone is not confirmation of tool access.</p>
  return <div>
    <h3>Pass access status</h3>
    <p>{access.enforced?'Pass checks are enabled.':'Pass checks are disabled; this is not an access guarantee.'}</p>
    <p>{access.eligible?'Eligible under the stored pass policy. Each tool call still checks permissions and available quota.':reasons[access.reason??'']??'Pass access status is unavailable.'}</p>
    {access.dailyLimit!=null&&<p>Daily allowance: {access.dailyLimit} calls · Used today: {access.usedToday??'Unavailable'} · Remaining: {access.remainingToday??'Unavailable'} · Resets at 00:00 UTC.</p>}
    {access.durationDays!=null&&<p>Stored duration: {access.durationDays} days from purchase. Multiple passes do not multiply the daily allowance.</p>}
    {access.policyVersion&&<p style={{overflowWrap:'anywhere'}}>Stored policy version: <code>{access.policyVersion}</code></p>}
    <p>Access requires a pass issued under this policy. This status does not open the sale, grant admin rights, cover gas or third-party fees, or authorize wallet spending.</p>
  </div>
}
