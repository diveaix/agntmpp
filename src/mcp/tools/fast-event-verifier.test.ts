import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFastVerificationMode,
  type CompiledEventRule,
  type FastVerificationResult,
} from '../fast-event-types.js'
import { compileEventAutomation } from '../fast-event-compiler.js'
import { EventQuorumStore } from '../event-quorum-store.js'
import { FastEventVerifier } from '../fast-event-verifier.js'
import { EventHotCache } from '../event-hot-cache.js'
import { EventAuditWorker } from '../event-audit-worker.js'

test('normalizes supported fast verification modes', () => {
  assert.equal(normalizeFastVerificationMode('speed'), 'speed')
  assert.equal(normalizeFastVerificationMode('balanced'), 'balanced')
  assert.equal(normalizeFastVerificationMode('fortress'), 'fortress')
  assert.equal(normalizeFastVerificationMode(undefined), 'balanced')
  assert.equal(normalizeFastVerificationMode('unknown'), 'balanced')
})

test('compiled rule and result types support strict evidence', () => {
  const rule: CompiledEventRule = {
    automationId: 'auto_1',
    topic: 'iran_israel_conflict',
    mode: 'balanced',
    sourceHandles: ['sentdefender'],
    minSourceTrust: 0.8,
    sourceTiers: { sentdefender: 0.95 },
    actorAliases: ['iran', 'tehran'],
    targetAliases: ['israel'],
    confirmedVerbs: ['attacked', 'launched', 'struck'],
    rejectPhrases: ['may attack', 'could attack', 'rumor', 'unconfirmed'],
    eventType: 'military_attack',
    freshnessMs: 120_000,
    quorum: 1,
    actionReady: true,
    createdAt: 1_700_000_000_000,
  }

  const result: FastVerificationResult = {
    decision: 'pass',
    score: 0.93,
    reason: 'trusted source confirmed actor, target, and event verb',
    matchedRuleIds: [rule.automationId],
    evidence: [{
      ruleId: rule.automationId,
      sourceHandle: 'sentdefender',
      tweetId: 'tweet_1',
      actor: 'iran',
      target: 'israel',
      verb: 'launched',
      eventType: 'military_attack',
      matchedText: 'Iran launched missiles toward Israel.',
    }],
    latencyMs: 1,
  }

  assert.equal(result.decision, 'pass')
  assert.equal(result.evidence[0]?.verb, 'launched')
})

test('compiles an event automation into strict attack verification rules', () => {
  const rule = compileEventAutomation({
    automationId: 'auto_iran_israel',
    topic: 'iran_israel_conflict',
    triggerText: 'buy YES if Iran attacks Israel',
    sourceHandles: ['@sentdefender'],
    sourceTiers: { '@sentdefender': 0.95 },
    verificationMode: 'speed',
    actionReady: true,
    createdAt: 1_700_000_000_000,
  })

  assert.equal(rule.automationId, 'auto_iran_israel')
  assert.equal(rule.mode, 'speed')
  assert.deepEqual(rule.actorAliases, ['iran'])
  assert.deepEqual(rule.targetAliases, ['israel'])
  assert.ok(rule.confirmedVerbs.includes('attacked'))
  assert.ok(rule.confirmedVerbs.includes('launched'))
  assert.ok(rule.rejectPhrases.includes('may attack'))
  assert.equal(rule.quorum, 1)
})

test('fortress mode requires two-source quorum by default', () => {
  const rule = compileEventAutomation({
    automationId: 'auto_fortress',
    topic: 'iran_israel_conflict',
    triggerText: 'short ETH if Iran attacks Israel',
    sourceHandles: ['@sourcea', '@sourceb'],
    sourceTiers: { '@sourcea': 0.9, '@sourceb': 0.91 },
    verificationMode: 'fortress',
    actionReady: true,
    createdAt: 1_700_000_000_000,
  })

  assert.equal(rule.mode, 'fortress')
  assert.equal(rule.quorum, 2)
})

test('event quorum store ignores duplicate tweet confirmations', () => {
  const store = new EventQuorumStore({ ttlMs: 60_000 })
  const first = store.record({
    fingerprint: 'iran-israel-attack',
    tweetId: 'tweet_1',
    sourceHandle: '@sourcea',
    requiredQuorum: 2,
    now: 1_700_000_000_000,
  })
  const duplicate = store.record({
    fingerprint: 'iran-israel-attack',
    tweetId: 'tweet_1',
    sourceHandle: '@sourcea',
    requiredQuorum: 2,
    now: 1_700_000_000_100,
  })

  assert.equal(first.met, false)
  assert.equal(first.uniqueSources, 1)
  assert.equal(duplicate.met, false)
  assert.equal(duplicate.uniqueSources, 1)
})

test('event quorum store passes after independent trusted sources confirm', () => {
  const store = new EventQuorumStore({ ttlMs: 60_000 })
  store.record({
    fingerprint: 'iran-israel-attack',
    tweetId: 'tweet_1',
    sourceHandle: '@sourcea',
    requiredQuorum: 2,
    now: 1_700_000_000_000,
  })
  const second = store.record({
    fingerprint: 'iran-israel-attack',
    tweetId: 'tweet_2',
    sourceHandle: '@sourceb',
    requiredQuorum: 2,
    now: 1_700_000_000_500,
  })

  assert.equal(second.met, true)
  assert.equal(second.uniqueSources, 2)
})

test('fast verifier passes a clear trusted-source confirmation', () => {
  const rule = compileEventAutomation({
    automationId: 'auto_1',
    topic: 'iran_israel_conflict',
    triggerText: 'buy YES if Iran attacks Israel',
    sourceHandles: ['@sentdefender'],
    sourceTiers: { '@sentdefender': 0.95 },
    verificationMode: 'speed',
    actionReady: true,
    createdAt: 1_700_000_000_000,
  })
  const verifier = new FastEventVerifier()

  const result = verifier.verify({
    post: {
      id: 'tweet_1',
      sourceHandle: '@sentdefender',
      text: 'Breaking: Iran launched missiles toward Israel tonight.',
      createdAt: 1_700_000_000_000,
      receivedAt: 1_700_000_000_500,
    },
    rules: [rule],
    now: 1_700_000_000_500,
  })

  assert.equal(result.decision, 'pass')
  assert.equal(result.matchedRuleIds[0], 'auto_1')
  assert.equal(result.evidence[0]?.actor, 'iran')
  assert.equal(result.evidence[0]?.target, 'israel')
})

test('fast verifier rejects prediction language even from a trusted source', () => {
  const rule = compileEventAutomation({
    automationId: 'auto_1',
    topic: 'iran_israel_conflict',
    triggerText: 'buy YES if Iran attacks Israel',
    sourceHandles: ['@sentdefender'],
    sourceTiers: { '@sentdefender': 0.95 },
    verificationMode: 'speed',
    actionReady: true,
    createdAt: 1_700_000_000_000,
  })
  const verifier = new FastEventVerifier()

  const result = verifier.verify({
    post: {
      id: 'tweet_2',
      sourceHandle: '@sentdefender',
      text: 'Iran may attack Israel if talks fail.',
      createdAt: 1_700_000_000_000,
      receivedAt: 1_700_000_000_100,
    },
    rules: [rule],
    now: 1_700_000_000_100,
  })

  assert.equal(result.decision, 'reject')
  assert.match(result.reason, /reject phrase/i)
})

test('fast verifier escalates when action readiness was not completed', () => {
  const rule = compileEventAutomation({
    automationId: 'auto_1',
    topic: 'iran_israel_conflict',
    triggerText: 'buy YES if Iran attacks Israel',
    sourceHandles: ['@sentdefender'],
    sourceTiers: { '@sentdefender': 0.95 },
    verificationMode: 'speed',
    actionReady: false,
    createdAt: 1_700_000_000_000,
  })
  const verifier = new FastEventVerifier()

  const result = verifier.verify({
    post: {
      id: 'tweet_3',
      sourceHandle: '@sentdefender',
      text: 'Iran attacked Israel.',
      createdAt: 1_700_000_000_000,
      receivedAt: 1_700_000_000_010,
    },
    rules: [rule],
    now: 1_700_000_000_010,
  })

  assert.equal(result.decision, 'escalate')
  assert.match(result.reason, /readiness/i)
})

test('event hot cache returns only rules for the incoming source', () => {
  const first = compileEventAutomation({
    automationId: 'auto_1',
    topic: 'iran_israel_conflict',
    triggerText: 'buy YES if Iran attacks Israel',
    sourceHandles: ['@sentdefender'],
    sourceTiers: { '@sentdefender': 0.95 },
    verificationMode: 'speed',
    actionReady: true,
    createdAt: 1_700_000_000_000,
  })
  const second = compileEventAutomation({
    automationId: 'auto_2',
    topic: 'trump_greenland',
    triggerText: 'sell NO if Trump attacks Greenland',
    sourceHandles: ['@politics'],
    sourceTiers: { '@politics': 0.92 },
    verificationMode: 'balanced',
    actionReady: true,
    createdAt: 1_700_000_000_000,
  })
  const cache = new EventHotCache()
  cache.rebuild([first, second])

  assert.deepEqual(cache.rulesForSource('@sentdefender').map((rule) => rule.automationId), ['auto_1'])
  assert.deepEqual(cache.rulesForSource('politics').map((rule) => rule.automationId), ['auto_2'])
  assert.deepEqual(cache.rulesForSource('@unknown'), [])
})

test('event audit worker queues fast-path decisions without blocking', async () => {
  const audited: string[] = []
  const worker = new EventAuditWorker({
    enabled: true,
    audit: async (item) => {
      audited.push(item.automationIds[0] ?? 'missing')
    },
  })

  worker.enqueue({
    automationIds: ['auto_1'],
    tweetId: 'tweet_1',
    sourceHandle: '@sentdefender',
    text: 'Iran attacked Israel.',
    reason: 'fast verified',
    createdAt: 1_700_000_000_000,
  })

  await worker.drainForTests()
  assert.deepEqual(audited, ['auto_1'])
})
