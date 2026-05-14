import type { GrokVerificationResult, IncomingTweet, PrefilterMatch, UniversalEventTrigger } from './automation-types.js'

export interface VerifyEventInput {
  tweet: IncomingTweet
  prefilter: PrefilterMatch
  trigger: UniversalEventTrigger
}

export interface GrokVerifier {
  verify(input: VerifyEventInput): Promise<GrokVerificationResult>
}

function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const raw = fenced || text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Grok verifier did not return JSON.')
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
}

function bool(value: unknown): boolean {
  return value === true || value === 'true'
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

export function normalizeGrokVerificationJson(json: Record<string, unknown>, trigger: UniversalEventTrigger): GrokVerificationResult {
  const confidence = num(json.confidence)
  if (confidence === undefined) throw new Error('Grok verifier JSON is missing numeric confidence.')
  return {
    event_happened: bool(json.event_happened),
    matches_trigger: bool(json.matches_trigger),
    matches_automation: bool(json.matches_automation ?? json.matches_trigger),
    needs_external_search: bool(json.needs_external_search),
    is_rumor: bool(json.is_rumor),
    is_old_news: bool(json.is_old_news),
    is_opinion_or_prediction: bool(json.is_opinion_or_prediction),
    actor: str(json.actor) || trigger.actor,
    target: str(json.target) || trigger.target,
    event_type: str(json.event_type) || trigger.eventType || 'unknown',
    confidence,
    reason: str(json.reason) || 'No reason returned.',
  }
}

export interface XaiGrokVerifierConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class XaiGrokVerifier implements GrokVerifier {
  constructor(private readonly config: XaiGrokVerifierConfig = {}) {}

  isEnabled(): boolean {
    return Boolean(this.config.apiKey || process.env.XAI_API_KEY)
  }

  async verify(input: VerifyEventInput): Promise<GrokVerificationResult> {
    const apiKey = this.config.apiKey || process.env.XAI_API_KEY
    if (!apiKey) throw new Error('XAI_API_KEY is required for live Grok verification.')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || Number(process.env.GROK_VERIFY_TIMEOUT_MS || 8000))
    timeout.unref()

    try {
      const baseUrl = (this.config.baseUrl || process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, '')
      const model = this.config.model || process.env.GROK_VERIFY_MODEL || 'grok-4.20-reasoning'
      const body = {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You verify whether one trusted tweet confirms one automation rule. Do not search X or the web. Return strict JSON only.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: 'Does this tweet confirm the automation trigger?',
              tweet: input.tweet,
              prefilter: input.prefilter,
              trigger: input.trigger,
              output_schema: {
                event_happened: 'boolean',
                matches_trigger: 'boolean',
                matches_automation: 'boolean',
                needs_external_search: 'boolean, must be false on this fast path',
                is_rumor: 'boolean',
                is_old_news: 'boolean',
                is_opinion_or_prediction: 'boolean',
                actor: 'string or null',
                target: 'string or null',
                event_type: 'string',
                confidence: 'number 0..1',
                reason: 'short plain English reason',
              },
            }),
          },
        ],
      }

      const res = await (this.config.fetchImpl || globalThis.fetch)(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Grok verifier failed ${res.status}: ${await res.text().catch(() => '')}`)
      const json = await res.json() as {
        choices?: { message?: { content?: string } }[]
      }
      const content = json.choices?.[0]?.message?.content
      if (!content) throw new Error('Grok verifier returned no content.')
      return normalizeGrokVerificationJson(extractJsonObject(content), input.trigger)
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function createDefaultGrokVerifier(): GrokVerifier {
  const live = new XaiGrokVerifier()
  return live.isEnabled() ? live : new MockGrokVerifier()
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
