import test from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { recentSaleAuth } from '../sale/recent-auth.js'

test('sale mutations require recent server authentication, never an activity timestamp',()=>{
  const now=Date.parse('2026-09-20T12:00:00Z')
  function check(path:string,created:string|undefined,method='POST'){
    let status=0,proceeded=false,body:unknown
    const res={status(code:number){status=code;return this},json(value:unknown){body=value}} as Response
    recentSaleAuth(()=>created,()=>now)({path,method} as Request,res,()=>{proceeded=true})
    return {status,proceeded,body}
  }
  for(const path of ['/purchases','/withdrawals','/WITHDRAWALS/','/request-recovery','/operator/withdrawals/11111111-1111-1111-1111-111111111111/approve']){
    for(const created of [undefined,'invalid',new Date(now+1).toISOString(),new Date(now-900001).toISOString()]){
      const result=check(path,created)
      assert.equal(result.status,401)
      assert.equal(result.proceeded,false)
      assert.equal((result.body as {error:string}).error,'sale_recent_login_required')
    }
    assert.equal(check(path,new Date(now-900000).toISOString()).proceeded,true)
    assert.equal(check(path,new Date(now).toISOString()).proceeded,true)
  }
  for(const path of ['/account','/request-status','/cancel-pending-request','/withdrawals/id/cancel','/quote']){
    assert.equal(check(path,undefined).proceeded,true)
  }
  assert.equal(check('/purchases',undefined,'GET').proceeded,true)
})
