import type { AutomationEntry } from './scheduler.js'
import { isAutomationStillValid, type EventTriggerAutomationParams, type GrokVerificationResult, type UniversalEvent } from './automation-types.js'

function lower(value: string | undefined): string {
  return (value || '').toLowerCase()
}

export function buildUniversalEventFromVerification(
  id: string,
  sourceTweetIds: string[],
  summary: string,
  verification: GrokVerificationResult,
  topic: string,
): UniversalEvent {
  return {
    id,
    topic,
    eventType: verification.event_type,
    actor: verification.actor,
    target: verification.target,
    entities: [verification.actor, verification.target].filter(Boolean) as string[],
    assetImpact: [],
    confidence: verification.confidence,
    sourceTweetIds,
    createdAt: new Date().toISOString(),
    summary,
  }
}

export function matchEventAutomations(event: UniversalEvent, automations: AutomationEntry[]): AutomationEntry[] {
  return automations.filter((auto) => {
    if (auto.status !== 'active' || auto.type !== 'event_trigger') return false
    const params = auto.params as unknown as EventTriggerAutomationParams
    if (!isAutomationStillValid(params.validUntil)) return false
    const trigger = params.trigger
    if (trigger.topic !== event.topic) return false
    if (trigger.eventType && lower(trigger.eventType) !== lower(event.eventType)) return false
    if (trigger.actor && lower(trigger.actor) !== lower(event.actor)) return false
    if (trigger.target && lower(trigger.target) !== lower(event.target)) return false
    if (trigger.assetImpact && !event.assetImpact.map((impact) => lower(impact)).includes(lower(trigger.assetImpact))) return false
    if (event.confidence < (trigger.minConfidence ?? 0.8)) return false
    return true
  })
}
