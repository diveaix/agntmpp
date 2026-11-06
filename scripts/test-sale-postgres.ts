import assert from 'node:assert/strict'
import { createHash, randomUUID, generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import { migrateSale } from '../src/mcp/sale/database.js'
import { configureSaleAccess } from '../src/mcp/sale/access-policy.js'
import { SaleService } from '../src/mcp/sale/service.js'
import { approveFixtureWithdrawal, provisionFixtureTreasuryLimits } from './test-sale-approvals.js'
import { recordWithdrawalApproval } from '../src/mcp/sale/withdrawal-approvals.js'
import { CURVE_VERSION, totalPrice } from '../src/mcp/sale/pricing.js'
import { reconcileSale } from '../src/mcp/sale/reconcile.js'
import { SignerArtifacts } from '../src/mcp/sale/signer-artifacts.js'
import { DepositAssignments } from '../src/mcp/sale/deposit-assignments.js'
import { deliverSaleNotifications } from '../src/mcp/sale/notifications.js'
import { signPurchaseReceipt } from '../src/mcp/sale/receipt-worker.js'
import { verifyReceiptBytes } from '../src/mcp/sale/receipt-signature.js'

const exec=promisify(execFile)
const name=`agnt-sale-test-${randomUUID()}`
const password=randomUUID()
let containerId:string|undefined
let pool:Pool|undefined
let signerPool:Pool|undefined
let nodeFixture:Server|undefined
try{
  console.log('Starting disposable, loopback-only PostgreSQL 16. Synthetic accounting/RPC fixtures only; no public-chain access.')
  const created=await exec('docker',['run','--rm','--detach','--name',name,'--label','com.agnt.sale-test=true','--memory','512m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_DB=agnt_sale_test','-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','postgres:16-alpine'],{timeout:180000})
  containerId=created.stdout.trim()
  assert.match(containerId,/^[0-9a-f]{64}$/)
  const port=(await exec('docker',['port',containerId,'5432/tcp'])).stdout.trim()
  assert.match(port,/^127\.0\.0\.1:\d+$/)
  pool=new Pool({host:'127.0.0.1',port:Number(port.split(':')[1]),user:'postgres',password,database:'agnt_sale_test',max:20,connectionTimeoutMillis:1000,statement_timeout:30000})
  let ready=false
  for(let attempt=0;attempt<60;attempt++){
    try{await pool.query('SELECT 1');ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,500))}
  }
  assert.ok(ready,'PostgreSQL did not become ready')
  await migrateSale(pool)
  await provisionFixtureTreasuryLimits(pool)
  const fixturePolicy=await configureSaleAccess(pool,30,5) // Disposable fixture only.
  const assignments=new DepositAssignments(pool)
  await assignments.migrate()
  const walletAccount='11111111-1111-1111-1111-111111111111'
  const addresses=await Promise.all(Array.from({length:12},()=>assignments.allocate('alice','regtest',walletAccount,async(_method,params=[])=>({
    account_uuid:walletAccount,diversifier_index:params[2],receiver_types:['orchard'],address:`synthetic-only-${String(params[2]).padStart(40,'0')}`,
  }))))
  assert.equal(new Set(addresses.map(assignment=>assignment.recipientAddresses[0])).size,1)
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM agnt_deposit_assignments')).rows[0].count,1)
  console.log('PASS: 12 concurrent deposit-address requests retain one reservation and one address.')
  const artifacts=new SignerArtifacts(pool)
  await artifacts.migrate()
  const claims=await Promise.allSettled(Array.from({length:12},()=>artifacts.begin('regtest:race','regtest','a'.repeat(64))))
  assert.equal(claims.filter(result=>result.status==='fulfilled').length,1)
  assert.equal(await artifacts.load('regtest:race'),null)
  await assert.rejects(new SignerArtifacts(pool).begin('regtest:race','regtest','a'.repeat(64)),/signing_already_started/)
  console.log('PASS: 12 concurrent signing claims yield one winner; missing artifact does not permit automatic re-signing.')
  let walletCalls=0
  const walletRaces=await Promise.allSettled(Array.from({length:12},(_,i)=>artifacts.signForWallet(walletAccount,
    {reference:`wallet-race:${i}`,network:'regtest',intentHash:'f'.repeat(64)},async()=>{
      walletCalls++
      throw new Error('synthetic ambiguous wallet response')
    })))
  assert.equal(walletCalls,1)
  assert.equal(walletRaces.filter(result=>result.status==='rejected').length,12)
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM agnt_wallet_signing_locks')).rows[0].count,1)
  await assert.rejects(new SignerArtifacts(pool).signForWallet(walletAccount,{reference:'wallet-race:restart',network:'regtest',intentHash:'f'.repeat(64)},async()=>{throw new Error('must not contact wallet')}),/treasury_signing_busy/)
  console.log('PASS: distinct concurrent withdrawals enter one wallet callback; ambiguity retains the durable wallet lock across worker recreation.')
  await pool.query("UPDATE agnt_sale SET state='OPEN' WHERE id=1")
  const service=new SaleService(pool)
  const receipt=(id:string,amount:string)=>({receiptId:`synthetic:${id}`,txid:'a'.repeat(64),amountZatoshi:amount,canonical:true,confirmations:3,blockHash:'b'.repeat(64)})
  const request=async(user:string,quantity:number)=>{
    const quote=await service.quote(user,quantity)
    return {quoteId:quote.id,quantity,maxTotalZatoshi:quote.totalZatoshi,curveVersion:CURVE_VERSION,idempotencyKey:randomUUID()}
  }
  await service.observe('seed',receipt('seed','30000000000'),3)
  const first=await request('seed',1)
  const duplicates=await Promise.all(Array.from({length:12},()=>service.purchase('seed',first)))
  assert.equal(new Set(duplicates.map(p=>p.id)).size,1)
  assert.equal((await service.summary()).sold,1)
  console.log('PASS: 12 concurrent identical requests produce one purchase.')
  assert.equal(duplicates[0].access_policy_version,fixturePolicy.version)
  const receiptKey=generateKeyPairSync('ed25519') // Ephemeral, never persisted.
  const receiptRaceResults=await Promise.all(Array.from({length:12},()=>signPurchaseReceipt(pool!,duplicates[0].id,receiptKey.privateKey)))
  for(const envelope of receiptRaceResults)assert.deepEqual(envelope,receiptRaceResults[0])
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM agnt_sale_signed_receipts')).rows[0].count,1)
  const receiptPayload=verifyReceiptBytes(receiptRaceResults[0],receiptKey.publicKey)
  assert.equal(JSON.parse(receiptPayload.toString()).purchaseId,duplicates[0].id)
  await assert.rejects(pool.query('DELETE FROM agnt_sale_signed_receipts WHERE purchase_id=$1',[duplicates[0].id]),/signed_receipt_is_immutable/)
  console.log('PASS: twelve receipt workers retain one immutable, verifiable signed issuance envelope.')
  const rolePassword=randomUUID()
  await pool.query(`CREATE ROLE agnt_receipt_fixture LOGIN PASSWORD '${rolePassword}'`)
  await pool.query('GRANT USAGE ON SCHEMA public TO agnt_receipt_fixture')
  await pool.query('GRANT SELECT ON agnt_sale,agnt_sale_purchases,agnt_sale_passes,agnt_sale_signed_receipts TO agnt_receipt_fixture')
  await pool.query('GRANT INSERT ON agnt_sale_signed_receipts TO agnt_receipt_fixture')
  const receiptUrl=`postgresql://agnt_receipt_fixture:${rolePassword}@${port}/agnt_sale_test`
  const restricted=new Pool({connectionString:receiptUrl,max:2})
  const keyDir=await mkdtemp(join(tmpdir(),'agnt-receipt-role-')),keyFile=join(keyDir,'test-only.pem')
  try{
    const rolePurchase=await service.purchase('seed',await request('seed',1))
    await writeFile(keyFile,receiptKey.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600})
    const receiptEnv={...process.env,AGNT_RECEIPT_SIGNER_ENABLED:'true',AGNT_RECEIPT_SIGNING_KEY_FILE:keyFile,AGNT_RECEIPT_DATABASE_URL:receiptUrl}
    for(let i=0;i<2;i++){
      const result=await exec(process.execPath,['--import','tsx/esm','scripts/sale-sign-receipt.ts',rolePurchase.id],{env:receiptEnv,timeout:15000})
      assert.equal(JSON.parse(result.stdout).signed,true)
      assert.ok(!result.stdout.includes('PRIVATE KEY'))
    }
    const signedByRole=await service.purchaseReceipt('seed',rolePurchase.id)
    assert.equal(JSON.parse(verifyReceiptBytes(signedByRole.signature!,receiptKey.publicKey).toString()).purchaseId,rolePurchase.id)
    for(const sql of ["UPDATE agnt_sale_accounts SET available=0","UPDATE agnt_sale SET state='OPEN'",'TRUNCATE agnt_sale_signed_receipts','SELECT * FROM agnt_signed_artifacts'])await assert.rejects(restricted.query(sql),/permission denied/)
    console.log('PASS: configured receipt-signing subprocess signs and recovers with a SELECT/INSERT-only role; balance changes, sale changes, signature truncation and wallet artifact reads are denied.')
  }finally{
    await restricted.end()
    await unlink(keyFile).catch(()=>{})
    await rmdir(keyDir)
  }
  await assert.rejects(pool.query('UPDATE agnt_sale SET access_daily_calls=6 WHERE id=1'),/issued_access_policy_is_immutable/)
  const quotaRace=await Promise.allSettled(Array.from({length:12},()=>service.consumeAccess('seed')))
  assert.equal(quotaRace.filter(result=>result.status==='fulfilled').length,5)
  for(const result of quotaRace)if(result.status==='rejected')assert.match(String(result.reason),/daily_tool_limit/)
  assert.equal((await service.accessSnapshot('seed')).usedToday,5)
  assert.equal((await service.accessSnapshot('seed')).policyVersion,fixturePolicy.version)
  console.log('PASS: stored policy is immutable after issuance; 12 concurrent tool calls consume exactly the five-call fixture allowance.')

  const shared=receipt('shared','20000000')
  const receiptRace=await Promise.allSettled(['alice','bob'].map(user=>service.observe(user,shared,3)))
  assert.equal(receiptRace.filter(r=>r.status==='fulfilled').length,1)
  const credits=await pool.query("SELECT sum(available)::text AS total FROM agnt_sale_accounts WHERE user_id IN ('alice','bob')")
  assert.equal(credits.rows[0].total,'20000000')
  console.log('PASS: concurrent attempts to attribute one receipt cannot credit two accounts.')

  const failing=await request('seed',1)
  const beforeFailure=(await service.account('seed')).balance.available
  const beforeSold=(await service.summary()).sold
  await pool.query("CREATE FUNCTION reject_test_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic allocation failure'; END $$")
  await pool.query('CREATE TRIGGER reject_test_allocation BEFORE INSERT ON agnt_sale_passes FOR EACH ROW EXECUTE FUNCTION reject_test_allocation()')
  await assert.rejects(service.purchase('seed',failing),/synthetic allocation failure/)
  assert.equal((await service.account('seed')).balance.available,beforeFailure)
  assert.equal((await service.summary()).sold,beforeSold)
  assert.equal((await pool.query('SELECT id FROM agnt_sale_purchases WHERE idempotency_key=$1',[failing.idempotencyKey])).rows.length,0)
  // This trigger and function exist only in the disposable database created above.
  await pool.query('DROP TRIGGER reject_test_allocation ON agnt_sale_passes')
  await pool.query('DROP FUNCTION reject_test_allocation()')
  await service.purchase('seed',failing)
  console.log('PASS: allocation failure rolls back debit, receipt, and inventory; retry succeeds with the original key.')

  const racePrice=String(totalPrice((await service.summary()).sold,1))
  await service.observe('spend-race',receipt('spend-race',racePrice),3)
  const buy=await request('spend-race',1)
  const spendRace=await Promise.allSettled([
    service.purchase('spend-race',buy),
    service.holdWithdrawal('spend-race',{destination:'synthetic-test-destination',amountZatoshi:racePrice,feeLimitZatoshi:'0',idempotencyKey:randomUUID()}),
  ])
  assert.equal(spendRace.filter(r=>r.status==='fulfilled').length,1)
  assert.equal((await service.account('spend-race')).balance.available,'0')
  console.log('PASS: concurrent purchase and withdrawal cannot spend the same balance twice.')

  for(const kind of ['purchase','withdrawal'] as const){
    for(let attempt=0;attempt<6;attempt++){
      const input=kind==='purchase'?await request('seed',1):{destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()}
      const submit=()=>kind==='purchase'?service.purchase('seed',input as Awaited<ReturnType<typeof request>>):service.holdWithdrawal('seed',input as {destination:string;amountZatoshi:string;feeLimitZatoshi:string;idempotencyKey:string})
      const cancel=()=>service.cancelPendingRequest('seed',kind,input.idempotencyKey)
      await Promise.allSettled(attempt%2?[submit(),cancel()]:[cancel(),submit()])
      const status=await service.requestStatus('seed',kind,input.idempotencyKey)
      assert.ok(['RECORDED','CANCELED'].includes(status.status))
      if(status.status==='CANCELED')await assert.rejects(submit(),/request_canceled/)
      else assert.equal((await submit()).id,status.receipt.id)
      assert.equal((await cancel()).status,status.status)
      const marker=await pool.query('SELECT 1 FROM agnt_sale_canceled_requests WHERE user_id=$1 AND kind=$2 AND idempotency_key=$3',['seed',kind,input.idempotencyKey])
      assert.equal(marker.rows.length,status.status==='CANCELED'?1:0)
    }
  }
  assert.equal((await reconcileSale(pool)).ok,true)
  console.log('PASS: purchase/withdrawal cancellation races yield a committed receipt or a durable rejection, never both; delayed retries cannot bypass cancellation.')

  for(const kind of ['purchase','withdrawal'] as const){
    for(let attempt=0;attempt<6;attempt++){
      const user=`generation-race-${kind}-${attempt}`
      await service.observe(user,receipt(user,'10000000'),3)
      const input=kind==='purchase'?await request(user,1):{destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()}
      const submit=()=>kind==='purchase'?service.purchase(user,input as Awaited<ReturnType<typeof request>>):service.holdWithdrawal(user,input as {destination:string;amountZatoshi:string;feeLimitZatoshi:string;idempotencyKey:string})
      const reset=()=>service.resetPendingRequests(user,0)
      const outcomes=await Promise.allSettled(attempt%2?[submit(),reset()]:[reset(),submit()])
      const resetOutcome=outcomes[attempt%2?1:0],submission=outcomes[attempt%2?0:1]
      assert.equal(resetOutcome.status,'fulfilled')
      assert.equal((await service.requestRecoveryState(user)).requestGeneration,1)
      const status=await service.requestStatus(user,kind,input.idempotencyKey)
      if(submission.status==='fulfilled'){
        assert.equal(status.status,'RECORDED')
        assert.equal((await submit()).id,status.receipt.id,'An old committed request must replay after reset')
      }else{
        assert.match(String(submission.reason),/request_generation_changed/)
        assert.equal(status.status,'UNKNOWN','No receipt exists for a fenced request')
        await assert.rejects(submit(),/request_generation_changed/)
        assert.equal((await service.account(user)).balance.available,'10000000')
        assert.equal((await service.account(user)).balance.held,'0')
      }
      // Concurrent retries of the same reset cannot advance the fence again.
      const repeats=await Promise.allSettled(Array.from({length:4},()=>reset()))
      assert.ok(repeats.every(result=>result.status==='rejected'&&String(result.reason).includes('request_generation_changed')))
      assert.equal((await service.requestRecoveryState(user)).requestGeneration,1)
    }
  }
  assert.equal((await reconcileSale(pool)).ok,true)
  console.log('PASS: PostgreSQL recovery-reset/submission races preserve committed receipts or reject stale requests without debit; reset retries never advance twice.')

  for(const actor of ['race-operator-a','race-operator-b'])await pool.query(
    'INSERT INTO agnt_treasury_operators(actor_id,enabled,authorization_version) VALUES($1,true,$2)',[actor,randomUUID()])
  const approvalHold=await service.holdWithdrawal('seed',{destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()})
  const repeatedVotes=await Promise.all(Array.from({length:12},()=>recordWithdrawalApproval(pool!,'race-operator-a',approvalHold.id,'Concurrent fixture review')))
  assert.ok(repeatedVotes.every(vote=>vote.validApprovals===1))
  await assert.rejects(service.approveWithdrawal('seed',approvalHold.id),/two_treasury_approvals_required/)
  await Promise.all(Array.from({length:12},()=>recordWithdrawalApproval(pool!,'race-operator-b',approvalHold.id,'Concurrent fixture review')))
  const approvals=await Promise.all(Array.from({length:12},()=>service.approveWithdrawal('seed',approvalHold.id)))
  assert.ok(approvals.every(row=>row.state==='APPROVED'&&row.signer_reference===approvals[0].signer_reference))
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM agnt_withdrawal_approval_votes WHERE withdrawal_id=$1',[approvalHold.id])).rows[0].count,2)
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM agnt_sale_events WHERE kind='WITHDRAWAL_APPROVED' AND reference=$1",[approvalHold.id])).rows[0].count,1)
  for(let attempt=0;attempt<6;attempt++){
    const before=(await service.account('seed')).balance
    const hold=await service.holdWithdrawal('seed',{destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()})
    for(const actor of ['race-operator-a','race-operator-b'])await recordWithdrawalApproval(pool,actor,hold.id,'Cancel-race fixture review')
    const approve=()=>service.approveWithdrawal('seed',hold.id),cancel=()=>service.cancelWithdrawal('seed',hold.id)
    const outcomes=await Promise.allSettled(attempt%2?[approve(),cancel()]:[cancel(),approve()])
    assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1)
    const state=(await service.withdrawalStatus('seed',hold.id)).withdrawal.state
    const after=(await service.account('seed')).balance
    assert.ok(state==='APPROVED'||state==='CANCELED')
    assert.equal(BigInt(after.held),BigInt(before.held)+(state==='APPROVED'?1n:0n))
    assert.equal(BigInt(after.available),BigInt(before.available)-(state==='APPROVED'?1n:0n))
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM agnt_withdrawal_approval_votes WHERE withdrawal_id=$1',[hold.id])).rows[0].count,2)
    if(state==='CANCELED')await assert.rejects(service.approveWithdrawal('seed',hold.id),/invalid_withdrawal_state/)
    else await assert.rejects(service.cancelWithdrawal('seed',hold.id),/withdrawal_cannot_cancel/)
  }
  assert.equal((await reconcileSale(pool)).ok,true)
  console.log('PASS: duplicate concurrent votes count once per operator; concurrent final approvals emit one event; approval/cancellation races preserve exact holds and immutable votes.')
  for(const boundary of ['revoke','freeze'] as const){
    const user=`approval-boundary-${boundary}`
    await service.observe(user,receipt(user,'10'),3)
    const hold=await service.holdWithdrawal(user,{destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()})
    const actors=[`${user}-a`,`${user}-b`]
    for(const actor of actors){
      await pool.query('INSERT INTO agnt_treasury_operators(actor_id,enabled,authorization_version) VALUES($1,true,$2)',[actor,randomUUID()])
      await recordWithdrawalApproval(pool,actor,hold.id,'Lock-boundary fixture review')
    }
    const blocker=await pool.connect()
    let pendingApproval:Promise<{state:string}|{error:unknown}>|undefined
    try{
      await blocker.query('BEGIN')
      const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if(boundary==='revoke')await blocker.query('UPDATE agnt_treasury_operators SET enabled=false WHERE actor_id=$1',[actors[0]])
      else await blocker.query('UPDATE agnt_sale_accounts SET frozen=true WHERE user_id=$1',[user])
      pendingApproval=service.approveWithdrawal(user,hold.id).then(row=>({state:row.state}),error=>({error}))
      let waiting=false
      for(let attempt=0;attempt<100;attempt++){
        waiting=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',[blockerPid])).rows[0].waiting
        if(waiting)break
        await new Promise(resolve=>setTimeout(resolve,25))
      }
      assert.ok(waiting,'Approval must actually wait on the concurrent security update, not run afterward by chance')
      await blocker.query('COMMIT')
      const outcome=await pendingApproval
      assert.ok('error' in outcome)
      if('error' in outcome)assert.match(String(outcome.error),boundary==='revoke'?/two_treasury_approvals_required/:/account_frozen/)
      assert.equal((await service.withdrawalStatus(user,hold.id)).withdrawal.state,'HELD')
      assert.equal((await service.account(user)).balance.held,'1')
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM agnt_sale_events WHERE kind='WITHDRAWAL_APPROVED' AND reference=$1",[hold.id])).rows[0].count,0)
    }finally{
      await blocker.query('ROLLBACK').catch(()=>{});blocker.release()
      if(pendingApproval)await pendingApproval
    }
    // Fixture cleanup only; never an automatic production unfreeze operation.
    if(boundary==='freeze')await pool.query('UPDATE agnt_sale_accounts SET frozen=false WHERE user_id=$1',[user])
    await service.cancelWithdrawal(user,hold.id)
  }
  console.log('PASS: approvals demonstrably blocked behind an operator revocation or account freeze recheck committed security state and do not authorize a payout.')
  const priorLimits=(await pool.query('SELECT max_payout,max_outstanding FROM agnt_treasury_limits WHERE id=1')).rows[0]
  const outstanding=BigInt((await pool.query("SELECT COALESCE(sum(amount::numeric+fee_limit),0)::text AS total FROM agnt_sale_withdrawals WHERE state IN ('APPROVED','SIGNED','BROADCAST','REVIEW')")).rows[0].total)
  await pool.query('UPDATE agnt_treasury_limits SET max_payout=1,max_outstanding=$1 WHERE id=1',[String(outstanding+1n)])
  try{
    const contenders=[]
    for(let i=0;i<10;i++){
      const user=`treasury-cap-race-${i}`
      await service.observe(user,receipt(user,'1'),3)
      const hold=await service.holdWithdrawal(user,{destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()})
      for(const actor of ['race-operator-a','race-operator-b'])await recordWithdrawalApproval(pool,actor,hold.id,'Treasury-cap fixture review')
      contenders.push({user,id:hold.id})
    }
    const results=await Promise.allSettled(contenders.map(item=>service.approveWithdrawal(item.user,item.id)))
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
    for(const result of results)if(result.status==='rejected')assert.match(String(result.reason),/treasury_outstanding_limit_exceeded/)
    const after=BigInt((await pool.query("SELECT COALESCE(sum(amount::numeric+fee_limit),0)::text AS total FROM agnt_sale_withdrawals WHERE state IN ('APPROVED','SIGNED','BROADCAST','REVIEW')")).rows[0].total)
    assert.equal(after,outstanding+1n)
  }finally{
    // Restore explicit test settings, not a production policy update mechanism.
    await pool.query('UPDATE agnt_treasury_limits SET max_payout=$1,max_outstanding=$2 WHERE id=1',[priorLimits.max_payout,priorLimits.max_outstanding])
  }
  console.log('PASS: ten different accounts race for one remaining treasury authorization unit; exactly one approval commits.')

  // Separate logical databases in this disposable server. This verifies process
  // recovery, not production role isolation or real transaction validation.
  await pool.query('CREATE DATABASE agnt_signer_test')
  const signerUrl=`postgresql://postgres:${password}@${port}/agnt_signer_test`
  const signerEnv={...process.env,AGNT_SALE_SIGNER_DATABASE_URL:signerUrl,AGNT_SALE_DATABASE_URL:`postgresql://postgres:${password}@${port}/agnt_sale_test`,
    AGNT_SALE_SIGNER_ENABLED:'true',AGNT_ZCASH_NETWORK:'regtest',AGNT_ZCASH_GENESIS_HASH:'d'.repeat(64),AGNT_ZALLET_SIGNER_ACCOUNT:walletAccount,
    AGNT_ZALLET_SIGNER_RPC_URL:'http://127.0.0.1:1',AGNT_ZALLET_SIGNER_RPC_USER:'test',AGNT_ZALLET_SIGNER_RPC_PASSWORD:'test-only',
    AGNT_ZEBRA_RPC_URL:'http://127.0.0.1:1',AGNT_ZEBRA_RPC_USER:'test',AGNT_ZEBRA_RPC_PASSWORD:'test-only'}
  await exec(process.execPath,['--import','tsx/esm','scripts/sale-signer-migrate.ts'],{env:signerEnv,timeout:15000})
  signerPool=new Pool({connectionString:signerUrl,max:2})
  const signerStore=new SignerArtifacts(signerPool)
  const cliHold=await service.holdWithdrawal('seed',{destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0',idempotencyKey:randomUUID()})
  const approved=await approveFixtureWithdrawal(service,pool,'seed',cliHold.id)
  const intent={reference:approved.signer_reference,network:'regtest' as const,walletAccountUuid:walletAccount,destination:'synthetic-test-destination',amountZatoshi:'1',feeLimitZatoshi:'0'}
  await signerStore.signOnce({reference:intent.reference,network:'regtest',intentHash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')},async()=>({txid:'e'.repeat(64),rawHex:'00',actualFeeZatoshi:'0'}))
  for(let retry=0;retry<2;retry++){
    const recovered=await exec(process.execPath,['--import','tsx/esm','scripts/sale-sign.ts',cliHold.id],{env:signerEnv,timeout:15000})
    assert.match(recovered.stdout,/No broadcast was performed/)
    assert.equal(recovered.stderr,'')
    const state=(await pool.query('SELECT state,txid FROM agnt_sale_withdrawals WHERE id=$1',[cliHold.id])).rows[0]
    assert.deepEqual(state,{state:'SIGNED',txid:'e'.repeat(64)})
  }
  assert.equal((await signerPool.query('SELECT count(*)::int AS count FROM agnt_signed_artifacts')).rows[0].count,1)
  console.log('PASS: isolated signer CLI migrates a separate database and recovers a saved artifact across process launches without contacting unreachable wallet/node endpoints.')

  let broadcasts=0,includePayout=false
  const fixtureErrors:unknown[]=[]
  const tipHash='c'.repeat(64),payoutBlock='f'.repeat(64),payoutTx='e'.repeat(64)
  nodeFixture=createServer(async(req,res)=>{
    let message:any
    try{
      const chunks:Buffer[]=[]
      for await(const chunk of req)chunks.push(Buffer.from(chunk))
      message=JSON.parse(Buffer.concat(chunks).toString())
      let result:unknown
      if(message.method==='getblockchaininfo')result={chain:'test',blocks:100,bestblockhash:tipHash,initialblockdownload:false}
      else if(message.method==='getblockhash')result=message.params[0]===0?'d'.repeat(64):message.params[0]===100?tipHash:payoutBlock
      else if(message.method==='getblock')result=message.params[0]===tipHash?{hash:tipHash,height:100,time:Math.floor(Date.now()/1000),tx:['b'.repeat(64)]}:{hash:payoutBlock,height:98,tx:includePayout?[payoutTx]:['a'.repeat(64)]}
      else if(message.method==='getrawmempool')result=[]
      else if(message.method==='sendrawtransaction'){assert.deepEqual(message.params,['00']);broadcasts++;result=payoutTx}
      else throw new Error('Unexpected fixture RPC method')
      res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
    }catch(error){fixtureErrors.push(error);res.end(JSON.stringify({jsonrpc:'2.0',id:message?.id,error:{code:-1,message:'fixture failure'}}))}
  })
  nodeFixture.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>nodeFixture!.once('listening',resolve))
  const payoutEnv={...signerEnv,AGNT_SALE_PAYOUTS_ENABLED:'true',AGNT_SALE_CONFIRMATIONS:'3',AGNT_ZEBRA_RPC_URL:`http://127.0.0.1:${(nodeFixture.address() as AddressInfo).port}`}
  const runPayout=(mode:string,...args:string[])=>exec(process.execPath,['--import','tsx/esm','scripts/sale-payout.ts',mode,cliHold.id,...args],{env:payoutEnv,timeout:15000})
  await runPayout('broadcast')
  await runPayout('broadcast')
  assert.equal(broadcasts,1)
  const heldBefore=(await service.account('seed')).balance.held
  await assert.rejects(runPayout('settle',payoutBlock),error=>{
    assert.equal((error as Error&{stderr:string}).stderr.trim(),'observer_transaction_not_in_block')
    return true
  })
  assert.equal((await service.account('seed')).balance.held,heldBefore)
  includePayout=true
  await runPayout('settle',payoutBlock)
  await runPayout('settle',payoutBlock)
  await runPayout('review')
  assert.equal((await service.account('seed')).balance.held,String(BigInt(heldBefore)-1n))
  assert.equal((await pool.query('SELECT state FROM agnt_sale_withdrawals WHERE id=$1',[cliHold.id])).rows[0].state,'PAID')
  assert.equal(broadcasts,1)
  assert.deepEqual(fixtureErrors,[])
  console.log('PASS: payout subprocesses broadcast stored bytes once, reject absent transaction membership without releasing credit, and settle/replay exactly once against a synthetic node.')

  const sold=(await service.summary()).sold
  await service.purchase('seed',await request('seed',4443-sold))
  await service.observe('final-a',receipt('final-a','20000000'),3)
  await service.observe('final-b',receipt('final-b','20000000'),3)
  const qa=await request('final-a',1),qb=await request('final-b',1)
  const last=await Promise.allSettled(Array.from({length:20},(_,i)=>service.purchase(i%2?'final-a':'final-b',{...(i%2?qa:qb),idempotencyKey:randomUUID()})))
  assert.equal(last.filter(r=>r.status==='fulfilled').length,1)
  assert.equal((await service.summary()).sold,4444)
  const count=await pool.query('SELECT count(*)::integer AS total,count(DISTINCT serial)::integer AS unique_total FROM agnt_sale_passes')
  assert.equal(count.rows[0].total,4444)
  assert.equal(count.rows[0].unique_total,4444)
  assert.equal((await reconcileSale(pool)).ok,true)
  console.log('PASS: 20 buyers racing for the final pass produce exactly one sale; all 4,444 serials and accounting reconcile.')
  let injectedDeposit=false
  const interleavedPool={connect:async()=>{
    const client=await pool!.connect()
    return {query:async(sql:string,args?:unknown[])=>{
      const result=await client.query(sql,args)
      if(!injectedDeposit&&sql.startsWith('SELECT reference,debit_account,credit_account,amount FROM agnt_sale_ledger')){
        injectedDeposit=true
        await service.observe('snapshot-new-account',receipt('snapshot-new-account','1000000'),3)
      }
      return result
    },release:()=>client.release()}
  }} as unknown as Pool
  const snapshotCheck=await reconcileSale(interleavedPool)
  assert.equal(injectedDeposit,true)
  assert.equal(snapshotCheck.ok,true,'A new committed deposit must not appear only in the source half of reconciliation')
  assert.equal((await service.account('snapshot-new-account')).balance.available,'1000000')
  assert.equal((await reconcileSale(pool)).ok,true)
  console.log('PASS: concurrent new-account deposit commits during reconciliation without a mixed-snapshot false mismatch; the next reconciliation includes it.')
  const financialBefore=(await service.account('seed')).balance
  await Promise.all(Array.from({length:6},()=>deliverSaleNotifications(pool!,100)))
  const delivery=(await pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE state='DELIVERED')::int AS delivered FROM agnt_sale_outbox")).rows[0]
  assert.ok(delivery.total>0)
  assert.equal(delivery.total,delivery.delivered)
  assert.equal((await pool.query('SELECT count(*)::int AS total FROM agnt_sale_notifications')).rows[0].total,delivery.total)
  assert.deepEqual((await service.account('seed')).balance,financialBefore)
  assert.equal((await reconcileSale(pool)).ok,true)
  console.log('PASS: six concurrent inbox workers deliver each outbox event once without changing customer balances or ledger invariants.')
  const statusProcess=await exec(process.execPath,['--import','tsx/esm','scripts/sale-status.ts'],{env:signerEnv,timeout:15000})
  const operational=JSON.parse(statusProcess.stdout)
  assert.equal(operational.sale.sold,4444)
  assert.equal(operational.productionReady,false)
  assert.equal(operational.treasurySolvencyVerified,false)
  assert.equal(operational.notificationsDue,0)
  assert.equal(statusProcess.stderr,'')
  console.log('PASS: read-only operations CLI reports aggregate queue/ledger states without claiming production readiness or treasury solvency.')
  // Quiescent synthetic databases only. Stream a real pg_dump archive into a
  // fresh database; no backup files or transaction bytes are printed or retained.
  async function restoreCopy(source:string,target:string){
    assert.ok(['agnt_sale_test','agnt_signer_test'].includes(source))
    assert.ok(['agnt_sale_restored','agnt_signer_restored'].includes(target))
    await pool!.query(`CREATE DATABASE ${target}`)
    const dump=await exec('docker',['exec',containerId!,'pg_dump','-U','postgres','--format=custom','--dbname',source],{encoding:'buffer',maxBuffer:16*1024*1024,timeout:30000})
    await new Promise<void>((resolve,reject)=>{
      const child=execFile('docker',['exec','-i',containerId!,'pg_restore','-U','postgres','--exit-on-error','--no-owner','--no-privileges','--dbname',target],{timeout:30000,maxBuffer:1024*1024},error=>error?reject(new Error('Disposable backup restore failed')):resolve())
      child.stdin!.on('error',()=>{})
      child.stdin!.end(dump.stdout)
    })
    return new Pool({host:'127.0.0.1',port:Number(port.split(':')[1]),user:'postgres',password,database:target,max:2,statement_timeout:30000})
  }
  const restored=await restoreCopy('agnt_sale_test','agnt_sale_restored')
  let restoredSigner:Pool|undefined
  try{
    restoredSigner=await restoreCopy('agnt_signer_test','agnt_signer_restored')
    for(const [original,copy] of [[pool,restored],[signerPool,restoredSigner]]){
      const tables=(await original!.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
      assert.deepEqual((await copy!.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows,tables)
      for(const {tablename} of tables){
        assert.match(tablename,/^agnt_[a-z_]+$/)
        const sql=`SELECT count(*)::int AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS fingerprint FROM "${tablename}" t`
        assert.deepEqual((await copy!.query(sql)).rows,(await original!.query(sql)).rows,`Restored table differs: ${tablename}`)
      }
    }
    // A restore is never permission to resume a sale or treasury process.
    await restored.query("UPDATE agnt_sale SET state='PAUSED' WHERE id=1")
    const recoveredService=new SaleService(restored)
    assert.equal((await recoveredService.summary()).state,'PAUSED')
    assert.equal((await recoveredService.summary()).sold,4444)
    assert.equal((await reconcileSale(restored)).ok,true)
    assert.equal((await recoveredService.purchase('seed',first)).id,duplicates[0].id)
    assert.equal((await recoveredService.accessSnapshot('seed')).policyVersion,fixturePolicy.version)
    assert.equal((await recoveredService.accessSnapshot('seed')).usedToday,5)
    await assert.rejects(recoveredService.consumeAccess('seed'),/daily_tool_limit/)
    const recoveredReceipt=await recoveredService.purchaseReceipt('seed',duplicates[0].id)
    assert.deepEqual(recoveredReceipt.signature,receiptRaceResults[0])
    assert.deepEqual(verifyReceiptBytes(recoveredReceipt.signature!,receiptKey.publicKey),receiptPayload)
    assert.deepEqual(await signPurchaseReceipt(restored,duplicates[0].id,receiptKey.privateKey),receiptRaceResults[0])
    const recoveredArtifacts=new SignerArtifacts(restoredSigner)
    assert.deepEqual(await recoveredArtifacts.load(intent.reference),await signerStore.load(intent.reference))
    await assert.rejects(new SignerArtifacts(restored).begin('regtest:race','regtest','a'.repeat(64)),/signing_already_started/)
    await assert.rejects(new SignerArtifacts(restored).signForWallet(walletAccount,{reference:'restored:must-not-sign',network:'regtest',intentHash:'f'.repeat(64)},async()=>{throw new Error('Restored ambiguity must not contact wallet')}),/treasury_signing_busy/)
    console.log('PASS: real pg_dump/pg_restore preserves every accounting/signer table, all 4,444 holdings, artifact bytes, retry identity and ambiguous locks; restored sale remains PAUSED and reconciles.')
  }finally{
    await restoredSigner?.end()
    await restored.end()
  }
}finally{
  if(nodeFixture){nodeFixture.closeAllConnections();await new Promise<void>(resolve=>nodeFixture!.close(()=>resolve()))}
  await signerPool?.end()
  await pool?.end()
  if(containerId){
    // Delete only the exact disposable container this process created, after verifying its label.
    const label=(await exec('docker',['inspect','--format','{{index .Config.Labels "com.agnt.sale-test"}}',containerId])).stdout.trim()
    assert.equal(label,'true')
    await exec('docker',['stop','--time','3',containerId])
    console.log('Removed disposable test container and its temporary database. Downloaded image remains cached.')
  }
}
