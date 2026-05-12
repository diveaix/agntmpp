/**
 * ./AGNT Protocol — Hosted MCP Server (Streamable HTTP + Legacy SSE)
 * 
 * Serves the MCP server over HTTP with Streamable HTTP transport (modern)
 * and legacy SSE transport for backward compatibility.
 * 
 * Usage:
 *   npm run mcp:serve          → http://localhost:3001/mcp
 *   AGNT_PORT=8080 npm run mcp:serve
 */

import 'dotenv/config' // Load .env before anything else

import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { TEMPO_CHAIN, TOKENS } from './config.js'
import { ALL_TOOLS, handleTool, TOOL_COUNT, initSkills } from './tools/index.js'
import { SUPPORTED_CHAINS } from './chains.js'
import { getToolTier, getToolPrice } from './pricing.js'
import { getStats } from './payment-tracker.js'
import { submitTask, getTask, cancelTask, listTasks, getTaskStats } from './a2a.js'
import { scheduleNewAutomation, startAutomationRunner, unscheduleAutomation } from './automation-runner.js'
import { listAutomationsForUser, updateAutomationStatusForUser } from './scheduler.js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { AuthContext, AccessPlan, SubscriptionStatus } from './access-types.js'
import {
  createApiKey,
  createConnectorLink,
  createCustomSource,
  createUser,
  deleteApiKeyForUser,
  deleteCustomSource,
  getCurrentSubscription,
  listApiKeysForUser,
  listConnectorLinksForUser,
  listCustomSources,
  loadAccessStore,
  markWebhookEventProcessed,
  recordPaymentEvent,
  revealApiKey,
  revokeConnectorLink,
  revokeApiKey,
  updateCustomSource,
  upsertSubscription,
} from './access-store.js'
import { isAccessRequired, resolveAuthContextFromHeaders, resolveAuthContextFromRequest, verifyStripeSignature } from './access-control.js'
import { applyCryptoAccessPayment, createCryptoAccessQuote } from './crypto-access.js'
import {
  confirmPublicCryptoCheckout,
  createPublicCryptoCheckoutQuote,
  formatPublicCheckoutQuoteResponse,
} from './public-checkout.js'
import {
  deleteDashboardWallet,
  getDashboardWallets,
  revealDashboardWalletPrivateKey,
  setDashboardWalletPassword,
} from './dashboard-wallets.js'
import { listActivityForUser } from './activity-log.js'
import {
  logoutDashboardSession,
  loginDashboard,
  resolveDashboardSession,
  signupDashboard,
  startEmailLogin,
  verifyEmailLogin,
  type DashboardSessionContext,
} from './dashboard-auth.js'
import { HACKATHON_DISABLED_MESSAGE, HACKATHON_MODE } from '../hackathon-mode.js'

// ─── Create MCP Server instance ──────────────────────────

function createMcpServer(auth?: AuthContext, walletScope?: string | (() => string | undefined)) {
  const server = new Server({ name: 'agnt-protocol', version: '2.1.0' }, { capabilities: { tools: {}, resources: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const meta = (req.params as Record<string, unknown>)?._meta as Record<string, unknown> | undefined
      const resolvedWalletScope = typeof walletScope === 'function' ? walletScope() : walletScope
      return await handleTool(req.params.name, (req.params.arguments || {}) as Record<string, unknown>, meta, auth, resolvedWalletScope)
    }
    catch (e) { return { content: [{ type: 'text' as const, text: `❌ ${e instanceof Error ? e.message : String(e)}` }], isError: true } }
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'agnt://info', name: './AGNT Protocol', description: 'Protocol info.', mimeType: 'text/plain' },
    ],
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === 'agnt://plans') {
      return { contents: [{ uri: 'agnt://plans', mimeType: 'text/plain', text: HACKATHON_DISABLED_MESSAGE }] }
    }
    return {
    contents: [{ uri: 'agnt://info', mimeType: 'text/plain', text:
      `./AGNT — Agent DeFi Toolkit v2.1 (${TOOL_COUNT} MPP-enabled tools)\n` +
      `Payment: MPP (Machine Payments Protocol) — USDC.e on Tempo\n` +
      `Chains: ${Object.values(SUPPORTED_CHAINS).map(c => c.label).join(', ')}\n` +
      `Venues: Tempo DEX, Hyperliquid Perps\n` +
      `Tokens: ${Object.keys(TOKENS).join(', ')}`
    }],
    }
  })

  return server
}

// ─── Express Server & Security ───────────────────────────

const app = express()
app.set('trust proxy', 1)
app.use(cors({ origin: true, credentials: true }))

// API Rate Limiting to prevent mass calling and abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
})
app.use(apiLimiter)

const JWT_SECRET = process.env.AGNT_PASSPHRASE || 'default_secret_for_dev_only_change_in_prod'
type AuthedRequest = express.Request & { agntAuth?: AuthContext; dashboard?: DashboardSessionContext }

function getAuthForRequest(req: express.Request): AuthContext | undefined {
  return (req as AuthedRequest).agntAuth
}

function getHeaderString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function resolvePersistentWalletScope(req: express.Request, auth?: AuthContext): string {
  if (auth) return `user:${auth.userId}`

  const explicitClientId =
    getHeaderString(req.headers['x-agnt-client-id']) ||
    getHeaderString(req.headers['x-client-id']) ||
    (typeof req.query.clientId === 'string' ? req.query.clientId : undefined)

  if (explicitClientId?.trim()) {
    return `client:${explicitClientId.trim()}`
  }

  const forwardedFor = getHeaderString(req.headers['x-forwarded-for']) || req.ip || req.socket.remoteAddress || 'unknown-ip'
  const userAgent = getHeaderString(req.headers['user-agent']) || 'unknown-agent'
  const host = getHeaderString(req.headers.host) || 'unknown-host'
  const fingerprint = crypto.createHash('sha256').update(`${host}|${forwardedFor}|${userAgent}`).digest('hex').slice(0, 32)
  return `anonymous:${fingerprint}`
}

function parseCookies(req: express.Request): Record<string, string> {
  const header = req.headers.cookie
  if (!header) return {}
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...rest] = part.trim().split('=')
    return [decodeURIComponent(key), decodeURIComponent(rest.join('='))]
  }).filter(([key]) => Boolean(key)))
}

function getDashboardToken(req: express.Request): string | undefined {
  const headerToken = req.headers['x-agnt-dashboard-session']
  if (typeof headerToken === 'string' && headerToken) return headerToken
  return parseCookies(req).agnt_dashboard_session
}

function setDashboardCookie(res: express.Response, token: string): void {
  res.cookie('agnt_dashboard_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
}

function clearDashboardCookie(res: express.Response): void {
  res.clearCookie('agnt_dashboard_session', { path: '/' })
}

function requireDashboardAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const context = resolveDashboardSession(getDashboardToken(req))
  if (!context) {
    res.status(401).json({ error: 'email_login_required', error_description: 'Confirm your email before continuing.' })
    return
  }
  ;(req as AuthedRequest).dashboard = context
  next()
}

function hasPaidDashboardAccess(auth: AuthContext): boolean {
  return (auth.plan === 'pro' || auth.plan === 'max') && (auth.subscriptionStatus === 'active' || auth.subscriptionStatus === 'trialing')
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.AGNT_ADMIN_TOKEN
  if (!adminToken) {
    res.status(403).json({ error: 'admin_disabled', error_description: 'Set AGNT_ADMIN_TOKEN before using admin bootstrap.' })
    return
  }
  const supplied = req.headers['x-agnt-admin-token']
  if (supplied !== adminToken) {
    res.status(401).json({ error: 'invalid_admin_token' })
    return
  }
  next()
}

function requireAccessAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = resolveAuthContextFromRequest(req.headers, req.originalUrl || req.url)
  if (!auth) {
    res.status(401).json({ error: 'invalid_api_key', error_description: 'Provide x-agnt-api-key or Authorization: Bearer agnt_live_...' })
    return
  }
  ;(req as AuthedRequest).agntAuth = auth
  next()
}

function sendHackathonDisabled(res: express.Response, feature: string) {
  res.status(403).json({
    error: 'hackathon_mode_disabled',
    feature,
    error_description: HACKATHON_DISABLED_MESSAGE,
  })
}

// ─── OAuth 2.1 Authorization ─────────────────────────────

// Server Metadata Discovery
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const baseUrl = `${req.protocol}://${req.headers.host}`
  res.json({
    issuer: baseUrl,
    token_endpoint: `${baseUrl}/token`,
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]
  })
})

// Token Endpoint (Client Credentials Grant)
app.post('/token', express.json(), express.urlencoded({ extended: true }), (req, res) => {
  const grantType = req.body.grant_type
  
  if (grantType !== 'client_credentials') {
    res.status(400).json({ error: 'unsupported_grant_type' })
    return
  }

  let clientId, clientSecret
  
  // Support Basic Auth
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Basic ')) {
    const b64 = authHeader.split(' ')[1]
    const decoded = Buffer.from(b64, 'base64').toString('ascii')
    ;[clientId, clientSecret] = decoded.split(':')
  } else {
    // Support POST body auth
    clientId = req.body.client_id
    clientSecret = req.body.client_secret
  }

  if (!clientId || !clientSecret) {
    res.status(401).json({ error: 'invalid_client' })
    return
  }

  // Validate credentials
  // For production, this should verify against a DB of registered clients.
  // We use the passphrase as a simple master secret for now.
  const validSecret = process.env.AGNT_PASSPHRASE || 'demo_secret'
  if (clientSecret !== validSecret) {
    res.status(401).json({ error: 'invalid_client' })
    return
  }

  const token = jwt.sign({ client_id: clientId }, JWT_SECRET, { expiresIn: '1h' })
  
  res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 3600
  })
})

// Auth Middleware to protect MCP endpoints
// When AGNT_PASSPHRASE is not set, auth is skipped (open dev mode).
// Set AGNT_PASSPHRASE in .env to enforce JWT protection in production.
const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (HACKATHON_MODE) {
    const accessAuth = resolveAuthContextFromRequest(req.headers, req.originalUrl || req.url)
    if (accessAuth) {
      ;(req as AuthedRequest).agntAuth = accessAuth
    }
    return next()
  }

  const accessAuth = resolveAuthContextFromRequest(req.headers, req.originalUrl || req.url)
  if (accessAuth) {
    ;(req as AuthedRequest).agntAuth = accessAuth
    return next()
  }

  if (!process.env.AGNT_PASSPHRASE && !isAccessRequired()) return next()

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'invalid_token', error_description: 'Missing or invalid Bearer token' })
    return
  }
  
  const token = authHeader.split(' ')[1]
  try {
    jwt.verify(token, JWT_SECRET)
    next()
  } catch (err) {
    res.status(401).json({ error: 'invalid_token', error_description: 'Token expired or invalid' })
  }
}

// ─── Streamable HTTP Transport (modern — used by Antigravity, etc.) ───

const streamableSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; auth?: AuthContext; walletScope: string }>()

// Handle POST, GET, DELETE on /mcp for Streamable HTTP
app.all('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined

  // Existing session — route to its transport
  if (sessionId && streamableSessions.has(sessionId)) {
    const session = streamableSessions.get(sessionId)!
    ;(req as AuthedRequest).agntAuth = session.auth
    await session.transport.handleRequest(req, res, req.body)
    return
  }

  // New initialization request (POST without session ID)
  if (req.method === 'POST' && !sessionId) {
    const auth = getAuthForRequest(req)
    const walletScope = resolvePersistentWalletScope(req, auth)
    const server = createMcpServer(auth, walletScope)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid: string) => {
        console.log(`[Streamable] Session registered: ${sid}`)
        streamableSessions.set(sid, { transport, server, auth, walletScope })
      },
    })

    transport.onclose = () => {
      const sid = transport.sessionId
      if (sid) {
        console.log(`[Streamable] Session closed: ${sid}`)
        streamableSessions.delete(sid)
      }
    }

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)

    // Belt-and-suspenders: also register after handleRequest in case callback didn't fire
    const sid = transport.sessionId
    if (sid && !streamableSessions.has(sid)) {
      console.log(`[Streamable] Session registered (fallback): ${sid}`)
      streamableSessions.set(sid, { transport, server, auth, walletScope })
    }
    return
  }

  // Session ID provided but not found, or non-POST without session
  res.status(404).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' }, id: null })
})

// ─── Legacy SSE Transport (backward compat — Cursor, Claude Desktop, etc.) ───

const sseSessions = new Map<string, { transport: SSEServerTransport; auth?: AuthContext; walletScope: string }>()

app.get('/sse', requireAuth, async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`)
  const transport = new SSEServerTransport('/messages', res)
  const auth = getAuthForRequest(req)
  const walletScope = resolvePersistentWalletScope(req, auth)
  const server = createMcpServer(auth, walletScope)
  sseSessions.set(transport.sessionId, { transport, auth, walletScope })

  res.on('close', () => {
    console.log(`[SSE] Connection closed: ${transport.sessionId}`)
    sseSessions.delete(transport.sessionId)
  })

  await server.connect(transport)
})

app.post('/messages', async (req, res, next) => {
  const sessionId = req.query.sessionId as string
  const session = sseSessions.get(sessionId)
  if (session?.auth) {
    ;(req as AuthedRequest).agntAuth = session.auth
    return next()
  }
  return requireAuth(req, res, next)
}, async (req, res) => {
  const sessionId = req.query.sessionId as string
  const session = sseSessions.get(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  ;(req as AuthedRequest).agntAuth = session.auth
  await session.transport.handlePostMessage(req, res)
})

// ─── Utility Endpoints ──────────────────────────────────

// Access and billing endpoints

function normalizeAccessPlan(value: unknown): AccessPlan {
  if (value === 'pro' || value === 'max') return value
  return 'free'
}

function normalizeSubscriptionStatus(value: unknown): SubscriptionStatus {
  if (value === 'trialing' || value === 'past_due' || value === 'canceled' || value === 'expired') return value
  return 'active'
}

function stripePriceForPlan(plan: AccessPlan): string | undefined {
  if (plan === 'pro') return process.env.STRIPE_PRICE_PRO
  if (plan === 'max') return process.env.STRIPE_PRICE_MAX
  return undefined
}

async function createStripeCheckoutSession(input: {
  userId: string
  plan: AccessPlan
  priceId: string
  successUrl: string
  cancelUrl: string
}) {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret) {
    return {
      id: `dev_checkout_${Date.now().toString(36)}`,
      url: null,
      mode: 'dev',
      message: 'STRIPE_SECRET_KEY is not configured. This is a dry checkout response.',
    }
  }

  const body = new URLSearchParams()
  body.set('mode', 'subscription')
  body.set('line_items[0][price]', input.priceId)
  body.set('line_items[0][quantity]', '1')
  body.set('success_url', input.successUrl)
  body.set('cancel_url', input.cancelUrl)
  body.set('metadata[user_id]', input.userId)
  body.set('metadata[plan]', input.plan)
  body.set('subscription_data[metadata][user_id]', input.userId)
  body.set('subscription_data[metadata][plan]', input.plan)

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const json = await response.json() as { id?: string; url?: string; error?: { message?: string } }
  if (!response.ok) throw new Error(json.error?.message || `Stripe checkout failed with ${response.status}`)
  return { id: json.id, url: json.url, mode: 'stripe' }
}

function applyStripeEvent(event: Record<string, unknown>): { processed: boolean; summary: string } {
  const eventId = String(event.id || '')
  if (!eventId) throw new Error('Stripe event missing id.')
  const firstSeen = markWebhookEventProcessed(eventId)
  if (!firstSeen) return { processed: false, summary: 'Duplicate Stripe event ignored.' }

  const type = String(event.type || '')
  const data = event.data as { object?: Record<string, unknown> } | undefined
  const object = data?.object || {}
  const metadata = (object.metadata || {}) as Record<string, unknown>
  const userId = String(metadata.user_id || metadata.userId || '')
  const plan = normalizeAccessPlan(metadata.plan)

  if (type === 'checkout.session.completed') {
    if (!userId) return { processed: true, summary: 'Checkout completed without AGNT user metadata.' }
    upsertSubscription({
      userId,
      plan,
      status: 'active',
      provider: 'stripe',
      providerCustomerId: typeof object.customer === 'string' ? object.customer : undefined,
      providerSubscriptionId: typeof object.subscription === 'string' ? object.subscription : undefined,
    })
    recordPaymentEvent({ userId, provider: 'stripe', status: 'checkout.session.completed', stripeEventId: eventId })
    return { processed: true, summary: `Activated ${plan} for ${userId}.` }
  }

  if (type.startsWith('customer.subscription.')) {
    const subUserId = userId || String(metadata.agnt_user_id || '')
    if (!subUserId) return { processed: true, summary: 'Subscription event missing AGNT user metadata.' }
    const periodStart = typeof object.current_period_start === 'number' ? new Date(object.current_period_start * 1000).toISOString() : undefined
    const periodEnd = typeof object.current_period_end === 'number' ? new Date(object.current_period_end * 1000).toISOString() : undefined
    const rawStatus = type === 'customer.subscription.deleted' ? 'expired' : object.status
    upsertSubscription({
      userId: subUserId,
      plan,
      status: normalizeSubscriptionStatus(rawStatus),
      provider: 'stripe',
      providerCustomerId: typeof object.customer === 'string' ? object.customer : undefined,
      providerSubscriptionId: typeof object.id === 'string' ? object.id : undefined,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: object.cancel_at_period_end === true,
    })
    return { processed: true, summary: `Updated Stripe subscription for ${subUserId}.` }
  }

  if (type === 'invoice.payment_failed' || type === 'invoice.payment_succeeded') {
    recordPaymentEvent({
      provider: 'stripe',
      status: type,
      stripeInvoiceId: typeof object.id === 'string' ? object.id : undefined,
      stripeEventId: eventId,
    })
    return { processed: true, summary: `Recorded ${type}.` }
  }

  return { processed: true, summary: `Stored idempotency for unsupported event ${type}.` }
}

if (HACKATHON_MODE) {
  app.use('/access', (_req, res) => sendHackathonDisabled(res, 'access and API keys'))
  app.use('/auth', (_req, res) => sendHackathonDisabled(res, 'login and signup'))
  app.use('/dashboard', (_req, res) => sendHackathonDisabled(res, 'dashboard'))
  app.use('/public/checkout', (_req, res) => sendHackathonDisabled(res, 'checkout'))
  app.use('/billing', (_req, res) => sendHackathonDisabled(res, 'billing'))
}

app.post('/access/bootstrap', requireAdmin, express.json(), (req, res) => {
  const body = req.body as { email?: string; walletAddress?: string; plan?: AccessPlan; label?: string }
  const user = createUser({ email: body.email, walletAddress: body.walletAddress })
  if (body.plan && body.plan !== 'free') {
    upsertSubscription({ userId: user.id, plan: normalizeAccessPlan(body.plan), status: 'active', provider: 'manual' })
  }
  const apiKey = createApiKey(user.id, body.label || 'bootstrap')
  res.json({
    user,
    apiKey: apiKey.apiKey,
    apiKeyId: apiKey.record.id,
    warning: 'This is the only time the API key is returned. Store it securely.',
  })
})

app.get('/access/me', requireAccessAuth, (req, res) => {
  const auth = getAuthForRequest(req)!
  const store = loadAccessStore()
  const keys = store.apiKeys
    .filter((key) => key.userId === auth.userId)
    .map(({ keyHash: _keyHash, ...safe }) => safe)
  res.json({
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
    plan: auth.plan,
    subscriptionStatus: auth.subscriptionStatus,
    entitlement: auth.entitlement,
    subscription: getCurrentSubscription(auth.userId),
    apiKeys: keys,
  })
})

app.post('/access/api-keys', requireAccessAuth, express.json(), (req, res) => {
  const auth = getAuthForRequest(req)!
  const body = req.body as { label?: string }
  const result = createApiKey(auth.userId, body.label || 'generated')
  res.json({
    apiKey: result.apiKey,
    apiKeyId: result.record.id,
    prefix: result.record.prefix,
    warning: 'This is the only time the API key is returned. Store it securely.',
  })
})

app.delete('/access/api-keys/:id', requireAccessAuth, (req, res) => {
  const auth = getAuthForRequest(req)!
  const revoked = revokeApiKey(String(req.params.id), auth.userId)
  if (!revoked) {
    res.status(404).json({ error: 'api_key_not_found' })
    return
  }
  res.json({ revoked: true, apiKeyId: revoked.id })
})

app.post('/auth/email/start', express.json(), (req, res) => {
  try {
    const body = req.body as { email?: string }
    const result = startEmailLogin(body.email || '')
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: 'email_start_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/auth/signup', express.json(), (req, res) => {
  try {
    const body = req.body as { email?: string; password?: string }
    const result = signupDashboard({ email: body.email || '', password: body.password || '' })
    setDashboardCookie(res, result.sessionToken)
    res.json({
      user: result.user,
      plan: result.auth.plan,
      subscriptionStatus: result.auth.subscriptionStatus,
      entitlement: result.auth.entitlement,
    })
  } catch (e) {
    res.status(400).json({ error: 'signup_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/auth/login', express.json(), (req, res) => {
  try {
    const body = req.body as { email?: string; password?: string }
    const result = loginDashboard({ email: body.email || '', password: body.password || '' })
    setDashboardCookie(res, result.sessionToken)
    res.json({
      user: result.user,
      plan: result.auth.plan,
      subscriptionStatus: result.auth.subscriptionStatus,
      entitlement: result.auth.entitlement,
    })
  } catch (e) {
    res.status(400).json({ error: 'login_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/auth/email/verify', express.json(), (req, res) => {
  try {
    const body = req.body as { email?: string; code?: string }
    const result = verifyEmailLogin({ email: body.email || '', code: body.code || '' })
    setDashboardCookie(res, result.sessionToken)
    res.json({
      user: result.user,
      plan: result.auth.plan,
      subscriptionStatus: result.auth.subscriptionStatus,
      entitlement: result.auth.entitlement,
    })
  } catch (e) {
    res.status(400).json({ error: 'email_verify_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/auth/logout', (req, res) => {
  logoutDashboardSession(getDashboardToken(req))
  clearDashboardCookie(res)
  res.json({ ok: true })
})

app.get('/dashboard/me', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const store = loadAccessStore()
  const usage = store.usage.find((entry) => entry.userId === dashboard.user.id) || null
  const customSources = listCustomSources(dashboard.user.id)
  const automations = listAutomationsForUser(dashboard.user.id)
  res.json({
    user: dashboard.user,
    plan: dashboard.auth.plan,
    subscriptionStatus: dashboard.auth.subscriptionStatus,
    entitlement: dashboard.auth.entitlement,
    subscription: getCurrentSubscription(dashboard.user.id),
    usage,
    counts: {
      automations: automations.length,
      activeAutomations: automations.filter((automation) => automation.status === 'active').length,
      customSources: customSources.length,
    },
    apiKeys: hasPaidDashboardAccess(dashboard.auth) ? listApiKeysForUser(dashboard.user.id) : [],
  })
})

app.get('/dashboard/api-keys', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  if (!hasPaidDashboardAccess(dashboard.auth)) {
    res.json({ apiKeys: [] })
    return
  }
  res.json({ apiKeys: listApiKeysForUser(dashboard.user.id) })
})

app.get('/dashboard/connector-links', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  if (!hasPaidDashboardAccess(dashboard.auth)) {
    res.json({ connectorLinks: [] })
    return
  }
  res.json({ connectorLinks: listConnectorLinksForUser(dashboard.user.id) })
})

app.post('/dashboard/api-keys', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    if (!hasPaidDashboardAccess(dashboard.auth)) {
      res.status(403).json({ error: 'paid_plan_required', error_description: 'API keys are available on Pro and Ultra plans only.' })
      return
    }
    const body = req.body as { label?: string }
    const result = createApiKey(dashboard.user.id, body.label || 'dashboard')
    res.json({
      apiKey: result.apiKey,
      apiKeyId: result.record.id,
      prefix: result.record.prefix,
      apiKeys: listApiKeysForUser(dashboard.user.id),
    })
  } catch (e) {
    res.status(400).json({ error: 'api_key_create_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/dashboard/connector-links', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    if (!hasPaidDashboardAccess(dashboard.auth)) {
      res.status(403).json({ error: 'paid_plan_required', error_description: 'Claude connector links are available on Pro and Ultra plans only.' })
      return
    }
    const body = req.body as { label?: string; client?: string; apiKeyId?: string }
    const result = createConnectorLink(dashboard.user.id, {
      label: body.label || 'Claude connector',
      client: body.client || 'claude',
      apiKeyId: body.apiKeyId,
    })
    const baseUrl = `${req.protocol}://${req.headers.host}`
    res.json({
      connectorToken: result.token,
      connectorUrl: `${baseUrl}/mcp?agnt_connector_token=${encodeURIComponent(result.token)}`,
      connectorLinks: listConnectorLinksForUser(dashboard.user.id),
      warning: 'This connector URL is shown once. Revoke it from the dashboard if it leaks.',
    })
  } catch (e) {
    res.status(400).json({ error: 'connector_link_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.get('/dashboard/api-keys/:id/reveal', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  if (!hasPaidDashboardAccess(dashboard.auth)) {
    res.status(403).json({ error: 'paid_plan_required', error_description: 'API key reveal is available on Pro and Ultra plans only.' })
    return
  }
  const apiKey = revealApiKey(dashboard.user.id, String(req.params.id))
  if (!apiKey) {
    res.status(404).json({ error: 'api_key_unavailable', error_description: 'Older keys cannot be revealed. Create a new key if you need to copy it again.' })
    return
  }
  res.json({ apiKey })
})

app.delete('/dashboard/api-keys/:id', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const deleted = deleteApiKeyForUser(dashboard.user.id, String(req.params.id))
  if (!deleted) {
    res.status(404).json({ error: 'api_key_not_found' })
    return
  }
  res.json({ deleted: true, apiKeys: listApiKeysForUser(dashboard.user.id) })
})

app.delete('/dashboard/connector-links/:id', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const revoked = revokeConnectorLink(dashboard.user.id, String(req.params.id))
  if (!revoked) {
    res.status(404).json({ error: 'connector_link_not_found' })
    return
  }
  res.json({ revoked: true, connectorLinks: listConnectorLinksForUser(dashboard.user.id) })
})

app.get('/dashboard/automations', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  res.json({ automations: listAutomationsForUser(dashboard.user.id) })
})

app.get('/dashboard/history', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const automations = listAutomationsForUser(dashboard.user.id)
  const automationHistory = automations.flatMap((automation) => automation.history.map((entry) => ({
    kind: 'automation',
    automationId: automation.id,
    automationName: automation.name,
    title: automation.name,
    type: automation.type,
    ...entry,
  })))
  const activityHistory = listActivityForUser(dashboard.user.id, {
    limit: 100,
  }).map((entry) => ({
    kind: 'tool',
    automationId: entry.id,
    automationName: entry.title,
    title: entry.title,
    type: entry.tool,
    time: entry.time,
    result: entry.txHash ? `${entry.result}\nTx: ${entry.txHash}` : entry.result,
    success: entry.success,
  }))
  const history = [...automationHistory, ...activityHistory]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  res.json({ history })
})

app.get('/dashboard/wallets', requireDashboardAuth, async (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    if (!hasPaidDashboardAccess(dashboard.auth)) {
      res.json({ wallets: [], activeIndex: -1, exportAvailable: false, passwordSet: false })
      return
    }
    const wallets = await getDashboardWallets(req.headers.host)
    res.json(wallets)
  } catch (e) {
    res.status(400).json({ error: 'wallets_unavailable', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/dashboard/wallets/password', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const body = req.body as { password?: string }
    const result = setDashboardWalletPassword(req.headers.host, body.password || '')
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: 'wallet_password_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/dashboard/wallets/:name/reveal', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const body = req.body as { password?: string }
    const result = revealDashboardWalletPrivateKey(req.headers.host, String(req.params.name), body.password || '')
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: 'wallet_reveal_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.delete('/dashboard/wallets/:name', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    if (!hasPaidDashboardAccess(dashboard.auth)) {
      res.status(403).json({ error: 'paid_plan_required', error_description: 'Wallet management is available on Pro and Ultra plans only.' })
      return
    }
    const body = req.body as { password?: string }
    const result = deleteDashboardWallet(req.headers.host, String(req.params.name), body.password || '')
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: 'wallet_delete_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/dashboard/automations/:id/pause', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const automation = updateAutomationStatusForUser(String(req.params.id), dashboard.user.id, 'paused')
  if (!automation) {
    res.status(404).json({ error: 'automation_not_found' })
    return
  }
  unscheduleAutomation(automation.id)
  res.json({ automation })
})

app.post('/dashboard/automations/:id/resume', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const automation = updateAutomationStatusForUser(String(req.params.id), dashboard.user.id, 'active')
  if (!automation) {
    res.status(404).json({ error: 'automation_not_found' })
    return
  }
  scheduleNewAutomation(automation)
  res.json({ automation })
})

app.post('/dashboard/automations/:id/cancel', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const automation = updateAutomationStatusForUser(String(req.params.id), dashboard.user.id, 'completed')
  if (!automation) {
    res.status(404).json({ error: 'automation_not_found' })
    return
  }
  unscheduleAutomation(automation.id)
  res.json({ automation })
})

app.get('/dashboard/sources', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  res.json({
    sources: listCustomSources(dashboard.user.id),
    limit: dashboard.auth.entitlement.customSourceSlots,
  })
})

app.post('/dashboard/sources', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    const body = req.body as { handle?: string; displayName?: string; topics?: string[]; keywords?: string[]; enabled?: boolean; trustScore?: number }
    const source = createCustomSource(dashboard.user.id, {
      handle: body.handle || '',
      displayName: body.displayName,
      topics: body.topics || [],
      keywords: body.keywords,
      enabled: body.enabled,
      trustScore: body.trustScore,
    })
    res.json({ source, sources: listCustomSources(dashboard.user.id) })
  } catch (e) {
    res.status(400).json({ error: 'source_create_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.patch('/dashboard/sources/:id', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    const source = updateCustomSource(dashboard.user.id, String(req.params.id), req.body || {})
    if (!source) {
      res.status(404).json({ error: 'source_not_found' })
      return
    }
    res.json({ source, sources: listCustomSources(dashboard.user.id) })
  } catch (e) {
    res.status(400).json({ error: 'source_update_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.delete('/dashboard/sources/:id', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  const deleted = deleteCustomSource(dashboard.user.id, String(req.params.id))
  if (!deleted) {
    res.status(404).json({ error: 'source_not_found' })
    return
  }
  res.json({ deleted: true, sources: listCustomSources(dashboard.user.id) })
})

app.post('/public/checkout/crypto/quote', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    const body = req.body as { email?: string; walletAddress?: string; plan?: AccessPlan; provider?: 'crypto' | 'mpp'; months?: number; paymentNetwork?: string }
    const checkout = createPublicCryptoCheckoutQuote({
      email: dashboard.user.email || body.email || '',
      verifiedUserId: dashboard.user.id,
      walletAddress: body.walletAddress,
      plan: normalizeAccessPlan(body.plan),
      provider: body.provider || 'mpp',
      months: body.months || 1,
      paymentNetwork: body.paymentNetwork,
    })
    res.json(formatPublicCheckoutQuoteResponse(checkout.quote))
  } catch (e) {
    res.status(400).json({ error: 'public_crypto_quote_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/public/checkout/crypto/confirm', express.json(), async (req, res) => {
  try {
    const dashboard = resolveDashboardSession(getDashboardToken(req))
    if (!dashboard) {
      res.status(401).json({ error: 'email_login_required', error_description: 'Confirm your email before confirming checkout.' })
      return
    }
    const body = req.body as { email?: string; quoteId?: string; provider?: 'crypto' | 'mpp'; txHash?: string; payer?: string }
    if (!body.quoteId || !body.provider || !body.txHash) {
      res.status(400).json({ error: 'missing_fields', error_description: 'quoteId, provider, and txHash are required.' })
      return
    }
    const result = await confirmPublicCryptoCheckout({
      email: dashboard.user.email || body.email || '',
      verifiedUserId: dashboard.user.id,
      quoteId: body.quoteId,
      provider: body.provider,
      txHash: body.txHash,
      payer: body.payer,
    })
    res.status(result.applied ? 200 : 402).json({
      ...result,
      warning: result.apiKey ? 'This is the only time the API key is returned. Store it securely.' : undefined,
    })
  } catch (e) {
    res.status(400).json({ error: 'public_crypto_confirm_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/billing/checkout', requireAccessAuth, express.json(), async (req, res) => {
  try {
    const auth = getAuthForRequest(req)!
    const body = req.body as { plan?: AccessPlan; successUrl?: string; cancelUrl?: string }
    const plan = normalizeAccessPlan(body.plan)
    if (plan === 'free') {
      res.status(400).json({ error: 'invalid_plan', error_description: 'Checkout is only for Pro or Max.' })
      return
    }
    const priceId = stripePriceForPlan(plan)
    if (!priceId) {
      res.status(400).json({ error: 'missing_price', error_description: `Set STRIPE_PRICE_${plan.toUpperCase()} before creating checkout.` })
      return
    }

    const baseUrl = `${req.protocol}://${req.headers.host}`
    const checkout = await createStripeCheckoutSession({
      userId: auth.userId,
      plan,
      priceId,
      successUrl: body.successUrl || `${baseUrl}/billing/success`,
      cancelUrl: body.cancelUrl || `${baseUrl}/billing/cancel`,
    })
    res.json(checkout)
  } catch (e) {
    res.status(500).json({ error: 'checkout_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/billing/crypto/quote', requireAccessAuth, express.json(), (req, res) => {
  try {
    const auth = getAuthForRequest(req)!
    const body = req.body as { plan?: AccessPlan; provider?: 'crypto' | 'mpp'; months?: number }
    const quote = createCryptoAccessQuote({
      userId: auth.userId,
      plan: normalizeAccessPlan(body.plan),
      provider: body.provider || 'mpp',
      months: body.months || 1,
    })
    res.json({
      id: quote.id,
      provider: quote.provider,
      plan: quote.plan,
      amount: quote.amount,
      currency: quote.currency,
      network: quote.network,
      chainId: quote.chainId,
      recipient: quote.recipient,
      months: quote.months,
      expiresAt: quote.expiresAt,
      instructions: `Send exactly ${quote.amount} USDC-equivalent to ${quote.recipient} on ${quote.network}, then confirm with the transaction hash.`,
    })
  } catch (e) {
    res.status(400).json({ error: 'crypto_quote_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/billing/crypto/confirm', requireAccessAuth, express.json(), async (req, res) => {
  try {
    const auth = getAuthForRequest(req)!
    const body = req.body as { quoteId?: string; provider?: 'crypto' | 'mpp'; txHash?: string; payer?: string }
    if (!body.quoteId || !body.provider || !body.txHash) {
      res.status(400).json({ error: 'missing_fields', error_description: 'quoteId, provider, and txHash are required.' })
      return
    }
    const result = await applyCryptoAccessPayment({
      quoteId: body.quoteId,
      userId: auth.userId,
      provider: body.provider,
      txHash: body.txHash,
      payer: body.payer,
    })
    res.status(result.applied ? 200 : 402).json(result)
  } catch (e) {
    res.status(400).json({ error: 'crypto_confirm_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/billing/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}))
    const sig = req.headers['stripe-signature']
    const signatureHeader = Array.isArray(sig) ? sig[0] : sig
    if (!verifyStripeSignature(raw, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
      res.status(400).json({ error: 'invalid_signature' })
      return
    }
    const event = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    res.json(applyStripeEvent(event))
  } catch (e) {
    res.status(400).json({ error: 'webhook_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: sseSessions.size + streamableSessions.size, tools: TOOL_COUNT, version: '2.1.0', mpp: !HACKATHON_MODE, hackathonMode: HACKATHON_MODE, timestamp: new Date().toISOString() })
})

app.get('/pricing', (_req, res) => {
  const table = ALL_TOOLS.map(t => ({ name: t.name, tier: getToolTier(t.name), price: getToolPrice(t.name) }))
  res.json({ tools: table, tiers: { free: '$0', standard: '$0', premium: '$0' }, currency: 'USDC.e', hackathonMode: HACKATHON_MODE })
})

app.get('/stats', (_req, res) => {
  res.json(getStats())
})

// ─── A2A Protocol ─────────────────────────────────────────

const port = parseInt(process.env.AGNT_PORT || process.env.PORT || '3001', 10)

app.get('/agent-card', (_req, res) => {
  try {
    const cardPath = resolve(process.cwd(), 'public/.well-known/agent-card.json')
    const card = JSON.parse(readFileSync(cardPath, 'utf-8'))
    card.url = `http://localhost:${port}`
    res.json(card)
  } catch {
    res.status(500).json({ error: 'Agent card not found' })
  }
})

// Also serve at well-known path
app.get('/.well-known/agent.json', (_req, res) => {
  try {
    const cardPath = resolve(process.cwd(), 'public/.well-known/agent-card.json')
    const card = JSON.parse(readFileSync(cardPath, 'utf-8'))
    card.url = `http://localhost:${port}`
    res.json(card)
  } catch {
    res.status(500).json({ error: 'Agent card not found' })
  }
})

app.post('/a2a/tasks/send', requireAuth, express.json(), async (req, res) => {
  const { message, metadata } = req.body || {}
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Missing or invalid "message" field.' })
    return
  }
  const task = await submitTask(message, metadata)
  res.json(task)
})

app.get('/a2a/tasks/:id', requireAuth, (req, res) => {
  const task = getTask(req.params.id as string)
  if (!task) { res.status(404).json({ error: 'Task not found' }); return }
  res.json(task)
})

app.post('/a2a/tasks/:id/cancel', requireAuth, (req, res) => {
  const task = cancelTask(req.params.id as string)
  if (!task) { res.status(404).json({ error: 'Task not found' }); return }
  res.json(task)
})

app.get('/a2a/tasks', requireAuth, (req, res) => {
  const limit = parseInt((req.query.limit as string) || '50', 10)
  res.json({ tasks: listTasks(limit), stats: getTaskStats() })
})

// ─── Start ───────────────────────────────────────────────

async function start() {
  // Load skills from skills/ directory before starting
  await initSkills()

  app.listen(port, '::', () => {
    console.log(`\n./AGNT MCP Server v2.1 (Streamable HTTP + SSE + MPP + A2A) — ${ALL_TOOLS.length} tools`)
    console.log(`Streamable HTTP: http://localhost:${port}/mcp  (Antigravity, modern clients)`)
    console.log(`Legacy SSE:      http://localhost:${port}/sse  (Cursor, Claude Desktop)`)
    console.log(`Agent Card:      http://localhost:${port}/agent-card`)
    console.log(`A2A Tasks:       http://localhost:${port}/a2a/tasks`)
    console.log(`Health:          http://localhost:${port}/health`)
    console.log(`Pricing:         http://localhost:${port}/pricing`)
    console.log(`Stats:           http://localhost:${port}/stats\n`)
    startAutomationRunner()
  })
}

start()
