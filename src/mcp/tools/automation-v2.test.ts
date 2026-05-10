import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAutomationStillValid,
  parseAutomationValidity,
  normalizeAutomationMode,
  type EventTriggerAutomationParams,
  type HyperliquidInfoMonitorParams,
} from '../automation-types.js'
import { addAutomationHistory, createAutomation, loadAutomations, updateAutomationStatusForUser } from '../scheduler.js'
import { buildTopicRule, prefilterTweet } from '../automation-tags.js'
import { deriveSourceState } from '../automation-source-manager.js'
import { MockGrokVerifier } from '../automation-verifier.js'
import { buildUniversalEventFromVerification, matchEventAutomations } from '../automation-matcher.js'
import { evaluateAutomationPolicy } from '../automation-policy.js'
import { simulateAutomationAction, simulateHyperliquidInfoMonitor } from '../automation-simulators.js'
import { canCreateDataAutomation, getPlanEntitlement } from '../automation-entitlements.js'
import automationsModule from './automations.js'
import { TwitterApiIoClient } from '../twitterapi-client.js'
import { processIncomingTweet } from '../twitter-ingestion-worker.js'
import { checkEventAutomationIntake, formatMissingQuestions } from '../automation-intake.js'

test('normalizes automation execution modes', () => {
  assert.equal(normalizeAutomationMode(undefined), 'notify_only')
  assert.equal(normalizeAutomationMode('ask_first'), 'ask_first')
  assert.equal(normalizeAutomationMode('auto_execute'), 'auto_execute')
  assert.equal(normalizeAutomationMode('bad-value'), 'notify_only')
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

test('event trigger params support Polymarket and Hyperliquid actions', () => {
  const polymarket: EventTriggerAutomationParams = {
    trigger: {
      topic: 'iran_israel_conflict',
      eventType: 'military_attack',
      actor: 'Iran',
      target: 'Israel',
      minConfidence: 0.8,
    },
    action: {
      protocol: 'polymarket',
      marketId: 'iran-israel-market',
      side: 'YES',
      maxSpend: 25,
      maxPrice: 0.65,
    },
    policy: { maxDailySpend: 50 },
    mode: 'auto_execute',
    validFor: '6h',
    validUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  }

  const hyperliquid: EventTriggerAutomationParams = {
    trigger: {
      topic: 'middle_east_conflict',
      eventType: 'military_attack',
      assetImpact: 'crypto_risk_off',
      minConfidence: 0.85,
    },
    action: {
      protocol: 'hyperliquid',
      kind: 'trade',
      market: 'ETH',
      side: 'short',
      amountUsd: 50,
      leverage: 2,
      stopLossPercent: 3,
      takeProfitPercent: 6,
    },
    policy: { maxLeverage: 3 },
    mode: 'ask_first',
    validFor: '1d',
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }

  assert.equal(polymarket.action.protocol, 'polymarket')
  assert.equal(hyperliquid.action.protocol, 'hyperliquid')
})

test('hyperliquid information monitor params are read-only capable', () => {
  const monitor: HyperliquidInfoMonitorParams = {
    trigger: {
      protocol: 'hyperliquid',
      metric: 'funding_rate',
      market: 'BTC',
      condition: 'above',
      threshold: 0.01,
    },
    action: {
      kind: 'notify',
      message: 'BTC funding is unusually high.',
    },
    policy: {},
    mode: 'notify_only',
    validFor: '7d',
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }

  assert.equal(monitor.trigger.metric, 'funding_rate')
  assert.equal(monitor.action.kind, 'notify')
})

test('scheduler persists event trigger automations', () => {
  const path = `./.agnt/test-automations-${Date.now()}.enc`
  const auto = createAutomation({
    type: 'event_trigger',
    name: 'Iran Israel Polymarket test',
    params: {
      trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
      action: { protocol: 'polymarket', marketId: 'market-1', side: 'YES', maxSpend: 10 },
      policy: { maxDailySpend: 10 },
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

test('resuming a paused DCA restores the next run when executions remain', () => {
  const previousPath = process.env.AGNT_AUTOMATIONS_PATH
  process.env.AGNT_AUTOMATIONS_PATH = `./.agnt/test-resume-dca-${Date.now()}.enc`
  try {
    const auto = createAutomation({
      type: 'dca',
      name: 'Swap pathUSD to USDC.e',
      userId: 'usr_resume_dca',
      params: { tokenIn: 'pathUSD', tokenOut: 'USDC.e', amount: 0.1 },
      intervalMs: 20_000,
      maxRuns: 4,
      status: 'active',
    })

    addAutomationHistory(auto.id, 'run 1', true)
    addAutomationHistory(auto.id, 'run 2', true)
    addAutomationHistory(auto.id, 'run 3', true)

    const paused = updateAutomationStatusForUser(auto.id, 'usr_resume_dca', 'paused')
    assert.equal(paused?.runCount, 3)
    assert.equal(paused?.nextRun, null)

    const resumed = updateAutomationStatusForUser(auto.id, 'usr_resume_dca', 'active')
    assert.equal(resumed?.status, 'active')
    assert.equal(resumed?.runCount, 3)
    assert.ok(resumed?.nextRun)
    assert.ok(new Date(resumed.nextRun).getTime() > Date.now())
  } finally {
    if (previousPath === undefined) delete process.env.AGNT_AUTOMATIONS_PATH
    else process.env.AGNT_AUTOMATIONS_PATH = previousPath
  }
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
        action: { protocol: 'polymarket', marketId: 'm1', side: 'YES', maxSpend: 10 },
        policy: {},
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
    name: 'Buy YES',
    params: {
      trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
      action: { protocol: 'polymarket', marketId: 'm1', side: 'YES', maxSpend: 10 },
      policy: {},
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

test('policy blocks auto execution when simulation has blocks or mode is paused', () => {
  const blocked = evaluateAutomationPolicy(
    { maxTradeSizeUsd: 10 },
    'auto_execute',
    { ok: false, protocol: 'polymarket', summary: 'bad price', warnings: [], blocks: ['price too high'], estimatedCostUsd: 8 },
  )
  const paused = evaluateAutomationPolicy(
    {},
    'emergency_paused',
    { ok: true, protocol: 'hyperliquid', summary: 'ok', warnings: [], blocks: [], estimatedCostUsd: 5 },
  )

  assert.equal(blocked.allowed, false)
  assert.equal(paused.allowed, false)
})

test('policy allows ask-first simulations but marks mode clearly', () => {
  const decision = evaluateAutomationPolicy(
    { maxTradeSizeUsd: 100 },
    'ask_first',
    { ok: true, protocol: 'polymarket', summary: 'ok', warnings: [], blocks: [], estimatedCostUsd: 10 },
  )

  assert.equal(decision.allowed, true)
  assert.equal(decision.mode, 'ask_first')
})

test('simulates Polymarket event action with max price guard', async () => {
  const ok = await simulateAutomationAction({
    protocol: 'polymarket',
    marketId: 'm1',
    side: 'YES',
    maxSpend: 25,
    maxPrice: 0.65,
  }, { polymarketPrice: 0.55 })

  const blocked = await simulateAutomationAction({
    protocol: 'polymarket',
    marketId: 'm1',
    side: 'YES',
    maxSpend: 25,
    maxPrice: 0.65,
  }, { polymarketPrice: 0.75 })

  assert.equal(ok.ok, true)
  assert.equal(blocked.ok, false)
  assert.match(blocked.blocks.join(' '), /price/i)
})

test('simulates Hyperliquid trades and requires stop loss when requested', async () => {
  const result = await simulateAutomationAction({
    protocol: 'hyperliquid',
    kind: 'trade',
    market: 'ETH',
    side: 'short',
    amountUsd: 50,
    leverage: 2,
  }, { requireStopLoss: true })

  assert.equal(result.ok, false)
  assert.match(result.blocks.join(' '), /stop loss/i)
})

test('simulates Hyperliquid information monitors as read-only', async () => {
  const result = await simulateHyperliquidInfoMonitor({
    trigger: { protocol: 'hyperliquid', metric: 'funding_rate', market: 'BTC', condition: 'above', threshold: 0.01 },
    action: { kind: 'notify', message: 'BTC funding is high.' },
    policy: {},
    mode: 'notify_only',
    validFor: '1h',
    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, { currentValue: 0.012 })

  assert.equal(result.ok, true)
  assert.equal(result.protocol, 'hyperliquid')
  assert.match(result.summary, /funding_rate/)
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
    protocol: 'hyperliquid',
    topic: 'middle_east_conflict',
    eventType: 'military_attack',
  })

  assert.equal(result.ok, false)
  const formatted = formatMissingQuestions(result)
  assert.match(formatted, /How long should this automation stay active/)
  assert.match(formatted, /What stop loss percent should protect the trade/)
})

test('automations tool creates event trigger automation in plain English output', async () => {
  process.env.AGNT_AUTOMATIONS_PATH = `./.agnt/test-tool-event-${Date.now()}.enc`
  const result = await automationsModule.handle('automations', {
    action: 'create_event',
    plan: 'free',
    topic: 'iran_israel_conflict',
    eventType: 'military_attack',
    actor: 'Iran',
    target: 'Israel',
    protocol: 'polymarket',
    marketId: 'm1',
    side: 'YES',
    maxSpend: 10,
    maxPrice: 0.65,
    validFor: '1h',
    mode: 'notify_only',
  })

  const output = result?.content?.[0]?.type === 'text' ? result.content[0].text : ''
  assert.match(output, /Event Automation Created/i)
  assert.match(output, /Grok verification/i)
  assert.match(output, /Plan: free/i)
})

test('automations tool creates Hyperliquid information monitor', async () => {
  process.env.AGNT_AUTOMATIONS_PATH = `./.agnt/test-tool-monitor-${Date.now()}.enc`
  const result = await automationsModule.handle('automations', {
    action: 'create_hl_monitor',
    plan: 'pro',
    metric: 'funding_rate',
    market: 'BTC',
    condition: 'above',
    threshold: 0.01,
    validFor: '1h',
    mode: 'notify_only',
  })

  const output = result?.content?.[0]?.type === 'text' ? result.content[0].text : ''
  assert.match(output, /Hyperliquid Monitor Created/i)
  assert.match(output, /funding_rate/i)
})

test('twitterapi client stays disabled without API key', () => {
  const client = new TwitterApiIoClient({ apiKey: undefined })
  assert.equal(client.isEnabled(), false)
})

test('tweet ingestion verifies and matches event automations', async () => {
  const result = await processIncomingTweet({
    tweet: { id: 'tw1', text: 'Iran launched missiles toward Israel, officials say', authorHandle: 'Reuters', createdAt: new Date().toISOString() },
    automations: [{
      id: 'auto1',
      type: 'event_trigger',
      name: 'Buy YES',
      params: {
        trigger: { topic: 'iran_israel_conflict', eventType: 'military_attack', actor: 'Iran', target: 'Israel', minConfidence: 0.8 },
        action: { protocol: 'polymarket', marketId: 'm1', side: 'YES', maxSpend: 10 },
        policy: {},
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
})

test('automations tool refuses event automation without validity window', async () => {
  process.env.AGNT_AUTOMATIONS_PATH = `./.agnt/test-tool-missing-validity-${Date.now()}.enc`
  const result = await automationsModule.handle('automations', {
    action: 'create_event',
    plan: 'pro',
    topic: 'iran_israel_conflict',
    eventType: 'military_attack',
    actor: 'Iran',
    target: 'Israel',
    protocol: 'polymarket',
    marketId: 'm1',
    side: 'YES',
    maxSpend: 10,
    mode: 'notify_only',
  })

  const output = result?.content?.[0]?.type === 'text' ? result.content[0].text : ''
  assert.equal(result?.isError, true)
  assert.match(output, /How long should this automation stay active/i)
})

test('twitter ingestion remains disabled without TWITTERAPI_IO_KEY', () => {
  delete process.env.TWITTERAPI_IO_KEY
  const client = new TwitterApiIoClient({ apiKey: process.env.TWITTERAPI_IO_KEY })
  assert.equal(client.isEnabled(), false)
})
