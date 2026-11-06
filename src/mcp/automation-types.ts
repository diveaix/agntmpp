export type AutomationMode = 'notify_only' | 'emergency_paused'

export type AutomationPlan = 'free' | 'pro' | 'max'

export type UniversalEventType =
  | 'military_attack'
  | 'military_threat'
  | 'ceasefire'
  | 'election_result'
  | 'regulatory_action'
  | 'protocol_exploit'
  | 'market_shock'
  | 'funding_spike'
  | 'open_interest_spike'
  | 'liquidation_risk'
  | 'account_margin_change'

export type AssetImpact =
  | 'crypto_risk_off'
  | 'crypto_risk_on'
  | 'oil_up'
  | 'oil_down'
  | 'volatility_up'
  | 'stablecoin_risk'

export interface UniversalEventTrigger {
  topic: string
  eventType?: UniversalEventType | string
  actor?: string
  target?: string
  assetImpact?: AssetImpact | string
  entities?: string[]
  minConfidence?: number
}

export interface UniversalEvent {
  id: string
  topic: string
  eventType: UniversalEventType | string
  actor?: string
  target?: string
  entities: string[]
  assetImpact: string[]
  confidence: number
  sourceTweetIds: string[]
  createdAt: string
  summary: string
}

export interface TweetSourceMeta {
  handle: string
  enabled: boolean
  topics: string[]
  trustScore: number
}

export interface IncomingTweet {
  id: string
  text: string
  authorHandle: string
  createdAt: string
  url?: string
}

export interface TopicRule {
  topic: string
  activeAutomationCount: number
  keywords: string[]
  entities: string[]
  sourceHandles: string[]
}

export interface PrefilterMatch {
  shouldVerify: boolean
  candidateTopics: string[]
  matchedKeywords: string[]
  matchedEntities: string[]
  sourceTrust: number
}

export interface GrokVerificationResult {
  event_happened: boolean
  matches_trigger: boolean
  matches_automation: boolean
  needs_external_search: boolean
  is_rumor: boolean
  is_old_news: boolean
  is_opinion_or_prediction: boolean
  actor?: string
  target?: string
  event_type: string
  confidence: number
  reason: string
}

export interface EventAutomationAction {
  kind: 'notify'
  message?: string
}

export interface EventTriggerAutomationParams {
  trigger: UniversalEventTrigger
  action: EventAutomationAction
  mode: AutomationMode
  verificationMode?: 'speed' | 'balanced' | 'fortress'
  actionReady?: boolean
  readinessReason?: string
  validUntil: string
  validFor: string
}

export function isNotificationEvent(params: Record<string, unknown>): boolean {
  const action = params.action as Record<string, unknown> | undefined
  return action?.kind === 'notify' && action.protocol === undefined &&
    (params.mode === 'notify_only' || params.mode === 'emergency_paused')
}

export function normalizeAutomationMode(value: unknown): AutomationMode {
  if (value === undefined || value === 'notify_only') return 'notify_only'
  if (value === 'emergency_paused') return value
  throw new Error('Only notification automation modes are supported.')
}

export function parseAutomationValidity(value: unknown, now = Date.now()): { validFor: string; validUntil: string; durationMs: number } {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('validFor is required. Ask the user how long this automation should run, like "10m", "6h", "7d", or "1mo".')
  }
  const match = value.trim().match(/^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days|mo|mon|month|months)$/i)
  if (!match) throw new Error(`Invalid validFor "${value}". Use "10m", "6h", "7d", or "1mo".`)
  const amount = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const durationMs =
    unit.startsWith('m') && !unit.startsWith('mo') && !unit.startsWith('mon') ? amount * 60_000 :
      unit.startsWith('h') ? amount * 3_600_000 :
        unit.startsWith('d') ? amount * 86_400_000 :
          amount * 30 * 86_400_000
  return { validFor: value.trim(), validUntil: new Date(now + durationMs).toISOString(), durationMs }
}

export function isAutomationStillValid(validUntil: unknown, now = Date.now()): boolean {
  if (typeof validUntil !== 'string' || !validUntil) return false
  const expiresAt = new Date(validUntil).getTime()
  return Number.isFinite(expiresAt) && expiresAt > now
}
