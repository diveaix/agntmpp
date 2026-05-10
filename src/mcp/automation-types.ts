export type AutomationMode = 'notify_only' | 'ask_first' | 'auto_execute' | 'emergency_paused'

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

export interface AutomationPolicy {
  maxTradeSizeUsd?: number
  maxDailySpend?: number
  maxDailyLoss?: number
  maxLeverage?: number
  maxSlippagePercent?: number
  maxPolymarketPrice?: number
  requireStopLoss?: boolean
  cooldownSeconds?: number
}

export interface PolymarketEventAction {
  protocol: 'polymarket'
  marketId: string
  side: 'YES' | 'NO'
  maxSpend: number
  maxPrice?: number
}

export interface HyperliquidTradeAction {
  protocol: 'hyperliquid'
  kind: 'trade'
  market: string
  side: 'long' | 'short'
  amountUsd: number
  leverage: number
  stopLossPercent?: number
  takeProfitPercent?: number
}

export type EventAutomationAction = PolymarketEventAction | HyperliquidTradeAction

export interface EventTriggerAutomationParams {
  trigger: UniversalEventTrigger
  action: EventAutomationAction
  policy: AutomationPolicy
  mode: AutomationMode
  validUntil: string
  validFor: string
}

export type HyperliquidInfoMetric =
  | 'funding_rate'
  | 'open_interest'
  | 'volume'
  | 'liquidation_risk'
  | 'account_margin'
  | 'position_pnl'
  | 'order_fill'
  | 'vault_performance'
  | 'staking_validator'
  | 'spot_market'

export interface HyperliquidInfoMonitorParams {
  trigger: {
    protocol: 'hyperliquid'
    metric: HyperliquidInfoMetric
    market?: string
    condition: 'above' | 'below' | 'changes'
    threshold?: number
  }
  action: {
    kind: 'notify' | 'ask' | 'defensive_action'
    message: string
  }
  policy: AutomationPolicy
  mode: AutomationMode
  validUntil: string
  validFor: string
}

export interface SimulationResult {
  ok: boolean
  protocol: 'polymarket' | 'hyperliquid'
  summary: string
  estimatedCostUsd?: number
  estimatedSlippagePercent?: number
  warnings: string[]
  blocks: string[]
}

export interface PolicyDecision {
  allowed: boolean
  mode: AutomationMode
  reason: string
}

export function normalizeAutomationMode(value: unknown): AutomationMode {
  if (value === 'ask_first' || value === 'auto_execute' || value === 'emergency_paused' || value === 'notify_only') return value
  return 'notify_only'
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
