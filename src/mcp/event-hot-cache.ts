import { normalizeFastSourceHandle, type CompiledEventRule } from './fast-event-types.js'

export class EventHotCache {
  private rulesBySource = new Map<string, CompiledEventRule[]>()
  private rulesByAutomationId = new Map<string, CompiledEventRule>()

  rebuild(rules: CompiledEventRule[]): void {
    const nextRulesBySource = new Map<string, CompiledEventRule[]>()
    const nextRulesByAutomationId = new Map<string, CompiledEventRule>()

    for (const rule of rules) {
      nextRulesByAutomationId.set(rule.automationId, rule)
      for (const source of rule.sourceHandles) {
        const handle = normalizeFastSourceHandle(source)
        const existing = nextRulesBySource.get(handle) ?? []
        existing.push(rule)
        nextRulesBySource.set(handle, existing)
      }
    }

    this.rulesBySource = nextRulesBySource
    this.rulesByAutomationId = nextRulesByAutomationId
  }

  rulesForSource(handle: string): CompiledEventRule[] {
    return this.rulesBySource.get(normalizeFastSourceHandle(handle)) ?? []
  }

  ruleByAutomationId(id: string): CompiledEventRule | undefined {
    return this.rulesByAutomationId.get(id)
  }
}
