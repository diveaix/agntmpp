/**
 * ./AGNT Protocol — Hono Backend Server
 * Serves the React SPA and provides API endpoints.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { TOKENS, CONTRACTS, STARGATE, CHAIN_EIDS, TEMPO_CHAIN } from '../mcp/config.js'
import { submitTask, getTask, cancelTask, listTasks, getTaskStats } from '../mcp/a2a.js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const app = new Hono()

// CORS for dev
app.use('/api/*', cors())

const MCP_UPSTREAM = process.env.AGNT_MCP_HTTP_URL || 'http://localhost:3001'

async function proxyToMcp(c: { req: { url: string; method: string; raw: Request } }) {
  const incoming = new URL(c.req.url)
  const upstream = new URL(`${incoming.pathname}${incoming.search}`, MCP_UPSTREAM)
  const headers = new Headers(c.req.raw.headers)
  headers.set('host', upstream.host)

  const body = c.req.method === 'GET' || c.req.method === 'HEAD'
    ? undefined
    : await c.req.raw.arrayBuffer()

  try {
    const response = await fetch(upstream, {
      method: c.req.method,
      headers,
      body,
      redirect: 'manual',
    })
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'mcp_backend_unreachable',
      error_description: `Could not reach AGNT MCP backend at ${MCP_UPSTREAM}. Start it with npm run mcp:serve.`,
      detail: error instanceof Error ? error.message : String(error),
    }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}

app.all('/auth/*', proxyToMcp)
app.all('/dashboard/*', proxyToMcp)
app.all('/public/checkout/*', proxyToMcp)

// ─── Existing API Routes ──────────────────────────────────

app.get('/api/tokens', (c) => {
  return c.json({
    chain: { id: TEMPO_CHAIN.id, name: TEMPO_CHAIN.name, rpc: TEMPO_CHAIN.rpc },
    tokens: Object.entries(TOKENS).map(([symbol, token]) => ({
      symbol,
      name: token.name,
      address: token.address,
      decimals: token.decimals,
    })),
  })
})

app.get('/api/chain-info', (c) => {
  return c.json({
    chain: {
      id: TEMPO_CHAIN.id,
      name: TEMPO_CHAIN.name,
      rpc: TEMPO_CHAIN.rpc,
      explorer: TEMPO_CHAIN.explorer,
    },
    contracts: CONTRACTS,
    stargate: STARGATE,
    bridgeDestinations: Object.entries(CHAIN_EIDS).map(([key, value]) => ({
      key,
      name: value.name,
      eid: value.eid,
    })),
  })
})

app.get('/api/mcp-config', (c) => {
  return c.json({
    mcpServers: {
      'agnt-protocol': {
        command: 'npx',
        args: ['tsx', 'src/mcp/server.ts'],
        env: {},
      },
    },
  })
})

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})



// ─── A2A Protocol (Agent-to-Agent) ────────────────────────

/**
 * GET /.well-known/agent.json
 * A2A Agent Card — enables other agents to discover ./AGNT's capabilities.
 */
app.get('/.well-known/agent.json', (c) => {
  try {
    const cardPath = resolve(process.cwd(), 'public/.well-known/agent-card.json')
    const card = JSON.parse(readFileSync(cardPath, 'utf-8'))
    // Inject dynamic URL based on request
    const host = c.req.header('host') || `localhost:${port}`
    const protocol = c.req.header('x-forwarded-proto') || 'http'
    card.url = `${protocol}://${host}`
    return c.json(card)
  } catch {
    return c.json({ error: 'Agent card not found' }, 500)
  }
})

/**
 * POST /a2a/tasks/send
 * Submit a new A2A task. The task is executed synchronously and returned.
 * Body: { message: string, metadata?: object }
 */
app.post('/a2a/tasks/send', async (c) => {
  let body: { message?: string; metadata?: Record<string, unknown> }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400)
  }

  if (!body.message || typeof body.message !== 'string') {
    return c.json({ error: 'Missing or invalid "message" field.' }, 400)
  }

  const task = await submitTask(body.message, body.metadata)
  return c.json(task)
})

/**
 * GET /a2a/tasks/:id
 * Get the status and result of a specific task.
 */
app.get('/a2a/tasks/:id', (c) => {
  const id = c.req.param('id')
  const task = getTask(id)
  if (!task) return c.json({ error: 'Task not found' }, 404)
  return c.json(task)
})

/**
 * POST /a2a/tasks/:id/cancel
 * Cancel a running task.
 */
app.post('/a2a/tasks/:id/cancel', (c) => {
  const id = c.req.param('id')
  const task = cancelTask(id)
  if (!task) return c.json({ error: 'Task not found' }, 404)
  return c.json(task)
})

/**
 * GET /a2a/tasks
 * List recent tasks with optional limit query param.
 */
app.get('/a2a/tasks', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10)
  return c.json({ tasks: listTasks(limit), stats: getTaskStats() })
})

// ─── Static Files (production) ───────────────────────────

app.use('/*', serveStatic({ root: './dist/client' }))

// SPA fallback
app.get('*', serveStatic({ path: './dist/client/index.html' }))

// ─── Start ───────────────────────────────────────────────

const port = parseInt(process.env.PORT || '3000', 10)

function startServer(retries = 3) {
  const server = serve({ fetch: app.fetch, port })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] Port ${port} is in use.${retries > 0 ? ' Retrying in 2s...' : ' Giving up.'}`)
      if (retries > 0) {
        setTimeout(() => startServer(retries - 1), 2000)
      } else {
        console.error(`[server] Could not bind to port ${port} after retries. Kill the process using it:`)
        console.error(`         netstat -ano | findstr :${port}`)
        process.exit(1)
      }
    } else {
      console.error('[server] Fatal error:', err)
      process.exit(1)
    }
  })

  server.on('listening', () => {
    console.log(`./AGNT Backend running on http://localhost:${port}`)
    console.log(`A2A Agent Card:  http://localhost:${port}/.well-known/agent.json`)
    console.log(`A2A Tasks:       http://localhost:${port}/a2a/tasks`)
  })
}

startServer()
