/**
 * ./AGENT Protocol — Automation Runner
 * Background engine that executes automations independently of MCP clients.
 *
 * Price Alerts:    Polls price periodically (needs to check current price).
 *
 * On server boot, rehydrates all active automations from disk and schedules them.
 */

import { loadAutomations, addAutomationHistory, cancelAutomation, type AutomationEntry } from './scheduler.js'
import { TwitterApiIoClient, type TwitterPollingHandle } from './twitterapi-client.js'
import { deriveSourceState } from './automation-source-manager.js'
import { createDefaultGrokVerifier } from './automation-verifier.js'
import { processIncomingTweet } from './twitter-ingestion-worker.js'
import { compileEventAutomation } from './fast-event-compiler.js'
import { EventHotCache } from './event-hot-cache.js'
import { FastEventVerifier } from './fast-event-verifier.js'
import { EventAuditWorker } from './event-audit-worker.js'
import { isNotificationEvent, isAutomationStillValid, type EventTriggerAutomationParams, type TweetSourceMeta } from './automation-types.js'
import { canRunOwnedAutomation } from './access-control.js'

const PRICE_POLL_MS = 30_000 // Check price alerts every 30s

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
    if (automation.status !== 'active' || automation.type !== 'event_trigger' || !isNotificationEvent(automation.params) || automation.params.mode !== 'notify_only') return []
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

// ─── Price Alert Executor ────────────────────────────────

export function groupPriceAlerts(alerts: AutomationEntry[]): AutomationEntry[][] {
  const groups = new Map<string, AutomationEntry[]>()
  for (const alert of alerts) {
    if (alert.type !== 'price_alert' || alert.status !== 'active') continue
    const key = JSON.stringify([alert.userId ?? null, (alert.params as { token: string }).token])
    const group = groups.get(key) || []
    group.push(alert)
    groups.set(key, group)
  }
  return [...groups.values()]
}

let checkingPrices = false
export async function checkPriceAlerts() {
  if (checkingPrices) return
  checkingPrices = true
  try {
    const store = loadAutomations()
    const alerts = store.automations.filter((a) => a.type === 'price_alert' && a.status === 'active')
    if (!alerts.length) return

    // Share one lookup only within the same owner: never borrow another owner's quota.
    const groups = groupPriceAlerts(alerts)
    const { handleTool } = await import('./tools/index.js')

    for (const group of groups) {
      try {
        const token = (group[0].params as { token: string }).token
        const owner = canRunOwnedAutomation(group[0])
        if (!owner.allowed || (process.env.AGNT_PASS_ACCESS_REQUIRED === 'true' && !owner.auth)) {
          for (const alert of group) addAutomationHistory(alert.id, 'Price alert paused: active account ownership could not be verified.', false, { countRun: false, status: 'paused', nextRun: null })
          continue
        }
        // Central dispatch checks the current pass and consumes this owner's lookup quota.
        const result = await handleTool('market_data', { action: 'price', token }, undefined, owner.auth)
        if (result.isError) continue
        const priceText = result.content?.[0]?.type === 'text' ? (result.content[0] as { text: string }).text : ''
        const priceMatch = priceText.match(/\$[\d,]+\.?\d*/)?.[0]?.replace(/[$,]/g, '')
        if (!priceMatch) continue
        const currentPrice = parseFloat(priceMatch)
        if (isNaN(currentPrice)) continue

        // Check all alerts for this token
        for (const alert of group) {
          // A user may have canceled the alert while its price request was in flight.
          if (!loadAutomations().automations.some(a => a.id === alert.id && a.status === 'active' && a.userId === alert.userId)) continue
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
  } finally {
    checkingPrices = false
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
 * - Restores verified event notifications from saved automations
 * - Starts a polling loop for price alerts
 */
export function startAutomationRunner() {
  if (running) return
  running = true
  console.log(`[Runner] 🚀 Automation runner starting...`)

  // Rehydrate active automations from disk
  const store = loadAutomations()
  const active = store.automations.filter((a) => a.status === 'active')

  const alertCount = active.filter((auto) => auto.type === 'price_alert').length

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

  console.log(`[Runner] ✅ Rehydrated ${active.length} automation(s): ${alertCount} price alerts`)
}

export function scheduleNewAutomation(auto: AutomationEntry) {
  if (!running) return
  if (auto.type === 'event_trigger' && auto.status === 'active') {
    eventHotCache = buildEventHotCacheFromAutomations(loadAutomations().automations)
    void twitterPolling?.pollNow()
  }
  // Price alerts are picked up by the polling loop automatically
}

export function unscheduleAutomation(_autoId: string) {
  eventHotCache = buildEventHotCacheFromAutomations(loadAutomations().automations)
}

export function stopAutomationRunner() {
  running = false
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
