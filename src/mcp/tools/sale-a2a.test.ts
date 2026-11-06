import test from 'node:test'
import assert from 'node:assert/strict'
import { submitTask, getTask, cancelTask, listTasks, getTaskStats } from '../a2a.js'
import { getAccessEntitlement } from '../access-store.js'
import type { AuthContext } from '../access-types.js'
import { createAutomation, loadAutomations } from '../scheduler.js'
import { dispatchMatchedEventAutomation } from '../event-action-dispatcher.js'
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPriceAlerts, groupPriceAlerts } from '../automation-runner.js'

test('A2A carries trusted account identity into pass checks and isolates task history',async()=>{
  const previous=process.env.AGNT_PASS_ACCESS_REQUIRED
  const duration=process.env.AGNT_SALE_DATABASE_URL
  const auth:AuthContext={userId:'sale-a2a-alice',apiKeyId:'test-key',plan:'free',subscriptionStatus:'active',entitlement:getAccessEntitlement('free'),source:'api_key'}
  try{
    process.env.AGNT_PASS_ACCESS_REQUIRED='true'
    delete process.env.AGNT_SALE_DATABASE_URL
    const task=await submitTask('price of BTC',{userId:'sale-a2a-bob'},auth)
    assert.equal(task.state,'failed')
    // A missing forwarded auth would fail with account_required instead.
    assert.match(JSON.stringify(task.artifacts),/sale_database_unconfigured/)
    assert.equal(getTask(task.id,auth.userId)?.id,task.id)
    assert.equal(getTask(task.id,'sale-a2a-bob'),null)
    assert.equal(getTask(task.id),null)
    assert.equal(cancelTask(task.id,'sale-a2a-bob'),null)
    assert.equal(listTasks(50,'sale-a2a-bob').some(t=>t.id===task.id),false)
    assert.equal(getTaskStats('sale-a2a-bob').total,0)
    assert.equal(getTaskStats(auth.userId).total,1)
  }finally{
    if(previous===undefined)delete process.env.AGNT_PASS_ACCESS_REQUIRED
    else process.env.AGNT_PASS_ACCESS_REQUIRED=previous
    if(duration===undefined)delete process.env.AGNT_SALE_DATABASE_URL
    else process.env.AGNT_SALE_DATABASE_URL=duration
  }
})

test('unowned queued notifications pause without consuming a successful run when pass enforcement is enabled',async()=>{
  const previous=process.env.AGNT_PASS_ACCESS_REQUIRED
  const previousPath=process.env.AGNT_AUTOMATIONS_PATH
  const dir=mkdtempSync(join(tmpdir(),'agnt-sale-notification-'))
  const path=join(dir,'automations.json')
  try{
    process.env.AGNT_PASS_ACCESS_REQUIRED='true'
    process.env.AGNT_AUTOMATIONS_PATH=path
    const auto=createAutomation({type:'event_trigger',name:'Pass gate test',params:{trigger:{topic:'test'},action:{kind:'notify',message:'test'},mode:'notify_only',validUntil:new Date(Date.now()+60000).toISOString()},intervalMs:0,maxRuns:1,status:'active'})
    const result=await dispatchMatchedEventAutomation(auto,{id:'test-event',topic:'test',eventType:'test',entities:[],assetImpact:[],confidence:1,sourceTweetIds:[],createdAt:new Date().toISOString(),summary:'test'})
    assert.match(result.reason,/pass entitlement could not be verified/)
    const saved=loadAutomations().automations.find(a=>a.id===auto.id)!
    assert.equal(saved.status,'paused')
    assert.equal(saved.runCount,0)
    assert.equal(saved.history[0].success,false)
    const price=createAutomation({type:'price_alert',name:'Unowned price alert',params:{token:'BTC',condition:'above',targetPrice:1},intervalMs:30000,maxRuns:1,status:'active'})
    const groups=groupPriceAlerts([
      {...price,id:'alice-1',userId:'alice'},
      {...price,id:'alice-2',userId:'alice'},
      {...price,id:'bob-1',userId:'bob'},
      {...price,id:'alice-paused',userId:'alice',status:'paused'},
    ])
    assert.deepEqual(groups.map(g=>g.map(a=>a.id)),[['alice-1','alice-2'],['bob-1']])
    await checkPriceAlerts()
    const savedPrice=loadAutomations().automations.find(a=>a.id===price.id)!
    assert.equal(savedPrice.status,'paused')
    assert.equal(savedPrice.runCount,0)
    assert.match(savedPrice.history[0].result,/ownership could not be verified/)
  }finally{
    if(previous===undefined)delete process.env.AGNT_PASS_ACCESS_REQUIRED
    else process.env.AGNT_PASS_ACCESS_REQUIRED=previous
    if(previousPath===undefined)delete process.env.AGNT_AUTOMATIONS_PATH
    else process.env.AGNT_AUTOMATIONS_PATH=previousPath
    try{unlinkSync(path)}catch{}
    try{rmdirSync(dir)}catch{}
  }
})
