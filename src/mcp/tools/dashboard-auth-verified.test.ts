import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { loginDashboard, signupDashboardVerified, startEmailLogin, startEmailLoginWithDelivery, verifyEmailLogin } from '../dashboard-auth.js'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

test('email login uses six-digit codes and locks a challenge after five incorrect attempts',async()=>{
  const path=join(tmpdir(),`agnt-code-attempts-${randomUUID()}.enc`)
  try{
    const started=startEmailLogin('attempts@example.com',path,{now:1000})
    assert.match(started.devCode!,/^[0-9]{6}$/)
    const wrong=started.devCode==='000000'?'111111':'000000'
    for(let i=0;i<5;i++)assert.throws(()=>verifyEmailLogin({email:'attempts@example.com',code:wrong,now:1001},path),/not correct/)
    assert.throws(()=>verifyEmailLogin({email:'attempts@example.com',code:started.devCode!,now:1002},path),/Too many attempts/)
  }finally{await unlink(path).catch(()=>{})}
})

test('production rejects console login codes before creating a verification record',async()=>{
  const storePath=join(tmpdir(),`agnt-auth-production-${randomUUID()}.enc`)
  const previousEnv=process.env.NODE_ENV,previousProvider=process.env.AGNT_EMAIL_PROVIDER
  try{
    process.env.NODE_ENV='production'
    process.env.AGNT_EMAIL_PROVIDER='console'
    assert.throws(()=>startEmailLogin('private@example.com',storePath),/requires verified delivery/)
    await assert.rejects(startEmailLoginWithDelivery('private@example.com',storePath),/not configured/)
    assert.equal(existsSync(storePath),false)
  }finally{
    if(previousEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousEnv
    if(previousProvider===undefined)delete process.env.AGNT_EMAIL_PROVIDER;else process.env.AGNT_EMAIL_PROVIDER=previousProvider
  }
})

test('dashboard signup requires and consumes a valid email code', () => {
  const storePath = join(tmpdir(), `agnt-auth-${randomUUID()}.enc`)
  const started = startEmailLogin('verified@example.com', storePath, { now: 1_000 })
  assert.ok(started.devCode)
  assert.throws(() => signupDashboardVerified({
    email: 'verified@example.com',
    password: 'password123',
    code: '000000',
    now: 1_001,
  }, storePath), /not correct/i)

  const signedUp = signupDashboardVerified({
    email: 'verified@example.com',
    password: 'password123',
    code: started.devCode!,
    now: 1_002,
  }, storePath)
  assert.equal(signedUp.user.email, 'verified@example.com')
  assert.equal(loginDashboard({ email: 'verified@example.com', password: 'password123' }, storePath).user.id, signedUp.user.id)
})
