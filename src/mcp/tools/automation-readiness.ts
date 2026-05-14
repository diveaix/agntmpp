import type { EventAutomationAction } from '../automation-types.js'
import {
  formatPolymarketSetupGuide,
  getPolymarketSetupBlocker,
  type PolymarketSetupStatus,
} from './polymarket-helpers.js'
import {
  formatHyperliquidSetupGuide,
  getHyperliquidSetupBlocker,
  type HyperliquidSetupStatus,
} from './hyperliquid-helpers.js'

export interface AutomationReadinessSnapshot {
  polymarket?: PolymarketSetupStatus
  hyperliquid?: HyperliquidSetupStatus
}

export interface AutomationReadinessResult {
  allowed: boolean
  message?: string
}

export type AutomationReadinessProbe = (action: EventAutomationAction) => Promise<AutomationReadinessResult>

export function evaluateAutomationReadiness(
  action: EventAutomationAction,
  snapshot: AutomationReadinessSnapshot,
): AutomationReadinessResult {
  if (action.protocol === 'polymarket') {
    const status: PolymarketSetupStatus = {
      ...(snapshot.polymarket || { hasWallet: false }),
      requiredPusd: action.maxSpend,
    }
    const blocker = getPolymarketSetupBlocker('buy', status)
    if (blocker) {
      return { allowed: false, message: formatPolymarketSetupGuide(status, blocker) }
    }
    return { allowed: true }
  }

  const status: HyperliquidSetupStatus = {
    ...(snapshot.hyperliquid || { hasWallet: false }),
    requiredMargin: action.amountUsd,
  }
  const blocker = getHyperliquidSetupBlocker('order', status)
  if (blocker) {
    return { allowed: false, message: formatHyperliquidSetupGuide(status, blocker) }
  }
  return { allowed: true }
}
