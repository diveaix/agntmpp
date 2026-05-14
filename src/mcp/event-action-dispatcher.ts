import type { AuthContext } from './access-types.js'
import type { AutomationEntry } from './scheduler.js'
import { addAutomationHistory } from './scheduler.js'
import { getPlanEntitlement } from './automation-entitlements.js'
import type { EventAutomationAction, EventTriggerAutomationParams, UniversalEvent } from './automation-types.js'
import { simulateAutomationAction } from './automation-simulators.js'
import { evaluateAutomationPolicy } from './automation-policy.js'

export interface EventDispatchResult {
  automationId: string
  mode: string
  submitted: boolean
  reason: string
  latencyMs: number
}

function authFromAutomation(auto: AutomationEntry): AuthContext | undefined {
  if (!auto.userId) return undefined
  const plan = auto.planAtCreation || 'free'
  return {
    userId: auto.userId,
    apiKeyId: auto.createdByApiKeyId || 'automation',
    plan,
    subscriptionStatus: 'active',
    entitlement: {
      ...getPlanEntitlement(plan),
      eventEvaluationsMonthly: plan === 'max' ? 50_000 : plan === 'pro' ? 10_000 : 100,
      executionsMonthly: plan === 'max' ? 10_000 : plan === 'pro' ? 1_000 : 0,
    },
    source: 'api_key',
  }
}

function toolCallForAction(action: EventAutomationAction): { tool: string; args: Record<string, unknown> } {
  if (action.protocol === 'polymarket') {
    return {
      tool: 'polymarket',
      args: {
        action: 'buy',
        marketId: action.marketId,
        outcome: action.side,
        amount: action.maxSpend,
        maxPrice: action.maxPrice,
        mode: 'market_fok',
      },
    }
  }
  return {
    tool: 'hyperliquid',
    args: {
      action: 'order',
      market: action.market,
      side: action.side === 'long' ? 'buy' : 'sell',
      amount: action.amountUsd,
      leverage: action.leverage,
      stopLossPercent: action.stopLossPercent,
      takeProfitPercent: action.takeProfitPercent,
      execute: true,
    },
  }
}

async function submitLiveAction(auto: AutomationEntry, action: EventAutomationAction): Promise<string> {
  const { handleTool } = await import('./tools/index.js')
  const call = toolCallForAction(action)
  const auth = authFromAutomation(auto)
  const result = await handleTool(call.tool, call.args, undefined, auth, auth ? `user:${auth.userId}` : undefined)
  const body = result.content.map((part) => part.text).join('\n').trim()
  if (result.isError) throw new Error(body)
  return body.slice(0, 500)
}

export async function dispatchMatchedEventAutomation(auto: AutomationEntry, event: UniversalEvent): Promise<EventDispatchResult> {
  const started = Date.now()
  const params = auto.params as unknown as EventTriggerAutomationParams
  const simulation = await simulateAutomationAction(params.action, { requireStopLoss: params.mode === 'auto_execute' && params.action.protocol === 'hyperliquid' })
  const decision = evaluateAutomationPolicy(params.policy || {}, params.mode, simulation)

  if (!decision.allowed) {
    const reason = `Verified event matched, but action is blocked: ${decision.reason}`
    addAutomationHistory(auto.id, reason, false, { countRun: false, status: 'failed', nextRun: null })
    return { automationId: auto.id, mode: params.mode, submitted: false, reason, latencyMs: Date.now() - started }
  }

  if (params.mode === 'notify_only') {
    const reason = `Verified event matched. Notify only: ${event.summary}`
    addAutomationHistory(auto.id, reason, true, { status: 'completed', nextRun: null })
    return { automationId: auto.id, mode: params.mode, submitted: false, reason, latencyMs: Date.now() - started }
  }

  if (params.mode === 'ask_first') {
    const reason = `Verified event matched. Waiting for user approval before executing: ${simulation.summary}`
    addAutomationHistory(auto.id, reason, true, { status: 'paused', nextRun: null })
    return { automationId: auto.id, mode: params.mode, submitted: false, reason, latencyMs: Date.now() - started }
  }

  if (process.env.AGNT_EVENT_AUTO_EXECUTE_ENABLED !== 'true') {
    const reason = `Verified event matched and simulation passed, but live auto-execute is disabled. Set AGNT_EVENT_AUTO_EXECUTE_ENABLED=true to submit live actions.`
    addAutomationHistory(auto.id, reason, true, { status: 'paused', nextRun: null })
    return { automationId: auto.id, mode: params.mode, submitted: false, reason, latencyMs: Date.now() - started }
  }

  const live = await submitLiveAction(auto, params.action)
  const reason = `Verified event matched. Live action submitted.\n${live}`
  addAutomationHistory(auto.id, reason, true, { status: 'completed', nextRun: null })
  return { automationId: auto.id, mode: params.mode, submitted: true, reason, latencyMs: Date.now() - started }
}
