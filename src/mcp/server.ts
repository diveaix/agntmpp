/**
 * ./AGENT Protocol — MCP Server (Stdio Transport)
 * DeFi toolkit for AI agents on supported EVM networks.
 * Supports stdio (local) transport for Claude Desktop, Cursor, etc.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { ALL_TOOLS, handleTool, TOOL_COUNT } from './tools/index.js'
import { SUPPORTED_CHAINS } from './chains.js'

// ─── Server ──────────────────────────────────────────────

const server = new Server({ name: 'agent-protocol', version: '2.1.0' }, { capabilities: { tools: {}, resources: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const meta = (req.params as Record<string, unknown>)?._meta as Record<string, unknown> | undefined
    return await handleTool(req.params.name, (req.params.arguments || {}) as Record<string, unknown>, meta)
  }
  catch (e) { return { content: [{ type: 'text' as const, text: `❌ ${e instanceof Error ? e.message : String(e)}` }], isError: true } }
})

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'agent://info', name: './AGENT Protocol', description: 'Protocol info and available tools.', mimeType: 'text/plain' },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'agent://info' || req.params.uri === 'agnt://info') {
    return { contents: [{ uri: req.params.uri, mimeType: 'text/plain', text:
      `./AGENT — Agent DeFi Toolkit (v2.1 + A2A)\n` +
      `Supported Chains: ${Object.values(SUPPORTED_CHAINS).map(c => c.label).join(', ')}\n\n` +
      `Tools (${TOOL_COUNT}): ${ALL_TOOLS.map(t => t.name).join(', ')}\n` +
      `Agent Features: Memory (persistent), Telegram Bridge, A2A Tasks`
    }] }
  }
  throw new Error(`Unknown resource: ${req.params.uri}`)
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`./AGENT MCP Server v2.1 running (stdio + A2A) — ${TOOL_COUNT} tools`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
