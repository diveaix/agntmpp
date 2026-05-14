/**
 * ./AGNT Protocol — Automation Runner
 * Background engine that executes automations independently of MCP clients.
 *
 * DCA:             setTimeout for exact timing — fires precisely when due.
 * Price Alerts:    Polls price periodically (needs to check current price).
 *
 * On server boot, rehydrates all active automations from disk and schedules them.
 */

import { loadAutomations, addAutomationHistory, cancelAutomation, type AutomationEntry } from './scheduler.js'
import { TwitterApiIoClient, type TwitterPollingHandle } from './twitterapi-client.js'
import { canRunOwnedAutomation } from './access-control.js'
import { deriveSourceState } from './automation-source-manager.js'
import { createDefaultGrokVerifier } from './automation-verifier.js'
import { processIncomingTweet } from './twitter-ingestion-worker.js'
import { compileEventAutomation } from './fast-event-compiler.js'
import { EventHotCache } from './event-hot-cache.js'
import { FastEventVerifier } from './fast-event-verifier.js'
import { EventAuditWorker } from './event-audit-worker.js'
import { isAutomationStillValid, type EventTriggerAutomationParams, type TweetSourceMeta } from './automation-types.js'

const PRICE_POLL_MS = 30_000 // Check price alerts every 30s

// Track active timers so we can cancel them
const activeTimers = new Map<string, NodeJS.Timeout>()
let pricePollTimer: NodeJS.Timeout | null = null
let running = false
let twitterClient: TwitterApiIoClient | null = null
let twitterPolling: TwitterPollingHandle | null = null
let eventHotCache = new EventHotCache()
const fastEventVerifier = new FastEventVerifier()
const eventAuditWorker = new EventAuditWorker({
  enabled: process.env.AGNT_FAST_VERIFY_AUDIT_ENABLED !== 'false',
  audit: async (item) => {
    addAutomationHistory(
      item.automationIds[0] || 'event_audit',
      `Fast verification audited: ${item.reason}`,
      true,
      { countRun: false },
    )
  },
})

function sourceTrustByTopic(sources: TweetSourceMeta[], topic: string): { handles: string[]; tiers: Record<string, number> } {
  const topicSources = sources.filter((source) => source.enabled && source.topics.includes(topic))
  return {
    handles: topicSources.map((source) => source.handle),
    tiers: Object.fromEntries(topicSources.map((source) => [source.handle, source.trustScore])),
  }
}

function triggerText(params: EventTriggerAutomationParams): string {
  return [
    params.trigger.actor,
    params.trigger.eventType,
    params.trigger.target,
  ].filter(Boolean).join(' ')
}

export function buildEventHotCacheFromAutomations(automations: AutomationEntry[]): EventHotCache {
  const sourceState = deriveSourceState(automations)
  const rules = automations.flatMap((automation) => {
    if (automation.status !== 'active' || automation.type !== 'event_trigger') return []
    const params = automation.params as unknown as EventTriggerAutomationParams
    if (!isAutomationStillValid(params.validUntil)) return []
    const topic = params.trigger?.topic
    if (!topic) return []
    const sourceTrust = sourceTrustByTopic(sourceState.sources, topic)
    if (!sourceTrust.handles.length) return []
    return [compileEventAutomation({
      automationId: automation.id,
      topic,
      triggerText: triggerText(params),
      trigger: params.trigger,
      sourceHandles: sourceTrust.handles,
      sourceTiers: sourceTrust.tiers,
      verificationMode: params.verificationMode,
      actionReady: params.actionReady === true,
      createdAt: new Date(automation.createdAt).getTime(),
    })]
  })

  const cache = new EventHotCache()
  cache.rebuild(rules)
  return cache
}

// ─── DCA Executor ────────────────────────────────────────

async function executeDCA(autoId: string) {
  // Reload from disk to get latest state (may have been cancelled)
  const store = loadAutomations()
  const auto = store.automations.find((a) => a.id === autoId)
  if (!auto || auto.status !== 'active') {
    activeTimers.delete(autoId)
    return
  }

  const { tokenIn, tokenOut, amount } = auto.params as { tokenIn: string; tokenOut: string; amount: number }
  const access = canRunOwnedAutomation(auto)
  if (!access.allowed) {
    addAutomationHistory(auto.id, `Skipped: ${access.reason}`, false, { countRun: false, status: 'paused', nextRun: null })
    console.log(`[Runner] DCA ${auto.id} paused by access control: ${access.reason}`)
    activeTimers.delete(autoId)
    return
  }
  console.log(`[Runner] ⏰ DCA ${auto.id} firing: ${amount} ${tokenIn} → ${tokenOut}`)

  try {
    const { handleTool } = await import('./tools/index.js')
    const result = await handleTool('tempo_swap', {
      action: 'execute',
      tokenIn,
      tokenOut,
      amount,
    })
    const resultText = result.content?.[0]?.type === 'text' ? (result.content[0] as { text: string }).text : JSON.stringify(result)
    const success = !result.isError
    addAutomationHistory(
      auto.id,
      success ? `Swapped ${amount} ${tokenIn} → ${tokenOut}` : `Failed: ${resultText.slice(0, 200)}`,
      success,
      success ? undefined : { countRun: false, status: 'failed', nextRun: null },
    )
    console.log(`[Runner] DCA ${auto.id}: ${success ? '✅' : '❌'} ${amount} ${tokenIn} → ${tokenOut}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    addAutomationHistory(auto.id, `Failed: ${msg.slice(0, 200)}`, false, { countRun: false, status: 'failed', nextRun: null })
    console.log(`[Runner] DCA ${auto.id} failed: ${msg.slice(0, 100)}`)
  }

  // Reload again to check if it was marked completed by addAutomationHistory (maxRuns reached)
  const updated = loadAutomations().automations.find((a) => a.id === autoId)
  if (updated && updated.status === 'active' && updated.intervalMs > 0) {
    // Schedule the next execution
    scheduleDCA(updated)
  } else {
    activeTimers.delete(autoId)
    console.log(`[Runner] DCA ${autoId} completed — no more runs.`)
  }
}

function scheduleDCA(auto: AutomationEntry) {
  // Clear any existing timer for this automation
  const existing = activeTimers.get(auto.id)
  if (existing) clearTimeout(existing)

  // Calculate delay: either from nextRun or from intervalMs
  let delayMs: number
  if (auto.nextRun) {
    delayMs = new Date(auto.nextRun).getTime() - Date.now()
    if (delayMs < 0) delayMs = 0 // Overdue — fire immediately
  } else {
    delayMs = auto.intervalMs
  }

  const delayStr = delayMs < 60_000
    ? `${(delayMs / 1000).toFixed(0)}s`
    : delayMs < 3_600_000
      ? `${(delayMs / 60_000).toFixed(1)}m`
      : `${(delayMs / 3_600_000).toFixed(1)}h`

  console.log(`[Runner] ⏳ DCA ${auto.id} "${auto.name}" scheduled in ${delayStr}`)

  const timer = setTimeout(() => executeDCA(auto.id), delayMs)
  timer.unref() // Don't prevent server shutdown
  activeTimers.set(auto.id, timer)
}

// ─── Price Alert Executor ────────────────────────────────

async function checkPriceAlerts() {
  if (!running) return
  try {
    const store = loadAutomations()
    const alerts = store.automations.filter((a) => a.type === 'price_alert' && a.status === 'active')
    if (!alerts.length) return

    // Get unique tokens to fetch prices for
    const tokens = [...new Set(alerts.map((a) => (a.params as { token: string }).token))]
    const { handleTool } = await import('./tools/index.js')

    for (const token of tokens) {
      try {
        const result = await handleTool('market_data', { action: 'price', token })
        const priceText = result.content?.[0]?.type === 'text' ? (result.content[0] as { text: string }).text : ''
        const priceMatch = priceText.match(/\$[\d,]+\.?\d*/)?.[0]?.replace(/[$,]/g, '')
        if (!priceMatch) continue
        const currentPrice = parseFloat(priceMatch)
        if (isNaN(currentPrice)) continue

        // Check all alerts for this token
        for (const alert of alerts.filter((a) => (a.params as { token: string }).token === token)) {
          const { condition, targetPrice, action } = alert.params as {
            condition: 'above' | 'below'
            targetPrice: number
            action?: string
          }

          const triggered = condition === 'above' ? currentPrice >= targetPrice : currentPrice <= targetPrice

          if (triggered) {
            console.log(`[Runner] 🔔 Alert ${alert.id}: ${token} is $${currentPrice} (${condition} $${targetPrice})`)
            addAutomationHistory(
              alert.id,
              `🔔 ${token.toUpperCase()} hit $${currentPrice.toFixed(2)} (target: ${condition} $${targetPrice})` +
              (action ? ` → Executing: ${action}` : ''),
              true,
            )

            // If there's an action, try to execute it
            if (action) {
              try {
                console.log(`[Runner] Executing alert action: ${action}`)
                // The action is a natural language description — log it
                addAutomationHistory(alert.id, `Action requested: ${action}`, true)
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                addAutomationHistory(alert.id, `Action error: ${msg.slice(0, 150)}`, false)
              }
            }

            // Mark as completed (one-shot alert)
            cancelAutomation(alert.id)
          }
        }
      } catch { /* skip token on error */ }
    }
  } catch (e) {
    console.error(`[Runner] Price check error:`, e instanceof Error ? e.message : e)
  }
}

// ─── Polling loop (price alerts only) ────────────────────

function startPolling() {
  if (pricePollTimer) return

  async function poll() {
    if (!running) return
    await checkPriceAlerts()
  }

  pricePollTimer = setInterval(poll, PRICE_POLL_MS)
  pricePollTimer.unref()
  console.log(`[Runner] 📊 Price alerts polling every ${PRICE_POLL_MS / 1000}s`)
}

// ─── Public API ──────────────────────────────────────────

/**
 * Boot the automation runner.
 * - Rehydrates all active DCA automations with precise setTimeout timers
 * - Starts a polling loop for price alerts
 */
export function startAutomationRunner() {
  if (running) return
  running = true
  console.log(`[Runner] 🚀 Automation runner starting...`)

  // Rehydrate active automations from disk
  const store = loadAutomations()
  const active = store.automations.filter((a) => a.status === 'active')

  let dcaCount = 0
  let alertCount = 0

  for (const auto of active) {
    if (auto.type === 'dca') {
      scheduleDCA(auto)
      dcaCount++
    } else if (auto.type === 'price_alert') {
      alertCount++
    }
  }

  // Start polling for alerts. New alerts are picked up by the polling loop.
  // (we always start it since new ones can be created at any time)
  startPolling()

  twitterClient = new TwitterApiIoClient({ apiKey: process.env.TWITTERAPI_IO_KEY || process.env.AGNT_TWITTER_API_KEY })
  if (twitterClient.isEnabled()) {
    const verifier = createDefaultGrokVerifier()
    eventHotCache = buildEventHotCacheFromAutomations(loadAutomations().automations)
    twitterPolling = twitterClient.startPolling({
      getSources: () => deriveSourceState(loadAutomations().automations).sources,
      onTweet: async (tweet) => {
        const automations = loadAutomations().automations.filter((auto) => auto.status === 'active' && auto.type === 'event_trigger')
        eventHotCache = buildEventHotCacheFromAutomations(automations)
        const result = await processIncomingTweet({
          tweet,
          automations,
          verifier,
          dispatch: true,
          hotCache: eventHotCache,
          fastVerifier: fastEventVerifier,
          auditWorker: eventAuditWorker,
        })
        if (result.prefiltered) {
          console.log(
            `[Runner] Twitter event ${tweet.id}: verified=${result.verified} fast=${result.fastPath} matches=${result.matchedAutomationIds.length} latency=${result.latency.totalMs}ms reason=${result.reason.slice(0, 100)}`
          )
        }
      },
      onPoll: (stats) => {
        if (stats.sourceCount > 0 || stats.tweetCount > 0) {
          console.log(`[Runner] Twitter poll sources=${stats.sourceCount} newTweets=${stats.tweetCount} latency=${stats.latencyMs}ms`)
        }
      },
    })
    console.log(`[Runner] Twitter event ingestion enabled. Polling active sources every ${Number(process.env.TWITTERAPI_IO_POLL_MS || process.env.TWITTERAPI_IO_SOURCE_REFRESH_MS || 5000) / 1000}s.`)
  } else {
    console.log('[Runner] Twitter event ingestion disabled. Set TWITTERAPI_IO_KEY to enable.')
  }

  console.log(`[Runner] ✅ Rehydrated ${active.length} automation(s): ${dcaCount} DCA, ${alertCount} alerts`)
}

/**
 * Schedule a newly created DCA automation (called from the automations tool).
 * This is the hook for when a client creates a new DCA while the runner is live.
 */
export function scheduleNewAutomation(auto: AutomationEntry) {
  if (!running) return
  if (auto.type === 'dca' && auto.status === 'active') {
    scheduleDCA(auto)
  }
  if (auto.type === 'event_trigger' && auto.status === 'active') {
    eventHotCache = buildEventHotCacheFromAutomations(loadAutomations().automations)
    void twitterPolling?.pollNow()
  }
  // Price alerts are picked up by the polling loop automatically
}

export function unscheduleAutomation(autoId: string) {
  const existing = activeTimers.get(autoId)
  if (!existing) return
  clearTimeout(existing)
  activeTimers.delete(autoId)
  console.log(`[Runner] Cleared timer for automation ${autoId}`)
}

export function stopAutomationRunner() {
  running = false
  // Clear all DCA timers
  for (const [id, timer] of activeTimers) {
    clearTimeout(timer)
    console.log(`[Runner] Cleared timer for DCA ${id}`)
  }
  activeTimers.clear()
  // Clear polling timer
  if (pricePollTimer) {
    clearInterval(pricePollTimer)
    pricePollTimer = null
  }
  if (twitterPolling) {
    twitterPolling.stop()
    twitterPolling = null
  }
  twitterClient = null
  console.log(`[Runner] 🛑 Automation runner stopped`)
}
