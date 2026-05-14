import type { AutomationEntry } from './scheduler.js'
import type { GrokVerifier } from './automation-verifier.js'
import type { IncomingTweet } from './automation-types.js'
import { deriveSourceState } from './automation-source-manager.js'
import { prefilterTweet } from './automation-tags.js'
import { buildUniversalEventFromVerification, matchEventAutomations } from './automation-matcher.js'
import { dispatchMatchedEventAutomation, type EventDispatchResult } from './event-action-dispatcher.js'
import { FastEventVerifier } from './fast-event-verifier.js'
import type { EventHotCache } from './event-hot-cache.js'
import type { EventAuditWorker } from './event-audit-worker.js'
import type { UniversalEvent } from './automation-types.js'

export interface ProcessIncomingTweetInput {
  tweet: IncomingTweet
  automations: AutomationEntry[]
  verifier: GrokVerifier
  dispatch?: boolean
  hotCache?: EventHotCache
  fastVerifier?: FastEventVerifier
  auditWorker?: EventAuditWorker
  now?: number
}

export interface ProcessIncomingTweetResult {
  prefiltered: boolean
  verified: boolean
  fastPath: boolean
  matchedAutomationIds: string[]
  reason: string
  dispatches: EventDispatchResult[]
  latency: {
    totalMs: number
    prefilterMs: number
    verifyMs: number
    matchMs: number
    dispatchMs: number
  }
}

function numericTweetTime(createdAt: string): number {
  const parsed = new Date(createdAt).getTime()
  return Number.isFinite(parsed) ? parsed : Date.now()
}

export async function processIncomingTweet(input: ProcessIncomingTweetInput): Promise<ProcessIncomingTweetResult> {
  const started = Date.now()
  const prefilterStarted = Date.now()
  const now = input.now ?? Date.now()
  const sourceState = deriveSourceState(input.automations)
  const prefilter = prefilterTweet(input.tweet, sourceState.sources, sourceState.topicRules)
  const prefilterMs = Date.now() - prefilterStarted
  const emptyLatency = () => ({ totalMs: Date.now() - started, prefilterMs, verifyMs: 0, matchMs: 0, dispatchMs: 0 })
  if (!prefilter.shouldVerify) return { prefiltered: false, verified: false, fastPath: false, matchedAutomationIds: [], reason: 'Tweet did not pass prefilter.', dispatches: [], latency: emptyLatency() }

  const candidateTopic = prefilter.candidateTopics[0]
  const candidateAutomation = input.automations.find((auto) => {
    if (auto.type !== 'event_trigger' || auto.status !== 'active') return false
    const trigger = (auto.params as { trigger?: { topic?: string } }).trigger
    return trigger?.topic === candidateTopic
  })
  if (!candidateAutomation) return { prefiltered: true, verified: false, fastPath: false, matchedAutomationIds: [], reason: 'No candidate automation found.', dispatches: [], latency: emptyLatency() }

  const trigger = (candidateAutomation.params as { trigger: { topic: string; eventType?: string; actor?: string; target?: string } }).trigger
  const fastRules = input.hotCache?.rulesForSource(input.tweet.authorHandle) ?? []
  if (fastRules.length > 0) {
    const verifyStarted = Date.now()
    const fastVerifier = input.fastVerifier ?? new FastEventVerifier()
    const fastResult = fastVerifier.verify({
      post: {
        id: input.tweet.id,
        sourceHandle: input.tweet.authorHandle,
        text: input.tweet.text,
        createdAt: numericTweetTime(input.tweet.createdAt),
        receivedAt: now,
      },
      rules: fastRules,
      now,
    })
    const verifyMs = Date.now() - verifyStarted

    if (fastResult.decision === 'reject') {
      return {
        prefiltered: true,
        verified: false,
        fastPath: true,
        matchedAutomationIds: [],
        reason: fastResult.reason,
        dispatches: [],
        latency: { totalMs: Date.now() - started, prefilterMs, verifyMs, matchMs: 0, dispatchMs: 0 },
      }
    }

    if (fastResult.decision === 'pass') {
      const evidence = fastResult.evidence[0]
      const rule = fastResult.matchedRuleIds[0] ? input.hotCache?.ruleByAutomationId(fastResult.matchedRuleIds[0]) : undefined
      const event: UniversalEvent = {
        id: `evt_${input.tweet.id}`,
        topic: rule?.topic || candidateTopic,
        eventType: evidence?.eventType || rule?.eventType || trigger.eventType || 'unknown',
        actor: evidence?.actor || trigger.actor,
        target: evidence?.target || trigger.target,
        entities: [evidence?.actor || trigger.actor, evidence?.target || trigger.target].filter(Boolean) as string[],
        assetImpact: [],
        confidence: fastResult.score,
        sourceTweetIds: [input.tweet.id],
        createdAt: new Date(now).toISOString(),
        summary: input.tweet.text,
      }
      const matchStarted = Date.now()
      const matches = matchEventAutomations(event, input.automations)
      const matchMs = Date.now() - matchStarted

      const dispatchStarted = Date.now()
      const dispatches = input.dispatch
        ? await Promise.all(matches.map((auto) => dispatchMatchedEventAutomation(auto, event)))
        : []
      const dispatchMs = Date.now() - dispatchStarted

      input.auditWorker?.enqueue({
        automationIds: matches.map((match) => match.id),
        tweetId: input.tweet.id,
        sourceHandle: input.tweet.authorHandle,
        text: input.tweet.text,
        reason: fastResult.reason,
        createdAt: numericTweetTime(input.tweet.createdAt),
      })

      return {
        prefiltered: true,
        verified: true,
        fastPath: true,
        matchedAutomationIds: matches.map((m) => m.id),
        reason: fastResult.reason,
        dispatches,
        latency: { totalMs: Date.now() - started, prefilterMs, verifyMs, matchMs, dispatchMs },
      }
    }
  }

  const verifyStarted = Date.now()
  const verification = await input.verifier.verify({ tweet: input.tweet, prefilter, trigger })
  const verifyMs = Date.now() - verifyStarted
  if (!verification.event_happened || !verification.matches_trigger || verification.is_rumor || verification.is_old_news || verification.is_opinion_or_prediction) {
    return {
      prefiltered: true,
      verified: false,
      fastPath: false,
      matchedAutomationIds: [],
      reason: verification.reason,
      dispatches: [],
      latency: { totalMs: Date.now() - started, prefilterMs, verifyMs, matchMs: 0, dispatchMs: 0 },
    }
  }

  const matchStarted = Date.now()
  const event = buildUniversalEventFromVerification(`evt_${input.tweet.id}`, [input.tweet.id], input.tweet.text, verification, candidateTopic)
  const matches = matchEventAutomations(event, input.automations)
  const matchMs = Date.now() - matchStarted

  const dispatchStarted = Date.now()
  const dispatches = input.dispatch
    ? await Promise.all(matches.map((auto) => dispatchMatchedEventAutomation(auto, event)))
    : []
  const dispatchMs = Date.now() - dispatchStarted

  return {
    prefiltered: true,
    verified: true,
    fastPath: false,
    matchedAutomationIds: matches.map((m) => m.id),
    reason: verification.reason,
    dispatches,
    latency: {
      totalMs: Date.now() - started,
      prefilterMs,
      verifyMs,
      matchMs,
      dispatchMs,
    },
  }
}
