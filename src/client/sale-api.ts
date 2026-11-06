export class SaleApiError extends Error {constructor(message:string,readonly status:number){super(message)}}

export async function readPurchaseReceipt(owner:string,id:string,send:typeof fetch=fetch){
  const data=await saleApi<{userId:string;purchase:{id:string}}>('/purchases/'+encodeURIComponent(id),undefined,send)
  if(!data||data.userId!==owner||data.purchase?.id!==id)throw new Error('Receipt does not match this account or purchase. Refresh before downloading.')
  return data
}

export async function saleApi<T>(path:string,body?:unknown,send:typeof fetch=fetch):Promise<T>{
  const response=await send(`/api/sale${path}`,{credentials:'include',...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})
  // A malformed success response is ambiguous, not proof that a mutation failed
  // or succeeded. Throw so the caller retains its exact retry payload/key.
  let data:any
  try{data=await response.json()}catch{throw new Error(body===undefined?'The access service is unavailable. Please try again later.':'Unreadable sale response. Retry the same request; it may already have been received.')}
  if(!response.ok)throw new SaleApiError(response.status===401?'Account access is unavailable while the dashboard is paused.':data?.error||'Request failed',response.status)
  if(body!==undefined && (path==='/purchases'||path==='/withdrawals') &&
    (!data||typeof data.id!=='string'||!data.id))throw new Error('Missing transaction receipt. Retry the same request; it may already have been received.')
  return data as T
}

export function isDefinitiveSaleRejection(error:unknown){
  return error instanceof SaleApiError&&error.status>=400&&error.status<500&&error.status!==408&&error.status!==429&&
    error.message!=='sale_account_changed'&&error.message!=='idempotency_conflict'
}
