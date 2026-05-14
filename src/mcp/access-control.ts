import type { IncomingHttpHeaders } from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import type { AutomationEntry } from './scheduler.js'
import type { AccessPlan, AuthContext } from './access-types.js'
import { getAccessEntitlement, hashApiKey, resolveAuthContextFromApiKey, resolveAuthContextFromConnectorToken, resolveAuthContextForUser } from './access-store.js'

export function extractApiKeyFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const explicit = headers['x-agnt-api-key']
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (Array.isArray(explicit) && explicit[0]) return explicit[0].trim()

  const auth = headers.authorization
  if (!auth) return undefined
  const value = Array.isArray(auth) ? auth[0] : auth
  if (value.startsWith('Bearer agnt_')) return value.slice('Bearer '.length).trim()
  if (value.startsWith('ApiKey ')) return value.slice('ApiKey '.length).trim()
  return undefined
}

export function extractApiKeyFromUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    const parsed = new URL(rawUrl, 'http://localhost')
    const key = parsed.searchParams.get('agnt_api_key') || parsed.searchParams.get('api_key')
    return key?.startsWith('agnt_') ? key.trim() : undefined
  } catch {
    return undefined
  }
}

export function extractConnectorTokenFromUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    const parsed = new URL(rawUrl, 'http://localhost')
    const token = parsed.searchParams.get('agnt_connector_token') || parsed.searchParams.get('connector_token')
    return token?.startsWith('agnt_conn_') ? token.trim() : undefined
  } catch {
    return undefined
  }
}

export function resolveAuthContextFromHeaders(headers: IncomingHttpHeaders): AuthContext | null {
  return resolveAuthContextFromApiKeyWithLockdown(extractApiKeyFromHeaders(headers))
}

export function resolveAuthContextFromRequest(headers: IncomingHttpHeaders, rawUrl: string | undefined): AuthContext | null {
  const key = extractApiKeyFromHeaders(headers) || extractApiKeyFromUrl(rawUrl)
  const locked = resolveLockdownAuthContext(key)
  if (isLockdownEnabled()) return locked
  return (
    resolveAuthContextFromApiKey(key) ||
    resolveAuthContextFromConnectorToken(extractConnectorTokenFromUrl(rawUrl))
  )
}

export function isAccessRequired(): boolean {
  return isLockdownEnabled() || process.env.AGNT_ACCESS_REQUIRED === 'true' || process.env.NODE_ENV === 'production'
}

export function isLockdownEnabled(): boolean {
  return lockdownKeys().length > 0
}

function lockdownKeys(): string[] {
  return (process.env.AGNT_LOCKDOWN_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.startsWith('agnt_'))
}

function lockdownPlan(): AccessPlan {
  const plan = process.env.AGNT_LOCKDOWN_PLAN
  return plan === 'pro' || plan === 'max' ? plan : 'max'
}

function resolveAuthContextFromApiKeyWithLockdown(apiKey: string | undefined): AuthContext | null {
  const locked = resolveLockdownAuthContext(apiKey)
  if (isLockdownEnabled()) return locked
  return resolveAuthContextFromApiKey(apiKey)
}

export function resolveLockdownAuthContext(apiKey: string | undefined): AuthContext | null {
  if (!apiKey) return null
  const allowed = lockdownKeys()
  if (!allowed.length) return null
  const hash = hashApiKey(apiKey)
  const matched = allowed.some((allowedKey) => {
    const left = Buffer.from(hashApiKey(allowedKey), 'hex')
    const right = Buffer.from(hash, 'hex')
    return left.length === right.length && timingSafeEqual(left, right)
  })
  if (!matched) return null
  const plan = lockdownPlan()
  return {
    userId: `lockdown_${hash.slice(0, 16)}`,
    apiKeyId: `lockdown_${hash.slice(0, 12)}`,
    plan,
    subscriptionStatus: 'active',
    entitlement: getAccessEntitlement(plan),
    source: 'api_key',
  }
}

export function canRunOwnedAutomation(auto: AutomationEntry): { allowed: boolean; reason: string; auth?: AuthContext } {
  if (!auto.userId) return { allowed: true, reason: 'Legacy automation without owner.' }
  const auth = resolveAuthContextForUser(auto.userId, auto.createdByApiKeyId || 'worker')
  if (!auth) return { allowed: false, reason: 'Automation owner is inactive or missing.' }
  if (auth.subscriptionStatus === 'expired') return { allowed: false, reason: 'Subscription expired.' }
  if (auth.subscriptionStatus === 'past_due') return { allowed: false, reason: 'Subscription is past due; paid automations are notify-only until payment is fixed.', auth }
  return { allowed: true, reason: 'Owner entitlement is active.', auth }
}

export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined, webhookSecret: string | undefined, toleranceSeconds = 300): boolean {
  if (!webhookSecret) return process.env.NODE_ENV !== 'production'
  if (!signatureHeader) return false

  const parts = Object.fromEntries(
    signatureHeader
      .split(',')
      .map((part) => part.split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  )
  const timestamp = parts.t
  const signature = parts.v1
  if (!timestamp || !signature) return false

  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > toleranceSeconds) return false

  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex')
  const left = Buffer.from(expected, 'hex')
  const right = Buffer.from(signature, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
