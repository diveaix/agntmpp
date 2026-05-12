import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { encrypt, decrypt, getPassphrase } from './crypto.js'
import { getPlanEntitlement } from './automation-entitlements.js'
import type {
  AccessApiKey,
  AccessConnectorLink,
  AccessEntitlement,
  AccessPlan,
  AccessStore,
  AccessUser,
  ApiKeyCreationResult,
  AuthContext,
  CustomTwitterSource,
  DashboardSession,
  EmailVerificationCode,
  PaymentProvider,
  PaymentRecord,
  CryptoAccessIntent,
  SafeApiKey,
  SafeConnectorLink,
  SubscriptionRecord,
  SubscriptionStatus,
  UsageRecord,
} from './access-types.js'

const DEFAULT_ACCESS_STORE: AccessStore = {
  users: [],
  apiKeys: [],
  connectorLinks: [],
  subscriptions: [],
  usage: [],
  payments: [],
  cryptoAccessIntents: [],
  emailVerificationCodes: [],
  dashboardSessions: [],
  customSources: [],
  processedWebhookEventIds: [],
}

function nowIso(): string {
  return new Date().toISOString()
}

function cloneDefaultStore(): AccessStore {
  return {
    users: [],
    apiKeys: [],
    connectorLinks: [],
    subscriptions: [],
    usage: [],
    payments: [],
    cryptoAccessIntents: [],
    emailVerificationCodes: [],
    dashboardSessions: [],
    customSources: [],
    processedWebhookEventIds: [],
  }
}

function resolveAccessPath(custom?: string): string {
  const p = custom || process.env.AGNT_ACCESS_STORE_PATH || '.agnt/access.enc'
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 32).toString('hex')
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

export function generatePlainApiKey(kind: 'live' | 'test' = 'live'): string {
  return `agnt_${kind}_${randomBytes(24).toString('base64url')}`
}

export function generateConnectorToken(): string {
  return `agnt_conn_${randomBytes(24).toString('base64url')}`
}

export function loadAccessStore(custom?: string): AccessStore {
  const fp = resolveAccessPath(custom)
  if (!existsSync(fp)) return cloneDefaultStore()
  try {
    const raw = readFileSync(fp, 'utf-8')
    const parsed = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(decrypt(raw, getPassphrase()))
    return {
      ...DEFAULT_ACCESS_STORE,
      ...parsed,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [],
      connectorLinks: Array.isArray(parsed.connectorLinks) ? parsed.connectorLinks : [],
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
      usage: Array.isArray(parsed.usage) ? parsed.usage : [],
      payments: Array.isArray(parsed.payments) ? parsed.payments : [],
      cryptoAccessIntents: Array.isArray(parsed.cryptoAccessIntents) ? parsed.cryptoAccessIntents : [],
      emailVerificationCodes: Array.isArray(parsed.emailVerificationCodes) ? parsed.emailVerificationCodes : [],
      dashboardSessions: Array.isArray(parsed.dashboardSessions) ? parsed.dashboardSessions : [],
      customSources: Array.isArray(parsed.customSources) ? parsed.customSources : [],
      processedWebhookEventIds: Array.isArray(parsed.processedWebhookEventIds) ? parsed.processedWebhookEventIds : [],
    } as AccessStore
  } catch {
    return cloneDefaultStore()
  }
}

export function saveAccessStore(store: AccessStore, custom?: string): void {
  const fp = resolveAccessPath(custom)
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(fp, encrypt(JSON.stringify(store, null, 2), getPassphrase()), 'utf-8')
}

export function createUser(input: { email?: string; walletAddress?: string; status?: AccessUser['status'] } = {}, custom?: string): AccessUser {
  const store = loadAccessStore(custom)
  const timestamp = nowIso()
  const user: AccessUser = {
    id: generateId('usr'),
    email: input.email,
    walletAddress: input.walletAddress,
    status: input.status || 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  store.users.push(user)
  saveAccessStore(store, custom)
  return user
}

export function findUserByEmail(email: string | undefined, custom?: string): AccessUser | null {
  if (!email) return null
  const normalized = email.trim().toLowerCase()
  if (!normalized) return null
  const store = loadAccessStore(custom)
  return store.users.find((user) => user.email?.trim().toLowerCase() === normalized) || null
}

export function setUserPassword(userId: string, password: string, custom?: string): AccessUser {
  if (password.trim().length < 8) throw new Error('Password must be at least 8 characters.')
  const store = loadAccessStore(custom)
  const user = store.users.find((candidate) => candidate.id === userId && candidate.status === 'active')
  if (!user) throw new Error(`Active user "${userId}" not found.`)
  const salt = randomBytes(32).toString('hex')
  user.passwordSalt = salt
  user.passwordHash = hashPassword(password, salt)
  user.updatedAt = nowIso()
  saveAccessStore(store, custom)
  return user
}

export function userHasPassword(user: AccessUser | null | undefined): boolean {
  return Boolean(user?.passwordSalt && user.passwordHash)
}

export function verifyUserPassword(email: string | undefined, password: string, custom?: string): AccessUser | null {
  const user = findUserByEmail(email, custom)
  if (!user?.passwordSalt || !user.passwordHash) return null
  const expected = Buffer.from(user.passwordHash, 'hex')
  const actual = Buffer.from(hashPassword(password, user.passwordSalt), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return user
}

export function normalizeEmailAddress(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

export function createApiKey(userId: string, label = 'default', custom?: string, plainKey?: string): ApiKeyCreationResult {
  const store = loadAccessStore(custom)
  const user = store.users.find((u) => u.id === userId && u.status === 'active')
  if (!user) throw new Error(`Active user "${userId}" not found.`)
  const activeKeyCount = store.apiKeys.filter((key) => key.userId === userId && !key.revokedAt).length
  if (activeKeyCount >= 2) throw new Error('You can have only 2 active API keys at a time. Remove one before creating another.')

  const apiKey = plainKey || generatePlainApiKey()
  const record: AccessApiKey = {
    id: generateId('key'),
    userId,
    keyHash: hashApiKey(apiKey),
    keyCiphertext: encrypt(apiKey, getPassphrase()),
    prefix: apiKey.slice(0, 14),
    label,
    createdAt: nowIso(),
    lastUsedAt: null,
    revokedAt: null,
  }
  store.apiKeys.push(record)
  saveAccessStore(store, custom)
  return { apiKey, record }
}

export function listApiKeysForUser(userId: string, custom?: string): SafeApiKey[] {
  const store = loadAccessStore(custom)
  const user = store.users.find((candidate) => candidate.id === userId)
  return store.apiKeys
    .filter((key) => key.userId === userId)
    .map((key) => ({
      id: key.id,
      userId: key.userId,
      ownerEmail: user?.email,
      prefix: key.prefix,
      label: key.label,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
      canReveal: Boolean(key.keyCiphertext && !key.revokedAt),
    }))
}

export function revealApiKey(userId: string, apiKeyId: string, custom?: string): string | null {
  const store = loadAccessStore(custom)
  const key = store.apiKeys.find((candidate) => candidate.id === apiKeyId && candidate.userId === userId && !candidate.revokedAt)
  if (!key?.keyCiphertext) return null
  try {
    return decrypt(key.keyCiphertext, getPassphrase())
  } catch {
    return null
  }
}

export function revokeApiKey(apiKeyId: string, userId: string, custom?: string): AccessApiKey | null {
  const store = loadAccessStore(custom)
  const key = store.apiKeys.find((k) => k.id === apiKeyId && k.userId === userId)
  if (!key) return null
  key.revokedAt = nowIso()
  for (const link of store.connectorLinks) {
    if (link.apiKeyId === apiKeyId && link.userId === userId && !link.revokedAt) link.revokedAt = key.revokedAt
  }
  saveAccessStore(store, custom)
  return key
}

export function deleteApiKeyForUser(userId: string, apiKeyId: string, custom?: string): boolean {
  const store = loadAccessStore(custom)
  const before = store.apiKeys.length
  store.apiKeys = store.apiKeys.filter((key) => !(key.id === apiKeyId && key.userId === userId))
  store.connectorLinks = store.connectorLinks.filter((link) => !(link.apiKeyId === apiKeyId && link.userId === userId))
  if (store.apiKeys.length === before) return false
  saveAccessStore(store, custom)
  return true
}

export function findApiKeyByPlaintext(apiKey: string, custom?: string): AccessApiKey | null {
  const store = loadAccessStore(custom)
  const hashed = hashApiKey(apiKey)
  const key = store.apiKeys.find((candidate) => !candidate.revokedAt && secureEqual(candidate.keyHash, hashed))
  if (!key) return null
  key.lastUsedAt = nowIso()
  saveAccessStore(store, custom)
  return key
}

export function createConnectorLink(
  userId: string,
  input: { apiKeyId?: string; label?: string; client?: string } = {},
  custom?: string,
  plainToken?: string,
): { token: string; record: AccessConnectorLink } {
  const store = loadAccessStore(custom)
  const user = store.users.find((u) => u.id === userId && u.status === 'active')
  if (!user) throw new Error(`Active user "${userId}" not found.`)
  const activeLinks = store.connectorLinks.filter((link) => link.userId === userId && !link.revokedAt)
  if (activeLinks.length >= 5) throw new Error('You can have only 5 active connector links at a time. Revoke one before creating another.')
  const apiKey = input.apiKeyId
    ? store.apiKeys.find((key) => key.id === input.apiKeyId && key.userId === userId && !key.revokedAt)
    : store.apiKeys.find((key) => key.userId === userId && !key.revokedAt)
  if (!apiKey) throw new Error('Create an active API key before creating a connector link.')

  const token = plainToken || generateConnectorToken()
  const record: AccessConnectorLink = {
    id: generateId('conn'),
    userId,
    apiKeyId: apiKey.id,
    tokenHash: hashApiKey(token),
    prefix: token.slice(0, 16),
    label: input.label?.trim() || 'Claude connector',
    client: input.client?.trim() || 'claude',
    createdAt: nowIso(),
    lastUsedAt: null,
    revokedAt: null,
  }
  store.connectorLinks.push(record)
  saveAccessStore(store, custom)
  return { token, record }
}

export function listConnectorLinksForUser(userId: string, custom?: string): SafeConnectorLink[] {
  const store = loadAccessStore(custom)
  return store.connectorLinks
    .filter((link) => link.userId === userId)
    .map(({ tokenHash: _tokenHash, ...safe }) => safe)
}

export function revokeConnectorLink(userId: string, linkId: string, custom?: string): AccessConnectorLink | null {
  const store = loadAccessStore(custom)
  const link = store.connectorLinks.find((candidate) => candidate.id === linkId && candidate.userId === userId)
  if (!link) return null
  link.revokedAt = nowIso()
  saveAccessStore(store, custom)
  return link
}

export function findConnectorLinkByToken(token: string, custom?: string): AccessConnectorLink | null {
  const store = loadAccessStore(custom)
  const hashed = hashApiKey(token)
  const link = store.connectorLinks.find((candidate) => !candidate.revokedAt && secureEqual(candidate.tokenHash, hashed))
  if (!link) return null
  const apiKey = store.apiKeys.find((key) => key.id === link.apiKeyId && key.userId === link.userId && !key.revokedAt)
  if (!apiKey) return null
  link.lastUsedAt = nowIso()
  apiKey.lastUsedAt = nowIso()
  saveAccessStore(store, custom)
  return link
}

function parsePlan(value: unknown): AccessPlan {
  if (value === 'pro' || value === 'max') return value
  return 'free'
}

function parseJudgePlan(value: unknown): AccessPlan {
  if (value === 'free' || value === 'pro' || value === 'max') return value
  return 'max'
}

function resolveJudgeAuthContextFromApiKey(apiKey: string): AuthContext | null {
  const configured = process.env.AGNT_JUDGE_API_KEY?.trim()
  if (!configured) return null
  const providedHash = hashApiKey(apiKey.trim())
  const configuredHash = hashApiKey(configured)
  if (!secureEqual(providedHash, configuredHash)) return null
  const plan = parseJudgePlan(process.env.AGNT_JUDGE_PLAN)
  return {
    userId: process.env.AGNT_JUDGE_USER_ID?.trim() || 'judge-demo',
    apiKeyId: process.env.AGNT_JUDGE_API_KEY_ID?.trim() || 'judge-demo-env',
    plan,
    subscriptionStatus: 'active',
    entitlement: getAccessEntitlement(plan),
    source: 'api_key',
  }
}

export function createEmailVerificationCode(input: { email: string; codeHash: string; expiresAt: string }, custom?: string): EmailVerificationCode {
  const store = loadAccessStore(custom)
  const timestamp = nowIso()
  const code: EmailVerificationCode = {
    id: generateId('email'),
    email: normalizeEmailAddress(input.email),
    codeHash: input.codeHash,
    expiresAt: input.expiresAt,
    attempts: 0,
    createdAt: timestamp,
  }
  store.emailVerificationCodes.push(code)
  saveAccessStore(store, custom)
  return code
}

export function findLatestEmailVerificationCode(email: string, custom?: string): EmailVerificationCode | null {
  const normalized = normalizeEmailAddress(email)
  const store = loadAccessStore(custom)
  return store.emailVerificationCodes
    .filter((code) => code.email === normalized && !code.consumedAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null
}

export function updateEmailVerificationCode(code: EmailVerificationCode, custom?: string): EmailVerificationCode {
  const store = loadAccessStore(custom)
  const existing = store.emailVerificationCodes.find((candidate) => candidate.id === code.id)
  if (!existing) throw new Error(`Email verification code "${code.id}" not found.`)
  Object.assign(existing, code)
  saveAccessStore(store, custom)
  return existing
}

export function createDashboardSession(userId: string, tokenHash: string, expiresAt: string, custom?: string): DashboardSession {
  const store = loadAccessStore(custom)
  const user = store.users.find((candidate) => candidate.id === userId && candidate.status === 'active')
  if (!user) throw new Error(`Active user "${userId}" not found.`)
  const timestamp = nowIso()
  const session: DashboardSession = {
    id: generateId('sess'),
    userId,
    tokenHash,
    createdAt: timestamp,
    expiresAt,
    lastSeenAt: timestamp,
  }
  store.dashboardSessions.push(session)
  saveAccessStore(store, custom)
  return session
}

export function findDashboardSessionByTokenHash(tokenHash: string, custom?: string, now = Date.now()): DashboardSession | null {
  const store = loadAccessStore(custom)
  const session = store.dashboardSessions.find((candidate) => candidate.tokenHash === tokenHash && !candidate.revokedAt)
  if (!session) return null
  if (new Date(session.expiresAt).getTime() <= now) return null
  session.lastSeenAt = nowIso()
  saveAccessStore(store, custom)
  return session
}

export function revokeDashboardSession(tokenHash: string, custom?: string): boolean {
  const store = loadAccessStore(custom)
  const session = store.dashboardSessions.find((candidate) => candidate.tokenHash === tokenHash && !candidate.revokedAt)
  if (!session) return false
  session.revokedAt = nowIso()
  saveAccessStore(store, custom)
  return true
}

export function getAccessEntitlement(plan: AccessPlan | string | undefined): AccessEntitlement {
  const base = getPlanEntitlement(plan)
  const normalized = base.plan
  const eventLimit =
    normalized === 'max' ? Number(process.env.AUTOMATION_MAX_EVENT_EVALUATIONS_MONTHLY || 250_000) :
      normalized === 'pro' ? Number(process.env.AUTOMATION_PRO_EVENT_EVALUATIONS_MONTHLY || 25_000) :
        Number(process.env.AUTOMATION_FREE_EVENT_EVALUATIONS_MONTHLY || 500)
  const executionLimit =
    normalized === 'max' ? Number(process.env.AUTOMATION_MAX_EXECUTIONS_MONTHLY || 10_000) :
      normalized === 'pro' ? Number(process.env.AUTOMATION_PRO_EXECUTIONS_MONTHLY || 1_000) :
        Number(process.env.AUTOMATION_FREE_EXECUTIONS_MONTHLY || 0)

  return {
    ...base,
    eventEvaluationsMonthly: eventLimit,
    executionsMonthly: executionLimit,
  }
}

export function upsertSubscription(input: {
  userId: string
  plan: AccessPlan | string
  status: SubscriptionStatus
  provider: PaymentProvider
  providerCustomerId?: string
  providerSubscriptionId?: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd?: boolean
}, custom?: string): SubscriptionRecord {
  const store = loadAccessStore(custom)
  const user = store.users.find((u) => u.id === input.userId)
  if (!user) throw new Error(`User "${input.userId}" not found.`)

  const existing = store.subscriptions.find((s) =>
    (input.providerSubscriptionId && s.providerSubscriptionId === input.providerSubscriptionId) ||
    (!input.providerSubscriptionId && s.userId === input.userId && s.provider === input.provider)
  )
  const timestamp = nowIso()
  if (existing) {
    existing.plan = parsePlan(input.plan)
    existing.status = input.status
    existing.provider = input.provider
    existing.providerCustomerId = input.providerCustomerId ?? existing.providerCustomerId
    existing.providerSubscriptionId = input.providerSubscriptionId ?? existing.providerSubscriptionId
    existing.currentPeriodStart = input.currentPeriodStart ?? existing.currentPeriodStart
    existing.currentPeriodEnd = input.currentPeriodEnd ?? existing.currentPeriodEnd
    existing.cancelAtPeriodEnd = input.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd
    existing.updatedAt = timestamp
    saveAccessStore(store, custom)
    return existing
  }

  const subscription: SubscriptionRecord = {
    id: generateId('sub'),
    userId: input.userId,
    plan: parsePlan(input.plan),
    status: input.status,
    provider: input.provider,
    providerCustomerId: input.providerCustomerId,
    providerSubscriptionId: input.providerSubscriptionId,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  store.subscriptions.push(subscription)
  saveAccessStore(store, custom)
  return subscription
}

function subscriptionIsCurrent(subscription: SubscriptionRecord, at = Date.now()): boolean {
  if (subscription.status === 'active' || subscription.status === 'trialing' || subscription.status === 'past_due') return true
  if (subscription.status === 'canceled' && subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd) {
    return new Date(subscription.currentPeriodEnd).getTime() > at
  }
  return false
}

export function getCurrentSubscription(userId: string, custom?: string): SubscriptionRecord | null {
  const store = loadAccessStore(custom)
  const subscriptions = store.subscriptions
    .filter((s) => s.userId === userId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return subscriptions.find((s) => subscriptionIsCurrent(s)) || subscriptions[0] || null
}

export function resolveAuthContextForUser(userId: string, apiKeyId = 'manual', custom?: string): AuthContext | null {
  const store = loadAccessStore(custom)
  const user = store.users.find((u) => u.id === userId && u.status === 'active')
  if (!user) return null

  const subscription = getCurrentSubscription(userId, custom)
  const status = subscription?.status || 'active'
  const plan = subscription && subscriptionIsCurrent(subscription) ? subscription.plan : 'free'
  const entitlement = getAccessEntitlement(plan)
  if (status === 'past_due') {
    entitlement.autoExecuteAllowed = false
    entitlement.priorityQueue = false
  }

  return {
    userId,
    apiKeyId,
    plan,
    subscriptionStatus: subscription ? status : 'active',
    entitlement,
    source: 'api_key',
  }
}

export function resolveAuthContextFromApiKey(apiKey: string | undefined, custom?: string): AuthContext | null {
  if (!apiKey) return null
  const judgeAuth = resolveJudgeAuthContextFromApiKey(apiKey)
  if (judgeAuth) return judgeAuth
  const key = findApiKeyByPlaintext(apiKey, custom)
  if (!key) return null
  return resolveAuthContextForUser(key.userId, key.id, custom)
}

export function resolveAuthContextFromConnectorToken(token: string | undefined, custom?: string): AuthContext | null {
  if (!token) return null
  const link = findConnectorLinkByToken(token, custom)
  if (!link) return null
  return resolveAuthContextForUser(link.userId, link.apiKeyId, custom)
}

export function createDevAuthContext(plan: AccessPlan = 'free'): AuthContext {
  return {
    userId: 'dev',
    apiKeyId: 'dev',
    plan,
    subscriptionStatus: 'active',
    entitlement: getAccessEntitlement(plan),
    source: 'dev',
  }
}

export function recordUsage(userId: string, patch: Partial<Omit<UsageRecord, 'userId' | 'periodStart' | 'periodEnd' | 'updatedAt'>>, custom?: string): UsageRecord {
  const store = loadAccessStore(custom)
  const start = new Date()
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  const periodStart = start.toISOString()
  const periodEnd = end.toISOString()
  let usage = store.usage.find((u) => u.userId === userId && u.periodStart === periodStart)
  if (!usage) {
    usage = {
      userId,
      periodStart,
      periodEnd,
      activeDataAutomations: 0,
      eventEvaluationsUsed: 0,
      executionsUsed: 0,
      twitterTweetsIngested: 0,
      grokCallsUsed: 0,
      updatedAt: nowIso(),
    }
    store.usage.push(usage)
  }
  Object.assign(usage, patch, { updatedAt: nowIso() })
  saveAccessStore(store, custom)
  return usage
}

export function recordPaymentEvent(input: Omit<PaymentRecord, 'id' | 'createdAt'>, custom?: string): PaymentRecord {
  const store = loadAccessStore(custom)
  const payment: PaymentRecord = {
    ...input,
    id: generateId('pay'),
    createdAt: nowIso(),
  }
  store.payments.push(payment)
  saveAccessStore(store, custom)
  return payment
}

export function createCryptoAccessIntent(input: Omit<CryptoAccessIntent, 'id' | 'createdAt'>, custom?: string): CryptoAccessIntent {
  const store = loadAccessStore(custom)
  const user = store.users.find((u) => u.id === input.userId && u.status === 'active')
  if (!user) throw new Error(`Active user "${input.userId}" not found.`)
  const intent: CryptoAccessIntent = {
    ...input,
    id: generateId('crypto'),
    createdAt: nowIso(),
  }
  store.cryptoAccessIntents.push(intent)
  saveAccessStore(store, custom)
  return intent
}

export function updateCryptoAccessIntent(intent: CryptoAccessIntent, custom?: string): CryptoAccessIntent {
  const store = loadAccessStore(custom)
  const existing = store.cryptoAccessIntents.find((candidate) => candidate.id === intent.id)
  if (!existing) throw new Error(`Crypto access quote "${intent.id}" not found.`)
  Object.assign(existing, intent)
  saveAccessStore(store, custom)
  return existing
}

export function getCryptoAccessIntent(id: string, custom?: string): CryptoAccessIntent | null {
  const store = loadAccessStore(custom)
  return store.cryptoAccessIntents.find((intent) => intent.id === id) || null
}

function normalizeSourceHandle(handle: unknown): string {
  if (typeof handle !== 'string') return ''
  return handle.trim().replace(/^@+/, '')
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean))]
}

export function listCustomSources(userId?: string, custom?: string): CustomTwitterSource[] {
  const store = loadAccessStore(custom)
  return store.customSources
    .filter((source) => !userId || source.userId === userId)
    .map((source) => ({ ...source, topics: [...source.topics], keywords: [...source.keywords] }))
}

export function createCustomSource(userId: string, input: {
  handle: string
  displayName?: string
  topics: string[]
  keywords?: string[]
  enabled?: boolean
  trustScore?: number
}, custom?: string): CustomTwitterSource {
  const store = loadAccessStore(custom)
  const user = store.users.find((candidate) => candidate.id === userId && candidate.status === 'active')
  if (!user) throw new Error(`Active user "${userId}" not found.`)
  const entitlement = resolveAuthContextForUser(userId, 'dashboard', custom)?.entitlement || getAccessEntitlement('free')
  const ownedSources = store.customSources.filter((source) => source.userId === userId)
  if (ownedSources.length >= entitlement.customSourceSlots) {
    const label = entitlement.plan === 'max' ? 'Ultra' : entitlement.plan[0].toUpperCase() + entitlement.plan.slice(1)
    throw new Error(`${label} allows ${entitlement.customSourceSlots} custom sources. Remove one before adding another.`)
  }
  const handle = normalizeSourceHandle(input.handle)
  if (!handle) throw new Error('Twitter/X handle is required.')
  const topics = normalizeStringList(input.topics)
  if (topics.length === 0) throw new Error('Add at least one topic so AGNT knows when to poll this source.')
  if (ownedSources.some((source) => source.handle.toLowerCase() === handle.toLowerCase())) {
    throw new Error('This source is already in your list.')
  }

  const timestamp = nowIso()
  const source: CustomTwitterSource = {
    id: generateId('src'),
    userId,
    handle,
    displayName: input.displayName?.trim() || undefined,
    topics,
    keywords: normalizeStringList(input.keywords || []),
    enabled: input.enabled !== false,
    trustScore: Math.max(0, Math.min(1, Number(input.trustScore ?? 0.7))),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  store.customSources.push(source)
  saveAccessStore(store, custom)
  return source
}

export function updateCustomSource(userId: string, sourceId: string, patch: Partial<Pick<CustomTwitterSource, 'displayName' | 'topics' | 'keywords' | 'enabled' | 'trustScore'>>, custom?: string): CustomTwitterSource | null {
  const store = loadAccessStore(custom)
  const source = store.customSources.find((candidate) => candidate.id === sourceId && candidate.userId === userId)
  if (!source) return null
  if (patch.displayName !== undefined) source.displayName = patch.displayName.trim() || undefined
  if (patch.topics !== undefined) {
    const topics = normalizeStringList(patch.topics)
    if (topics.length === 0) throw new Error('Add at least one topic so AGNT knows when to poll this source.')
    source.topics = topics
  }
  if (patch.keywords !== undefined) source.keywords = normalizeStringList(patch.keywords)
  if (patch.enabled !== undefined) source.enabled = patch.enabled
  if (patch.trustScore !== undefined) source.trustScore = Math.max(0, Math.min(1, Number(patch.trustScore)))
  source.updatedAt = nowIso()
  saveAccessStore(store, custom)
  return source
}

export function deleteCustomSource(userId: string, sourceId: string, custom?: string): boolean {
  const store = loadAccessStore(custom)
  const before = store.customSources.length
  store.customSources = store.customSources.filter((source) => !(source.id === sourceId && source.userId === userId))
  if (store.customSources.length === before) return false
  saveAccessStore(store, custom)
  return true
}

export function hasProcessedPayment(provider: PaymentProvider, txHash: string, custom?: string): boolean {
  const store = loadAccessStore(custom)
  return store.payments.some((payment) => payment.provider === provider && payment.txHash?.toLowerCase() === txHash.toLowerCase())
}

export function markWebhookEventProcessed(eventId: string, custom?: string): boolean {
  const store = loadAccessStore(custom)
  if (store.processedWebhookEventIds.includes(eventId)) return false
  store.processedWebhookEventIds.push(eventId)
  if (store.processedWebhookEventIds.length > 5000) {
    store.processedWebhookEventIds = store.processedWebhookEventIds.slice(-5000)
  }
  saveAccessStore(store, custom)
  return true
}
