/**
 * ./AGNT Protocol — Automation Tools
 * Tools for DCA, price alerts, and strategy management.
 * Automations are persisted encrypted and resume on server restart.
 */

import type { ToolModule } from './index.js'
import {
  createAutomation,
  listAutomations,
  cancelAutomation,
  parseInterval,
  formatInterval,
  type AutomationEntry,
} from '../scheduler.js'
import { scheduleNewAutomation, unscheduleAutomation } from '../automation-runner.js'
import { parseAutomationValidity, normalizeAutomationMode, type AutomationPlan, type EventAutomationAction, type HyperliquidInfoMetric } from '../automation-types.js'
import { normalizeFastVerificationMode } from '../fast-event-types.js'
import { canCreateDataAutomation, getPlanEntitlement } from '../automation-entitlements.js'
import { checkEventAutomationIntake, checkHyperliquidMonitorIntake, formatMissingQuestions } from '../automation-intake.js'
import type { AuthContext } from '../access-types.js'
import { evaluateAutomationReadiness, type AutomationReadinessProbe } from './automation-readiness.js'
import { getPolymarketSetupStatus } from './polymarket.js'
import { getHyperliquidSetupStatus } from './hyperliquid.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'automations',
    description: 'Automation Tools to manage DCA, price alerts, and strategy execution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create_dca', 'create_alert', 'create_event', 'create_hl_monitor', 'list', 'cancel', 'log'], description: 'Action to perform' },
        tokenIn: { type: 'string', description: 'Token to spend (for create_dca)' },
        tokenOut: { type: 'string', description: 'Token to buy (for create_dca)' },
        amount: { type: 'number', description: 'Amount of tokenIn per buy (for create_dca)' },
        interval: { type: 'string', description: 'Interval between buys e.g. "10s", "30m", "6h", "1d" (for create_dca)' },
        maxRuns: { type: 'number', description: 'Stop after N executions. 0 = unlimited (for create_dca)' },
        token: { type: 'string', description: 'Token to watch (for create_alert)' },
        condition: { type: 'string', enum: ['above', 'below', 'changes'], description: 'Trigger condition (for create_alert or create_hl_monitor)' },
        targetPrice: { type: 'number', description: 'Target price in USD (for create_alert)' },
        alertAction: { type: 'string', description: 'Optional action to execute on trigger (for create_alert)' },
        topic: { type: 'string', description: 'Event topic, like iran_israel_conflict (for create_event)' },
        eventType: { type: 'string', description: 'Universal event type, like military_attack (for create_event)' },
        actor: { type: 'string', description: 'Event actor, like Iran (for create_event)' },
        target: { type: 'string', description: 'Event target, like Israel (for create_event)' },
        protocol: { type: 'string', enum: ['polymarket', 'hyperliquid'], description: 'Protocol action target (for create_event)' },
        marketId: { type: 'string', description: 'Polymarket market id (for create_event)' },
        side: { type: 'string', description: 'YES/NO for Polymarket or long/short for Hyperliquid' },
        market: { type: 'string', description: 'Hyperliquid market symbol' },
        maxSpend: { type: 'number', description: 'Max Polymarket spend' },
        maxPrice: { type: 'number', description: 'Max Polymarket outcome price' },
        amountUsd: { type: 'number', description: 'Hyperliquid trade size in USDC' },
        leverage: { type: 'number', description: 'Hyperliquid leverage' },
        stopLossPercent: { type: 'number', description: 'Hyperliquid stop loss percent' },
        takeProfitPercent: { type: 'number', description: 'Hyperliquid take profit percent' },
        minConfidence: { type: 'number', description: 'Minimum Grok confidence. Default 0.8' },
        verificationMode: { type: 'string', enum: ['speed', 'balanced', 'fortress'], description: 'Fast event verification mode. speed = fastest trusted-source path, balanced = default, fortress = stricter quorum.' },
        validFor: { type: 'string', description: 'Required validity window, like "10m", "6h", "7d", or "1mo"' },
        mode: { type: 'string', enum: ['notify_only', 'ask_first', 'auto_execute', 'emergency_paused'], description: 'Execution mode' },
        metric: { type: 'string', description: 'Hyperliquid info metric for create_hl_monitor' },
        threshold: { type: 'number', description: 'Monitor threshold' },
        message: { type: 'string', description: 'Notification message for monitor automations' },
        plan: { type: 'string', enum: ['free', 'pro', 'max'], description: 'User plan for data automation limits' },
        name: { type: 'string', description: 'Optional name for this strategy or alert' },
        status: { type: 'string', enum: ['all', 'active', 'completed', 'failed'], description: 'Filter by status. Default: all (for list)' },
        id: { type: 'string', description: 'Automation ID (for cancel, log)' },
      },
      required: ['action'],
    },
  },
]

// ─── Helpers ─────────────────────────────────────────────

function formatAutomation(a: AutomationEntry): string {
  const statusIcon = { active: '🟢', paused: '⏸️', completed: '✅', failed: '❌' }[a.status]
  let detail = ''
  if (a.type === 'dca') {
    detail = `Buy ${a.params.amount} ${a.params.tokenIn} → ${a.params.tokenOut} every ${formatInterval(a.intervalMs)}`
  } else if (a.type === 'price_alert') {
    detail = `Alert when ${a.params.token} goes ${a.params.condition} $${a.params.targetPrice}`
    if (a.params.action) detail += ` → ${a.params.action}`
  } else if (a.type === 'event_trigger') {
    const trigger = (a.params.trigger || {}) as { topic?: string; eventType?: string; actor?: string; target?: string }
    const action = (a.params.action || {}) as { protocol?: string; marketId?: string; market?: string; side?: string }
    detail = `Event ${trigger.topic || 'unknown'} ${trigger.eventType || ''} ${trigger.actor || ''}${trigger.target ? ` -> ${trigger.target}` : ''} => ${action.protocol || 'action'} ${action.side || ''} ${action.marketId || action.market || ''}`.trim()
  } else if (a.type === 'market_monitor') {
    const trigger = (a.params.trigger || {}) as { protocol?: string; metric?: string; market?: string; condition?: string; threshold?: number }
    detail = `${trigger.protocol || 'market'} monitor: ${trigger.metric || 'metric'} ${trigger.market || 'all'} ${trigger.condition || ''}${trigger.threshold !== undefined ? ` ${trigger.threshold}` : ''}`
  }
  const nextStr = a.nextRun ? `\n    Next: ${new Date(a.nextRun).toISOString().slice(0, 16).replace('T', ' ')}` : ''

  return `  ${statusIcon} [${a.id}] ${a.name}\n    ${detail}\n    Runs: ${a.runCount} | Created: ${a.createdAt.slice(0, 16).replace('T', ' ')}${nextStr}`
}

function visibleToAuth(a: AutomationEntry, auth?: AuthContext): boolean {
  if (!auth) return true
  return a.userId === auth.userId
}

function countActiveDataAutomations(auth?: AuthContext) {
  return listAutomations().filter((a) => visibleToAuth(a, auth) && a.status === 'active' && (a.type === 'event_trigger' || a.type === 'market_monitor')).length
}

function resolvePlan(args: Record<string, unknown>, auth?: AuthContext) {
  return auth?.plan || (args.plan as string | undefined) || 'free'
}

function ownerFields(auth: AuthContext | undefined, plan: string) {
  const planAtCreation: AutomationPlan = plan === 'pro' || plan === 'max' ? plan : 'free'
  return auth
    ? { userId: auth.userId, createdByApiKeyId: auth.apiKeyId, planAtCreation }
    : {}
}

async function defaultAutomationReadinessProbe(action: EventAutomationAction) {
  try {
    if (action.protocol === 'polymarket') {
      return evaluateAutomationReadiness(action, {
        polymarket: await getPolymarketSetupStatus(action.maxSpend),
      })
    }

    return evaluateAutomationReadiness(action, {
      hyperliquid: await getHyperliquidSetupStatus(action.amountUsd),
    })
  } catch (e) {
    return {
      allowed: false,
      message: `I could not verify ${action.protocol} setup, so I did not create the live trading automation.\n\nReason: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

let automationReadinessProbe: AutomationReadinessProbe = defaultAutomationReadinessProbe

export function setAutomationReadinessProbeForTests(probe: AutomationReadinessProbe | null) {
  automationReadinessProbe = probe || defaultAutomationReadinessProbe
}

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>, auth?: AuthContext) {
  if (name === 'automations') {
    switch (args.action) {
      case 'create_dca': {
        if (!args.tokenIn || !args.tokenOut || args.amount === undefined || !args.interval) {
          return err('Missing tokenIn, tokenOut, amount, or interval parameter')
        }
        const tokenIn = args.tokenIn as string
        const tokenOut = args.tokenOut as string
        const amount = args.amount as number
        const interval = args.interval as string
        const autoName = (args.name as string) || `DCA ${amount} ${tokenIn} → ${tokenOut}`

        try {
          const intervalMs = parseInterval(interval)
          const maxRuns = (args.maxRuns as number) || 0
          const automation = createAutomation({
            type: 'dca',
            name: autoName,
            ...ownerFields(auth, resolvePlan(args, auth)),
            params: { tokenIn, tokenOut, amount },
            intervalMs,
            maxRuns,
            status: 'active',
          })

          // Schedule the timer on the server-side runner immediately
          scheduleNewAutomation(automation)

          return text(
            `✅ DCA Strategy Created!\n\n` +
            `ID: ${automation.id}\n` +
            `Name: ${automation.name}\n` +
            `Strategy: Buy ${amount} ${tokenIn} worth of ${tokenOut}\n` +
            `Interval: Every ${formatInterval(intervalMs)}\n` +
            (maxRuns > 0 ? `Max Runs: ${maxRuns} (auto-stops after)\n` : `Max Runs: Unlimited\n`) +
            `Next Run: ${automation.nextRun?.slice(0, 16).replace('T', ' ')}\n\n` +
            `📌 Runs server-side — executes even if you disconnect.\n` +
            `Use list to monitor, cancel to stop.`
          )
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      }

      case 'create_alert': {
        if (!args.token || !args.condition || args.targetPrice === undefined) {
          return err('Missing token, condition, or targetPrice parameter')
        }
        const token = args.token as string
        const condition = args.condition as string
        const targetPrice = args.targetPrice as number
        const action = args.alertAction as string | undefined
        const autoName = (args.name as string) || `Alert: ${token} ${condition} $${targetPrice}`

        const automation = createAutomation({
          type: 'price_alert',
          name: autoName,
          ...ownerFields(auth, resolvePlan(args, auth)),
          params: { token, condition, targetPrice, action },
          intervalMs: 0, // one-shot
          maxRuns: 1,
          status: 'active',
        })

        return text(
          `✅ Price Alert Created!\n\n` +
          `ID: ${automation.id}\n` +
          `Name: ${automation.name}\n` +
          `Trigger: ${token.toUpperCase()} goes ${condition} $${targetPrice.toLocaleString()}\n` +
          (action ? `Action: ${action}\n` : `Action: Notify only\n`) +
          `\n📌 The alert will be checked on each price poll.\n` +
          `Use list to monitor, cancel to dismiss.`
        )
      }

      case 'create_event': {
        if (!args.protocol) return err('Missing protocol')
        if (args.protocol !== 'polymarket' && args.protocol !== 'hyperliquid') return err('protocol must be polymarket or hyperliquid')
        const intake = checkEventAutomationIntake(args)
        if (!intake.ok) return err(formatMissingQuestions(intake))
        const plan = resolvePlan(args, auth)
        const mode = normalizeAutomationMode(args.mode)
        let validity: { validFor: string; validUntil: string; durationMs: number }
        try {
          validity = parseAutomationValidity(args.validFor)
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        const entitlement = canCreateDataAutomation(plan, countActiveDataAutomations(auth))
        if (!entitlement.allowed) return err(entitlement.reason)
        const planDetails = auth?.entitlement || getPlanEntitlement(plan)
        if (mode === 'auto_execute' && !planDetails.autoExecuteAllowed) return err(`${planDetails.plan} plan does not allow auto-execute data automations.`)
        const verificationMode = normalizeFastVerificationMode(args.verificationMode || process.env.AGNT_FAST_VERIFY_DEFAULT_MODE)

        const trigger = {
          topic: args.topic as string,
          eventType: args.eventType as string | undefined,
          actor: args.actor as string | undefined,
          target: args.target as string | undefined,
          minConfidence: (args.minConfidence as number | undefined) ?? 0.8,
        }

        const action: EventAutomationAction = args.protocol === 'polymarket'
          ? {
              protocol: 'polymarket' as const,
              marketId: args.marketId as string,
              side: String(args.side || 'YES').toUpperCase() === 'NO' ? 'NO' as const : 'YES' as const,
              maxSpend: args.maxSpend as number,
              maxPrice: args.maxPrice as number | undefined,
            }
          : {
              protocol: 'hyperliquid' as const,
              kind: 'trade' as const,
              market: ((args.market as string | undefined) || 'ETH').toUpperCase(),
              side: ((args.side as string | undefined) === 'long' ? 'long' : 'short') as 'long' | 'short',
              amountUsd: (args.amountUsd as number | undefined) ?? 0,
              leverage: (args.leverage as number | undefined) ?? 1,
              stopLossPercent: args.stopLossPercent as number | undefined,
              takeProfitPercent: args.takeProfitPercent as number | undefined,
            }

        if (action.protocol === 'polymarket' && (!action.marketId || !action.maxSpend)) return err('Polymarket event automations need marketId and maxSpend')
        if (action.protocol === 'hyperliquid' && action.amountUsd <= 0) return err('Hyperliquid event automations need amountUsd')

        const readiness = await automationReadinessProbe(action)
        if (!readiness.allowed) return err(readiness.message || `${action.protocol} setup is not ready for live automations.`)
        const readinessReason = readiness.message || 'Account setup, balances, approvals, and market checks passed.'

        const automation = createAutomation({
          type: 'event_trigger',
          name: (args.name as string | undefined) || `Event: ${trigger.topic}`,
          ...ownerFields(auth, plan),
          params: {
            trigger,
            action,
            policy: {},
            mode,
            plan,
            verificationMode,
            actionReady: true,
            readinessReason,
            validFor: validity.validFor,
            validUntil: validity.validUntil,
          },
          intervalMs: 0,
          maxRuns: 0,
          status: 'active',
        })

        return text(
          `Event Automation Created\n\n` +
          `ID: ${automation.id}\n` +
          `Plan: ${planDetails.plan}\n` +
          `Topic: ${trigger.topic}\n` +
          `Action: ${action.protocol}\n` +
          `Mode: ${mode}\n\n` +
          `Verification: ${verificationMode}\n` +
          `Valid For: ${validity.validFor}\n` +
          `Expires: ${validity.validUntil.slice(0, 16).replace('T', ' ')} UTC\n\n` +
          `Grok verification only confirms whether the tweet satisfies this automation. No X search is required on the fast path.\n` +
          `Use list to monitor, cancel to stop.`
        )
      }

      case 'create_hl_monitor': {
        const intake = checkHyperliquidMonitorIntake(args)
        if (!intake.ok) return err(formatMissingQuestions(intake))
        const plan = resolvePlan(args, auth)
        const mode = normalizeAutomationMode(args.mode)
        let validity: { validFor: string; validUntil: string; durationMs: number }
        try {
          validity = parseAutomationValidity(args.validFor)
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        const entitlement = canCreateDataAutomation(plan, countActiveDataAutomations(auth))
        if (!entitlement.allowed) return err(entitlement.reason)

        const params = {
          trigger: {
            protocol: 'hyperliquid' as const,
            metric: args.metric as HyperliquidInfoMetric,
            market: args.market as string | undefined,
            condition: args.condition as 'above' | 'below' | 'changes',
            threshold: args.threshold as number | undefined,
          },
          action: {
            kind: 'notify' as const,
            message: (args.message as string | undefined) || `Hyperliquid ${args.metric} condition matched.`,
          },
          policy: {},
          mode,
          plan,
          validFor: validity.validFor,
          validUntil: validity.validUntil,
        }

        const automation = createAutomation({
          type: 'market_monitor',
          name: (args.name as string | undefined) || `HL monitor: ${params.trigger.metric}`,
          ...ownerFields(auth, plan),
          params,
          intervalMs: parseInterval((args.interval as string | undefined) || '30s'),
          maxRuns: 0,
          status: 'active',
        })

        scheduleNewAutomation(automation)

        return text(
          `Hyperliquid Monitor Created\n\n` +
          `ID: ${automation.id}\n` +
          `Plan: ${getPlanEntitlement(plan).plan}\n` +
          `Metric: ${params.trigger.metric}\n` +
          `Market: ${params.trigger.market || 'all'}\n` +
          `Condition: ${params.trigger.condition}${params.trigger.threshold !== undefined ? ` ${params.trigger.threshold}` : ''}\n` +
          `Mode: ${mode}\n` +
          `Valid For: ${validity.validFor}\n` +
          `Expires: ${validity.validUntil.slice(0, 16).replace('T', ' ')} UTC\n\n` +
          `This is an information automation. It will notify when the condition matches. Defensive actions require a separate explicit automation.`
        )
      }

      case 'list': {
        const statusFilter = (args.status as string) || 'all'
        let automations = listAutomations().filter((a) => visibleToAuth(a, auth))

        if (statusFilter !== 'all') {
          automations = automations.filter((a) => a.status === statusFilter)
        }

        if (!automations.length) {
          return text(`No automations${statusFilter !== 'all' ? ` with status "${statusFilter}"` : ''}.\n\nUse create_dca or create_alert to set one up.`)
        }

        const lines: string[] = [`📋 Automations (${statusFilter}):\n`]
        for (const a of automations) {
          lines.push(formatAutomation(a))
          lines.push('')
        }
        lines.push(`Total: ${automations.length} automation(s)`)

        return text(lines.join('\n'))
      }

      case 'cancel': {
        if (!args.id) return err('Missing id parameter')
        const id = args.id as string
        const candidate = listAutomations().find((a) => a.id === id)
        if (auth && (!candidate || candidate.userId !== auth.userId)) return err(`Automation "${id}" not found.`)
        const auto = cancelAutomation(id)
        if (!auto) return err(`Automation "${id}" not found.`)
        unscheduleAutomation(auto.id)
        return text(`✅ Automation cancelled.\n\nID: ${auto.id}\nName: ${auto.name}\nRuns completed: ${auto.runCount}`)
      }

      case 'log': {
        const id = args.id as string | undefined

        if (id) {
          const automations = listAutomations().filter((a) => visibleToAuth(a, auth))
          const auto = automations.find((a) => a.id === id)
          if (!auto) return err(`Automation "${id}" not found.`)

          if (!auto.history.length) return text(`No execution history for "${auto.name}" (${auto.id}).`)

          const lines: string[] = [`📊 Execution History — ${auto.name} [${auto.id}]:\n`]
          lines.push(`${'Time'.padEnd(18)} ${'Status'.padEnd(8)} Result`)
          lines.push('─'.repeat(60))

          for (const h of auto.history.slice(-20)) {
            const time = h.time.slice(0, 16).replace('T', ' ')
            const status = h.success ? '✅' : '❌'
            lines.push(`${time.padEnd(18)} ${status.padEnd(8)} ${h.result.slice(0, 60)}`)
          }

          lines.push(`\nTotal runs: ${auto.runCount}`)
          return text(lines.join('\n'))
        }

        // Show recent activity across all automations
        const allAutos = listAutomations().filter((a) => visibleToAuth(a, auth))
        const allHistory = allAutos
          .flatMap((a) => a.history.map((h) => ({ ...h, autoName: a.name, autoId: a.id })))
          .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
          .slice(0, 20)

        if (!allHistory.length) return text('No automation execution history yet.')

        const lines: string[] = ['📊 Recent Automation Activity:\n']
        for (const h of allHistory) {
          const time = h.time.slice(0, 16).replace('T', ' ')
          const status = h.success ? '✅' : '❌'
          lines.push(`${time} ${status} [${h.autoId}] ${h.autoName}: ${h.result.slice(0, 50)}`)
        }

        return text(lines.join('\n'))
      }

      default: return err(`Unknown automations action: ${args.action}`)
    }
  }

  return null
}

// ─── Module Export ────────────────────────────────────────

const automationsModule: ToolModule = { tools: TOOLS, handle }
export default automationsModule
