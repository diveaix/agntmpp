import type { AutomationEntry } from './scheduler.js'
import { addAutomationHistory } from './scheduler.js'
import { isNotificationEvent, type EventTriggerAutomationParams, type UniversalEvent } from './automation-types.js'
import { canRunOwnedAutomation } from './access-control.js'
import { enforcePassAccess } from './sale/runtime.js'

export interface EventDispatchResult {
  automationId: string
  mode: string
  submitted: boolean
  reason: string
  latencyMs: number
}

export async function dispatchMatchedEventAutomation(auto: AutomationEntry, event: UniversalEvent): Promise<EventDispatchResult> {
  const started = Date.now()
  const params = auto.params as unknown as EventTriggerAutomationParams
  if (!isNotificationEvent(auto.params) || params.mode !== 'notify_only') {
    const reason = 'Event action is unavailable or paused. Only event notifications are supported.'
    addAutomationHistory(auto.id, reason, false, { countRun: false, status: 'paused', nextRun: null })
    return { automationId: auto.id, mode: params.mode, submitted: false, reason, latencyMs: Date.now() - started }
  }

  if (process.env.AGNT_PASS_ACCESS_REQUIRED === 'true') {
    try {
      const owner = canRunOwnedAutomation(auto)
      if (!owner.allowed) throw new Error(owner.reason)
      await enforcePassAccess(owner.auth?.userId, 'automation_notification')
    } catch {
      const reason = 'Notification paused: current owner pass entitlement could not be verified.'
      addAutomationHistory(auto.id, reason, false, { countRun: false, status: 'paused', nextRun: null })
      return { automationId: auto.id, mode: params.mode, submitted: false, reason, latencyMs: Date.now() - started }
    }
  }

  const reason = `Verified event matched. Notify only: ${params.action.message || event.summary}`
  addAutomationHistory(auto.id, reason, true, { status: 'completed', nextRun: null })
  return { automationId: auto.id, mode: params.mode, submitted: false, reason, latencyMs: Date.now() - started }
}
