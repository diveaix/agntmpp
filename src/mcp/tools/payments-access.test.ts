import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'crypto'
import {
  createCustomSource,
  createApiKey,
  createDashboardSession,
  createUser,
  deleteApiKeyForUser,
  deleteCustomSource,
  hashApiKey,
  listApiKeysForUser,
  listCustomSources,
  loadAccessStore,
  revealApiKey,
  resolveAuthContextForUser,
  resolveAuthContextFromApiKey,
  saveAccessStore,
  upsertSubscription,
} from '../access-store.js'
import { canRunOwnedAutomation, verifyStripeSignature } from '../access-control.js'
import { createAutomation, loadAutomations } from '../scheduler.js'
import automationsModule, { setAutomationReadinessProbeForTests } from './automations.js'
import billingModule from './billing.js'
import accountModule from './account.js'
import {
  applyCryptoAccessPayment,
  createCryptoAccessQuote,
  type CryptoPaymentVerifier,
} from '../crypto-access.js'
import {
  confirmPublicCryptoCheckout,
  createPublicCryptoCheckoutQuote,
  formatPublicCheckoutQuoteResponse,
} from '../public-checkout.js'
import {
  logoutDashboardSession,
  loginDashboard,
  resetDashboardPassword,
  resolveDashboardSession,
  signupDashboard,
  startEmailLogin,
  verifyEmailLogin,
} from '../dashboard-auth.js'
import { deriveSourceState } from '../automation-source-manager.js'
import { OnChainErc20PaymentVerifier, type Erc20PaymentVerifierClient } from '../crypto-payment-verifier.js'

function testPath(name: string): string {
  return `./.agnt/test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.enc`
}

function toolIsError(result: unknown): boolean | undefined {
  return result && typeof result === 'object' && 'isError' in result
    ? (result as { isError?: boolean }).isError
    : undefined
}

function withAccessPath<T>(path: string, fn: () => T): T {
  const previous = process.env.AGNT_ACCESS_STORE_PATH
  process.env.AGNT_ACCESS_STORE_PATH = path
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.AGNT_ACCESS_STORE_PATH
    else process.env.AGNT_ACCESS_STORE_PATH = previous
  }
}

async function withAccessPathAsync<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGNT_ACCESS_STORE_PATH
  process.env.AGNT_ACCESS_STORE_PATH = path
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.AGNT_ACCESS_STORE_PATH
    else process.env.AGNT_ACCESS_STORE_PATH = previous
  }
}

function createVerifiedCheckoutUser(path: string, email = 'buyer@example.com') {
  const user = createUser({ email }, path)
  return { email, verifiedUserId: user.id, user }
}

test('API keys are hashed and resolve the server-side subscription plan', () => {
  const path = testPath('access-key')
  const user = createUser({ email: 'pro@example.com' }, path)
  upsertSubscription({ userId: user.id, plan: 'pro', status: 'active', provider: 'manual' }, path)
  const created = createApiKey(user.id, 'test', path, 'agnt_live_test_secret')

  const store = loadAccessStore(path)
  assert.equal(store.apiKeys[0].keyHash, hashApiKey('agnt_live_test_secret'))
  assert.notEqual(store.apiKeys[0].keyHash, 'agnt_live_test_secret')
  assert.equal(created.record.prefix, 'agnt_live_test')

  const auth = resolveAuthContextFromApiKey('agnt_live_test_secret', path)
  assert.equal(auth?.userId, user.id)
  assert.equal(auth?.plan, 'pro')
  assert.equal(auth?.entitlement.dataAutomationSlots, 5)
})

test('API keys are linked to email accounts and can be revealed only by their owner', () => {
  const path = testPath('key-reveal')
  const user = createUser({ email: 'keys-owner@example.com' }, path)
  const other = createUser({ email: 'keys-other@example.com' }, path)
  const created = createApiKey(user.id, 'dashboard', path, 'agnt_live_dashboard_secret')

  const keys = listApiKeysForUser(user.id, path)
  assert.equal(keys.length, 1)
  assert.equal(keys[0].id, created.record.id)
  assert.equal(keys[0].label, 'dashboard')
  assert.equal(keys[0].canReveal, true)
  assert.equal(keys[0].ownerEmail, 'keys-owner@example.com')

  assert.equal(revealApiKey(user.id, created.record.id, path), 'agnt_live_dashboard_secret')
  assert.equal(revealApiKey(other.id, created.record.id, path), null)
})

test('dashboard API key removal deletes the key record and authentication stops', () => {
  const path = testPath('key-delete')
  const user = createUser({ email: 'delete-key@example.com' }, path)
  const created = createApiKey(user.id, 'dashboard', path, 'agnt_live_delete_secret')

  assert.equal(deleteApiKeyForUser(user.id, created.record.id, path), true)
  assert.equal(resolveAuthContextFromApiKey('agnt_live_delete_secret', path), null)
  assert.equal(listApiKeysForUser(user.id, path).length, 0)
  assert.equal(deleteApiKeyForUser(user.id, created.record.id, path), false)
})

test('users can have only two active API keys at a time', () => {
  const path = testPath('key-limit')
  const user = createUser({ email: 'limit-key@example.com' }, path)
  const first = createApiKey(user.id, 'first', path, 'agnt_live_limit_first')
  createApiKey(user.id, 'second', path, 'agnt_live_limit_second')

  assert.throws(() => createApiKey(user.id, 'third', path, 'agnt_live_limit_third'), /2 active API keys/i)

  assert.equal(deleteApiKeyForUser(user.id, first.record.id, path), true)
  const replacement = createApiKey(user.id, 'replacement', path, 'agnt_live_limit_replacement')
  assert.equal(resolveAuthContextFromApiKey(replacement.apiKey, path)?.userId, user.id)
})

test('older hash-only API keys remain valid but cannot be revealed in dashboard', () => {
  const path = testPath('key-reveal-legacy')
  const user = createUser({ email: 'legacy@example.com' }, path)
  const created = createApiKey(user.id, 'legacy', path, 'agnt_live_legacy_secret')
  const store = loadAccessStore(path)
  delete store.apiKeys[0].keyCiphertext
  saveAccessStore(store, path)

  assert.equal(resolveAuthContextFromApiKey('agnt_live_legacy_secret', path)?.userId, user.id)
  assert.equal(revealApiKey(user.id, created.record.id, path), null)
})

test('email login requires the right code and creates a dashboard session', () => {
  const path = testPath('email-login')
  const user = createUser({ email: 'dive.aix@gmail.com' }, path)
  upsertSubscription({ userId: user.id, plan: 'pro', status: 'active', provider: 'crypto' }, path)
  const started = startEmailLogin('DIVE.AIX@GMAIL.COM', path)
  assert.equal(started.email, 'dive.aix@gmail.com')
  assert.ok(started.devCode)

  assert.throws(() => verifyEmailLogin({ email: 'dive.aix@gmail.com', code: '000000' }, path), /not correct/i)

  const verified = verifyEmailLogin({ email: 'dive.aix@gmail.com', code: started.devCode }, path)
  assert.equal(verified.user.email, 'dive.aix@gmail.com')
  assert.ok(verified.sessionToken)
  assert.equal(resolveDashboardSession(verified.sessionToken, path)?.user.id, verified.user.id)

  logoutDashboardSession(verified.sessionToken, path)
  assert.equal(resolveDashboardSession(verified.sessionToken, path), null)
})

test('dashboard signup sets account password', () => {
  const path = testPath('password-signup')
  const signedUp = signupDashboard({ email: 'password@example.com', password: 'password123' }, path)
  assert.equal(signedUp.user.email, 'password@example.com')
  assert.equal(signedUp.auth.plan, 'free')
  assert.throws(() => signupDashboard({ email: 'password@example.com', password: 'another-password' }, path), /already has a dashboard password/i)

  const loggedIn = loginDashboard({ email: 'password@example.com', password: 'password123' }, path)
  assert.equal(loggedIn.user.id, signedUp.user.id)
  assert.equal(resolveDashboardSession(loggedIn.sessionToken, path)?.user.id, signedUp.user.id)
  assert.throws(() => loginDashboard({ email: 'password@example.com', password: 'wrong-password' }, path), /not correct/i)
})

test('dashboard password reset uses a temporary one-time email code', () => {
  const path = testPath('password-reset')
  const user = createUser({ email: 'legacy-reset@example.com' }, path)

  const started = startEmailLogin('legacy-reset@example.com', path)
  const reset = resetDashboardPassword({
    email: 'legacy-reset@example.com',
    code: started.devCode!,
    password: 'new-password-123',
  }, path)

  assert.equal(reset.user.id, user.id)
  assert.equal(loginDashboard({ email: 'legacy-reset@example.com', password: 'new-password-123' }, path).user.id, user.id)
  assert.throws(() => resetDashboardPassword({
    email: 'legacy-reset@example.com',
    code: started.devCode!,
    password: 'another-password-123',
  }, path), /expired/i)
})

test('dashboard password reset does not create accounts for unknown emails', () => {
  const path = testPath('password-reset-unknown')
  const started = startEmailLogin('unknown-reset@example.com', path)

  assert.throws(() => resetDashboardPassword({
    email: 'unknown-reset@example.com',
    code: started.devCode!,
    password: 'new-password-123',
  }, path), /No dashboard account/i)
})

test('email login allows free dashboard access without upgrading plan', () => {
  const path = testPath('email-login-unpaid')
  const startedNew = startEmailLogin('free@example.com', path)
  assert.equal(startedNew.email, 'free@example.com')
  const verifiedNew = verifyEmailLogin({ email: 'free@example.com', code: startedNew.devCode! }, path)
  assert.equal(verifiedNew.auth.plan, 'free')

  const user = createUser({ email: 'existing-free@example.com' }, path)
  upsertSubscription({ userId: user.id, plan: 'free', status: 'active', provider: 'manual' }, path)
  const startedExisting = startEmailLogin('existing-free@example.com', path)
  const verifiedExisting = verifyEmailLogin({ email: 'existing-free@example.com', code: startedExisting.devCode! }, path)
  assert.equal(verifiedExisting.user.id, user.id)
  assert.equal(verifiedExisting.auth.plan, 'free')
})

test('existing free dashboard sessions restore as free dashboard sessions', () => {
  const path = testPath('email-login-free-restore')
  const user = createUser({ email: 'restore-free@example.com' }, path)
  const sessionToken = 'agnt_sess_existing_free'
  const tokenHash = createHash('sha256').update(sessionToken, 'utf8').digest('hex')
  createDashboardSession(user.id, tokenHash, new Date(Date.now() + 60_000).toISOString(), path)

  const restored = resolveDashboardSession(sessionToken, path)
  assert.equal(restored?.user.id, user.id)
  assert.equal(restored?.auth.plan, 'free')
})

test('expired email login codes cannot create dashboard sessions', () => {
  const path = testPath('email-expired')
  const user = createUser({ email: 'old@example.com' }, path)
  upsertSubscription({ userId: user.id, plan: 'pro', status: 'active', provider: 'crypto' }, path)
  const started = startEmailLogin('old@example.com', path, { now: 1_000, ttlMs: 1_000 })
  assert.ok(started.devCode)
  assert.throws(() => verifyEmailLogin({ email: 'old@example.com', code: started.devCode!, now: 3_000 }, path), /expired/i)
})

test('expired subscriptions resolve to free access', () => {
  const path = testPath('expired')
  const user = createUser({}, path)
  createApiKey(user.id, 'expired', path, 'agnt_live_expired')
  upsertSubscription({ userId: user.id, plan: 'max', status: 'expired', provider: 'manual' }, path)

  const auth = resolveAuthContextFromApiKey('agnt_live_expired', path)
  assert.equal(auth?.plan, 'free')
  assert.equal(auth?.entitlement.autoExecuteAllowed, false)
})

test('authenticated free users cannot spoof max plan for auto-execute event automation', async () => {
  const accessPath = testPath('spoof-access')
  const automationPath = testPath('spoof-automation')
  process.env.AGNT_AUTOMATIONS_PATH = automationPath

  const user = createUser({}, accessPath)
  createApiKey(user.id, 'free', accessPath, 'agnt_live_free')
  const auth = resolveAuthContextFromApiKey('agnt_live_free', accessPath)!

  const result = await automationsModule.handle('automations', {
    action: 'create_event',
    plan: 'max',
    topic: 'iran_israel_conflict',
    eventType: 'military_attack',
    actor: 'Iran',
    target: 'Israel',
    protocol: 'polymarket',
    marketId: 'm1',
    side: 'YES',
    maxSpend: 10,
    maxPrice: 0.65,
    mode: 'auto_execute',
    validFor: '1h',
  }, auth)

  const output = result?.content[0].text || ''
  assert.equal(result?.isError, true)
  assert.match(output, /free plan does not allow auto-execute/i)
})

test('owner-specific data automation slots are enforced from auth context', async () => {
  const accessPath = testPath('slots-access')
  const automationPath = testPath('slots-automation')
  process.env.AGNT_AUTOMATIONS_PATH = automationPath

  const user = createUser({}, accessPath)
  createApiKey(user.id, 'free', accessPath, 'agnt_live_slots')
  const auth = resolveAuthContextFromApiKey('agnt_live_slots', accessPath)!

  setAutomationReadinessProbeForTests(async () => ({ allowed: true }))
  try {
    const first = await automationsModule.handle('automations', {
      action: 'create_event',
      topic: 'iran_israel_conflict',
      eventType: 'military_attack',
      actor: 'Iran',
      target: 'Israel',
      protocol: 'polymarket',
      marketId: 'm1',
      side: 'YES',
      maxSpend: 10,
      maxPrice: 0.65,
      mode: 'notify_only',
      validFor: '1h',
    }, auth)
    assert.equal(first?.isError, undefined)

    const second = await automationsModule.handle('automations', {
      action: 'create_event',
      plan: 'max',
      topic: 'iran_israel_conflict',
      eventType: 'military_attack',
      actor: 'Iran',
      target: 'Israel',
      protocol: 'polymarket',
      marketId: 'm2',
      side: 'YES',
      maxSpend: 10,
      maxPrice: 0.65,
      mode: 'notify_only',
      validFor: '1h',
    }, auth)

    assert.equal(second?.isError, true)
    assert.match(second?.content[0].text || '', /free plan allows 1 data automation/i)
  } finally {
    setAutomationReadinessProbeForTests(null)
  }
})

test('automation list is filtered by authenticated owner', async () => {
  const accessPath = testPath('owner-access')
  const automationPath = testPath('owner-automation')
  process.env.AGNT_AUTOMATIONS_PATH = automationPath

  const userA = createUser({}, accessPath)
  const userB = createUser({}, accessPath)
  createApiKey(userA.id, 'a', accessPath, 'agnt_live_owner_a')
  createApiKey(userB.id, 'b', accessPath, 'agnt_live_owner_b')
  const authA = resolveAuthContextFromApiKey('agnt_live_owner_a', accessPath)!
  const authB = resolveAuthContextFromApiKey('agnt_live_owner_b', accessPath)!

  setAutomationReadinessProbeForTests(async () => ({ allowed: true }))
  try {
    await automationsModule.handle('automations', {
      action: 'create_event',
      topic: 'iran_israel_conflict',
      eventType: 'military_attack',
      actor: 'Iran',
      target: 'Israel',
      protocol: 'polymarket',
      marketId: 'market-a',
      side: 'YES',
      maxSpend: 10,
      maxPrice: 0.65,
      mode: 'notify_only',
      validFor: '1h',
      name: 'Owner A automation',
    }, authA)
    await automationsModule.handle('automations', {
      action: 'create_event',
      topic: 'iran_israel_conflict',
      eventType: 'military_attack',
      actor: 'Iran',
      target: 'Israel',
      protocol: 'polymarket',
      marketId: 'market-b',
      side: 'YES',
      maxSpend: 10,
      maxPrice: 0.65,
      mode: 'notify_only',
      validFor: '1h',
      name: 'Owner B automation',
    }, authB)

    const listA = await automationsModule.handle('automations', { action: 'list' }, authA)
    const output = listA?.content[0].text || ''
    assert.match(output, /Owner A automation/)
    assert.doesNotMatch(output, /Owner B automation/)
  } finally {
    setAutomationReadinessProbeForTests(null)
  }
})

test('worker access check pauses past-due owned automation', () => {
  const accessPath = testPath('worker-access')
  const automationPath = testPath('worker-automation')
  process.env.AGNT_ACCESS_STORE_PATH = accessPath

  const user = createUser({}, accessPath)
  const key = createApiKey(user.id, 'worker', accessPath, 'agnt_live_worker')
  upsertSubscription({ userId: user.id, plan: 'pro', status: 'past_due', provider: 'manual' }, accessPath)

  const auto = createAutomation({
    type: 'dca',
    name: 'Owned DCA',
    userId: user.id,
    createdByApiKeyId: key.record.id,
    planAtCreation: 'pro',
    params: { tokenIn: 'USDC', tokenOut: 'ETH', amount: 1 },
    intervalMs: 60_000,
    maxRuns: 0,
    status: 'active',
  }, automationPath)

  const access = canRunOwnedAutomation(auto)
  assert.equal(access.allowed, false)
  assert.match(access.reason, /past due/i)
})

test('Stripe webhook signatures verify with the configured secret', () => {
  const raw = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }))
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = createHmac('sha256', 'whsec_test')
    .update(`${timestamp}.${raw.toString('utf8')}`)
    .digest('hex')

  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${signature}`, 'whsec_test'), true)
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=bad`, 'whsec_test'), false)
})

test('crypto access quote stores the exact payment terms for MPP checkout', () => {
  const accessPath = testPath('crypto-quote')
  process.env.AGNT_ACCESS_STORE_PATH = accessPath
  process.env.AGNT_RECIPIENT = '0x1111111111111111111111111111111111111111'
  process.env.AGNT_PAYMENT_CURRENCY = '0x20C000000000000000000000b9537d11c60E8b50'
  process.env.CRYPTO_ACCESS_PRO_USDC = '49'

  const user = createUser({}, accessPath)
  const quote = createCryptoAccessQuote({ userId: user.id, plan: 'pro', provider: 'mpp', months: 1 }, accessPath)
  const store = loadAccessStore(accessPath)

  assert.equal(quote.provider, 'mpp')
  assert.equal(quote.plan, 'pro')
  assert.equal(quote.amount, 49)
  assert.equal(quote.recipient, '0x1111111111111111111111111111111111111111')
  assert.equal(store.cryptoAccessIntents[0].id, quote.id)
  assert.equal(store.cryptoAccessIntents[0].status, 'pending')
})

test('crypto access payment refuses unverified transfer confirmations', async () => {
  const accessPath = testPath('crypto-unverified')
  process.env.AGNT_ACCESS_STORE_PATH = accessPath
  const user = createUser({}, accessPath)
  const quote = createCryptoAccessQuote({ userId: user.id, plan: 'pro', provider: 'crypto', months: 1 }, accessPath)
  const verifier: CryptoPaymentVerifier = {
    verify: async () => ({ verified: false, reason: 'transfer not found' }),
  }

  const result = await applyCryptoAccessPayment({
    quoteId: quote.id,
    userId: user.id,
    provider: 'crypto',
    txHash: '0xabc',
    payer: '0x2222222222222222222222222222222222222222',
  }, verifier, accessPath)

  assert.equal(result.applied, false)
  assert.match(result.reason, /transfer not found/i)
  assert.equal(resolveAuthContextForUser(user.id, 'manual', accessPath)?.plan, 'free')
})

test('crypto access payment keeps quote pending while confirmations are still arriving', async () => {
  const accessPath = testPath('crypto-pending-confirmations')
  process.env.AGNT_ACCESS_STORE_PATH = accessPath
  const user = createUser({}, accessPath)
  const quote = createCryptoAccessQuote({ userId: user.id, plan: 'pro', provider: 'crypto', months: 1 }, accessPath)
  const verifier: CryptoPaymentVerifier = {
    verify: async () => ({ verified: false, reason: 'Transaction has 0 confirmation(s); 2 required.' }),
  }

  const result = await applyCryptoAccessPayment({
    quoteId: quote.id,
    userId: user.id,
    provider: 'crypto',
    txHash: '0xwaiting',
    payer: '0x2222222222222222222222222222222222222222',
  }, verifier, accessPath)
  const store = loadAccessStore(accessPath)

  assert.equal(result.applied, false)
  assert.match(result.reason, /confirmation/i)
  assert.equal(store.cryptoAccessIntents.find((intent) => intent.id === quote.id)?.status, 'pending')
})


test('verified MPP payment activates subscription and is idempotent by tx hash', async () => {
  const accessPath = testPath('crypto-verified')
  process.env.AGNT_ACCESS_STORE_PATH = accessPath
  const user = createUser({}, accessPath)
  const quote = createCryptoAccessQuote({ userId: user.id, plan: 'max', provider: 'mpp', months: 1 }, accessPath)
  const verifier: CryptoPaymentVerifier = {
    verify: async ({ expectedAmount, expectedCurrency }) => ({
      verified: true,
      amount: expectedAmount,
      currency: expectedCurrency,
      reason: 'verified test payment',
    }),
  }

  const first = await applyCryptoAccessPayment({
    quoteId: quote.id,
    userId: user.id,
    provider: 'mpp',
    txHash: '0xpaid',
    payer: '0x3333333333333333333333333333333333333333',
  }, verifier, accessPath)
  const second = await applyCryptoAccessPayment({
    quoteId: quote.id,
    userId: user.id,
    provider: 'mpp',
    txHash: '0xpaid',
    payer: '0x3333333333333333333333333333333333333333',
  }, verifier, accessPath)

  const auth = resolveAuthContextForUser(user.id, 'manual', accessPath)
  const store = loadAccessStore(accessPath)

  assert.equal(first.applied, true)
  assert.equal(second.applied, false)
  assert.match(second.reason, /already processed/i)
  assert.equal(auth?.plan, 'max')
  assert.equal(auth?.entitlement.priorityQueue, true)
  assert.equal(store.payments.filter((payment) => payment.txHash === '0xpaid').length, 1)
})

test('billing tool exposes plain-English plan details and website checkout steps', async () => {
  const result = await billingModule.handle('billing', { action: 'plans' })
  const output = result?.content[0].text || ''

  assert.match(output, /Free/i)
  assert.match(output, /Pro/i)
  assert.match(output, /Ultra/i)
  assert.match(output, /How to get access/i)
  assert.match(output, /website/i)
  assert.match(output, /\/plans/i)
  assert.match(output, /API key/i)
  assert.match(output, /MPP/i)
})

test('billing tool creates crypto quote for authenticated users', async () => {
  const accessPath = testPath('billing-quote')
  process.env.AGNT_ACCESS_STORE_PATH = accessPath
  process.env.AGNT_RECIPIENT = '0x4444444444444444444444444444444444444444'

  const user = createUser({}, accessPath)
  createApiKey(user.id, 'billing', accessPath, 'agnt_live_billing')
  const auth = resolveAuthContextFromApiKey('agnt_live_billing', accessPath)!
  const result = await billingModule.handle('billing', { action: 'crypto_quote', plan: 'pro', provider: 'mpp' }, auth)
  const output = result?.content[0].text || ''

  assert.equal(result && 'isError' in result ? result.isError : undefined, undefined)
  assert.match(output, /Payment quote/i)
  assert.match(output, /Pro/i)
  assert.match(output, /0x4444444444444444444444444444444444444444/)
  assert.match(output, /billing action="crypto_confirm"/i)
})

test('billing tool confirms crypto payment and activates access after verifier approval', async () => {
  const accessPath = testPath('billing-confirm')
  const previousAccessPath = process.env.AGNT_ACCESS_STORE_PATH
  const previousTrusted = process.env.CRYPTO_ACCESS_TRUSTED_CONFIRMATIONS
  process.env.AGNT_ACCESS_STORE_PATH = accessPath
  process.env.CRYPTO_ACCESS_TRUSTED_CONFIRMATIONS = 'true'
  process.env.AGNT_RECIPIENT = '0x5555555555555555555555555555555555555555'

  try {
    const user = createUser({}, accessPath)
    createApiKey(user.id, 'billing-confirm', accessPath, 'agnt_live_billing_confirm')
    const auth = resolveAuthContextFromApiKey('agnt_live_billing_confirm', accessPath)!
    const quoteResult = await billingModule.handle('billing', { action: 'crypto_quote', plan: 'pro', provider: 'mpp' }, auth)
    const quoteText = quoteResult?.content[0].text || ''
    const quoteId = quoteText.match(/Quote ID: (crypto_[a-f0-9]+)/)?.[1]
    assert.ok(quoteId)

    const confirmResult = await billingModule.handle('billing', {
      action: 'crypto_confirm',
      quoteId,
      provider: 'mpp',
      txHash: '0xconfirmed',
      payer: '0x6666666666666666666666666666666666666666',
    }, auth)

    const output = confirmResult?.content[0].text || ''
    const updatedAuth = resolveAuthContextForUser(user.id, 'manual', accessPath)
    assert.equal(confirmResult && 'isError' in confirmResult ? confirmResult.isError : undefined, undefined)
    assert.match(output, /Access activated/i)
    assert.equal(updatedAuth?.plan, 'pro')
  } finally {
    if (previousAccessPath === undefined) delete process.env.AGNT_ACCESS_STORE_PATH
    else process.env.AGNT_ACCESS_STORE_PATH = previousAccessPath
    if (previousTrusted === undefined) delete process.env.CRYPTO_ACCESS_TRUSTED_CONFIRMATIONS
    else process.env.CRYPTO_ACCESS_TRUSTED_CONFIRMATIONS = previousTrusted
  }
})

test('on-chain verifier accepts ERC-20 transfer that matches quote terms', async () => {
  const token = '0x20C000000000000000000000b9537d11c60E8b50'
  const recipient = '0x1111111111111111111111111111111111111111'
  const payer = '0x2222222222222222222222222222222222222222'
  const client: Erc20PaymentVerifierClient = {
    chainId: 6342,
    getBlockNumber: async () => 110n,
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 109n,
      logs: [{
        address: token,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          `0x000000000000000000000000${payer.slice(2).toLowerCase()}`,
          `0x000000000000000000000000${recipient.slice(2).toLowerCase()}`,
        ],
        data: '0x0000000000000000000000000000000000000000000000000000000002faf080',
      }],
    }),
  }

  const verifier = new OnChainErc20PaymentVerifier({ client, decimals: 6, minConfirmations: 2 })
  const result = await verifier.verify({
    quoteId: 'quote',
    provider: 'crypto',
    txHash: '0xpaid',
    payer,
    expectedAmount: 50,
    expectedCurrency: token,
    expectedRecipient: recipient,
    expectedChainId: 6342,
  })

  assert.equal(result.verified, true)
  assert.equal(result.amount, 50)
  assert.equal(result.currency, token)
})

test('on-chain verifier rejects wrong recipient or low amount', async () => {
  const token = '0x20C000000000000000000000b9537d11c60E8b50'
  const recipient = '0x1111111111111111111111111111111111111111'
  const wrongRecipient = '0x9999999999999999999999999999999999999999'
  const payer = '0x2222222222222222222222222222222222222222'
  const client: Erc20PaymentVerifierClient = {
    chainId: 6342,
    getBlockNumber: async () => 110n,
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      logs: [{
        address: token,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          `0x000000000000000000000000${payer.slice(2).toLowerCase()}`,
          `0x000000000000000000000000${wrongRecipient.slice(2).toLowerCase()}`,
        ],
        data: '0x00000000000000000000000000000000000000000000000000000000000f4240',
      }],
    }),
  }

  const verifier = new OnChainErc20PaymentVerifier({ client, decimals: 6, minConfirmations: 1 })
  const result = await verifier.verify({
    quoteId: 'quote',
    provider: 'crypto',
    txHash: '0xpaid',
    payer,
    expectedAmount: 50,
    expectedCurrency: token,
    expectedRecipient: recipient,
    expectedChainId: 6342,
  })

  assert.equal(result.verified, false)
  assert.match(result.reason, /matching ERC-20 transfer/i)
})

test('on-chain verifier rejects insufficient confirmations and wrong chain', async () => {
  const token = '0x20C000000000000000000000b9537d11c60E8b50'
  const recipient = '0x1111111111111111111111111111111111111111'
  const payer = '0x2222222222222222222222222222222222222222'
  const client: Erc20PaymentVerifierClient = {
    chainId: 6342,
    getBlockNumber: async () => 100n,
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      logs: [{
        address: token,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          `0x000000000000000000000000${payer.slice(2).toLowerCase()}`,
          `0x000000000000000000000000${recipient.slice(2).toLowerCase()}`,
        ],
        data: '0x0000000000000000000000000000000000000000000000000000000002faf080',
      }],
    }),
  }

  const verifier = new OnChainErc20PaymentVerifier({ client, decimals: 6, minConfirmations: 2 })
  const unconfirmed = await verifier.verify({
    quoteId: 'quote',
    provider: 'crypto',
    txHash: '0xpaid',
    payer,
    expectedAmount: 50,
    expectedCurrency: token,
    expectedRecipient: recipient,
    expectedChainId: 6342,
  })
  const wrongChain = await verifier.verify({
    quoteId: 'quote',
    provider: 'crypto',
    txHash: '0xpaid',
    payer,
    expectedAmount: 50,
    expectedCurrency: token,
    expectedRecipient: recipient,
    expectedChainId: 10,
  })

  assert.equal(unconfirmed.verified, false)
  assert.match(unconfirmed.reason, /confirmation/i)
  assert.equal(wrongChain.verified, false)
  assert.match(wrongChain.reason, /chain/i)
})

test('account register explains dashboard account creation owns API keys', async () => {
  const accessPath = testPath('account-no-register')
  await withAccessPathAsync(accessPath, async () => {
    const result = await accountModule.handle('account', { action: 'register', email: 'new@example.com' })
    const output = result?.content[0].text || ''
    const store = loadAccessStore(accessPath)

    assert.equal(toolIsError(result), true)
    assert.match(output, /AGNT dashboard/i)
    assert.match(output, /API keys/i)
    assert.match(output, /connector URLs/i)
    assert.equal(store.users.length, 0)
    assert.equal(store.apiKeys.length, 0)
  })
})

test('public checkout refuses to create a paid quote before email verification', () => {
  const accessPath = testPath('public-checkout-unverified')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  try {
    assert.throws(() => createPublicCryptoCheckoutQuote({
      email: 'buyer@example.com',
      walletAddress: '0x8888888888888888888888888888888888888888',
      plan: 'pro',
      provider: 'mpp',
    }, accessPath), /confirm your email/i)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('public checkout creates a paid quote after email verification before the user has an API key', () => {
  const accessPath = testPath('public-checkout-quote')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  try {
    const verified = createVerifiedCheckoutUser(accessPath, 'buyer@example.com')
    const checkout = createPublicCryptoCheckoutQuote({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      walletAddress: '0x8888888888888888888888888888888888888888',
      plan: 'pro',
      provider: 'mpp',
    }, accessPath)
    const store = loadAccessStore(accessPath)

    assert.equal(checkout.quote.plan, 'pro')
    assert.equal(checkout.quote.recipient, '0x7777777777777777777777777777777777777777')
    assert.equal(checkout.user.email, 'buyer@example.com')
    assert.equal(store.users.length, 1)
    assert.equal(store.apiKeys.length, 0)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('public checkout refuses to create paid quote without a real recipient', () => {
  const accessPath = testPath('public-checkout-recipient')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = ''
  try {
    const verified = createVerifiedCheckoutUser(accessPath, 'buyer@example.com')
    assert.throws(() => createPublicCryptoCheckoutQuote({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      plan: 'pro',
      provider: 'mpp',
    }, accessPath), /AGNT_RECIPIENT/i)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('public checkout quote response includes wallet-ready transfer fields', () => {
  const accessPath = testPath('public-checkout-wallet-fields')
  const previousRecipient = process.env.AGNT_RECIPIENT
  const previousDecimals = process.env.CRYPTO_ACCESS_TOKEN_DECIMALS
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  process.env.CRYPTO_ACCESS_TOKEN_DECIMALS = '6'
  try {
    const verified = createVerifiedCheckoutUser(accessPath, 'wallet@example.com')
    const checkout = createPublicCryptoCheckoutQuote({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      plan: 'pro',
      provider: 'mpp',
    }, accessPath)
    const response = formatPublicCheckoutQuoteResponse(checkout.quote)

    assert.equal(response.quoteId, checkout.quote.id)
    assert.equal(response.tokenDecimals, 6)
    assert.equal(response.amountUnits, '49000000')
    assert.equal(response.recipient, '0x7777777777777777777777777777777777777777')
    assert.equal(response.currency, checkout.quote.currency)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
    if (previousDecimals === undefined) delete process.env.CRYPTO_ACCESS_TOKEN_DECIMALS
    else process.env.CRYPTO_ACCESS_TOKEN_DECIMALS = previousDecimals
  }
})

test('public checkout can create a quote on Base USDC', () => {
  const accessPath = testPath('public-checkout-base')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  try {
    const verified = createVerifiedCheckoutUser(accessPath, 'base@example.com')
    const checkout = createPublicCryptoCheckoutQuote({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      plan: 'pro',
      provider: 'mpp',
      paymentNetwork: 'base',
    }, accessPath)
    const response = formatPublicCheckoutQuoteResponse(checkout.quote)

    assert.equal(response.network, 'base')
    assert.equal(response.chainId, 8453)
    assert.equal(response.currency.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    assert.equal(response.amountUnits, '49000000')
    assert.equal(response.rpcUrl, 'https://mainnet.base.org')
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('public checkout rejects Solana until SPL verification is implemented', () => {
  const accessPath = testPath('public-checkout-solana')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  try {
    const verified = createVerifiedCheckoutUser(accessPath, 'solana@example.com')
    assert.throws(() => createPublicCryptoCheckoutQuote({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      plan: 'pro',
      provider: 'mpp',
      paymentNetwork: 'solana',
    }, accessPath), /Solana payments/i)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('public checkout confirmation verifies payment and returns the API key once', async () => {
  const accessPath = testPath('public-checkout-confirm')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  const verifier: CryptoPaymentVerifier = {
    verify: async ({ expectedAmount, expectedCurrency }) => ({
      verified: true,
      amount: expectedAmount,
      currency: expectedCurrency,
      reason: 'verified test payment',
    }),
  }

  try {
    const verified = createVerifiedCheckoutUser(accessPath, 'paid@example.com')
    const checkout = createPublicCryptoCheckoutQuote({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      plan: 'max',
      provider: 'mpp',
    }, accessPath)
    const confirmed = await confirmPublicCryptoCheckout({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      quoteId: checkout.quote.id,
      provider: 'mpp',
      txHash: '0xpublicpaid',
      payer: '0x9999999999999999999999999999999999999999',
    }, verifier, accessPath)
    const second = await confirmPublicCryptoCheckout({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      quoteId: checkout.quote.id,
      provider: 'mpp',
      txHash: '0xpublicpaid',
    }, verifier, accessPath)

    assert.equal(confirmed.applied, true)
    assert.ok(confirmed.apiKey)
    assert.equal(resolveAuthContextFromApiKey(confirmed.apiKey, accessPath)?.plan, 'max')
    assert.equal(second.applied, false)
    assert.equal(second.apiKey, undefined)
    assert.match(second.reason, /already processed|already paid/i)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('public checkout activates access without minting a third active API key', async () => {
  const accessPath = testPath('public-checkout-key-limit')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  const verifier: CryptoPaymentVerifier = {
    verify: async ({ expectedAmount, expectedCurrency }) => ({
      verified: true,
      amount: expectedAmount,
      currency: expectedCurrency,
      reason: 'verified test payment',
    }),
  }

  try {
    const verified = createVerifiedCheckoutUser(accessPath, 'paid-limit@example.com')
    createApiKey(verified.user.id, 'first', accessPath, 'agnt_live_paid_limit_first')
    createApiKey(verified.user.id, 'second', accessPath, 'agnt_live_paid_limit_second')
    const checkout = createPublicCryptoCheckoutQuote({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      plan: 'pro',
      provider: 'mpp',
    }, accessPath)
    const confirmed = await confirmPublicCryptoCheckout({
      email: verified.email,
      verifiedUserId: verified.verifiedUserId,
      quoteId: checkout.quote.id,
      provider: 'mpp',
      txHash: '0xpublicpaidlimit',
    }, verifier, accessPath)

    assert.equal(confirmed.applied, true)
    assert.equal(confirmed.apiKey, undefined)
    assert.match(confirmed.reason, /already has 2 active API keys/i)
    assert.equal(resolveAuthContextForUser(verified.user.id, 'manual', accessPath)?.plan, 'pro')
    assert.equal(listApiKeysForUser(verified.user.id, accessPath).filter((key) => !key.revokedAt).length, 2)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('public checkout refuses to confirm a quote for another email', async () => {
  const accessPath = testPath('public-checkout-email')
  const previousRecipient = process.env.AGNT_RECIPIENT
  process.env.AGNT_RECIPIENT = '0x7777777777777777777777777777777777777777'
  const verifier: CryptoPaymentVerifier = {
    verify: async () => ({ verified: true, reason: 'should not run' }),
  }

  try {
    const owner = createVerifiedCheckoutUser(accessPath, 'owner@example.com')
    const attacker = createVerifiedCheckoutUser(accessPath, 'attacker@example.com')
    const checkout = createPublicCryptoCheckoutQuote({
      email: owner.email,
      verifiedUserId: owner.verifiedUserId,
      plan: 'pro',
      provider: 'mpp',
    }, accessPath)
    const result = await confirmPublicCryptoCheckout({
      email: attacker.email,
      verifiedUserId: attacker.verifiedUserId,
      quoteId: checkout.quote.id,
      provider: 'mpp',
      txHash: '0xwrongemail',
    }, verifier, accessPath)

    assert.equal(result.applied, false)
    assert.match(result.reason, /does not belong/i)
  } finally {
    if (previousRecipient === undefined) delete process.env.AGNT_RECIPIENT
    else process.env.AGNT_RECIPIENT = previousRecipient
  }
})

test('custom Twitter sources enforce plan limits and belong to the email account owner', () => {
  const path = testPath('custom-sources')
  const free = createUser({ email: 'free-sources@example.com' }, path)
  const pro = createUser({ email: 'pro-sources@example.com' }, path)
  upsertSubscription({ userId: pro.id, plan: 'pro', status: 'active', provider: 'manual' }, path)

  assert.throws(() => createCustomSource(free.id, {
    handle: '@WatcherGuru',
    topics: ['crypto_market'],
  }, path), /Free allows 0 custom sources/i)

  const source = createCustomSource(pro.id, {
    handle: '@WatcherGuru',
    displayName: 'Watcher Guru',
    topics: ['crypto_market'],
    keywords: ['bitcoin', 'ethereum'],
  }, path)

  assert.equal(source.handle, 'WatcherGuru')
  assert.equal(source.enabled, true)
  assert.equal(source.userId, pro.id)
  assert.equal(listCustomSources(pro.id, path).length, 1)
  assert.equal(listCustomSources(free.id, path).length, 0)
  assert.throws(() => createCustomSource(pro.id, { handle: 'watcherguru', topics: ['crypto_market'] }, path), /already/i)

  assert.equal(deleteCustomSource(pro.id, source.id, path), true)
  assert.equal(listCustomSources(pro.id, path).length, 0)
})

test('source manager merges enabled user custom sources for active automation topics', () => {
  const accessPath = testPath('source-merge-access')
  const user = createUser({ email: 'sources@example.com' }, accessPath)
  upsertSubscription({ userId: user.id, plan: 'pro', status: 'active', provider: 'manual' }, accessPath)
  createCustomSource(user.id, {
    handle: '@CustomIntel',
    topics: ['iran_israel_conflict'],
    keywords: ['iran', 'israel'],
  }, accessPath)
  createCustomSource(user.id, {
    handle: '@DisabledIntel',
    topics: ['iran_israel_conflict'],
    enabled: false,
  }, accessPath)

  const state = deriveSourceState([{
    id: 'auto-source-test',
    type: 'event_trigger',
    name: 'Iran Israel watch',
    userId: user.id,
    params: {
      trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack' },
      action: { protocol: 'polymarket', marketId: 'm1', side: 'YES', maxSpend: 10 },
      policy: {},
      mode: 'notify_only',
      validFor: '1h',
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    intervalMs: 0,
    maxRuns: 0,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    runCount: 0,
    history: [],
  }], accessPath)

  assert.ok(state.sources.some((source) => source.handle === 'Reuters'))
  assert.ok(state.sources.some((source) => source.handle === 'CustomIntel'))
  assert.equal(state.sources.some((source) => source.handle === 'DisabledIntel'), false)
  assert.ok(state.topicRules.find((rule) => rule.topic === 'iran_israel_conflict')?.sourceHandles.includes('CustomIntel'))
})

test('account me shows current plan and safe key list', async () => {
  const accessPath = testPath('account-me')
  await withAccessPathAsync(accessPath, async () => {
    const user = createUser({ email: 'me@example.com' }, accessPath)
    const rawKey = 'agnt_live_me_secret_value'
    const created = createApiKey(user.id, 'primary', accessPath, rawKey)
    const auth = resolveAuthContextFromApiKey(rawKey, accessPath)!
    const result = await accountModule.handle('account', { action: 'me' }, auth)
    const output = result?.content[0].text || ''
    assert.match(output, /Current plan: Free/i)
    assert.match(output, new RegExp(created.record.id))
    assert.match(output, /primary/)
    assert.doesNotMatch(output, /keyHash/i)
    assert.doesNotMatch(output, new RegExp(rawKey))
  })
})

test('account create_api_key returns a new key that can authenticate', async () => {
  const accessPath = testPath('account-create-key')
  await withAccessPathAsync(accessPath, async () => {
    const user = createUser({ email: 'keys@example.com' }, accessPath)
    createApiKey(user.id, 'primary', accessPath, 'agnt_live_primary')
    const auth = resolveAuthContextFromApiKey('agnt_live_primary', accessPath)!
    const result = await accountModule.handle('account', { action: 'create_api_key', label: 'laptop' }, auth)
    const output = result?.content[0].text || ''
    const apiKey = output.match(/AGNT_API_KEY=(agnt_live_[A-Za-z0-9_-]+)/)?.[1]
    assert.equal(toolIsError(result), undefined)
    assert.ok(apiKey)
    assert.equal(resolveAuthContextFromApiKey(apiKey, accessPath)?.userId, user.id)
  })
})

test('account revoke_api_key revokes only owned keys', async () => {
  const accessPath = testPath('account-revoke-key')
  await withAccessPathAsync(accessPath, async () => {
    const user = createUser({ email: 'revoke@example.com' }, accessPath)
    const other = createUser({ email: 'other@example.com' }, accessPath)
    createApiKey(user.id, 'primary', accessPath, 'agnt_live_revoke_primary')
    const second = createApiKey(user.id, 'secondary', accessPath, 'agnt_live_revoke_secondary')
    const otherKey = createApiKey(other.id, 'other', accessPath, 'agnt_live_other_key')
    const auth = resolveAuthContextFromApiKey('agnt_live_revoke_primary', accessPath)!

    const blocked = await accountModule.handle('account', { action: 'revoke_api_key', id: otherKey.record.id }, auth)
    const revoked = await accountModule.handle('account', { action: 'revoke_api_key', id: second.record.id }, auth)

    assert.equal(toolIsError(blocked), true)
    assert.match(blocked?.content[0].text || '', /not found/i)
    assert.equal(toolIsError(revoked), undefined)
    assert.equal(resolveAuthContextFromApiKey('agnt_live_revoke_secondary', accessPath), null)
    assert.equal(resolveAuthContextFromApiKey('agnt_live_revoke_primary', accessPath)?.userId, user.id)
  })
})
