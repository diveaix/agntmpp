import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  isAutomationStillValid,
  parseAutomationValidity,
  normalizeAutomationMode,
} from '../automation-types.js'
import { addAutomationHistory, createAutomation, loadAutomations, updateAutomationStatusForUser } from '../scheduler.js'
import { buildTopicRule, prefilterTweet } from '../automation-tags.js'
import { deriveSourceState } from '../automation-source-manager.js'
import { MockGrokVerifier, XaiGrokVerifier, normalizeGrokVerificationJson } from '../automation-verifier.js'
import { buildUniversalEventFromVerification, matchEventAutomations } from '../automation-matcher.js'
import { canCreateDataAutomation, getPlanEntitlement } from '../automation-entitlements.js'
import { TwitterApiIoClient } from '../twitterapi-client.js'
import { processIncomingTweet } from '../twitter-ingestion-worker.js'
import { checkEventAutomationIntake, formatMissingQuestions } from '../automation-intake.js'
import { compileEventAutomation } from '../fast-event-compiler.js'
import { EventHotCache } from '../event-hot-cache.js'
import { buildEventHotCacheFromAutomations } from '../automation-runner.js'
import { dispatchMatchedEventAutomation } from '../event-action-dispatcher.js'
import type { AutomationEntry } from '../scheduler.js'

test('normalizes automation execution modes', () => {
  assert.equal(normalizeAutomationMode(undefined), 'notify_only')
  assert.equal(normalizeAutomationMode('emergency_paused'), 'emergency_paused')
  assert.throws(() => normalizeAutomationMode('ask_first'), /notification/)
})

test('parses automation validity windows and rejects missing validity', () => {
  const parsed = parseAutomationValidity('6h', Date.UTC(2026, 0, 1, 0, 0, 0))
  assert.equal(parsed.durationMs, 6 * 60 * 60 * 1000)
  assert.equal(isAutomationStillValid(parsed.validUntil, Date.UTC(2026, 0, 1, 1, 0, 0)), true)
  assert.equal(isAutomationStillValid(parsed.validUntil, Date.UTC(2026, 0, 2, 0, 0, 0)), false)
  assert.throws(() => parseAutomationValidity(undefined), /validFor is required/)
})

test('Grok verifier confirms whether tweet satisfies automation only', async () => {
  const verifier = new MockGrokVerifier()
  const result = await verifier.verify({
    tweet: { id: 'g1', text: 'Iran launched missiles toward Israel, officials say', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    prefilter: { shouldVerify: true, candidateTopics: ['iran_israel_conflict'], matchedKeywords: ['iran', 'launched', 'missiles', 'israel'], matchedEntities: [], sourceTrust: 0.95 },
    trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
  })

  assert.equal(result.matches_automation, true)
  assert.equal(result.needs_external_search, false)
})

test('scheduler persists event trigger automations', () => {
  const path = `./.agnt/test-automations-${Date.now()}.enc`
  const auto = createAutomation({
    type: 'event_trigger',
    name: 'Iran Israel event notification',
    params: {
      trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
      action: { kind: 'notify' },
      mode: 'notify_only',
      validFor: '1h',
      validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    intervalMs: 0,
    maxRuns: 1,
    status: 'active',
  }, path)

  const store = loadAutomations(path)
  assert.equal(store.automations[0].id, auto.id)
  assert.equal(store.automations[0].type, 'event_trigger')
})

test('prefilter sends only active topic tweets to Grok', () => {
  const rule = buildTopicRule('iran_israel_conflict', 2)
  const match = prefilterTweet(
    { id: 't1', text: 'Breaking: Iran launches missiles toward Israel', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    [{ handle: 'Reuters', enabled: true, topics: ['iran_israel_conflict'], trustScore: 0.95 }],
    [rule],
  )

  assert.equal(match.shouldVerify, true)
  assert.deepEqual(match.candidateTopics, ['iran_israel_conflict'])
  assert.match(match.matchedKeywords.join(' '), /iran/i)
})

test('prefilter blocks inactive topics before Grok', () => {
  const rule = buildTopicRule('iran_israel_conflict', 0)
  const match = prefilterTweet(
    { id: 't2', text: 'Iran launches missiles toward Israel', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    [{ handle: 'Reuters', enabled: true, topics: ['iran_israel_conflict'], trustScore: 0.95 }],
    [rule],
  )

  assert.equal(match.shouldVerify, false)
})

test('source manager enables topics only when active automations need them', () => {
  const state = deriveSourceState([
    {
      id: 'a1',
      type: 'event_trigger',
      name: 'Iran Israel',
      params: {
        trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack' },
        action: { kind: 'notify' },
        mode: 'notify_only',
        validFor: '1h',
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      intervalMs: 0,
      maxRuns: 1,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastRun: null,
      nextRun: null,
      runCount: 0,
      history: [],
    },
  ])

  assert.equal(state.topicRules.length, 1)
  assert.equal(state.topicRules[0].topic, 'iran_israel_conflict')
  assert.equal(state.sources.some((s) => s.enabled && s.topics.includes('iran_israel_conflict')), true)
})

test('mock Grok verifier rejects predictions and accepts happened events', async () => {
  const verifier = new MockGrokVerifier()
  const prediction = await verifier.verify({
    tweet: { id: 'p1', text: 'Iran might attack Israel tonight', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    prefilter: { shouldVerify: true, candidateTopics: ['iran_israel_conflict'], matchedKeywords: ['iran', 'attack', 'israel'], matchedEntities: [], sourceTrust: 0.95 },
    trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
  })

  const happened = await verifier.verify({
    tweet: { id: 'h1', text: 'Iran launched missiles toward Israel, officials say', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    prefilter: { shouldVerify: true, candidateTopics: ['iran_israel_conflict'], matchedKeywords: ['iran', 'launched', 'missiles', 'israel'], matchedEntities: [], sourceTrust: 0.95 },
    trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
  })

  assert.equal(prediction.event_happened, false)
  assert.equal(happened.event_happened, true)
  assert.equal(happened.matches_trigger, true)
})

test('matcher finds automations whose trigger matches verified event tags', () => {
  const event = buildUniversalEventFromVerification(
    'evt1',
    ['tweet1'],
    'Iran launched missiles toward Israel',
    {
      event_happened: true,
      matches_trigger: true,
      matches_automation: true,
      needs_external_search: false,
      is_rumor: false,
      is_old_news: false,
      is_opinion_or_prediction: false,
      actor: 'Iran',
      target: 'Israel',
      event_type: 'military_attack',
      confidence: 0.88,
      reason: 'confirmed',
    },
    'iran_israel_conflict',
  )

  const matches = matchEventAutomations(event, [{
    id: 'auto1',
    type: 'event_trigger',
    name: 'Event notification',
    params: {
      trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
      action: { kind: 'notify' },
      mode: 'notify_only',
      validFor: '1h',
      validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    intervalMs: 0,
    maxRuns: 1,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    runCount: 0,
    history: [],
  }])

  assert.equal(matches.length, 1)
  assert.equal(matches[0].id, 'auto1')
})

test('plan entitlements limit data-based automations', () => {
  assert.equal(getPlanEntitlement('free').dataAutomationSlots, 1)
  assert.equal(getPlanEntitlement('pro').dataAutomationSlots, 5)
  assert.equal(getPlanEntitlement('max').dataAutomationSlots, 30)

  assert.equal(canCreateDataAutomation('free', 0).allowed, true)
  assert.equal(canCreateDataAutomation('free', 1).allowed, false)
  assert.equal(canCreateDataAutomation('pro', 4).allowed, true)
  assert.equal(canCreateDataAutomation('pro', 5).allowed, false)
})

test('complex event automation intake lists missing setup questions', () => {
  const result = checkEventAutomationIntake({
    topic: 'middle_east_conflict',
    eventType: 'military_attack',
  })

  assert.equal(result.ok, false)
  const formatted = formatMissingQuestions(result)
  assert.match(formatted, /How long should this automation stay active/)
})

test('twitterapi client stays disabled without API key', () => {
  const client = new TwitterApiIoClient({ apiKey: undefined })
  assert.equal(client.isEnabled(), false)
})

test('twitterapi client fetches, normalizes, and dedupes recent tweets', async () => {
  let calls = 0
  const client = new TwitterApiIoClient({
    apiKey: 'test',
    baseUrl: 'https://api.twitterapi.io',
    tweetsPerSource: 2,
    fetchImpl: async (url) => {
      calls += 1
      assert.match(String(url), /\/twitter\/user\/last_tweets/)
      return new Response(JSON.stringify({
        tweets: [
          { id: '1', text: 'Older tweet', userName: 'Reuters', createdAt: '2026-05-14T00:00:01.000Z' },
          { id: '2', text: 'Iran launched missiles toward Israel', userName: 'Reuters', createdAt: '2026-05-14T00:00:02.000Z' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const seen: string[] = []
  const source = { handle: 'Reuters', enabled: true, topics: ['iran_israel_conflict'], trustScore: 0.95 }
  await client.pollOnce((tweet) => { seen.push(tweet.id) }, [source])
  await client.pollOnce((tweet) => { seen.push(tweet.id) }, [source])

  assert.deepEqual(seen, ['1', '2'])
  assert.equal(calls, 2)
})

test('xAI Grok verifier parses strict JSON responses', async () => {
  const verifier = new XaiGrokVerifier({
    apiKey: 'xai-test',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            event_happened: true,
            matches_trigger: true,
            matches_automation: true,
            needs_external_search: false,
            is_rumor: false,
            is_old_news: false,
            is_opinion_or_prediction: false,
            actor: 'Iran',
            target: 'Israel',
            event_type: 'military_attack',
            confidence: 0.91,
            reason: 'The tweet says the event happened.',
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })

  const result = await verifier.verify({
    tweet: { id: 'grok1', text: 'Iran launched missiles toward Israel', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    prefilter: { shouldVerify: true, candidateTopics: ['iran_israel_conflict'], matchedKeywords: ['iran'], matchedEntities: ['Israel'], sourceTrust: 0.95 },
    trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel' },
  })

  assert.equal(result.matches_trigger, true)
  assert.equal(result.confidence, 0.91)
})

test('grok verification JSON rejects missing confidence', () => {
  assert.throws(
    () => normalizeGrokVerificationJson({ event_happened: true, matches_trigger: true }, { topic: 'iran_israel_conflict' }),
    /missing numeric confidence/i,
  )
})

test('tweet ingestion verifies and matches event automations', async () => {
  const result = await processIncomingTweet({
    tweet: { id: 'tw1', text: 'Iran launched missiles toward Israel, officials say', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    automations: [{
      id: 'auto1',
      type: 'event_trigger',
      name: 'Event notification',
      params: {
        trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
        action: { kind: 'notify' },
        mode: 'notify_only',
        validFor: '1h',
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      intervalMs: 0,
      maxRuns: 1,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastRun: null,
      nextRun: null,
      runCount: 0,
      history: [],
    }],
    verifier: new MockGrokVerifier(),
  })

  assert.equal(result.verified, true)
  assert.equal(result.matchedAutomationIds.includes('auto1'), true)
  assert.equal(result.dispatches.length, 0)
  assert.equal(result.latency.totalMs >= 0, true)
})

test('tweet ingestion uses fast verifier before Grok for clear trusted events', async () => {
  const rule = compileEventAutomation({
    automationId: 'auto_fast_1',
    topic: 'iran_israel_conflict',
    triggerText: 'notify if Iran attacks Israel',
    sourceHandles: ['sentdefender'],
    sourceTiers: { sentdefender: 0.95 },
    verificationMode: 'speed',
    actionReady: true,
    createdAt: 1_700_000_000_000,
  })
  const hotCache = new EventHotCache()
  hotCache.rebuild([rule])
  let grokCalled = false

  const result = await processIncomingTweet({
    tweet: {
      id: 'tweet_fast_1',
      authorHandle: 'sentdefender',
      text: 'Iran launched missiles toward Israel.',
      createdAt: new Date(1_700_000_000_000).toISOString(),
    },
    automations: [{
      id: 'auto_fast_1',
      type: 'event_trigger',
      name: 'Event notification',
      params: {
        trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
        action: { kind: 'notify' },
        mode: 'notify_only',
        validFor: '1h',
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      intervalMs: 0,
      maxRuns: 1,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastRun: null,
      nextRun: null,
      runCount: 0,
      history: [],
    }],
    verifier: {
      verify: async () => {
        grokCalled = true
        return {
          event_happened: true,
          matches_trigger: true,
          matches_automation: true,
          needs_external_search: false,
          is_rumor: false,
          is_old_news: false,
          is_opinion_or_prediction: false,
          event_type: 'military_attack',
          confidence: 0.9,
          reason: 'grok confirmation',
        }
      },
    },
    hotCache,
    dispatch: false,
    now: 1_700_000_000_010,
  })

  assert.equal(result.verified, true)
  assert.equal(result.fastPath, true)
  assert.equal(result.matchedAutomationIds.includes('auto_fast_1'), true)
  assert.equal(grokCalled, false)
  assert.equal(Number.isFinite(result.latency.verifyMs), true)
})

test('runner builds hot cache from active event automations', () => {
  const cache = buildEventHotCacheFromAutomations([{
    id: 'auto_runner_1',
    type: 'event_trigger',
    name: 'Event notification',
    params: {
      trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
      action: { kind: 'notify' },
      mode: 'notify_only',
      verificationMode: 'speed',
      actionReady: true,
      validFor: '1h',
      validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    intervalMs: 0,
    maxRuns: 1,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    runCount: 0,
    history: [],
  }])

  assert.deepEqual(cache.rulesForSource('Reuters').map((rule) => rule.automationId), ['auto_runner_1'])
})

test('tweet ingestion dispatches notify-only event automations and records latency', async () => {
  const previousPath = process.env.AGNT_AUTOMATIONS_PATH
  process.env.AGNT_AUTOMATIONS_PATH = `./.agnt/test-event-dispatch-${Date.now()}-${Math.random().toString(16).slice(2)}.enc`
  try {
    const automation = createAutomation({
      type: 'event_trigger',
      name: 'Notify event',
      params: {
        trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
        action: { kind: 'notify' },
        mode: 'notify_only',
        validFor: '1h',
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      intervalMs: 0,
      maxRuns: 1,
      status: 'active',
    })

    const result = await processIncomingTweet({
      tweet: { id: 'tw-dispatch', text: 'Iran launched missiles toward Israel, officials say', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
      automations: [automation],
      verifier: new MockGrokVerifier(),
      dispatch: true,
    })

    assert.equal(result.dispatches.length, 1)
    assert.equal(result.dispatches[0].submitted, false)
    assert.equal(result.latency.dispatchMs >= 0, true)
    const saved = loadAutomations().automations.find((item) => item.id === automation.id)
    assert.equal(saved?.status, 'completed')
    assert.match(saved?.history[0]?.result || '', /Verified event matched/)
  } finally {
    if (previousPath === undefined) delete process.env.AGNT_AUTOMATIONS_PATH
    else process.env.AGNT_AUTOMATIONS_PATH = previousPath
  }
})

test('twitter ingestion remains disabled without TWITTERAPI_IO_KEY', () => {
  delete process.env.TWITTERAPI_IO_KEY
  const client = new TwitterApiIoClient({ apiKey: process.env.TWITTERAPI_IO_KEY })
  assert.equal(client.isEnabled(), false)
})

function legacyAutomation(overrides: Partial<AutomationEntry> = {}): AutomationEntry {
  return {
    id: 'legacy-auto',
    type: 'dca',
    name: 'Saved automation',
    userId: 'usr_legacy',
    params: { tokenIn: 'USDC', tokenOut: 'ETH', amount: 1 },
    intervalMs: 30_000,
    maxRuns: 3,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: new Date(Date.now() + 30_000).toISOString(),
    runCount: 1,
    history: [{ time: new Date().toISOString(), result: 'Previous execution', success: true }],
    ...overrides,
  }
}

test('legacy integrations remain saved but cannot resume or be retargeted', () => {
  const previousPath = process.env.AGNT_AUTOMATIONS_PATH
  process.env.AGNT_AUTOMATIONS_PATH = `./.agnt/test-legacy-automations-${Date.now()}.json`
  const legacy = [
    legacyAutomation(),
    legacyAutomation({ id: 'legacy-trade', type: 'event_trigger', params: {
      trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack' },
      action: { protocol: 'polymarket', marketId: 'saved-market', side: 'YES', maxSpend: 10 },
      mode: 'auto_execute', validUntil: new Date(Date.now() + 60_000).toISOString(),
    } }),
    legacyAutomation({ id: 'legacy-monitor', type: 'market_monitor', params: { trigger: { protocol: 'hyperliquid', metric: 'funding_rate' } } }),
  ]
  writeFileSync(process.env.AGNT_AUTOMATIONS_PATH, JSON.stringify({ automations: legacy }))
  try {
    const saved = loadAutomations().automations
    assert.deepEqual(JSON.parse(readFileSync(process.env.AGNT_AUTOMATIONS_PATH!, 'utf8')).automations, legacy)
    assert.equal(saved.length, legacy.length)
    for (const [index, auto] of saved.entries()) {
      assert.equal(auto.status, 'paused')
      assert.equal(auto.nextRun, null)
      assert.deepEqual(auto.params, legacy[index].params)
      assert.equal(auto.history[0].result, 'Previous execution')
      const resumed = updateAutomationStatusForUser(auto.id, 'usr_legacy', 'active')
      assert.equal(resumed?.status, 'paused')
      assert.equal(resumed?.runCount, 1)
      assert.equal(resumed?.nextRun, null)
      assert.match(resumed?.history.at(-1)?.result || '', /no longer supported/)
    }
    assert.equal(deriveSourceState(legacy).topicRules.length, 0)
    assert.equal(buildEventHotCacheFromAutomations(legacy).rulesForSource('Reuters').length, 0)
  } finally {
    if (previousPath === undefined) delete process.env.AGNT_AUTOMATIONS_PATH
    else process.env.AGNT_AUTOMATIONS_PATH = previousPath
  }
})

test('legacy event trade dispatcher cannot submit or turn a trade into a notification', async () => {
  const auto = legacyAutomation({ type: 'event_trigger', params: {
    action: { protocol: 'hyperliquid', kind: 'trade', market: 'ETH', amountUsd: 50 },
    mode: 'auto_execute',
  } })
  const result = await dispatchMatchedEventAutomation(auto, {
    id: 'event', topic: 'crypto_security', eventType: 'protocol_exploit', entities: [], assetImpact: [],
    confidence: 1, sourceTweetIds: [], createdAt: new Date().toISOString(), summary: 'Verified event',
  })
  assert.equal(result.submitted, false)
  assert.match(result.reason, /unavailable or paused/)
})
