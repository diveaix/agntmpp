import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'

// Isolated headless browser, never the user's profile. Optional module directory
// lets the desktop's bundled Playwright run without changing project dependencies.
const require=createRequire(process.env.AGNT_TEST_NODE_MODULES?resolve(process.env.AGNT_TEST_NODE_MODULES,'../package.json'):import.meta.url)
const {chromium}=require('playwright')
const vite=await createServer({server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'})
let browser
try{
  await vite.listen()
  const port=vite.httpServer.address().port,origin=`http://127.0.0.1:${port}`
  browser=await chromium.launch({headless:true,...(process.env.AGNT_TEST_CHROME_PATH?{executablePath:process.env.AGNT_TEST_CHROME_PATH}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900}})
  let enabled=false,recorded=false,withdrawalRecorded=false
  let quoteTerms=null
  let requestGeneration=0,recoveryFailure=false
  const recoveryAttempts=[]
  let receiptOwner='test-alice'
  const attempts=[]
  const withdrawalAttempts=[]
  const canceledRequests=new Set()
  const errors=[]
  const account={userId:'test-alice',balance:{available:'5000000',held:'0',frozen:false},passes:[],deposits:[],purchases:[],withdrawals:[]}
  account.collectibleAccess={source:'collectible_pass',enforced:false,eligible:false,reason:'access_terms_unconfigured',policyVersion:null}
  let inboxFailure=false,inboxOwner=account.userId
  const notices=[{event_id:'test-notification',kind:'PURCHASE',reference:'test-receipt-reference',created_at:new Date().toISOString(),read_at:null}]
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url())
    if(url.origin!==origin){await route.abort();return}
    if(!url.pathname.startsWith('/api/sale')){await route.continue();return}
    const path=url.pathname.slice('/api/sale'.length)
    let body
    if(path==='')body={state:'OPEN',sold:0,supply:4444,nextPriceZatoshi:'2000000',firstPriceZatoshi:'2000000',lastPriceZatoshi:'14399274',launchEnabled:enabled,fundingEnabled:enabled,withdrawalsEnabled:enabled,blockers:[]}
    else if(path==='/account')body=account
    else if(path==='/request-recovery'){
      if(route.request().method()==='POST'){
        const input=route.request().postDataJSON()
        recoveryAttempts.push(input)
        assert.equal(input.ownerId,account.userId)
        if(recoveryFailure){await route.fulfill({status:503,json:{error:'simulated_recovery_failure'}});return}
        if(input.expectedGeneration!==requestGeneration){await route.fulfill({status:409,json:{error:'request_generation_changed'}});return}
        requestGeneration++
        body={userId:account.userId,requestGeneration,recordedRequestsPreserved:true}
      }else body={userId:account.userId,requestGeneration}
    }
    else if(path==='/notifications'){
      if(inboxFailure){await route.fulfill({status:503,json:{error:'simulated_inbox_failure'}});return}
      body={userId:inboxOwner,notifications:notices}
    }
    else if(path==='/notifications/test-notification/read'){
      assert.equal(route.request().postDataJSON().ownerId,account.userId)
      notices[0].read_at=new Date().toISOString();body={event_id:notices[0].event_id,read_at:notices[0].read_at}
    }
    else if(path==='/account/export')body={...account,formatVersion:1,amountUnit:'zatoshi'}
    else if(path==='/purchases/test-receipt')body={userId:receiptOwner,signature:null,purchase:{id:'test-receipt',quantity:1,total:'2000000'}}
    else if(path==='/deposit-address')body={network:'regtest',address:'synthetic-deposit-address-not-for-real-funds'}
    else if(path==='/quote')body={id:'test-quote',quantity:1,soldCountSnapshot:0,availableSupply:4444,totalZatoshi:'2000000',curveVersion:'test-curve',accessPolicy:quoteTerms,expiresAt:new Date(Date.now()+120000).toISOString()}
    else if(path==='/purchases'){
      attempts.push(route.request().postDataJSON())
      await route.fulfill({status:503,json:{error:'simulated_lost_response'}});return
    }else if(path==='/withdrawals'){
      withdrawalAttempts.push(route.request().postDataJSON())
      await route.fulfill({status:503,json:{error:'simulated_withdrawal_response_loss'}});return
    }else if(path==='/withdrawals/test-hold/cancel'){
      account.withdrawals[0].state='CANCELED'
      account.balance={available:'3000000',held:'0',frozen:false}
      body={id:'test-hold',state:'CANCELED'}
    }else if(path==='/cancel-pending-request'){
      const input=route.request().postDataJSON()
      canceledRequests.add(`${input.kind}:${input.idempotencyKey}`)
      body={userId:account.userId,kind:input.kind,status:'CANCELED',receipt:null}
    }else if(path==='/request-status'){
      const input=route.request().postDataJSON()
      const found=input.kind==='purchase'?recorded:withdrawalRecorded
      body={userId:account.userId,kind:input.kind,status:found?'RECORDED':'UNKNOWN',receipt:found?{id:input.kind==='purchase'?'test-purchase':'test-hold'}:null}
      if(canceledRequests.has(`${input.kind}:${input.idempotencyKey}`))body={userId:account.userId,kind:input.kind,status:'CANCELED',receipt:null}
    }else {await route.fulfill({status:503,json:{error:'fixture_endpoint_disabled'}});return}
    await route.fulfill({json:body})
  })
  const page=await context.newPage()
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`${origin}/presale`)
  await page.getByRole('button',{name:'Preview exact price'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Fund with ZEC — unavailable'}).isDisabled(),true)
  assert.equal(await page.getByRole('button',{name:'Withdraw unused credit — unavailable'}).isDisabled(),true)
  const downloaded=page.waitForEvent('download')
  await page.getByRole('button',{name:'Export holdings and full history'}).click()
  const download=await downloaded
  assert.equal(download.suggestedFilename(),'agent-sale-history.json')
  const stream=await download.createReadStream(),chunks=[]
  for await(const chunk of stream)chunks.push(chunk)
  const exported=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(exported.userId,'test-alice')
  assert.equal(exported.amountUnit,'zatoshi')
  account.purchases=[{id:'test-receipt',quantity:1,total:'2000000'}]
  account.deposits=[{receipt_id:'test-deposit',amount:'3000000',state:'CONFIRMING',confirmations:1,required_confirmations:3},{receipt_id:'legacy-deposit',amount:'1000000',state:'CONFIRMING',confirmations:0}]
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText(/1 \/ 3 confirmations required at last check/).waitFor()
  await page.getByText(/0 \/ unknown confirmations required at last check/).waitFor()
  const receiptDownload=page.waitForEvent('download')
  await page.getByRole('button',{name:'Download receipt test-receipt',exact:true}).click()
  const savedReceipt=await receiptDownload
  assert.equal(savedReceipt.suggestedFilename(),'agent-purchase-receipt.json')
  const receiptStream=await savedReceipt.createReadStream(),receiptChunks=[]
  for await(const chunk of receiptStream)receiptChunks.push(chunk)
  const receiptJson=JSON.parse(Buffer.concat(receiptChunks).toString('utf8'))
  assert.equal(receiptJson.purchase.id,'test-receipt')
  assert.equal(receiptJson.userId,account.userId)
  assert.equal(receiptJson.signature,null)
  receiptOwner='different-account'
  let unexpectedDownloads=0
  const onUnexpectedDownload=()=>unexpectedDownloads++
  page.on('download',onUnexpectedDownload)
  await page.getByRole('button',{name:'Download receipt test-receipt',exact:true}).click()
  await page.getByText('Receipt does not match this account or purchase. Refresh before downloading.',{exact:true}).waitFor()
  assert.equal(unexpectedDownloads,0)
  page.off('download',onUnexpectedDownload)
  receiptOwner=account.userId
  account.purchases=[];account.deposits=[]
  account.withdrawals=[{id:'progress-fixture',amount:'1000000',state:'BROADCAST',confirmations:1,required_confirmations:3,confirmation_checked_at:'2026-09-20T12:00:00.000Z'}]
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText(/1 \/ 3 confirmations at last check:.*Not a time estimate\./).waitFor()
  assert.equal(await page.getByRole('button',{name:'Cancel unsigned withdrawal'}).count(),0)
  account.withdrawals[0].state='PAID';account.withdrawals[0].settlement_review=true
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText(/PAID · SETTLEMENT REVIEW/).waitFor()
  assert.equal(await page.getByRole('button',{name:'Cancel unsigned withdrawal'}).count(),0)
  account.withdrawals=[]
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText('Pass terms are not configured.',{exact:true}).waitFor()
  await page.getByText('Pass checks are disabled; this is not an access guarantee.',{exact:true}).waitFor()
  await page.getByText('PURCHASE · Unread',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Mark as read',exact:true}).click()
  await page.getByText('PURCHASE · Read',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Mark as read',exact:true}).count(),0)
  inboxFailure=true
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText('Notifications are unavailable. Your balance and payment recovery remain available.',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Export holdings and full history'}).isDisabled(),false)
  assert.equal(await page.getByText('test-receipt-reference',{exact:true}).count(),0)
  inboxFailure=false;inboxOwner='different-account'
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText('Notifications are unavailable. Your balance and payment recovery remain available.',{exact:true}).waitFor()
  assert.equal(await page.getByText('test-receipt-reference',{exact:true}).count(),0)
  inboxOwner=account.userId
  account.collectibleAccess={source:'collectible_pass',enforced:true,eligible:true,reason:null,policyVersion:'a'.repeat(64),dailyLimit:5,usedToday:2,remainingToday:3,durationDays:30}
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText('Daily allowance: 5 calls · Used today: 2 · Remaining: 3 · Resets at 00:00 UTC.',{exact:true}).waitFor()
  account.collectibleAccess.eligible=false;account.collectibleAccess.reason='daily_tool_limit';account.collectibleAccess.usedToday=5;account.collectibleAccess.remainingToday=0
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText('Daily tool allowance used up.',{exact:true}).waitFor()
  account.collectibleAccess={source:'collectible_pass',enforced:false,eligible:false,reason:'access_terms_unconfigured',policyVersion:null}
  enabled=true
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByRole('button',{name:'Show my ZEC deposit address'}).waitFor()
  await page.getByRole('button',{name:'Preview exact price'}).click()
  await page.getByText('At quote time: 0 sold · 4444 available. No inventory is reserved.',{exact:true}).waitFor()
  await page.getByRole('checkbox',{name:/I understand this is custodial credit/}).check()
  assert.equal(await page.getByRole('button',{name:'Buy 1 pass',exact:true}).isDisabled(),true)
  assert.equal(attempts.length,0)
  quoteTerms={version:'a'.repeat(64),durationDays:30,dailyCalls:5}
  await page.getByRole('button',{name:'Preview exact price'}).click()
  await page.getByText('Quoted access: 30 days from purchase · 5 tool calls per account per UTC day. Multiple passes do not multiply the daily allowance.',{exact:true}).waitFor()
  await page.getByRole('checkbox',{name:/I understand this is custodial credit/}).check()
  await page.getByRole('button',{name:'Buy 1 pass',exact:true}).click()
  await page.getByText('simulated_lost_response',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('Quantity',{exact:true}).isDisabled(),true)
  await page.reload()
  await page.getByText('Quoted access: 30 days from purchase · 5 tool calls per account per UTC day. Multiple passes do not multiply the daily allowance.',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Retry same purchase'}).click()
  await page.getByText('simulated_lost_response',{exact:true}).waitFor()
  assert.equal(attempts.length,2)
  assert.deepEqual(attempts[0],attempts[1])
  assert.deepEqual(attempts[1].accessPolicy,quoteTerms)
  recorded=true
  account.passes=[{serial:1,state:'ACTIVE'}]
  account.balance.available='3000000'
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByText('./AGENT #0001',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Retry same purchase'}).count(),0)
  assert.equal(await page.getByLabel('Quantity',{exact:true}).isDisabled(),false)
  await page.getByRole('button',{name:'Show my ZEC deposit address'}).click()
  await page.getByText('synthetic-deposit-address-not-for-real-funds',{exact:true}).waitFor()
  await page.getByText('regtest deposit address',{exact:true}).waitFor()
  await page.getByLabel('Zcash recipient address',{exact:true}).fill('synthetic-withdrawal-recipient')
  await page.getByLabel('Amount (ZEC)',{exact:true}).fill('0.01')
  await page.getByLabel('Maximum network fee (ZEC)',{exact:true}).fill('0.0001')
  assert.equal(await page.getByRole('button',{name:'Request withdrawal',exact:true}).isDisabled(),true)
  await page.getByRole('checkbox',{name:/I checked the recipient and amount/}).check()
  await page.getByRole('button',{name:'Request withdrawal',exact:true}).click()
  await page.getByText('simulated_withdrawal_response_loss',{exact:true}).waitFor()
  await page.reload()
  await page.getByRole('button',{name:'Retry same withdrawal'}).waitFor()
  assert.equal(await page.getByLabel('Zcash recipient address',{exact:true}).isDisabled(),true)
  assert.equal(await page.getByLabel('Amount (ZEC)',{exact:true}).inputValue(),'0.01000000')
  await page.getByRole('button',{name:'Retry same withdrawal'}).click()
  await page.getByText('simulated_withdrawal_response_loss',{exact:true}).waitFor()
  assert.equal(withdrawalAttempts.length,2)
  assert.deepEqual(withdrawalAttempts[0],withdrawalAttempts[1])
  assert.equal(withdrawalAttempts[0].amountZatoshi,'1000000')
  assert.equal(withdrawalAttempts[0].feeLimitZatoshi,'10000')
  withdrawalRecorded=true
  account.withdrawals=[{id:'test-hold',amount:'1000000',state:'HELD'}]
  account.balance={available:'1990000',held:'1010000',frozen:false}
  await page.getByRole('button',{name:'Refresh balance and status'}).click()
  await page.getByRole('button',{name:'Cancel unsigned withdrawal'}).click()
  await page.getByText('0.01000000 ZEC · CANCELED',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Retry same withdrawal'}).count(),0)
  assert.equal(await page.getByRole('button',{name:'Cancel unsigned withdrawal'}).count(),0)
  recorded=false
  await page.getByRole('button',{name:'Preview exact price'}).click()
  await page.getByRole('checkbox',{name:/I understand this is custodial credit/}).check()
  await page.getByRole('button',{name:'Buy 1 pass',exact:true}).click()
  await page.getByText('simulated_lost_response',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Resolve or stop pending purchase'}).click()
  await page.getByRole('button',{name:'Retry same purchase'}).waitFor({state:'hidden'})
  assert.equal(await page.getByLabel('Quantity',{exact:true}).isDisabled(),false)
  assert.equal(canceledRequests.size,1)
  await page.getByRole('button',{name:'Preview exact price'}).click()
  await page.getByRole('checkbox',{name:/I understand this is custodial credit/}).check()
  await page.getByRole('button',{name:'Buy 1 pass',exact:true}).click()
  await page.getByText('simulated_lost_response',{exact:true}).waitFor()
  assert.equal(attempts.at(-1).requestGeneration,0)
  await page.getByText('Lost or unreadable pending request?',{exact:true}).click()
  const resetButton=page.getByRole('button',{name:'Stop older uncommitted requests',exact:true})
  assert.equal(await resetButton.isDisabled(),true)
  await page.getByRole('checkbox',{name:'I understand that recorded purchases and withdrawal holds remain.'}).check()
  recoveryFailure=true
  await resetButton.click()
  await page.getByText('simulated_recovery_failure',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Retry same purchase'}).count(),1,'Failed recovery must not erase the original draft')
  recoveryFailure=false
  await resetButton.click()
  await page.getByRole('button',{name:'Retry same purchase'}).waitFor({state:'hidden'})
  assert.deepEqual(recoveryAttempts,[{ownerId:account.userId,expectedGeneration:0},{ownerId:account.userId,expectedGeneration:0}])
  assert.equal(requestGeneration,1)
  await page.getByText('Older uncommitted requests have been stopped. Recorded purchases and withdrawal holds are unchanged. Review your history below before submitting another request.',{exact:true}).waitFor()
  await page.getByText('./AGENT #0001',{exact:true}).waitFor()
  await page.getByText('0.01000000 ZEC · CANCELED',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Preview exact price'}).click()
  await page.getByRole('checkbox',{name:/I understand this is custodial credit/}).check()
  await page.getByRole('button',{name:'Buy 1 pass',exact:true}).click()
  await page.getByText('simulated_lost_response',{exact:true}).waitFor()
  assert.equal(attempts.at(-1).requestGeneration,1,'New requests must carry the refreshed generation')
  await page.reload()
  await page.getByRole('button',{name:'Retry same purchase'}).click()
  await page.getByText('simulated_lost_response',{exact:true}).waitFor()
  assert.deepEqual(attempts.at(-1),attempts.at(-2),'Reload must retain the generation, payload and key unchanged')
  for(const label of ['Zcash recipient address','Amount (ZEC)','Maximum network fee (ZEC)']){
    const field=page.getByLabel(label,{exact:true})
    assert.ok(await field.evaluate(element=>parseFloat(getComputedStyle(element).borderTopWidth)>0),'Withdrawal fields need visible boundaries')
  }
  await mkdir('test-results',{recursive:true})
  await page.evaluate(()=>scrollTo(0,0))
  await page.screenshot({path:'test-results/sale-desktop.png',fullPage:true})
  await page.setViewportSize({width:390,height:844})
  await page.evaluate(()=>scrollTo(0,0))
  await page.screenshot({path:'test-results/sale-mobile.png',fullPage:true})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile page must not overflow horizontally')
  assert.deepEqual(errors,[])
  console.log('PASS: private inbox read status, account-mismatch hiding and failure isolation; history JSON download, quote supply snapshot, rendered launch locks, deposit address/network, purchase and withdrawal consent, lost-response reload/retry identity, receipt recovery, unsigned cancellation, mobile overflow and no page errors. API responses are synthetic; no real payments.')
}finally{
  await browser?.close()
  await vite.close()
}
