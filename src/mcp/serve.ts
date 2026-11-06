/**
 * ./AGENT Protocol — Hosted MCP Server (Streamable HTTP + Legacy SSE)
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
import { recentSaleAuth } from './sale/recent-auth.js'
import { describePassAccess } from './sale/runtime.js'
import cors from 'cors'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { ALL_TOOLS, handleTool, TOOL_COUNT, initSkills } from './tools/index.js'
import { SUPPORTED_CHAINS } from './chains.js'
import { getStats } from './payment-tracker.js'
import { submitTask, getTask, cancelTask, listTasks, getTaskStats } from './a2a.js'
import { listAutomationsForUser } from './scheduler.js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { AuthContext } from './access-types.js'
import {
  createApiKey,
  createConnectorLink,
  createUser,
  deleteApiKeyForUser,
  listApiKeysForUser,
  listConnectorLinksForUser,
  loadAccessStore,
  revealApiKey,
  revokeConnectorLink,
  revokeApiKey,
} from './access-store.js'
import { isAccessRequired, resolveAuthContextFromHeaders, resolveAuthContextFromRequest } from './access-control.js'
import {
  deleteDashboardWallet,
  getDashboardWallets,
  revealDashboardWalletPrivateKey,
  setDashboardWalletPassword,
} from './dashboard-wallets.js'
import { listActivityForUser } from './activity-log.js'
import { runWithToolContext } from './tool-context.js'
import {
  logoutDashboardSession,
  publicDashboardUser,
  loginDashboard,
  resetDashboardPassword,
  resolveDashboardSession,
  signupDashboardVerified,
  startEmailLoginWithDelivery,
  verifyEmailLogin,
  type DashboardSessionContext,
} from './dashboard-auth.js'
import { setWalletExportPassword } from './wallet-vault.js'
import { ACCESS_PAUSED, FEATURE_DISABLED_MESSAGE } from '../product-mode.js'
import { DASHBOARD_DISABLED_RESPONSE, isDashboardDisabledPath } from '../dashboard-access.js'
import { flushMemory } from './memory.js'
import { getPassphrase } from './crypto.js'
import { allowedOrigins, validateProductionConfig } from './production-readiness.js'
import { saleRouter } from './sale/routes.js'
import { configuredSaleProviders } from './sale/provider-config.js'

// ─── Create MCP Server instance ──────────────────────────

function createMcpServer(auth?: AuthContext, walletScope?: string | (() => string | undefined)) {
  const server = new Server({ name: 'agent-protocol', version: '2.1.0' }, { capabilities: { tools: {}, resources: {} } })

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
      { uri: 'agent://info', name: './AGENT Protocol', description: 'Protocol info.', mimeType: 'text/plain' },
    ],
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return {
    contents: [{ uri: req.params.uri === 'agnt://info' ? req.params.uri : 'agent://info', mimeType: 'text/plain', text:
      `./AGENT — Agent DeFi Toolkit v2.1 (${TOOL_COUNT} tools)\n` +
      `Chains: ${Object.values(SUPPORTED_CHAINS).map(c => c.label).join(', ')}\n` +
      `Tools: ${ALL_TOOLS.map(t => t.name).join(', ')}`
    }],
    }
  })

  return server
}

// ─── Express Server & Security ───────────────────────────

const app = express()
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(['/auth','/dashboard','/access'],(_req,res,next)=>{
  res.setHeader('Cache-Control','no-store')
  next()
})
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  next()
})
app.use((req, res, next) => {
  if (isDashboardDisabledPath(req.path)) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(503).json(DASHBOARD_DISABLED_RESPONSE)
    return
  }
  next()
})
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins().includes(origin)) callback(null, true)
    else callback(null, false)
  },
}))

// API Rate Limiting to prevent mass calling and abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
})
app.use(apiLimiter)

const JWT_SECRET = getPassphrase()
type AuthedRequest = express.Request & { agntAuth?: AuthContext; dashboard?: DashboardSessionContext }

function getAuthForRequest(req: express.Request): AuthContext | undefined {
  return (req as AuthedRequest).agntAuth
}

function getHeaderString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function resolvePersistentWalletScope(req: express.Request, auth?: AuthContext): string {
  if (auth) return `user:${auth.userId}`
  if (!isAccessRequired()) return 'local:dev'
  throw new Error('Authenticated API key or connector token is required before wallets can be used.')
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

const requireRecentSaleAuth=recentSaleAuth(req=>(req as AuthedRequest).dashboard?.session.createdAt)
const authenticateSale:express.RequestHandler=(req,res,next)=>requireDashboardAuth(req,res,()=>requireRecentSaleAuth(req,res,next))
app.use('/api/sale', saleRouter(authenticateSale, req => (req as AuthedRequest).dashboard!.user.id, allowedOrigins, configuredSaleProviders()))

function buildDashboardHistory(userId: string) {
  const automations = listAutomationsForUser(userId)
  const automationHistory = automations.flatMap((automation) => automation.history.map((entry) => ({
    kind: 'automation',
    automationId: automation.id,
    automationName: automation.name,
    title: automation.name,
    type: automation.type,
    ...entry,
  })))
  const activityHistory = listActivityForUser(userId, {
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
  return [...automationHistory, ...activityHistory]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
}

async function buildDashboardSnapshot(dashboard: DashboardSessionContext, hostHeader?: string) {
  const wallets = await runWithToolContext(
    { auth: dashboard.auth, walletScope: `user:${dashboard.user.id}` },
    () => getDashboardWallets(hostHeader),
  )
  const me = {
    user: publicDashboardUser(dashboard.user),
    apiKeys: listApiKeysForUser(dashboard.user.id),
    collectibleAccess: await describePassAccess(dashboard.user.id),
  }
  return {
    me,
    apiKeys: me.apiKeys,
    connectorLinks: listConnectorLinksForUser(dashboard.user.id),
    history: buildDashboardHistory(dashboard.user.id),
    wallets: wallets.wallets,
    walletExportAvailable: wallets.exportAvailable,
    walletPasswordSet: wallets.passwordSet,
  }
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

function sendFeatureDisabled(res: express.Response, feature: string) {
  res.status(403).json({
    error: 'feature_disabled',
    feature,
    error_description: FEATURE_DISABLED_MESSAGE,
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
  const validSecret = process.env.AGNT_PASSPHRASE
  if (!validSecret) {
    res.status(403).json({ error: 'oauth_disabled', error_description: 'Legacy OAuth token issuing is disabled. Use AGENT API keys or connector tokens.' })
    return
  }
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

// Auth Middleware to protect MCP endpoints.
// Access fails closed by default. Local development can opt out with
// AGNT_ACCESS_REQUIRED=false, but production ignores that opt-out.
const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (ACCESS_PAUSED) {
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

  if (!isAccessRequired()) return next()

  res.status(401).json({
    error: 'invalid_api_key',
    error_description: 'Provide x-agnt-api-key, Authorization: Bearer agnt_live_..., or a valid AGENT connector token.',
  })
}

function getSessionAuthOrReject(req: express.Request, res: express.Response): AuthContext | undefined {
  const auth = getAuthForRequest(req)
  if (auth || !isAccessRequired()) return auth
  res.status(401).json({
    error: 'invalid_api_key',
    error_description: 'Authenticated wallet access requires an API key or connector token.',
  })
  return undefined
}

/*
  Legacy JWT token support remains exposed for old clients that probe OAuth
  metadata, but MCP wallet access no longer accepts those tokens. Every hosted
  wallet scope must resolve to an AGENT user through an API key or connector.
*/
function verifyLegacyJwt(req: express.Request): boolean {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  const token = authHeader.split(' ')[1]
  try {
    jwt.verify(token, JWT_SECRET)
    return true
  } catch {
    return false
  }
}

function requireLegacyJwtOrAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  const accessAuth = resolveAuthContextFromRequest(req.headers, req.originalUrl || req.url)
  if (accessAuth) {
    ;(req as AuthedRequest).agntAuth = accessAuth
    return next()
  }
  if (!isAccessRequired() || verifyLegacyJwt(req)) {
    next()
    return
  }
  res.status(401).json({ error: 'invalid_token', error_description: 'Missing or invalid token' })
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

if (ACCESS_PAUSED) {
  app.use('/access', (_req, res) => sendFeatureDisabled(res, 'access and API keys'))
  app.use('/auth', (_req, res) => sendFeatureDisabled(res, 'login and signup'))
  app.use('/dashboard', (_req, res) => sendFeatureDisabled(res, 'dashboard'))
}

app.post('/access/bootstrap', requireAdmin, express.json(), (req, res) => {
  const body = req.body as { email?: string; walletAddress?: string; label?: string }
  const user = createUser({ email: body.email, walletAddress: body.walletAddress })

  const apiKey = createApiKey(user.id, body.label || 'bootstrap')
  res.json({
    user: publicDashboardUser(user),
    apiKey: apiKey.apiKey,
    apiKeyId: apiKey.record.id,
    warning: 'This is the only time the API key is returned. Store it securely.',
  })
})

app.get('/access/me', requireAccessAuth, (req, res) => {
  const auth = getAuthForRequest(req)!
  const keys = listApiKeysForUser(auth.userId)
  res.json({
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
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

app.post('/auth/email/start', express.json(), async (req, res) => {
  try {
    const body = req.body as { email?: string }
    const result = await startEmailLoginWithDelivery(body.email || '')
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: 'email_start_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/auth/signup', express.json(), async (req, res) => {
  try {
    const body = req.body as { email?: string; password?: string; code?: string }
    const result = signupDashboardVerified({ email: body.email || '', password: body.password || '', code: body.code || '' })
    await runWithToolContext({ auth: result.auth, walletScope: `user:${result.user.id}` }, async () => {
      setWalletExportPassword(body.password || '')
    })
    setDashboardCookie(res, result.sessionToken)
    res.json({
      user: publicDashboardUser(result.user),
    })
  } catch (e) {
    res.status(400).json({ error: 'signup_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/auth/password/reset', express.json(), async (req, res) => {
  try {
    const body = req.body as { email?: string; code?: string; password?: string }
    const result = resetDashboardPassword({ email: body.email || '', code: body.code || '', password: body.password || '' })
    await runWithToolContext({ auth: result.auth, walletScope: `user:${result.user.id}` }, async () => {
      setWalletExportPassword(body.password || '')
    })
    setDashboardCookie(res, result.sessionToken)
    res.json({
      user: publicDashboardUser(result.user),
    })
  } catch (e) {
    res.status(400).json({ error: 'password_reset_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/auth/login', express.json(), (req, res) => {
  try {
    const body = req.body as { email?: string; password?: string }
    const result = loginDashboard({ email: body.email || '', password: body.password || '' })
    setDashboardCookie(res, result.sessionToken)
    res.json({
      user: publicDashboardUser(result.user),
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
      user: publicDashboardUser(result.user),
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
  buildDashboardSnapshot(dashboard, req.headers.host)
    .then((snapshot) => res.json(snapshot.me))
    .catch((e) => res.status(400).json({ error: 'dashboard_unavailable', error_description: e instanceof Error ? e.message : String(e) }))
})

app.get('/dashboard/snapshot', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  buildDashboardSnapshot(dashboard, req.headers.host)
    .then((snapshot) => res.json(snapshot))
    .catch((e) => res.status(400).json({ error: 'dashboard_unavailable', error_description: e instanceof Error ? e.message : String(e) }))
})

app.get('/dashboard/api-keys', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  res.json({ apiKeys: listApiKeysForUser(dashboard.user.id) })
})

app.get('/dashboard/connector-links', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  res.json({ connectorLinks: listConnectorLinksForUser(dashboard.user.id) })
})

app.post('/dashboard/api-keys', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
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

app.get('/dashboard/history', requireDashboardAuth, (req, res) => {
  const dashboard = (req as AuthedRequest).dashboard!
  res.json({ history: buildDashboardHistory(dashboard.user.id) })
})

app.get('/dashboard/wallets', requireDashboardAuth, async (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    const wallets = await runWithToolContext(
      { auth: dashboard.auth, walletScope: `user:${dashboard.user.id}` },
      () => getDashboardWallets(req.headers.host),
    )
    res.json(wallets)
  } catch (e) {
    res.status(400).json({ error: 'wallets_unavailable', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/dashboard/wallets/password', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    const body = req.body as { password?: string }
    runWithToolContext(
      { auth: dashboard.auth, walletScope: `user:${dashboard.user.id}` },
      async () => setDashboardWalletPassword(req.headers.host, body.password || ''),
    ).then((result) => res.json(result))
      .catch((e) => res.status(400).json({ error: 'wallet_password_failed', error_description: e instanceof Error ? e.message : String(e) }))
  } catch (e) {
    res.status(400).json({ error: 'wallet_password_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/dashboard/wallets/:name/reveal', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    const body = req.body as { password?: string }
    runWithToolContext(
      { auth: dashboard.auth, walletScope: `user:${dashboard.user.id}` },
      async () => revealDashboardWalletPrivateKey(req.headers.host, String(req.params.name), body.password || ''),
    ).then((result) => res.json(result))
      .catch((e) => res.status(400).json({ error: 'wallet_reveal_failed', error_description: e instanceof Error ? e.message : String(e) }))
  } catch (e) {
    res.status(400).json({ error: 'wallet_reveal_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.delete('/dashboard/wallets/:name', requireDashboardAuth, express.json(), (req, res) => {
  try {
    const dashboard = (req as AuthedRequest).dashboard!
    const body = req.body as { password?: string }
    runWithToolContext(
      { auth: dashboard.auth, walletScope: `user:${dashboard.user.id}` },
      async () => deleteDashboardWallet(req.headers.host, String(req.params.name), body.password || ''),
    ).then((result) => res.json(result))
      .catch((e) => res.status(400).json({ error: 'wallet_delete_failed', error_description: e instanceof Error ? e.message : String(e) }))
  } catch (e) {
    res.status(400).json({ error: 'wallet_delete_failed', error_description: e instanceof Error ? e.message : String(e) })
  }
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: sseSessions.size + streamableSessions.size, tools: TOOL_COUNT, version: '2.1.0', mpp: false, accessPaused: ACCESS_PAUSED, timestamp: new Date().toISOString() })
})

app.get('/ready', (_req, res) => {
  try {
    validateProductionConfig()
    loadAccessStore()
    res.json({ status: 'ready' })
  } catch (error) {
    res.status(503).json({ status: 'not_ready', error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/stats', (_req, res) => {
  res.json(getStats())
})

// ─── A2A Protocol ─────────────────────────────────────────

const port = parseInt(process.env.AGNT_PORT || process.env.PORT || '3001', 10)

function publicRequestUrl(req: express.Request): string {
  const protocol = getHeaderString(req.headers['x-forwarded-proto']) || req.protocol
  return `${protocol}://${req.get('host') || `localhost:${port}`}`
}

app.get('/agent-card', (req, res) => {
  try {
    const cardPath = resolve(process.cwd(), 'public/.well-known/agent-card.json')
    const card = JSON.parse(readFileSync(cardPath, 'utf-8'))
    card.url = publicRequestUrl(req)
    res.json(card)
  } catch {
    res.status(500).json({ error: 'Agent card not found' })
  }
})

// Also serve at well-known path
app.get('/.well-known/agent.json', (req, res) => {
  try {
    const cardPath = resolve(process.cwd(), 'public/.well-known/agent-card.json')
    const card = JSON.parse(readFileSync(cardPath, 'utf-8'))
    card.url = publicRequestUrl(req)
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
  const task = await submitTask(message, metadata, getAuthForRequest(req))
  res.json(task)
})

app.get('/a2a/tasks/:id', requireAuth, (req, res) => {
  const task = getTask(req.params.id as string, getAuthForRequest(req)?.userId)
  if (!task) { res.status(404).json({ error: 'Task not found' }); return }
  res.json(task)
})

app.post('/a2a/tasks/:id/cancel', requireAuth, (req, res) => {
  const task = cancelTask(req.params.id as string, getAuthForRequest(req)?.userId)
  if (!task) { res.status(404).json({ error: 'Task not found' }); return }
  res.json(task)
})

app.get('/a2a/tasks', requireAuth, (req, res) => {
  const limit = parseInt((req.query.limit as string) || '50', 10)
  const userId = getAuthForRequest(req)?.userId
  res.json({ tasks: listTasks(limit, userId), stats: getTaskStats(userId) })
})

// ─── Start ───────────────────────────────────────────────

async function start() {
  validateProductionConfig()
  // Load skills from skills/ directory before starting
  await initSkills()

  const httpServer = app.listen(port, '::', () => {
    console.log(`\n./AGENT MCP Server v2.1 (Streamable HTTP + SSE + A2A) — ${ALL_TOOLS.length} tools`)
    console.log(`Streamable HTTP: http://localhost:${port}/mcp  (Antigravity, modern clients)`)
    console.log(`Legacy SSE:      http://localhost:${port}/sse  (Cursor, Claude Desktop)`)
    console.log(`Agent Card:      http://localhost:${port}/agent-card`)
    console.log(`A2A Tasks:       http://localhost:${port}/a2a/tasks`)
    console.log(`Health/ready:    http://localhost:${port}/health  http://localhost:${port}/ready`)
    console.log(`Stats:           http://localhost:${port}/stats\n`)
  })

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] ${signal} received; shutting down.`)
    flushMemory()
    httpServer.close((error) => {
      if (error) console.error('[server] Shutdown error:', error)
      process.exit(error ? 1 : 0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

start().catch((error) => {
  console.error('[server] Startup failed:', error)
  process.exit(1)
})
