import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { AccessUser, AuthContext, DashboardSession } from './access-types.js'
import {
  createDashboardSession,
  createEmailVerificationCode,
  createUser,
  findDashboardSessionByTokenHash,
  findLatestEmailVerificationCode,
  findUserByEmail,
  loadAccessStore,
  normalizeEmailAddress,
  resolveAuthContextForUser,
  revokeDashboardSession,
  setUserPassword,
  updateEmailVerificationCode,
  userHasPassword,
  verifyUserPassword,
} from './access-store.js'
import { setWalletExportPassword } from './wallet-vault.js'

export interface StartEmailLoginOptions {
  now?: number
  ttlMs?: number
}

export interface StartEmailLoginResult {
  email: string
  expiresAt: string
  devCode?: string
}

export interface VerifyEmailLoginInput {
  email: string
  code: string
  now?: number
}

export interface VerifyEmailLoginResult {
  user: AccessUser
  session: DashboardSession
  sessionToken: string
  auth: AuthContext
}

export interface DashboardSessionContext {
  user: AccessUser
  session: DashboardSession
  auth: AuthContext
}

export interface DashboardPasswordAuthInput {
  email: string
  password: string
}

const DEFAULT_EMAIL_TTL_MS = 10 * 60_000
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function secureEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function generateCode(): string {
  return randomBytes(3).readUIntBE(0, 3).toString().padStart(6, '0').slice(0, 6)
}

function generateSessionToken(): string {
  return `agnt_sess_${randomBytes(32).toString('base64url')}`
}

function shouldReturnDevCode(): boolean {
  return process.env.AGNT_EMAIL_PROVIDER === 'console' || process.env.NODE_ENV !== 'production'
}

function resolveOrCreateDashboardAuth(email: string, customStorePath?: string): { user: AccessUser; auth: AuthContext } {
  const user = findUserByEmail(email, customStorePath) || createUser({ email }, customStorePath)
  const auth = resolveAuthContextForUser(user.id, 'dashboard', customStorePath)
  if (!auth) throw new Error('Could not create dashboard session.')
  return { user, auth }
}

function createSessionForUser(user: AccessUser, customStorePath: string | undefined, now = Date.now()): VerifyEmailLoginResult {
  const sessionToken = generateSessionToken()
  const session = createDashboardSession(user.id, hashSecret(sessionToken), new Date(now + DEFAULT_SESSION_TTL_MS).toISOString(), customStorePath)
  const auth = resolveAuthContextForUser(user.id, session.id, customStorePath)
  if (!auth) throw new Error('Could not create dashboard session.')
  return { user, session, sessionToken, auth }
}

export function signupDashboard(input: DashboardPasswordAuthInput, customStorePath?: string): VerifyEmailLoginResult {
  const email = normalizeEmailAddress(input.email)
  const password = typeof input.password === 'string' ? input.password : ''
  if (!email || !email.includes('@')) throw new Error('Enter a valid email address.')
  if (password.trim().length < 8) throw new Error('Password must be at least 8 characters.')

  const existing = findUserByEmail(email, customStorePath)
  if (userHasPassword(existing)) throw new Error('This email already has a dashboard password. Use Login instead.')
  const user = existing || createUser({ email }, customStorePath)
  const updated = setUserPassword(user.id, password, customStorePath)
  setWalletExportPassword(password)
  return createSessionForUser(updated, customStorePath)
}

export function loginDashboard(input: DashboardPasswordAuthInput, customStorePath?: string): VerifyEmailLoginResult {
  const email = normalizeEmailAddress(input.email)
  const password = typeof input.password === 'string' ? input.password : ''
  if (!email || !email.includes('@')) throw new Error('Enter a valid email address.')
  if (!password) throw new Error('Password is required.')
  const user = verifyUserPassword(email, password, customStorePath)
  if (!user) throw new Error('Email or password is not correct.')
  return createSessionForUser(user, customStorePath)
}

export function startEmailLogin(emailInput: string, customStorePath?: string, options: StartEmailLoginOptions = {}): StartEmailLoginResult {
  const email = normalizeEmailAddress(emailInput)
  if (!email || !email.includes('@')) throw new Error('Enter a valid email address.')
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_EMAIL_TTL_MS
  const code = generateCode()
  const expiresAt = new Date(now + ttlMs).toISOString()
  createEmailVerificationCode({ email, codeHash: hashSecret(code), expiresAt }, customStorePath)
  if (process.env.AGNT_EMAIL_PROVIDER === 'console' || process.env.NODE_ENV !== 'production') {
    console.log(`[Email] AGNT login code for ${email}: ${code}`)
  }
  return { email, expiresAt, devCode: shouldReturnDevCode() ? code : undefined }
}

export function verifyEmailLogin(input: VerifyEmailLoginInput, customStorePath?: string): VerifyEmailLoginResult {
  const email = normalizeEmailAddress(input.email)
  const submitted = typeof input.code === 'string' ? input.code.trim() : ''
  if (!email) throw new Error('Email is required.')
  if (!submitted) throw new Error('Email confirmation code is required.')

  const record = findLatestEmailVerificationCode(email, customStorePath)
  if (!record) throw new Error('That code expired. Send a new one.')
  const now = input.now ?? Date.now()
  if (new Date(record.expiresAt).getTime() <= now) {
    record.consumedAt = new Date(now).toISOString()
    updateEmailVerificationCode(record, customStorePath)
    throw new Error('That code expired. Send a new one.')
  }
  if (record.attempts >= 5) throw new Error('Too many attempts. Try again in a few minutes.')

  const matches = secureEqualHex(record.codeHash, hashSecret(submitted))
  if (!matches) {
    record.attempts += 1
    updateEmailVerificationCode(record, customStorePath)
    throw new Error('That code is not correct.')
  }

  record.consumedAt = new Date(now).toISOString()
  updateEmailVerificationCode(record, customStorePath)
  const { user } = resolveOrCreateDashboardAuth(email, customStorePath)
  return createSessionForUser(user, customStorePath, now)
}

export function resolveDashboardSession(sessionToken: string | undefined, customStorePath?: string, now = Date.now()): DashboardSessionContext | null {
  if (!sessionToken) return null
  const session = findDashboardSessionByTokenHash(hashSecret(sessionToken), customStorePath, now)
  if (!session) return null
  const store = loadAccessStore(customStorePath)
  const user = store.users.find((candidate) => candidate.id === session.userId && candidate.status === 'active')
  if (!user) return null
  const auth = resolveAuthContextForUser(user.id, session.id, customStorePath)
  if (!auth) return null
  return { user, session, auth }
}

export function logoutDashboardSession(sessionToken: string | undefined, customStorePath?: string): boolean {
  if (!sessionToken) return false
  return revokeDashboardSession(hashSecret(sessionToken), customStorePath)
}
