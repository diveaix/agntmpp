import { randomUUID } from 'node:crypto'
import { SaleError } from './pricing.js'
import { ZcashRpcError, type ZcashRpc } from './zcash-observer.js'

export interface ZcashRpcConfig {
  endpoint:string
  username:string
  password:string
  methods:readonly string[]
  timeoutMs?:number
}

// Server-only transport. Never pass its configuration to the browser or MCP tools.
// Remote HTTP is rejected: use TLS or an authenticated loopback tunnel.
export function zcashRpcClient(config:ZcashRpcConfig):ZcashRpc{
  let endpoint:URL
  try{endpoint=new URL(config.endpoint)}catch{throw new SaleError('invalid_zcash_rpc_configuration',503)}
  const timeoutMs=config.timeoutMs??120000
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
    (endpoint.protocol!=='https:' && !(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))||
    !config.username||!config.password||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||
    !config.methods.length||config.methods.some(method=>!/^\w+$/.test(method)))throw new SaleError('invalid_zcash_rpc_configuration',503)
  const methods=new Set(config.methods)
  const authorization=`Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
  return async(method,params=[])=>{
    if(!methods.has(method))throw new SaleError('zcash_rpc_method_forbidden',403)
    const id=randomUUID(),body=JSON.stringify({jsonrpc:'2.0',id,method,params})
    if(Buffer.byteLength(body)>4*1024*1024)throw new SaleError('zcash_rpc_request_too_large',503)
    let response:Response
    try{response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:authorization,'Content-Type':'application/json'},body})}
    catch{throw new SaleError('zcash_rpc_transport_failed',503)}
    if(!response.ok){await response.body?.cancel();throw new SaleError('zcash_rpc_http_failed',503)}
    const reader=response.body?.getReader()
    if(!reader)throw new SaleError('invalid_zcash_rpc_response',503)
    const chunks:Uint8Array[]=[]
    let size=0
    try{
      for(;;){
        const chunk=await reader.read()
        if(chunk.done)break
        size+=chunk.value.byteLength
        if(size>16*1024*1024){await reader.cancel();throw new SaleError('zcash_rpc_response_too_large',503)}
        chunks.push(chunk.value)
      }
    }catch(error){if(error instanceof SaleError)throw error;throw new SaleError('zcash_rpc_transport_failed',503)}
    let result:any
    try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new SaleError('invalid_zcash_rpc_response',503)}
    if(!result||result.id!==id||result.jsonrpc!=='2.0')throw new SaleError('invalid_zcash_rpc_response',503)
    if(result.error){
      if(!Number.isSafeInteger(result.error.code))throw new SaleError('invalid_zcash_rpc_response',503)
      // Preserve only the exact non-wallet sentinel required by the scanner.
      // Other server messages may echo request details or secrets; don't expose them.
      const detail=method==='z_viewtransaction'&&result.error.code===-5&&result.error.message==='Invalid or non-wallet transaction id'?
        'Invalid or non-wallet transaction id':'RPC request rejected'
      throw new ZcashRpcError(method,result.error.code,detail)
    }
    if(!Object.hasOwn(result,'result'))throw new SaleError('invalid_zcash_rpc_response',503)
    return result.result
  }
}
