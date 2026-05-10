import type { EventAutomationAction, HyperliquidInfoMonitorParams, SimulationResult } from './automation-types.js'

export interface SimulationContext {
  polymarketPrice?: number
  estimatedSlippagePercent?: number
  requireStopLoss?: boolean
  currentValue?: number
}

export async function simulateAutomationAction(action: EventAutomationAction, context: SimulationContext = {}): Promise<SimulationResult> {
  if (action.protocol === 'polymarket') {
    const price = context.polymarketPrice ?? action.maxPrice ?? 0.5
    const blocks: string[] = []
    if (action.maxPrice !== undefined && price > action.maxPrice) {
      blocks.push(`Current ${action.side} price ${price.toFixed(2)} is above max price ${action.maxPrice.toFixed(2)}.`)
    }
    return {
      ok: blocks.length === 0,
      protocol: 'polymarket',
      summary: `Polymarket ${action.side} preview for ${action.marketId}: spend up to $${action.maxSpend.toFixed(2)} at price ${price.toFixed(2)}.`,
      estimatedCostUsd: action.maxSpend,
      estimatedSlippagePercent: context.estimatedSlippagePercent ?? 0,
      warnings: [],
      blocks,
    }
  }

  const blocks: string[] = []
  if (context.requireStopLoss && action.stopLossPercent === undefined) blocks.push('Hyperliquid auto trades require a stop loss.')
  if (action.leverage <= 0) blocks.push('Leverage must be greater than 0.')
  return {
    ok: blocks.length === 0,
    protocol: 'hyperliquid',
    summary: `Hyperliquid ${action.side.toUpperCase()} ${action.market}-PERP preview: $${action.amountUsd.toFixed(2)} at ${action.leverage}x.`,
    estimatedCostUsd: action.amountUsd,
    estimatedSlippagePercent: context.estimatedSlippagePercent ?? 0,
    warnings: action.takeProfitPercent === undefined ? ['No take profit configured.'] : [],
    blocks,
  }
}

export async function simulateHyperliquidInfoMonitor(params: HyperliquidInfoMonitorParams, context: SimulationContext = {}): Promise<SimulationResult> {
  const current = context.currentValue
  const threshold = params.trigger.threshold
  const conditionMet =
    params.trigger.condition === 'changes' ||
    (params.trigger.condition === 'above' && current !== undefined && threshold !== undefined && current > threshold) ||
    (params.trigger.condition === 'below' && current !== undefined && threshold !== undefined && current < threshold)

  return {
    ok: conditionMet,
    protocol: 'hyperliquid',
    summary: `Hyperliquid ${params.trigger.metric} monitor${params.trigger.market ? ` for ${params.trigger.market}` : ''}: current=${current ?? 'unknown'} threshold=${threshold ?? 'n/a'} condition=${params.trigger.condition}.`,
    warnings: conditionMet ? [] : ['Monitor condition is not met.'],
    blocks: [],
  }
}
