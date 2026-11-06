/**
 * ./AGENT Protocol — Tool Registry
 * Central registry for account-authorized tools.
 * Both server.ts (stdio) and serve.ts (SSE) import from here.
 * Integrates auto-memory recording and Telegram notifications.
 */

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolResult {
  [x: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
  _meta?: Record<string, unknown>
}

import type { AuthContext } from '../access-types.js'
import { runWithToolContext } from '../tool-context.js'

export interface ToolModule {
  tools: ToolDef[]
  handle: (name: string, args: Record<string, unknown>, auth?: AuthContext) => Promise<ToolResult | null>
}

// ─── Import all venue modules ────────────────────────────

import walletModule from './wallet.js'
import marketDataModule from './market-data.js'
import defiModule from './defi.js'
import analyticsModule from './analytics.js'
import safetyModule from './safety.js'
import advancedModule from './advanced.js'
import protocolsModule from './protocols.js'
import lendingModule from './lending.js'
import swapsModule from './swaps.js'
import bridgesModule from './bridges.js'
import walletSendModule from './wallet-send.js'
import smartSwapModule from './smart-swap.js'
import accountModule from './account.js'

import memoryModule from './memory.js'
import skillManagerModule from './skill-manager.js'

// ─── Import skill system ────────────────────────────────

import { loadAllSkills, getSkillTools, handleSkillCall, getSkillCount } from '../skill-loader.js'

import { recordCall } from '../payment-tracker.js'

import { autoRemember } from '../memory.js'
import { recordToolActivity } from '../activity-log.js'
import { formatTxError } from '../tx-errors.js'
import { getActiveWallet } from '../wallet.js'
import { liveExecutionEnabled } from '../production-readiness.js'
import { enforcePassAccess } from '../sale/runtime.js'

const MODULES: ToolModule[] = [

  walletModule,
  marketDataModule,
  defiModule,
  analyticsModule,
  safetyModule,
  advancedModule,
  protocolsModule,
  lendingModule,
  bridgesModule,
  swapsModule,
  walletSendModule,
  smartSwapModule,
  accountModule,
  memoryModule,
  skillManagerModule,
]

// ─── Merged exports ──────────────────────────────────────

/** All tools from all venue modules + loaded skills, merged into one flat array. */
export function getAllTools(): ToolDef[] {
  return [...MODULES.flatMap((m) => m.tools), ...getSkillTools()]
}
export let ALL_TOOLS: ToolDef[] = MODULES.flatMap((m) => m.tools)

/** Initialize skills on first import. Call refreshTools() after. */
export async function initSkills() {
  await loadAllSkills()
  ALL_TOOLS = getAllTools()
}

/** Route a tool call to the correct module within its account and wallet scope. */
export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _meta?: Record<string, unknown>,
  auth?: AuthContext,
  walletScope?: string,
): Promise<ToolResult> {
  return runWithToolContext({ auth, walletScope: walletScope || (auth ? `user:${auth.userId}` : undefined) }, async () => {
    if (process.env.AGNT_MPP_ENABLED === 'true') {
      return {
        content: [{ type: 'text', text: 'Per-call payment settlement is no longer supported. Disable AGNT_MPP_ENABLED and use account access.' }],
        isError: true,
      }
    }
    try {
      await enforcePassAccess(auth?.userId, name)
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Pass access unavailable' }], isError: true }
    }
    recordCall()
    return execTool(name, args, auth)
  })
}

// ─── Write tools that trigger auto-memory + Telegram ────

const WRITE_TOOLS = new Set([
  'wallet', 'wallet_send',
  'smart_swap', 'uniswap', 'pancakeswap',
  'relay', 'jumper',
  'aave', 'morpho', 'lido', 'pendle', 'ethena', 'ondo',
  'payment', 'yield', 'advanced',
])

const WRITE_ACTIONS = new Set([
  'swap', 'execute', 'find_and_swap', 'bridge',
  'supply', 'withdraw', 'stake', 'stake_eth', 'deposit', 'borrow', 'repay',
  'order', 'buy', 'sell', 'send', 'mint', 'redeem', 'approve',
  'buy_pt', 'buy_yt',
  'lp', 'close', 'cancel', 'leverage', 'fund',
  'swap_any_chain',
])

function isWriteAction(name: string, args: Record<string, unknown>): boolean {
  if (!WRITE_TOOLS.has(name)) return false
  const action = args.action as string | undefined
  if (!action) return false
  return WRITE_ACTIONS.has(action)
}

/** Execute a tool via the module chain + skills, with auto-memory hooks. */
async function execTool(name: string, args: Record<string, unknown>, auth?: AuthContext): Promise<ToolResult> {
  if (isWriteAction(name, args) && !liveExecutionEnabled()) {
    return {
      content: [{ type: 'text', text: '❌ Live transaction execution is disabled. Set AGNT_LIVE_EXECUTION_ENABLED=true only after operational approval.' }],
      isError: true,
    }
  }

  // Check built-in modules first
  for (const mod of MODULES) {
    let result: ToolResult | null
    try {
      result = await mod.handle(name, args, auth)
    } catch (e) {
      const action = typeof args.action === 'string' ? args.action : undefined
      const errorResult: ToolResult = {
        content: [{ type: 'text', text: `❌ ${formatTxError(e, { tool: name, action, chain: typeof args.chain === 'string' ? args.chain : undefined })}` }],
        isError: true,
      }
      if (isWriteAction(name, args)) {
        try {
          recordToolActivity(name, args, errorResult, auth)
        } catch { /* never crash on activity recording */ }
      }
      return errorResult
    }
    if (result) {
      if (isWriteAction(name, args)) {
        try {
          recordToolActivity(name, args, result, auth)
        } catch { /* never crash on activity recording */ }
      }
      if (isWriteAction(name, args) && !result.isError) {
        try {
          const snippet = result.content.map((c) => c.text).join(' ').slice(0, 200)
          const activeWallet = getActiveWallet()
          autoRemember(name, args, snippet, activeWallet ? {
            walletName: activeWallet.name,
            walletAddress: activeWallet.address,
          } : {})
        } catch { /* never crash on memory recording */ }
      }
      return result
    }
  }

  // Check loaded skills
  const skillResult = await handleSkillCall(name, args)
  if (skillResult) return skillResult

  return { content: [{ type: 'text', text: `❌ Unknown tool: ${name}` }], isError: true }
}

/** Refresh tools list (after skill install/remove). */
export function refreshTools() {
  ALL_TOOLS = getAllTools()
}

/** Total tool count for display purposes. */
export const TOOL_COUNT = ALL_TOOLS.length
