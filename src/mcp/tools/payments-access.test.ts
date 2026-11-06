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
import accountModule from './account.js'
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

test('worker access check pauses past-due owned automation', () => {
  const accessPath = testPath('worker-access')
  const automationPath = testPath('worker-automation')
  process.env.AGNT_ACCESS_STORE_PATH = accessPath

  const user = createUser({}, accessPath)
  const key = createApiKey(user.id, 'worker', accessPath, 'agnt_live_worker')
  upsertSubscription({ userId: user.id, plan: 'pro', status: 'past_due', provider: 'manual' }, accessPath)

  const auto = createAutomation({
    type: 'price_alert',
    name: 'Owned price alert',
    userId: user.id,
    createdByApiKeyId: key.record.id,
    planAtCreation: 'pro',
    params: { token: 'ETH', condition: 'above', price: 5000 },
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

test('account register explains dashboard account creation owns API keys', async () => {
  const accessPath = testPath('account-no-register')
  await withAccessPathAsync(accessPath, async () => {
    const result = await accountModule.handle('account', { action: 'register', email: 'new@example.com' })
    const output = result?.content[0].text || ''
    const store = loadAccessStore(accessPath)

    assert.equal(toolIsError(result), true)
    assert.match(output, /AGENT dashboard/i)
    assert.match(output, /API keys/i)
    assert.match(output, /connector URLs/i)
    assert.equal(store.users.length, 0)
    assert.equal(store.apiKeys.length, 0)
  })
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
      action: { kind: 'notify' },
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
    assert.match(output, /Access: account authenticated/i)
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
