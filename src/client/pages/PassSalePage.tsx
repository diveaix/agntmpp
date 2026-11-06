import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Nav from '../components/Nav'
import Footer from '../components/Footer'
import PassAccessSummary, { type PassAccess } from '../components/PassAccessSummary'
import '../pass-sale.css'
import { zecToZatoshi } from '../sale-amount'
import { saleApi as api, isDefinitiveSaleRejection, readPurchaseReceipt } from '../sale-api'
import { loadPendingSale, savePendingSale, clearPendingSale, recoverPendingSale, validQuotedAccessPolicy, type QuotedAccessPolicy, type PendingWithdrawal } from '../sale-pending'

type Summary = { state:string;sold:number|null;supply:number;nextPriceZatoshi:string|null;firstPriceZatoshi:string;lastPriceZatoshi:string;launchEnabled:boolean;fundingEnabled:boolean;withdrawalsEnabled:boolean;blockers:string[] }
type Account = { userId:string;collectibleAccess?:PassAccess;balance:{available:string;held:string;frozen:boolean};passes:{serial:number;state:string}[];deposits:{receipt_id:string;amount:string;state:string;confirmations:number;required_confirmations?:number|null}[];purchases:{id:string;quantity:number;total:string}[];withdrawals:{id:string;amount:string;state:string;settlement_review?:boolean;confirmations?:number|null;required_confirmations?:number|null;confirmation_checked_at?:string|null}[] }
type Quote = {id:string;quantity:number;totalZatoshi:string;curveVersion:string;expiresAt:string;soldCountSnapshot?:number;availableSupply?:number;accessPolicy?:QuotedAccessPolicy|null}
type WithdrawalRequest=PendingWithdrawal
type SaleNotification={event_id:string;kind:string;reference:string;created_at:string;read_at:string|null}
function zec(value:string|null|undefined) {
  if(value==null)return '—'
  const n=BigInt(value)
  return `${n/100000000n}.${String(n%100000000n).padStart(8,'0')}`
}
export default function PassSalePage(){
  const [summary,setSummary]=useState<Summary|null>(null)
  const [summaryChecked,setSummaryChecked]=useState(false)
  const [account,setAccount]=useState<Account|null>(null)
  const [recovery,setRecovery]=useState<{userId:string;requestGeneration:number}|null>(null)
  const [recoveryAccepted,setRecoveryAccepted]=useState(false)
  const [recoveryCompletedFor,setRecoveryCompletedFor]=useState<string|null>(null)
  const [inbox,setInbox]=useState<{userId:string;notifications:SaleNotification[]}|null>(null)
  const [inboxError,setInboxError]=useState('')
  const [quantity,setQuantity]=useState(1)
  const [quote,setQuote]=useState<Quote|null>(null)
  const [error,setError]=useState('')
  const [accountMessage,setAccountMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [accepted,setAccepted]=useState(false)
  const [purchaseKey,setPurchaseKey]=useState<string>(()=>crypto.randomUUID())
  const [purchasePending,setPurchasePending]=useState(false)
  const [deposit,setDeposit]=useState<{network:string;address:string}|null>(null)
  const [destination,setDestination]=useState('')
  const [withdrawAmount,setWithdrawAmount]=useState('')
  const [feeLimit,setFeeLimit]=useState('')
  const [withdrawAccepted,setWithdrawAccepted]=useState(false)
  const [withdrawalRequest,setWithdrawalRequest]=useState<WithdrawalRequest|null>(null)
  async function refreshInbox(owner:string){
    setInbox(null);setInboxError('')
    try{
      const data=await api<{userId:string;notifications:SaleNotification[]}>('/notifications')
      if(data.userId!==owner||!Array.isArray(data.notifications)||data.notifications.some(n=>!n||['event_id','kind','reference','created_at'].some(key=>typeof n[key as keyof SaleNotification]!=='string')||(n.read_at!==null&&typeof n.read_at!=='string')))throw new Error('Invalid inbox response')
      setInbox(data)
    }catch{setInboxError('Notifications are unavailable. Your balance and payment recovery remain available.')}
  }
  async function readNotification(id:string){
    if(!account)return
    setBusy(true)
    try{await api(`/notifications/${encodeURIComponent(id)}/read`,{ownerId:account.userId});await refreshInbox(account.userId)}
    catch{setInboxError('Could not mark this notification as read. Refresh and try again.')}
    finally{setBusy(false)}
  }
  async function refresh(){
    setRecoveryCompletedFor(null)
    setRecovery(null);setRecoveryAccepted(false)
    setInbox(null);setInboxError('')
    try{setSummary(await api<Summary>(''));setError('')}catch(e){setSummary(null);setError((e as Error).message)}finally{setSummaryChecked(true)}
    try{
      const next=await api<Account>('/account')
      if(typeof next.userId!=='string'||!next.userId)throw new Error('Account identity is unavailable.')
      const state=await api<{userId:string;requestGeneration:number}>('/request-recovery')
      if(state.userId!==next.userId||!Number.isSafeInteger(state.requestGeneration)||state.requestGeneration<0||state.requestGeneration>2147483647)throw new Error('Request recovery state is unavailable.')
      setRecovery(state)
      const warnings=await recoverPendingSale(next.userId,body=>api('/request-status',body))
      if(warnings.length)setError(warnings.join(' '))
      const pendingPurchase=loadPendingSale(next.userId,'purchase'),pendingWithdrawal=loadPendingSale(next.userId,'withdrawal')
      setAccount(next);setAccountMessage('');setDeposit(null)
      setPurchasePending(!!pendingPurchase);setAccepted(!!pendingPurchase)
      setQuote(pendingPurchase?{id:pendingPurchase.quoteId,quantity:pendingPurchase.quantity,totalZatoshi:pendingPurchase.maxTotalZatoshi,curveVersion:pendingPurchase.curveVersion,expiresAt:pendingPurchase.expiresAt,accessPolicy:pendingPurchase.accessPolicy}:null)
      if(pendingPurchase){setPurchaseKey(pendingPurchase.idempotencyKey);setQuantity(pendingPurchase.quantity)}
      setWithdrawalRequest(pendingWithdrawal);setWithdrawAccepted(!!pendingWithdrawal)
      setDestination(pendingWithdrawal?.destination??'');setWithdrawAmount(pendingWithdrawal?zec(pendingWithdrawal.amountZatoshi):'');setFeeLimit(pendingWithdrawal?zec(pendingWithdrawal.feeLimitZatoshi):'')
      await refreshInbox(next.userId)
    }catch(e){setAccount(null);setAccountMessage((e as Error).message)}
  }
  useEffect(()=>{void refresh()},[])
  async function getQuote(){
    if(purchasePending)return
    setBusy(true);setError('');setQuote(null);setAccepted(false)
    try{setQuote(await api<Quote>('/quote',{quantity}));setPurchaseKey(crypto.randomUUID())}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function exportHistory(purchaseId?:string){
    if(!account)return
    setBusy(true);setError('')
    try{
      const data=purchaseId?await readPurchaseReceipt(account.userId,purchaseId):await api<{userId:string}>('/account/export')
      if(data.userId!==account.userId)throw new Error('Account changed. Refresh before exporting.')
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}))
      const link=document.createElement('a')
      link.href=url;link.download=purchaseId?'agent-purchase-receipt.json':'agent-sale-history.json';document.body.appendChild(link);link.click();link.remove()
      setTimeout(()=>URL.revokeObjectURL(url),1000)
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function purchase(){
    if(!quote||!accepted||!account||recovery?.userId!==account.userId)return
    if(!purchasePending&&!validQuotedAccessPolicy(quote.accessPolicy)){setError('Access terms are unavailable. Request a new quote before purchasing.');return}
    const recovering=purchasePending
    setBusy(true);setError('')
    setPurchasePending(true)
    try{
      const pending=loadPendingSale(account.userId,'purchase')??{ownerId:account.userId,requestGeneration:recovery.requestGeneration,quoteId:quote.id,quantity:quote.quantity,maxTotalZatoshi:quote.totalZatoshi,curveVersion:quote.curveVersion,idempotencyKey:purchaseKey,expiresAt:quote.expiresAt,...(validQuotedAccessPolicy(quote.accessPolicy)?{accessPolicy:quote.accessPolicy}:{})}
      savePendingSale(account.userId,'purchase',pending)
      await api('/purchases',pending)
      clearPendingSale(account.userId,'purchase')
      setPurchasePending(false);setQuote(null);setAccepted(false);await refresh()
    }catch(e){if(!recovering&&isDefinitiveSaleRejection(e)){clearPendingSale(account.userId,'purchase');setPurchasePending(false)}setError((e as Error).message)}finally{setBusy(false)}
  }
  async function cancelWithdrawal(id:string){
    setBusy(true);setError('')
    try{await api(`/withdrawals/${encodeURIComponent(id)}/cancel`,{});await refresh()}
    catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function cancelPending(kind:'purchase'|'withdrawal'){
    if(!account)return
    setBusy(true);setError('')
    try{
      const pending=loadPendingSale(account.userId,kind)
      if(!pending)throw new Error('No pending request is available to resolve.')
      await api('/cancel-pending-request',{ownerId:account.userId,kind,idempotencyKey:pending.idempotencyKey})
      // Do not clear on a transport response alone; refresh verifies the durable
      // receipt/cancellation, including after an ambiguous cancellation response.
      await refresh()
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function fund(){
    if(!account)return
    setBusy(true);setError('')
    try{setDeposit(await api('/deposit-address',{ownerId:account.userId}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function withdraw(){
    if(!account||recovery?.userId!==account.userId)return
    const recovering=!!withdrawalRequest
    setBusy(true);setError('')
    try{
      const request=withdrawalRequest??{ownerId:account.userId,requestGeneration:recovery.requestGeneration,destination:destination.trim(),amountZatoshi:zecToZatoshi(withdrawAmount),feeLimitZatoshi:zecToZatoshi(feeLimit),idempotencyKey:crypto.randomUUID()}
      if(!withdrawalRequest&&(!withdrawAccepted||request.amountZatoshi==='0'))throw new Error('Enter a positive amount and confirm the withdrawal details.')
      setWithdrawalRequest(request)
      savePendingSale(account.userId,'withdrawal',request)
      await api('/withdrawals',request)
      clearPendingSale(account.userId,'withdrawal')
      setWithdrawalRequest(null);setWithdrawAmount('');setWithdrawAccepted(false);await refresh()
    }catch(e){
      // A transport/5xx failure may have created the hold. Lock the draft and
      // retry its exact payload/key, never silently create another withdrawal.
      if(!recovering&&isDefinitiveSaleRejection(e)){clearPendingSale(account.userId,'withdrawal');setWithdrawalRequest(null)}
      setError((e as Error).message)
    }finally{setBusy(false)}
  }
  async function resetLostRequests(){
    if(!recovery||!recoveryAccepted)return
    setBusy(true);setError('')
    try{
      const result=await api<{userId:string;requestGeneration:number;recordedRequestsPreserved:boolean}>('/request-recovery',{ownerId:recovery.userId,expectedGeneration:recovery.requestGeneration})
      if(result.userId!==recovery.userId||result.requestGeneration!==recovery.requestGeneration+1||result.recordedRequestsPreserved!==true)throw new Error('Recovery response could not be verified. Refresh and review account history.')
      clearPendingSale(recovery.userId,'purchase');clearPendingSale(recovery.userId,'withdrawal')
      await refresh()
      setRecoveryCompletedFor(recovery.userId)
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  return <><Nav/><main className="pass-sale">
    <div className="pass-eyebrow">./AGENT ACCESS COLLECTION</div>
    <h1>One pass.<br/>Your agent, equipped.</h1>
    <p className="pass-lead">4,444 account-bound access collectibles. Fund with ZEC, buy from confirmed credit, and unlock supported tools. Database-managed ownership—not a native Zcash NFT.</p>
    <div className="pass-status" role="status">{summary ? `${summary.launchEnabled ? summary.state : 'NOT OPEN'} · ${summary.sold==null ? 'Inventory unavailable' : `${summary.sold} / ${summary.supply} sold`}` : summaryChecked ? 'SALE UNAVAILABLE · No funds can be accepted' : 'Checking sale availability…'}</div>
    {error&&<p className="pass-error" role="alert">{error}</p>}
    {recoveryCompletedFor&&recovery?.userId===recoveryCompletedFor&&<p role="status">Older uncommitted requests have been stopped. Recorded purchases and withdrawal holds are unchanged. Review your history below before submitting another request.</p>}
    {recovery&&<details><summary>Lost or unreadable pending request?</summary>
      <p>Stop older uncommitted purchase and withdrawal requests across your account. Completed purchases are not refunded, and existing withdrawal holds are not canceled. Review your history afterward. Other tabs must refresh before starting new requests.</p>
      <label><input type="checkbox" checked={recoveryAccepted} disabled={busy} onChange={e=>setRecoveryAccepted(e.target.checked)}/> I understand that recorded purchases and withdrawal holds remain.</label>
      <button disabled={busy||!recoveryAccepted} onClick={()=>void resetLostRequests()}>Stop older uncommitted requests</button>
    </details>}
    <section className="pass-metrics" aria-label="Sale pricing">
      <div><span>First pass</span><strong>{zec(summary?.firstPriceZatoshi)} ZEC</strong></div>
      <div><span>Next pass</span><strong>{zec(summary?.nextPriceZatoshi)} ZEC</strong></div>
      <div><span>Final pass</span><strong>{zec(summary?.lastPriceZatoshi)} ZEC</strong></div>
      <div><span>Per sale</span><strong>+0.04444%</strong></div>
    </section>
    <div className="pass-columns">
      <section className="pass-panel"><h2>Purchase access</h2>
        <p>The curve advances only after a completed purchase. Quotes do not reserve inventory. Every pass in a multi-buy uses its own price on the curve.</p>
        <label htmlFor="pass-quantity">Quantity</label>
        <input id="pass-quantity" type="number" min={1} max={4444} step={1} value={quantity} disabled={busy||purchasePending} onChange={e=>{setQuantity(Number(e.target.value));setQuote(null);setAccepted(false)}}/>
        <button onClick={getQuote} disabled={busy||purchasePending||!account||!Number.isInteger(quantity)||quantity<1||quantity>4444}>Preview exact price</button>
        {quote&&<div className="pass-quote"><strong>{zec(quote.totalZatoshi)} ZEC maximum</strong><p>Quote expires {new Date(quote.expiresAt).toLocaleTimeString()}. If the price rises, the purchase is rejected without spending your credit.</p>
          {quote.soldCountSnapshot!==undefined&&<p>At quote time: {quote.soldCountSnapshot} sold · {quote.availableSupply} available. No inventory is reserved.</p>}
          {validQuotedAccessPolicy(quote.accessPolicy)?<div><p>Quoted access: {quote.accessPolicy.durationDays} days from purchase · {quote.accessPolicy.dailyCalls} tool calls per account per UTC day. Multiple passes do not multiply the daily allowance.</p><p style={{overflowWrap:'anywhere'}}>Accepted policy version: <code>{quote.accessPolicy.version}</code></p></div>:<p>Access terms are unavailable. New purchases are disabled. An existing pending request can still be checked or retried unchanged.</p>}
          <label className="pass-consent"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>I accept the quoted access duration and account-wide daily allowance above. I understand this is custodial credit and a non-transferable, database-managed pass. There is no curve sell-back.</label>
          {purchasePending&&<p role="status">This purchase may already have completed. Retry keeps the same price consent and request key.</p>}
          {purchasePending&&<><button disabled={busy} onClick={()=>void cancelPending('purchase')}>Resolve or stop pending purchase</button><p>Shows a recorded purchase, or permanently stops this request if it has not committed. This does not refund a completed purchase.</p></>}
          <button onClick={purchase} disabled={busy||!accepted||!summary?.launchEnabled||(!purchasePending&&(!validQuotedAccessPolicy(quote.accessPolicy)||Date.now()>=Date.parse(quote.expiresAt)))}>{purchasePending?'Retry same purchase':`Buy ${quote.quantity} ${quote.quantity===1?'pass':'passes'}`}</button>
        </div>}
        {!summary?.launchEnabled&&<p>Purchasing is locked until settlement infrastructure and access terms are approved.</p>}
      </section>
      <section className="pass-panel"><h2>Your ZEC credit</h2>
        {account ? <><dl><dt>Available</dt><dd>{zec(account.balance.available)} ZEC</dd><dt>Held for withdrawals</dt><dd>{zec(account.balance.held)} ZEC</dd></dl>{account.balance.frozen&&<p role="alert">Account under settlement review. Purchases and withdrawals are paused.</p>}</> : <p>{accountMessage||'Loading account…'} <Link to="/toolkit">Explore the MCP connection</Link></p>}
        <button onClick={fund} disabled={busy||!account||account.balance.frozen||!summary?.fundingEnabled}>{summary?.fundingEnabled?'Show my ZEC deposit address':'Fund with ZEC — unavailable'}</button>
        {deposit&&account&&summary?.fundingEnabled&&<div className="pass-quote"><strong>{deposit.network} deposit address</strong><p style={{overflowWrap:'anywhere'}}><code>{deposit.address}</code></p><p>Send only ZEC on this network. Credit becomes spendable after confirmation; a deposit does not reserve a pass price.</p></div>}
        {!summary?.fundingEnabled&&<p>No deposit address is shown until the wallet connection and withdrawal path are verified. Do not send ZEC to an address supplied outside this flow.</p>}
        <h3>Withdraw unused credit</h3>
        <p>Use a Zcash Unified Address with an Orchard receiver on the configured network. Transparent-only and legacy shielded addresses are not supported by this withdrawal path.</p>
        <label htmlFor="withdraw-destination">Zcash recipient address</label><input id="withdraw-destination" value={destination} disabled={busy||!!withdrawalRequest} onChange={e=>{setDestination(e.target.value);setWithdrawAccepted(false)}} autoComplete="off"/>
        <label htmlFor="withdraw-amount">Amount (ZEC)</label><input id="withdraw-amount" inputMode="decimal" value={withdrawAmount} disabled={busy||!!withdrawalRequest} onChange={e=>{setWithdrawAmount(e.target.value);setWithdrawAccepted(false)}}/>
        <label htmlFor="withdraw-fee">Maximum network fee (ZEC)</label><input id="withdraw-fee" inputMode="decimal" value={feeLimit} disabled={busy||!!withdrawalRequest} onChange={e=>{setFeeLimit(e.target.value);setWithdrawAccepted(false)}}/>
        <label className="pass-consent"><input type="checkbox" checked={withdrawAccepted} disabled={busy||!!withdrawalRequest} onChange={e=>setWithdrawAccepted(e.target.checked)}/>I checked the recipient and amount. The amount plus fee limit will be reserved; unused fee allowance is returned after settlement.</label>
        {withdrawalRequest&&<p role="status">The request may already have been received. Retry submits the same request; its details are locked to avoid duplicate holds.</p>}
        {withdrawalRequest&&<><button disabled={busy} onClick={()=>void cancelPending('withdrawal')}>Resolve or stop pending withdrawal</button><p>Shows an existing hold, or permanently stops this request if no hold exists. Existing holds must be canceled separately while unsigned.</p></>}
        <button onClick={withdraw} disabled={busy||!account||account.balance.frozen||!summary?.withdrawalsEnabled||(!withdrawalRequest&&(!withdrawAccepted||!destination.trim()||!withdrawAmount||!feeLimit))}>{withdrawalRequest?'Retry same withdrawal':summary?.withdrawalsEnabled?'Request withdrawal':'Withdraw unused credit — unavailable'}</button>
        <button onClick={()=>void refresh()} disabled={busy}>Refresh balance and status</button>
      </section>
    </div>
    <section className="pass-panel"><h2>Your passes</h2>
      {account&&<PassAccessSummary access={account.collectibleAccess}/>}
      <button onClick={()=>void exportHistory()} disabled={busy||!account}>Export holdings and full history</button>
      <p>The JSON export contains private account history. Store it securely. It is a record, not a transferable ownership token. History previews below show the latest 100 entries per category.</p>
      {account?.passes.length ? <div className="pass-holdings">{account.passes.map(p=><div key={p.serial}><span>./AGENT #{String(p.serial).padStart(4,'0')}</span><strong>{p.state}</strong></div>)}</div> : <p>No passes to display. Sign in to see account-bound ownership.</p>}
      {!!account?.deposits.length&&<><h3>Deposits</h3>{account.deposits.map(d=><p key={d.receipt_id}>{zec(d.amount)} ZEC · {d.state} · {d.confirmations} / {d.required_confirmations??'unknown'} confirmations required at last check (not a time estimate)</p>)}</>}
      {!!account?.purchases.length&&<><h3>Purchase receipts</h3>{account.purchases.map(p=><div key={p.id}><p>{p.quantity} passes · {zec(p.total)} ZEC · <code>{p.id}</code></p><button disabled={busy} onClick={()=>void exportHistory(p.id)} aria-label={`Download receipt ${p.id}`}>Download receipt</button></div>)}</>}
      {!!account?.withdrawals.length&&<><h3>Withdrawals</h3>{account.withdrawals.map(w=><div key={w.id}><p>{zec(w.amount)} ZEC · {w.state}{w.settlement_review?' · SETTLEMENT REVIEW':''}</p>{w.confirmation_checked_at&&<p>{w.confirmations??'unknown'} / {w.required_confirmations??'unknown'} confirmations at last check: {new Date(w.confirmation_checked_at).toLocaleString()}. Not a time estimate.</p>}{w.state==='HELD'&&<button disabled={busy} onClick={()=>void cancelWithdrawal(w.id)}>Cancel unsigned withdrawal</button>}</div>)}</>}
    </section>
    <section className="pass-panel"><h2>Account notifications</h2>
      <p>Private delivery updates, not payment confirmations. Check the balance and receipt status above before taking action. Showing the latest 100 notifications.</p>
      {!account?<p>Sign in to view your inbox.</p>:inboxError?<p role="status">{inboxError}</p>:inbox?.userId===account.userId?<>
        {!inbox.notifications.length&&<p>No notifications yet.</p>}
        {inbox.notifications.map(n=><div key={n.event_id}><p><strong>{n.kind.replaceAll('_',' ')}</strong> · {n.read_at?'Read':'Unread'}</p><p style={{overflowWrap:'anywhere'}}>Reference: <code>{n.reference}</code></p><p>{new Date(n.created_at).toLocaleString()}</p>{!n.read_at&&<button disabled={busy} onClick={()=>void readNotification(n.event_id)}>Mark as read</button>}</div>)}
      </>:<p>Loading notifications…</p>}
    </section>
    <section className="pass-panel"><h2>Know what you are buying</h2><ul>
      <li>Pass duration and usage allowances are not finalized. No sale opens before those terms are published.</li>
      <li>Access does not include wallet-spending authorization, network gas, unrestricted admin actions, or guaranteed investment returns.</li>
      <li>Unused funding is custodial credit. Funding does not guarantee a pass or lock its price.</li>
      <li>EVM transactions remain public. This pass does not make DeFi activity anonymous.</li>
    </ul>{!!summary?.blockers.length&&<><h3>Before launch</h3><ul>{summary.blockers.map(b=><li key={b}>{b}</li>)}</ul></>}</section>
  </main><Footer/></>
}
