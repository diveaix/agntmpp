import type { AutomationMode, AutomationPolicy, PolicyDecision, SimulationResult } from './automation-types.js'

export function evaluateAutomationPolicy(policy: AutomationPolicy, mode: AutomationMode, simulation: SimulationResult): PolicyDecision {
  if (mode === 'emergency_paused') return { allowed: false, mode, reason: 'Automation execution is emergency paused.' }
  if (simulation.blocks.length || !simulation.ok) return { allowed: false, mode, reason: simulation.blocks[0] || 'Simulation failed.' }
  if (policy.maxTradeSizeUsd !== undefined && (simulation.estimatedCostUsd || 0) > policy.maxTradeSizeUsd) {
    return {
      allowed: false,
      mode,
      reason: `Estimated cost $${simulation.estimatedCostUsd?.toFixed(2)} exceeds max trade size $${policy.maxTradeSizeUsd.toFixed(2)}.`,
    }
  }
  if (policy.maxSlippagePercent !== undefined && (simulation.estimatedSlippagePercent || 0) > policy.maxSlippagePercent) {
    return {
      allowed: false,
      mode,
      reason: `Estimated slippage ${simulation.estimatedSlippagePercent?.toFixed(2)}% exceeds limit ${policy.maxSlippagePercent.toFixed(2)}%.`,
    }
  }
  return { allowed: true, mode, reason: mode === 'auto_execute' ? 'Policy allows auto execution.' : 'Policy allows preview/notification.' }
}
