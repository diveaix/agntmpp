/**
 * ./AGNT Protocol — MCP Server (Stdio Transport)
 * DeFi toolkit for AI agents on Tempo chain + Hyperliquid + Multi-chain.
 * Supports stdio (local) transport for Claude Desktop, Cursor, etc.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { TEMPO_CHAIN, TOKENS } from './config.js'
import { CHAIN_EIDS } from './config.js'
import { ALL_TOOLS, handleTool, TOOL_COUNT } from './tools/index.js'
import { SUPPORTED_CHAINS } from './chains.js'
import { formatBillingCatalog } from './billing-catalog.js'

// ─── Server ──────────────────────────────────────────────

const server = new Server({ name: 'agnt-protocol', version: '2.1.0' }, { capabilities: { tools: {}, resources: {} } })

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
    { uri: 'agnt://info', name: './AGNT Protocol', description: 'Protocol info and available tools.', mimeType: 'text/plain' },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'agnt://info') {
    return { contents: [{ uri: 'agnt://info', mimeType: 'text/plain', text:
      `./AGNT — Agent DeFi Toolkit (v2.1 + MPP + A2A)\n` +
      `Payment: MPP (Machine Payments Protocol) — USDC.e on Tempo\n` +
      `Chain: Tempo (${TEMPO_CHAIN.id}) | RPC: ${TEMPO_CHAIN.rpc}\n` +
      `Supported Chains: ${Object.values(SUPPORTED_CHAINS).map(c => c.label).join(', ')}\n\n` +
      `Tools (${TOOL_COUNT}): ${ALL_TOOLS.map(t => t.name).join(', ')}\n` +
      `Tokens: ${Object.keys(TOKENS).join(', ')}\n` +
      `Bridge: ${Object.values(CHAIN_EIDS).map(c => c.name).join(', ')}\n` +
      `Venues: Tempo DEX, Hyperliquid Perps\n` +
      `Agent Features: Memory (persistent), Telegram Bridge, A2A Tasks\n\n` +
      `Docs: https://docs.tempo.xyz | MPP: https://mpp.dev`
    }] }
  }
  if (req.params.uri === 'agnt://plans') {
    return { contents: [{ uri: 'agnt://plans', mimeType: 'text/plain', text: formatBillingCatalog() }] }
  }
  throw new Error(`Unknown resource: ${req.params.uri}`)
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`./AGNT MCP Server v2.1 running (stdio + MPP + A2A) — ${TOOL_COUNT} tools`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
