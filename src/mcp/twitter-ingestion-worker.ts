import type { AutomationEntry } from './scheduler.js'
import type { GrokVerifier } from './automation-verifier.js'
import type { IncomingTweet } from './automation-types.js'
import { deriveSourceState } from './automation-source-manager.js'
import { prefilterTweet } from './automation-tags.js'
import { buildUniversalEventFromVerification, matchEventAutomations } from './automation-matcher.js'

export interface ProcessIncomingTweetInput {
  tweet: IncomingTweet
  automations: AutomationEntry[]
  verifier: GrokVerifier
}

export interface ProcessIncomingTweetResult {
  prefiltered: boolean
  verified: boolean
  matchedAutomationIds: string[]
  reason: string
}

export async function processIncomingTweet(input: ProcessIncomingTweetInput): Promise<ProcessIncomingTweetResult> {
  const sourceState = deriveSourceState(input.automations)
  const prefilter = prefilterTweet(input.tweet, sourceState.sources, sourceState.topicRules)
  if (!prefilter.shouldVerify) return { prefiltered: false, verified: false, matchedAutomationIds: [], reason: 'Tweet did not pass prefilter.' }

  const candidateTopic = prefilter.candidateTopics[0]
  const candidateAutomation = input.automations.find((auto) => {
    if (auto.type !== 'event_trigger' || auto.status !== 'active') return false
    const trigger = (auto.params as { trigger?: { topic?: string } }).trigger
    return trigger?.topic === candidateTopic
  })
  if (!candidateAutomation) return { prefiltered: true, verified: false, matchedAutomationIds: [], reason: 'No candidate automation found.' }

  const trigger = (candidateAutomation.params as { trigger: { topic: string } }).trigger
  const verification = await input.verifier.verify({ tweet: input.tweet, prefilter, trigger })
  if (!verification.event_happened || !verification.matches_trigger || verification.is_rumor || verification.is_old_news || verification.is_opinion_or_prediction) {
    return { prefiltered: true, verified: false, matchedAutomationIds: [], reason: verification.reason }
  }

  const event = buildUniversalEventFromVerification(`evt_${input.tweet.id}`, [input.tweet.id], input.tweet.text, verification, candidateTopic)
  const matches = matchEventAutomations(event, input.automations)

  return {
    prefiltered: true,
    verified: true,
    matchedAutomationIds: matches.map((m) => m.id),
    reason: verification.reason,
  }
}
