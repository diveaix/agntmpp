import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { zcashRpcClient } from '../sale/zcash-rpc.js'
import { ZcashRpcError } from '../sale/zcash-observer.js'
import { zecJsonAmount } from '../sale/zallet-signer.js'

test('RPC transport bounds requests, streamed responses and waits, and never follows redirects',async()=>{
  let mode='redirect',received=0,redirected=0
  const server=createServer(async(req,res)=>{
    received++
    if(req.url==='/redirect-target'){redirected++;res.end();return}
    for await(const _chunk of req){ /* Drain the request before testing its response. */ }
    if(mode==='redirect'){res.writeHead(307,{Location:'/redirect-target'});res.end();return}
    if(mode==='oversize'){res.end(Buffer.alloc(16*1024*1024+1,32));return}
    if(mode==='stream-timeout'){res.writeHead(200);res.write('{');return}
    // Intentionally leave headers pending to exercise the connection timeout.
  })
  server.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const config={endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,username:'test',password:'test-only',methods:['getblock']}
  try{
    const client=zcashRpcClient({...config,timeoutMs:5000})
    await assert.rejects(client('getblock',['x'.repeat(4*1024*1024)]),/zcash_rpc_request_too_large/)
    assert.equal(received,0)
    await assert.rejects(client('getblock'),/zcash_rpc_transport_failed/)
    assert.equal(redirected,0)
    mode='oversize'
    await assert.rejects(client('getblock'),/zcash_rpc_response_too_large/)
    const bounded=zcashRpcClient({...config,timeoutMs:100})
    for(const value of ['header-timeout','stream-timeout']){
      mode=value
      await assert.rejects(bounded('getblock'),/zcash_rpc_transport_failed/)
    }
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('RPC configuration rejects remote plaintext and URL credentials',()=>{
  for(const endpoint of ['http://remote.example/rpc','ftp://127.0.0.1','https://user:secret@example.com','https://example.com/?key=secret']){
    assert.throws(()=>zcashRpcClient({endpoint,username:'test',password:'secret',methods:['getblock']}),/invalid_zcash_rpc_configuration/)
  }
})
test('RPC transport binds IDs, preserves exact amounts, restricts methods and redacts errors',async()=>{
  let mode='ok',received=0
  const server=createServer(async(req,res)=>{
    received++
    const chunks:Buffer[]=[]
    for await(const chunk of req)chunks.push(Buffer.from(chunk))
    const text=Buffer.concat(chunks).toString(),request=JSON.parse(text)
    if(request.method==='pczt_create'&&request.params.length)assert.ok(text.includes('0.00000001'))
    res.setHeader('Content-Type','application/json')
    if(mode==='invalid'){res.end('broken JSON');return}
    if(mode==='error'){res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-20,message:'private credentials must not escape'}}));return}
    if(mode==='unknown'){res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-5,message:'Invalid or non-wallet transaction id'}}));return}
    res.end(JSON.stringify({jsonrpc:'2.0',id:mode==='wrong-id'?'wrong':request.id,result:{ok:true}}))
  })
  server.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const client=zcashRpcClient({endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,username:'test',password:'test-only',methods:['pczt_create','z_viewtransaction']})
  try{
    await assert.rejects(client('sendrawtransaction'),/method_forbidden/)
    assert.equal(received,0)
    assert.deepEqual(await client('pczt_create',[{amount:zecJsonAmount('1')}]),{ok:true})
    mode='error'
    await assert.rejects(client('pczt_create'),error=>error instanceof ZcashRpcError&&!error.message.includes('private credentials'))
    mode='unknown'
    await assert.rejects(client('z_viewtransaction'),error=>error instanceof ZcashRpcError&&error.detail==='Invalid or non-wallet transaction id')
    for(const value of ['invalid','wrong-id']){mode=value;await assert.rejects(client('pczt_create'),/invalid_zcash_rpc_response/)}
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
