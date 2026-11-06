import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec=promisify(execFile)
const script=fileURLToPath(new URL('../../../scripts/sale-sign.ts',import.meta.url))

test('receipt signer is inert by default and fails closed on missing configuration',async()=>{
  const receiptScript=fileURLToPath(new URL('../../../scripts/sale-sign-receipt.ts',import.meta.url))
  const env={...process.env,AGNT_RECEIPT_SIGNER_ENABLED:'false',AGNT_RECEIPT_SIGNING_KEY_FILE:'missing-file',AGNT_RECEIPT_DATABASE_URL:''}
  const disabled=await exec(process.execPath,['--import','tsx/esm',receiptScript],{env,timeout:15000})
  assert.match(disabled.stdout,/disabled.*No key file or database/)
  for(const args of [[],['invalid'],['11111111-1111-1111-1111-111111111111']]){
    await assert.rejects(exec(process.execPath,['--import','tsx/esm',receiptScript,...args],{env:{...env,AGNT_RECEIPT_SIGNER_ENABLED:'true'},timeout:15000}),error=>{
      const result=error as Error&{code:number;stderr:string}
      assert.equal(result.code,1)
      assert.equal(result.stderr.trim(),'receipt_signing_failed')
      return true
    })
  }
})
test('payout command is disabled by default and rejects incomplete or unknown actions',async()=>{
  const payout=fileURLToPath(new URL('../../../scripts/sale-payout.ts',import.meta.url))
  const disabled=await exec(process.execPath,['--import','tsx/esm',payout],{env:{...process.env,AGNT_SALE_PAYOUTS_ENABLED:'false'},timeout:15000})
  assert.match(disabled.stdout,/disabled.*No database or node connection/s)
  for(const args of [[],['sign'],['broadcast','invalid'],['settle','11111111-1111-1111-1111-111111111111']]){
    await assert.rejects(exec(process.execPath,['--import','tsx/esm',payout,...args],{env:{...process.env,AGNT_SALE_PAYOUTS_ENABLED:'true'},timeout:15000}),error=>{
      const result=error as Error&{code:number;stderr:string}
      assert.equal(result.code,1)
      assert.equal(result.stderr.trim(),'invalid_payout_arguments')
      return true
    })
  }
})
test('signer command is inert by default and rejects missing explicit withdrawal identity',async()=>{
  const disabled=await exec(process.execPath,['--import','tsx/esm',script],{env:{...process.env,AGNT_SALE_SIGNER_ENABLED:'false'},timeout:15000})
  assert.match(disabled.stdout,/disabled.*No database, wallet or node connection/s)
  assert.equal(disabled.stderr,'')
  await assert.rejects(exec(process.execPath,['--import','tsx/esm',script,'invalid-id'],{env:{...process.env,AGNT_SALE_SIGNER_ENABLED:'true'},timeout:15000}),error=>{
    const result=error as Error&{code:number;stderr:string}
    assert.equal(result.code,1)
    assert.equal(result.stderr.trim(),'signer_withdrawal_id_required')
    return true
  })
})
