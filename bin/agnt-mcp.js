#!/usr/bin/env node
/**
 * ./AGENT MCP Server — npx entrypoint
 * Usage: npx @agnt/mcp
 */
import 'tsx/esm'
await import('../src/mcp/server.ts')
