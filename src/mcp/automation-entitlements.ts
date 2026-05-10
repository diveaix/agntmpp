import type { AutomationPlan } from './automation-types.js'

export interface AutomationEntitlement {
  plan: AutomationPlan
  dataAutomationSlots: number
  customSourceSlots: number
  autoExecuteAllowed: boolean
  priorityQueue: boolean
}

const ENTITLEMENTS: Record<AutomationPlan, AutomationEntitlement> = {
  free: { plan: 'free', dataAutomationSlots: 1, customSourceSlots: 0, autoExecuteAllowed: false, priorityQueue: false },
  pro: { plan: 'pro', dataAutomationSlots: 5, customSourceSlots: 25, autoExecuteAllowed: true, priorityQueue: false },
  max: { plan: 'max', dataAutomationSlots: 30, customSourceSlots: 100, autoExecuteAllowed: true, priorityQueue: true },
}

export function getPlanEntitlement(plan: AutomationPlan | string | undefined): AutomationEntitlement {
  if (plan === 'pro' || plan === 'max' || plan === 'free') return ENTITLEMENTS[plan]
  return ENTITLEMENTS.free
}

export function canCreateDataAutomation(plan: AutomationPlan | string | undefined, activeDataAutomationCount: number): { allowed: boolean; reason: string } {
  const entitlement = getPlanEntitlement(plan)
  if (activeDataAutomationCount >= entitlement.dataAutomationSlots) {
    return { allowed: false, reason: `${entitlement.plan} plan allows ${entitlement.dataAutomationSlots} data automation(s).` }
  }
  return { allowed: true, reason: 'Plan allows another data automation.' }
}
