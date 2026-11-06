import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { persistAndRecoverRegtestArtifact } from './zcash-regtest-artifacts.js'
import { DepositAssignments } from '../src/mcp/sale/deposit-assignments.js'
import { zcashSaleProviders } from '../src/mcp/sale/zcash-providers.js'
import { migrateSale } from '../src/mcp/sale/database.js'
import { configureSaleAccess } from '../src/mcp/sale/access-policy.js'
import { scanAssignedBlock } from '../src/mcp/sale/deposit-scanner.js'
import { SaleService } from '../src/mcp/sale/service.js'
import { approveFixtureWithdrawal } from './test-sale-approvals.js'
import { ZcashRpcError } from '../src/mcp/sale/zcash-observer.js'
import { CURVE_VERSION } from '../src/mcp/sale/pricing.js'
import { signZalletWithdrawal, zecJsonAmount } from '../src/mcp/sale/zallet-signer.js'
import { SignerArtifacts } from '../src/mcp/sale/signer-artifacts.js'
import { signApprovedWithdrawal, broadcastSignedWithdrawal, settleConfirmedWithdrawal } from '../src/mcp/sale/withdrawal-worker.js'
import { reconcileSale } from '../src/mcp/sale/reconcile.js'
import { observeWalletInventory } from '../src/mcp/sale/wallet-inventory.js'
import type { Pool } from 'pg'

const exec=promisify(execFile)
const image='zodlinc/zallet:v0.1.0-beta.3@sha256:54d1a774317371b1e88c8a54712cdfa4aa7d8f20ae2a0205f9a190e502aef0f6'
const label='com.agnt.zcash-test'

interface ReadyWallet {rpc:(method:string,params?:unknown[])=>Promise<any>; account:string; address:string; restart:()=>Promise<void>}
export async function testRegtestWallet(networkId:string,nodeId:string,nodeRpc:(method:string,params?:unknown[])=>Promise<any>,onReady?:(wallet:ReadyWallet)=>Promise<void>,afterPurchase?:(db:Pool,block:{hash:string;height:number},txid:string)=>Promise<void>,afterPaid?:(db:Pool,block:{hash:string;height:number},withdrawalId:string)=>Promise<void>){
  const name=`agnt-wallet-test-${randomUUID()}`
  const volumes:string[]=[]
  let walletId:string|undefined
  try{
    for(const suffix of ['data','ca']){
      const volume=(await exec('docker',['volume','create','--label',`${label}=true`,`${name}-${suffix}`])).stdout.trim()
      assert.equal(volume,`${name}-${suffix}`)
      volumes.push(volume)
    }
    await exec('docker',['run','--rm','--network','none','--mount',`type=volume,source=${volumes[0]},target=/data`,'--mount',`type=volume,source=${volumes[1]},target=/certs`,'alpine:3.21','sh','-c','touch /data/.initialized && chown 1000:1000 /data /data/.initialized && cp /etc/ssl/certs/ca-certificates.crt /certs/'],{timeout:180000})
    const options=['--network',networkId,'--user','1000:1000','--memory','3g','--cpus','4','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--mount',`type=volume,source=${volumes[0]},target=/var/lib/zallet`,
      '--mount',`type=volume,source=${volumes[1]},target=/etc/ssl/certs,readonly`,
      '--mount',`type=bind,source=${resolve('integration/zcash-regtest/zallet.toml')},target=/etc/zallet/zallet.toml,readonly`,
      '--entrypoint','/usr/local/bin/zallet-zaino']
    const args=['--datadir','/var/lib/zallet','--config','/etc/zallet/zallet.toml']
    for(const step of ['generate-encryption-identity','init-wallet-encryption','generate-mnemonic']){
      console.log(`Initializing disposable wallet: ${step} (wallet output withheld).`)
      try{await exec('docker',['run','--rm',...options,image,...args,step],{timeout:120000})}
      catch(error){
        const stderr=String((error as {stderr?:string}).stderr||'')
        const diagnostic=stderr.split('\n').filter(line=>/error|invalid|failed|permission|unknown|unsupported|missing|denied/i.test(line) && !/AGE-SECRET|mnemonic|secret key/i.test(line)).join(' ').slice(0,400)
        throw new Error(`Disposable wallet initialization failed at ${step}: ${diagnostic || 'output withheld'}`)
      }
    }
    walletId=(await exec('docker',['run','--rm','--detach','--name',name,'--network-alias',name,'--label',`${label}=true`,...options,image,...args,'start'],{timeout:120000})).stdout.trim()
    assert.match(walletId,/^[a-f0-9]{64}$/)
    async function rpc(method:string,params:unknown[]=[]){
      const id=randomUUID()
      // PCZTs exceed Windows command-line limits. Keep payloads off argv and
      // stream them over stdin, also avoiding transaction data in process listings.
      const response=await new Promise<string>((resolve,reject)=>{
        const child=execFile('docker',['exec','-i',nodeId,'curl','--fail','--silent','--show-error','--max-time','120','--user','agnt-regtest:regtest-only-not-production','-H','Content-Type: application/json','--data-binary','@-',`http://${name}:28232`],{timeout:125000,maxBuffer:16*1024*1024},(error,stdout)=>error?reject(new Error(`Wallet transport failed: ${error.code}`)):resolve(stdout))
        child.stdin!.on('error',()=>{}) // Completion callback reports transport failure.
        child.stdin!.end(JSON.stringify({jsonrpc:'2.0',id,method,params}))
      })
      const body=JSON.parse(response)
      assert.equal(body.id,id)
      if(body.error){
        // These RPCs do not export keys; retain bounded diagnostics for disposable test failures.
        const detail=String(body.error.message||'').replace(/AGE-SECRET-KEY-[A-Z0-9]+/g,'[redacted]').slice(0,300)
        throw new ZcashRpcError(method,body.error.code,detail)
      }
      return body.result
    }
    let methods:string[]|undefined
    for(let attempt=0;attempt<30;attempt++){
      try{methods=(await rpc('rpc.discover')).methods.map((m:{name:string})=>m.name);break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}
    }
    assert.ok(methods,'Zallet RPC discovery did not become ready')
    for(const method of ['z_getnewaccount','z_getaddressforaccount','z_viewtransaction'])assert.ok(methods.includes(method),`Required method unavailable: ${method}`)
    let synchronized=false
    const initialHeight=(await nodeRpc('getblockchaininfo')).blocks
    for(let attempt=0;attempt<30;attempt++){
      const status=await rpc('getwalletstatus')
      if(status.node_tip?.height===initialHeight && status.wallet_tip?.height===initialHeight && status.wallet_tip.blockhash===status.node_tip.blockhash){synchronized=true;break}
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
    assert.ok(synchronized,'Wallet did not reach the regtest tip before account creation')
    console.log('Authenticated RPC and wallet/node tip agreement passed; creating a disposable test account.')
    const account=await rpc('z_getnewaccount',['agnt-regtest'])
    assert.equal(typeof account.account_uuid,'string')
    // Use a fresh explicit index and an Orchard-only receiver. Index zero can
    // already belong to the default receiver set; arbitrary Sapling indices may be invalid.
    const address=await rpc('z_getaddressforaccount',[account.account_uuid,['orchard'],1024])
    assert.equal(typeof address.address,'string')
    assert.ok(address.address.length>40)
    const replay=await rpc('z_getaddressforaccount',[account.account_uuid,['orchard'],1024])
    assert.equal(replay.address,address.address)
    console.log('PASS: disposable Zallet initialization, authenticated RPC discovery, and repeatable shielded address derivation.')
    console.log(`Staged-signing methods exposed: ${['pczt_create','pczt_prove','pczt_sign','pczt_extract'].filter(method=>methods!.includes(method)).join(', ') || 'none'}. No signing or payments performed.`)
    async function restart(){
      assert.equal((await exec('docker',['inspect','--format',`{{index .Config.Labels "${label}"}}`,walletId!])).stdout.trim(),'true')
      await exec('docker',['stop','--time','5',walletId!])
      walletId=undefined
      walletId=(await exec('docker',['run','--rm','--detach','--name',name,'--network-alias',name,'--label',`${label}=true`,...options,image,...args,'start'],{timeout:120000})).stdout.trim()
      const tip=await nodeRpc('getblockchaininfo')
      for(let attempt=0;attempt<60;attempt++){
        try{
          const status=await rpc('getwalletstatus')
          if(status.fully_synced_height===tip.blocks&&status.wallet_tip?.blockhash===tip.bestblockhash&&status.node_tip?.blockhash===tip.bestblockhash)return
        }catch{/* Newly restarted RPC may not be ready yet. */}
        await new Promise(resolve=>setTimeout(resolve,1000))
      }
      throw new Error('Restarted test wallet did not synchronize')
    }
    if(onReady){await onReady({rpc,account:account.account_uuid,address:address.address,restart});return}
    if(process.argv.includes('--signing')){
      for(const method of ['pczt_create','pczt_inspect','pczt_prove','pczt_sign','pczt_extract'])assert.ok(methods.includes(method),`Required signing-test method unavailable: ${method}`)
      console.log('Funding the disposable wallet with local regtest coinbase; no public-chain funds.')
      // Mine directly to a shielded receiver. z_sendmany intentionally excludes
      // transparent coinbase UTXOs; those require a separate shielding operation.
      await nodeRpc('generatetoaddress',[1,address.address])
      for(let batch=0;batch<10;batch++)await nodeRpc('generate',[10])
      const target=(await nodeRpc('getblockchaininfo')).blocks
      let synced=false
      for(let attempt=0;attempt<60;attempt++){
        const status=await rpc('getwalletstatus')
        if(status.fully_synced_height===target){synced=true;break}
        await new Promise(resolve=>setTimeout(resolve,1000))
      }
      assert.ok(synced,'Funded wallet did not finish scanning')
      const runSigning=async(receiver?:ReadyWallet)=>{
      const destination=receiver?.address??address.address
      const depositAmount=receiver?'5000000':'2000000'
      console.log('Building a signed, non-broadcast regtest transaction using the pinned wallet API.')
      await persistAndRecoverRegtestArtifact({reference:`regtest:${randomUUID()}`,network:'regtest',
        intentHash:createHash('sha256').update(JSON.stringify({destination,amountZatoshi:depositAmount,feeLimitZatoshi:'100000'})).digest('hex')},async(db)=>{
      const assignments=new DepositAssignments(db)
      await migrateSale(db)
      await configureSaleAccess(db,30,1) // Disposable fixture only.
      if(receiver){
        const customer=await assignments.allocate('regtest-customer','regtest',receiver.account,receiver.rpc)
        assert.equal(customer.recipientAddresses[0],destination)
      }
      const alice=await assignments.allocate('regtest-alice','regtest',account.account_uuid,rpc)
      if(!receiver)assert.equal(alice.recipientAddresses[0],address.address)
      assert.deepEqual(await assignments.allocate('regtest-alice','regtest',account.account_uuid,async()=>{throw new Error('Saved assignment must not call wallet')}),alice)
      const bob=await assignments.allocate('regtest-bob','regtest',account.account_uuid,rpc)
      assert.notEqual(alice.recipientAddresses[0],bob.recipientAddresses[0])
      console.log('PASS: actual wallet allocation matches reserved index, replays without RPC, and separates users.')
      const tipInfo=await nodeRpc('getblockchaininfo')
      const tipBlock=await nodeRpc('getblock',[tipInfo.bestblockhash,1])
      const providers=zcashSaleProviders(db,rpc,nodeRpc,{network:'regtest',genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300},account.account_uuid,tipBlock.time)
      await providers.validateDestination(destination)
      await assert.rejects(providers.validateDestination('not-a-zcash-address'.padEnd(80,'x')),/invalid_destination/)
      const allocated=await providers.depositAddress('regtest-provider')
      assert.equal(allocated.walletAccountUuid,account.account_uuid)
      assert.deepEqual(await providers.depositAddress('regtest-provider'),allocated)
      console.log('PASS: actual wallet provider validates an Orchard destination, rejects invalid encoding, and allocates/replays a network-bound deposit address.')
      const scanned=await scanAssignedBlock(db,rpc,nodeRpc,{network:'regtest',genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300},'regtest-alice',3,3,tipBlock.time)
      assert.equal(scanned.state,'advanced')
      assert.equal(scanned.transactions,1)
      assert.equal((await new SaleService(db).account('regtest-alice')).balance.available,'0')
      console.log('PASS: actual wallet discovery scans the funded block without crediting treasury coinbase to a customer.')
      const signed=await signZalletWithdrawal(rpc,nodeRpc,{network:'regtest',genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300},
        {reference:'regtest-adapter',network:'regtest',walletAccountUuid:account.account_uuid,destination,amountZatoshi:depositAmount,feeLimitZatoshi:'100000'},tipBlock.time)
      assert.equal((await nodeRpc('getrawmempool')).includes(signed.txid),false)
      return signed
      },async(db,artifact)=>{
      const signedTxid=artifact.txid
      // Restart the wallet too, then broadcast only the committed artifact.
      // Never re-extract: binding signatures can change the raw transaction bytes.
      await exec('docker',['stop','--time','5',walletId!])
      walletId=undefined
      walletId=(await exec('docker',['run','--rm','--detach','--name',name,'--network-alias',name,'--label',`${label}=true`,...options,image,...args,'start'])).stdout.trim()
      const recovered=artifact.rawHex
      assert.equal((await nodeRpc('getrawmempool')).includes(signedTxid),false)
      assert.equal(await nodeRpc('sendrawtransaction',[recovered]),signedTxid)
      const mined=await nodeRpc('generate',[1])
      assert.ok((await nodeRpc('getblock',[mined[0],1])).tx.includes(signedTxid))
      console.log('PASS: PCZT signing/extraction, persisted artifact recovery, explicit regtest broadcast after wallet restart, and block inclusion. Complete signer-worker crash recovery remains untested.')
      if(receiver){
        const depositBlock=await nodeRpc('getblock',[mined[0],1])
        let pendingScanned=false
        for(let attempt=0;attempt<60;attempt++){
          if((await receiver.rpc('getwalletstatus')).fully_synced_height===depositBlock.height){pendingScanned=true;break}
          await new Promise(resolve=>setTimeout(resolve,1000))
        }
        assert.ok(pendingScanned,'Recipient wallet did not scan the one-confirmation deposit')
        const pending=await scanAssignedBlock(db,receiver.rpc,nodeRpc,{network:'regtest',genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300},'regtest-customer',depositBlock.height,3,depositBlock.time)
        assert.equal(pending.state,'confirming')
        const pendingAccount=await new SaleService(db).account('regtest-customer')
        assert.equal(pendingAccount.balance.available,'0')
        assert.equal(pendingAccount.deposits[0].state,'CONFIRMING')
        assert.equal(pendingAccount.deposits[0].confirmations,1)
        const inventoryPolicy={network:'regtest' as const,genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300}
        const pendingInventory=await observeWalletInventory(receiver.rpc,nodeRpc,inventoryPolicy,receiver.account,3,depositBlock.time)
        assert.equal(pendingInventory.spendableTotalZatoshi,'0','Below-threshold notes must not be counted as spendable backing')
        assert.equal(pendingInventory.pendingZatoshi,depositAmount)
        console.log('PASS: actual shielded deposit is visible with one confirmation and zero spendable credit.')
        await nodeRpc('generate',[2])
        const tip=await nodeRpc('getblockchaininfo')
        let received=false
        for(let attempt=0;attempt<60;attempt++){
          if((await receiver.rpc('getwalletstatus')).fully_synced_height===tip.blocks){received=true;break}
          await new Promise(resolve=>setTimeout(resolve,1000))
        }
        assert.ok(received,'Recipient wallet did not finish scanning')
        const clock=(await nodeRpc('getblock',[tip.bestblockhash,1])).time
        await scanAssignedBlock(db,receiver.rpc,nodeRpc,{network:'regtest',genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300},'regtest-customer',depositBlock.height,3,clock)
        const service=new SaleService(db)
        assert.equal((await service.account('regtest-customer')).balance.available,depositAmount)
        const confirmedInventory=await observeWalletInventory(receiver.rpc,nodeRpc,inventoryPolicy,receiver.account,3,clock)
        assert.equal(confirmedInventory.spendableTotalZatoshi,depositAmount)
        assert.equal(confirmedInventory.pendingZatoshi,'0')
        assert.equal(confirmedInventory.treasurySolvencyVerified,false)
        console.log('PASS: actual wallet inventory excludes below-threshold deposit notes and reports exact confirmed spendable funds.')
        // Synthetic sale and entitlement terms apply only in this disposable DB.
        await db.query("UPDATE agnt_sale SET state='OPEN' WHERE id=1")
        const quote=await service.quote('regtest-customer',1)
        await service.purchase('regtest-customer',{quoteId:quote.id,quantity:1,maxTotalZatoshi:quote.totalZatoshi,curveVersion:CURVE_VERSION,idempotencyKey:randomUUID()})
        assert.equal((await service.account('regtest-customer')).passes.length,1)
        await service.consumeAccess('regtest-customer')
        await assert.rejects(service.consumeAccess('regtest-customer'),/daily_tool_limit/)
        console.log('PASS: separate-wallet shielded deposit credits the assigned user, funds a pass purchase, and grants bounded tool access.')
        if(afterPurchase){await afterPurchase(db,depositBlock,signedTxid);return}
        const policy={network:'regtest' as const,genesisHash:'029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327',maxTipAgeSeconds:300}
        const hold=await service.holdWithdrawal('regtest-customer',{destination:address.address,amountZatoshi:'1000000',feeLimitZatoshi:'100000',idempotencyKey:randomUUID()})
        await approveFixtureWithdrawal(service,db,'regtest-customer',hold.id)
        const artifacts=new SignerArtifacts(db) // Shared test DB only; production signer uses a separate role/database.
        const withdrawal=await signApprovedWithdrawal(db,artifacts,'regtest-customer',hold.id,'regtest',receiver.account,
          async intent=>{
            await assert.rejects(artifacts.signForWallet(receiver.account,{reference:'regtest-competing-withdrawal',network:'regtest',intentHash:'f'.repeat(64)},async()=>{throw new Error('Competing wallet callback must not execute')}),/treasury_signing_busy/)
            const signed=await signZalletWithdrawal(receiver.rpc,nodeRpc,policy,intent,clock)
            // Observe the cross-database interval before the callback result is
            // persisted: wallet notes are already locked, ledger still APPROVED.
            const signingInventory=await observeWalletInventory(receiver.rpc,nodeRpc,policy,receiver.account,3,clock)
            assert.equal(signingInventory.spendableTotalZatoshi,'0')
            assert.equal(signingInventory.pendingZatoshi,String(BigInt(depositAmount)-1000000n-BigInt(signed.actualFeeZatoshi)))
            assert.equal(signingInventory.lockedZatoshi,null,'Unavailable locked-input reporting is not a zero balance')
            const signingStatus=(await service.withdrawalStatus('regtest-customer',hold.id)).withdrawal
            assert.equal(signingStatus.state,'APPROVED')
            assert.equal((await service.account('regtest-customer')).balance.held,'1100000')
            console.log('PASS: spendable inventory is zero while signed notes are locked and the ledger payout is still APPROVED; this is not proof of insolvency.')
            return signed
          })
        assert.equal((await db.query('SELECT count(*)::int AS count FROM agnt_wallet_signing_locks')).rows[0].count,0)
        // The recipient owns only the one confirmed deposit note. Extraction
        // must reserve it before broadcast; pending change is not confirmed.
        await assert.rejects(receiver.rpc('pczt_create',[receiver.account,[{address:address.address,amount:zecJsonAmount('1000000')}],1,'FullPrivacy']),
          (error:unknown)=>error instanceof ZcashRpcError&&error.method==='pczt_create'&&/insufficient|not enough/i.test(error.detail))
        console.log('PASS: actual withdrawal excludes a concurrent proposal and the wallet refuses to reuse its pending-spent deposit note before broadcast.')
        await receiver.restart()
        await assert.rejects(receiver.rpc('pczt_create',[receiver.account,[{address:address.address,amount:zecJsonAmount('1000000')}],1,'FullPrivacy']),
          (error:unknown)=>error instanceof ZcashRpcError&&error.method==='pczt_create'&&/insufficient|not enough/i.test(error.detail))
        assert.equal((await nodeRpc('getrawmempool')).includes(withdrawal.txid),false)
        assert.equal((await observeWalletInventory(receiver.rpc,nodeRpc,policy,receiver.account,3,clock)).spendableTotalZatoshi,'0')
        console.log('PASS: recipient wallet restart preserves pending-note exclusion before broadcast; replay will use the saved artifact, not re-sign.')
        await signApprovedWithdrawal(db,artifacts,'regtest-customer',hold.id,'regtest',receiver.account,async()=>{throw new Error('Withdrawal replay must not re-sign')})
        await broadcastSignedWithdrawal(db,artifacts,nodeRpc,policy,'regtest-customer',hold.id,receiver.account,clock)
        const beforeConfirmation=(await service.account('regtest-customer')).balance
        const paidBlocks=await nodeRpc('generate',[1])
        const firstPayoutBlock=await nodeRpc('getblock',[paidBlocks[0],1])
        await assert.rejects(settleConfirmedWithdrawal(db,artifacts,nodeRpc,policy,'regtest-customer',hold.id,paidBlocks[0],3,firstPayoutBlock.time),/withdrawal_unconfirmed/)
        const confirmingPayout=(await service.withdrawalStatus('regtest-customer',hold.id)).withdrawal
        assert.equal(confirmingPayout.confirmations,1)
        assert.equal(confirmingPayout.required_confirmations,3)
        assert.equal(confirmingPayout.state,'BROADCAST')
        assert.deepEqual((await service.account('regtest-customer')).balance,beforeConfirmation)
        console.log('PASS: actual payout persists one-of-three confirmation progress without releasing held credit or fees.')
        paidBlocks.push(...await nodeRpc('generate',[2]))
        const paidTip=await nodeRpc('getblock',[paidBlocks[2],1])
        await settleConfirmedWithdrawal(db,artifacts,nodeRpc,policy,'regtest-customer',hold.id,paidBlocks[0],3,paidTip.time)
        const final=await service.account('regtest-customer')
        assert.equal(final.balance.held,'0')
        assert.equal(final.balance.available,String(2000000n-BigInt(withdrawal.actualFeeZatoshi)))
        assert.equal(final.withdrawals[0].state,'PAID')
        assert.equal(final.withdrawals[0].confirmations,3)
        assert.equal(final.withdrawals[0].required_confirmations,3)
        assert.equal((await reconcileSale(db)).ok,true)
        console.log('PASS: unused credit withdrawal is held, approved, signed once, broadcast, confirmed, fee-settled and reconciled.')
        if(afterPaid)await afterPaid(db,await nodeRpc('getblock',[paidBlocks[0],1]),hold.id)
      }
      })
      }
      if(process.argv.includes('--deposits'))await testRegtestWallet(networkId,nodeId,nodeRpc,runSigning)
      else await runSigning()
    }
  }finally{
    if(walletId){
      assert.equal((await exec('docker',['inspect','--format',`{{index .Config.Labels "${label}"}}`,walletId])).stdout.trim(),'true')
      await exec('docker',['stop','--time','5',walletId])
    }
    for(const volume of volumes){
      assert.equal((await exec('docker',['volume','inspect','--format',`{{index .Labels "${label}"}}`,volume])).stdout.trim(),'true')
      await exec('docker',['volume','rm',volume])
    }
    console.log('Removed disposable wallet and its test keys; no real funds were used.')
  }
}
