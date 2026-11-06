import test from 'node:test'
import assert from 'node:assert/strict'
import { describePassAccess } from '../sale/runtime.js'
import type { SaleService } from '../sale/service.js'

test('collectible status is read-only, policy-versioned and unavailable on database failure',async()=>{
  const names=['AGNT_PASS_ACCESS_REQUIRED','AGNT_PASS_DURATION_DAYS','AGNT_PASS_DAILY_CALLS']
  const previous=names.map(name=>process.env[name])
  const calls:unknown[][]=[]
  const service={accessSnapshot:async(...args:unknown[])=>{calls.push(args);return {eligible:true,source:'collectible_pass',policyVersion:'a'.repeat(64),passes:[{serial:1}]}}} as unknown as SaleService
  try{
    process.env.AGNT_PASS_ACCESS_REQUIRED='true'
    process.env.AGNT_PASS_DURATION_DAYS='30'
    process.env.AGNT_PASS_DAILY_CALLS='5'
    const a=await describePassAccess('alice',service)
    const b=await describePassAccess('alice',service)
    assert.equal(a.enforced,true)
    assert.equal(a.policyVersion,b.policyVersion)
    assert.match(a.policyVersion!,/^[a-f0-9]{64}$/)
    assert.deepEqual(calls[0],['alice'])
    process.env.AGNT_PASS_DAILY_CALLS='6'
    assert.equal((await describePassAccess('alice',service)).policyVersion,a.policyVersion)
    const broken={accessSnapshot:async()=>{throw new Error('private connection string')}} as unknown as SaleService
    const failed=await describePassAccess('alice',broken)
    assert.equal(failed.eligible,false)
    assert.equal(failed.reason,'pass_state_unavailable')
    assert.equal(failed.passes,null)
    assert.ok(!JSON.stringify(failed).includes('private connection'))
    delete process.env.AGNT_PASS_DURATION_DAYS
    assert.equal((await describePassAccess('alice',service)).policyVersion,a.policyVersion)
  }finally{
    names.forEach((name,i)=>{if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i]})
  }
})
