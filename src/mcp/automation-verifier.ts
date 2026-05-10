import type { GrokVerificationResult, IncomingTweet, PrefilterMatch, UniversalEventTrigger } from './automation-types.js'

export interface VerifyEventInput {
  tweet: IncomingTweet
  prefilter: PrefilterMatch
  trigger: UniversalEventTrigger
}

export interface GrokVerifier {
  verify(input: VerifyEventInput): Promise<GrokVerificationResult>
}

export class MockGrokVerifier implements GrokVerifier {
  async verify(input: VerifyEventInput): Promise<GrokVerificationResult> {
    const tweetText = input.tweet.text.toLowerCase()
    const isPrediction = /\b(might|may|could|expected|warning|warns|threatens|plans)\b/.test(tweetText)
    const happened = /\b(launched|launches|fires|fired|struck|hit|attack underway|officials say)\b/.test(tweetText)
    const matchesActor = input.trigger.actor ? tweetText.includes(input.trigger.actor.toLowerCase()) : true
    const matchesTarget = input.trigger.target ? tweetText.includes(input.trigger.target.toLowerCase()) : true
    const matches = happened && matchesActor && matchesTarget && !isPrediction

    return {
      event_happened: matches,
      matches_trigger: matches,
      matches_automation: matches,
      needs_external_search: false,
      is_rumor: false,
      is_old_news: false,
      is_opinion_or_prediction: isPrediction,
      actor: input.trigger.actor,
      target: input.trigger.target,
      event_type: input.trigger.eventType || 'unknown',
      confidence: matches ? Math.min(0.95, Math.max(0.8, input.prefilter.sourceTrust)) : 0.35,
      reason: matches ? 'The tweet states the event happened.' : 'The tweet does not state a confirmed happened event.',
    }
  }
}
