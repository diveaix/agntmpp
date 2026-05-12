/**
 * ./AGNT Protocol — Tool Registry
 * Central registry with MPP payment gating.
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

import tempoModule from './tempo.js'
import hyperliquidModule from './hyperliquid.js'
import marketDataModule from './market-data.js'
import automationsModule from './automations.js'
import defiModule from './defi.js'
import analyticsModule from './analytics.js'
import safetyModule from './safety.js'
import advancedModule from './advanced.js'
import protocolsModule from './protocols.js'
import lendingModule from './lending.js'
import swapsModule from './swaps.js'
import bridgesModule from './bridges.js'
import dataPlatformsModule from './data-platforms.js'
import dexIntelModule from './dex-intel.js'
import accountModule from './account.js'
import billingModule from './billing.js'

import memoryModule from './memory.js'
import polymarketModule from './polymarket.js'
import skillManagerModule from './skill-manager.js'

// ─── Import skill system ────────────────────────────────

import { loadAllSkills, getSkillTools, handleSkillCall, getSkillCount } from '../skill-loader.js'

// ─── Import MPP pricing ─────────────────────────────────

import { isFreeTool, getToolTier, getToolPrice } from '../pricing.js'
import { PRICING } from '../mpp.js'
import { isSessionCached, cacheSession, recordPayment, recordCall } from '../payment-tracker.js'

import { autoRemember } from '../memory.js'
import { recordToolActivity } from '../activity-log.js'
import { HACKATHON_MODE } from '../../hackathon-mode.js'

const MODULES: ToolModule[] = [

  tempoModule,
  hyperliquidModule,
  marketDataModule,
  automationsModule,
  defiModule,
  analyticsModule,
  safetyModule,
  advancedModule,
  protocolsModule,
  lendingModule,
  bridgesModule,
  swapsModule,
  dataPlatformsModule,
  dexIntelModule,
  accountModule,
  billingModule,
  memoryModule,
  polymarketModule,
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

/** Route a tool call to the correct venue module, with MPP payment gating. */
export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
  auth?: AuthContext,
  walletScope?: string,
): Promise<ToolResult> {
  return runWithToolContext({ auth, walletScope: walletScope || (auth ? `user:${auth.userId}` : undefined) }, async () => {
  recordCall()

  // Hackathon submission mode: keep every tool callable without MPP/API-key gates.
  if (HACKATHON_MODE) {
    return execTool(name, args, auth)
  }

  // ── Free tools: zero overhead ──
  if (isFreeTool(name)) {
    return execTool(name, args, auth)
  }

  // ── Check session cache for repeat callers ──
  const credential = meta?.['org.paymentauth/credential'] as Record<string, unknown> | undefined
  const payerAddress = credential?.source as string | undefined

  if (payerAddress && isSessionCached(payerAddress, name)) {
    return execTool(name, args, auth)
  }

  // ── Paid tool: check for credential ──
  if (!credential) {
    // Return -32042 Payment Required challenge
    const tier = getToolTier(name)
    const amount = getToolPrice(name)
    return {
      content: [{ type: 'text', text: `⚡ Payment required: $${amount} (${tier} tier) for ${name}` }],
      isError: true,
      _meta: {
        'org.paymentauth/challenge': {
          id: `ch_${Date.now().toString(36)}`,
          realm: 'agnt.dev',
          method: 'tempo',
          intent: 'charge',
          request: {
            amount: amount,
            currency: process.env.AGNT_PAYMENT_CURRENCY || '0x20C000000000000000000000b9537d11c60E8b50',
            recipient: process.env.AGNT_RECIPIENT || '0x0000000000000000000000000000000000000000',
          },
        },
      },
    }
  }

  // ── Credential present: verify + execute ──
  // In production, mppx.verify() validates the payment on-chain.
  // For now, we trust the credential and execute.
  const tier = getToolTier(name)
  const amount = getToolPrice(name)
  const txHash = (credential.payload as Record<string, unknown>)?.hash as string || 'optimistic'

  if (payerAddress) {
    cacheSession(payerAddress, name)
    recordPayment(name, tier, amount, payerAddress, txHash)
  }

  const result = await execTool(name, args, auth)
  result._meta = {
    ...result._meta,
    'org.paymentauth/receipt': {
      status: 'success',
      method: 'tempo',
      tier,
      amount,
      txHash,
    },
  }
  return result
  })
}

// ─── Write tools that trigger auto-memory + Telegram ────

const WRITE_TOOLS = new Set([
  'tempo_swap', 'smart_swap', 'uniswap', 'pancakeswap',
  'tempo_bridge', 'relay', 'debridge', 'jumper',
  'aave', 'morpho', 'lido', 'eigenlayer', 'pendle', 'ethena', 'ondo',
  'hyperliquid', 'polymarket', 'payment', 'yield',
])

const WRITE_ACTIONS = new Set([
  'swap', 'execute', 'find_and_swap', 'bridge',
  'supply', 'withdraw', 'stake', 'deposit', 'borrow', 'repay',
  'order', 'buy', 'sell', 'send', 'mint', 'redeem', 'approve',
  'buy_pt', 'buy_yt',
  'lp', 'close', 'cancel', 'leverage', 'fund',
  'scale', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'twap', 'bracket', 'trailing_stop',
  'copy_trade', 'dca', 'spot', 'earn', 'vaults', 'staking',
  'stop_loss', 'take_profit', 'batch_buy',
  'deploy_token', 'dao_vote', 'agent_pay',
])

function isWriteAction(name: string, args: Record<string, unknown>): boolean {
  if (!WRITE_TOOLS.has(name)) return false
  const action = args.action as string | undefined
  if (!action) return false
  return WRITE_ACTIONS.has(action)
}

/** Execute a tool via the module chain + skills, with auto-memory hooks. */
async function execTool(name: string, args: Record<string, unknown>, auth?: AuthContext): Promise<ToolResult> {
  // Check built-in modules first
  for (const mod of MODULES) {
    let result: ToolResult | null
    try {
      result = await mod.handle(name, args, auth)
    } catch (e) {
      return {
        content: [{ type: 'text', text: `❌ ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      }
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
          autoRemember(name, args, snippet)
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
