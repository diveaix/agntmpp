import { performance } from 'node:perf_hooks'
import {
  normalizeFastSourceHandle,
  type CompiledEventRule,
  type FastVerificationEvidence,
  type FastVerificationResult,
  type IncomingEventPost,
} from './fast-event-types.js'
import { EventQuorumStore } from './event-quorum-store.js'

export interface FastEventVerifierInput {
  post: IncomingEventPost
  rules: CompiledEventRule[]
  now: number
}

function lower(value: string): string {
  return value.toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsPhrase(text: string, phrases: string[]): string | undefined {
  return phrases.find((phrase) => text.includes(lower(phrase)))
}

function findTerm(text: string, terms: string[]): string | undefined {
  return terms.find((term) => new RegExp(`\\b${escapeRegExp(lower(term))}\\b`, 'i').test(text))
}

function eventFingerprint(rule: CompiledEventRule, evidence: FastVerificationEvidence): string {
  return `${rule.topic}:${evidence.actor}:${evidence.target}:${rule.eventType}`
}

export class FastEventVerifier {
  private readonly quorumStore: EventQuorumStore

  constructor(options: { quorumStore?: EventQuorumStore } = {}) {
    this.quorumStore = options.quorumStore ?? new EventQuorumStore({ ttlMs: 120_000 })
  }

  verify(input: FastEventVerifierInput): FastVerificationResult {
    const start = performance.now()
    const text = lower(input.post.text)
    const sourceHandle = normalizeFastSourceHandle(input.post.sourceHandle)

    for (const rule of input.rules) {
      if (!rule.sourceHandles.includes(sourceHandle)) continue

      const sourceTrust = rule.sourceTiers[sourceHandle] ?? 0
      if (sourceTrust < rule.minSourceTrust) {
        return this.result('escalate', sourceTrust, 'source trust below fast verifier threshold', [], [], start)
      }

      if (!rule.actionReady) {
        return this.result('escalate', 0.5, 'automation readiness check was not completed', [], [], start)
      }

      if (input.now - input.post.createdAt > rule.freshnessMs) {
        return this.result('reject', 0, 'post is outside allowed freshness window', [], [], start)
      }

      const rejectPhrase = containsPhrase(text, rule.rejectPhrases)
      if (rejectPhrase) {
        return this.result('reject', 0, `reject phrase matched: ${rejectPhrase}`, [], [], start)
      }

      const actor = rule.actorAliases.length ? findTerm(text, rule.actorAliases) : ''
      const target = rule.targetAliases.length ? findTerm(text, rule.targetAliases) : ''
      const verb = findTerm(text, rule.confirmedVerbs)
      if ((rule.actorAliases.length && !actor) || (rule.targetAliases.length && !target) || !verb) continue

      const evidence: FastVerificationEvidence = {
        ruleId: rule.automationId,
        sourceHandle,
        tweetId: input.post.id,
        actor: actor || '',
        target: target || '',
        verb,
        eventType: rule.eventType,
        matchedText: input.post.text,
      }
      const quorum = this.quorumStore.record({
        fingerprint: eventFingerprint(rule, evidence),
        tweetId: input.post.id,
        sourceHandle,
        requiredQuorum: rule.quorum,
        now: input.now,
      })

      if (!quorum.met) {
        return this.result(
          'escalate',
          Math.min(0.75, sourceTrust),
          `waiting for quorum: ${quorum.uniqueSources}/${rule.quorum} sources confirmed`,
          [rule.automationId],
          [evidence],
          start,
        )
      }

      return this.result(
        'pass',
        Math.min(0.99, sourceTrust),
        `fast verified ${rule.topic} from ${quorum.uniqueSources} source(s)`,
        [rule.automationId],
        [evidence],
        start,
      )
    }

    return this.result('escalate', 0.25, 'no deterministic rule matched', [], [], start)
  }

  private result(
    decision: FastVerificationResult['decision'],
    score: number,
    reason: string,
    matchedRuleIds: string[],
    evidence: FastVerificationEvidence[],
    start: number,
  ): FastVerificationResult {
    return {
      decision,
      score,
      reason,
      matchedRuleIds,
      evidence,
      latencyMs: Math.max(0, performance.now() - start),
    }
  }
}
