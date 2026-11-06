export type QuotedAccessPolicy={version:string;durationDays:number;dailyCalls:number}
export function validQuotedAccessPolicy(value:unknown):value is QuotedAccessPolicy{
  const p=value as QuotedAccessPolicy|null
  return !!p&&typeof p.version==='string'&&/^[a-f0-9]{64}$/.test(p.version)&&Number.isSafeInteger(p.durationDays)&&p.durationDays>0&&p.durationDays<=9999999&&Number.isSafeInteger(p.dailyCalls)&&p.dailyCalls>0&&p.dailyCalls<=9999999
}
export type PendingPurchase={ownerId:string;quoteId:string;quantity:number;maxTotalZatoshi:string;curveVersion:string;idempotencyKey:string;expiresAt:string;accessPolicy?:QuotedAccessPolicy;requestGeneration?:number}
export type PendingWithdrawal={ownerId:string;destination:string;amountZatoshi:string;feeLimitZatoshi:string;idempotencyKey:string;requestGeneration?:number}
type Pending={purchase:PendingPurchase;withdrawal:PendingWithdrawal}
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>
function key(owner:string,kind:keyof Pending){
  if(!owner)throw new Error('Sign in before preparing a sale request.')
  return `agnt.sale.pending.v1.${encodeURIComponent(owner)}.${kind}`
}
function valid(owner:string,kind:keyof Pending,value:any){
  if(!value||value.ownerId!==owner||typeof value.idempotencyKey!=='string'||!value.idempotencyKey)return false
  if(value.requestGeneration!==undefined&&(!Number.isSafeInteger(value.requestGeneration)||value.requestGeneration<0||value.requestGeneration>2147483647))return false
  if(kind==='purchase')return (value.accessPolicy===undefined||validQuotedAccessPolicy(value.accessPolicy))&&typeof value.quoteId==='string'&&Number.isInteger(value.quantity)&&value.quantity>0&&value.quantity<=4444&&
    typeof value.maxTotalZatoshi==='string'&&/^\d+$/.test(value.maxTotalZatoshi)&&typeof value.curveVersion==='string'&&typeof value.expiresAt==='string'&&Number.isFinite(Date.parse(value.expiresAt))
  return typeof value.destination==='string'&&value.destination.length>0&&typeof value.amountZatoshi==='string'&&/^\d+$/.test(value.amountZatoshi)&&typeof value.feeLimitZatoshi==='string'&&/^\d+$/.test(value.feeLimitZatoshi)
}
export function loadPendingSale<K extends keyof Pending>(owner:string,kind:K,storage:Store=sessionStorage):Pending[K]|null{
  const raw=storage.getItem(key(owner,kind))
  if(raw===null)return null
  let value:unknown
  try{value=JSON.parse(raw)}catch{throw new Error('Pending sale request is unreadable. Resolve its status before submitting another request.')}
  if(!valid(owner,kind,value))throw new Error('Pending sale request does not match this account or is invalid. Resolve its status before continuing.')
  return value as Pending[K]
}
export function savePendingSale<K extends keyof Pending>(owner:string,kind:K,value:Pending[K],storage:Store=sessionStorage){
  if(!valid(owner,kind,value))throw new Error('Invalid pending sale request.')
  const existing=loadPendingSale(owner,kind,storage)
  if(existing&&JSON.stringify(existing)!==JSON.stringify(value))throw new Error('Resolve the existing pending request before creating another one.')
  storage.setItem(key(owner,kind),JSON.stringify(value))
}
export function clearPendingSale(owner:string,kind:keyof Pending,storage:Store=sessionStorage){storage.removeItem(key(owner,kind))}

export async function recoverPendingSale(owner:string,lookup:(body:{ownerId:string;kind:keyof Pending;idempotencyKey:string})=>Promise<unknown>,storage:Store=sessionStorage){
  const warnings:string[]=[]
  for(const kind of ['purchase','withdrawal'] as const){
    // Invalid local storage must still block mutation controls.
    const pending=loadPendingSale(owner,kind,storage)
    if(!pending)continue
    let status:any
    try{status=await lookup({ownerId:owner,kind,idempotencyKey:pending.idempotencyKey})}
    catch{warnings.push(`Could not verify the pending ${kind}. Its original request is preserved.`);continue}
    if(status?.userId!==owner||status?.kind!==kind)throw new Error('Request status does not match this account.')
    if((status.status==='RECORDED'&&typeof status.receipt?.id==='string'&&status.receipt.id)||(status.status==='CANCELED'&&status.receipt===null))clearPendingSale(owner,kind,storage)
    else if(status.status!=='UNKNOWN'||status.receipt!==null)throw new Error('Request status is invalid. Keep the original request for recovery.')
  }
  return warnings
}
