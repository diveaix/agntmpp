export interface RouteValueInput {
  fromAmount: bigint
  fromDecimals: number
  fromPriceUsd?: string | number
  toAmount?: bigint
  toDecimals: number
  toPriceUsd?: string | number
  maxLossPercent?: number
}

export interface RouteValueAssessment {
  inputUsd: number
  outputUsd: number
  lossPercent: number
  maxLossPercent: number
  blocked: boolean
  reason?: string
}

export interface RouteUsdAssessmentInput {
  inputUsd: string | number | undefined
  outputUsd: string | number | undefined
  maxLossPercent?: number
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function unitsToNumber(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals
}

export function assessRouteValue(input: RouteValueInput): RouteValueAssessment {
  const maxLossPercent = input.maxLossPercent ?? 5
  const fromPrice = toNumber(input.fromPriceUsd)
  const toPrice = toNumber(input.toPriceUsd)
  const inputUsd = unitsToNumber(input.fromAmount, input.fromDecimals) * fromPrice
  const outputUsd = input.toAmount === undefined ? 0 : unitsToNumber(input.toAmount, input.toDecimals) * toPrice
  const lossPercent = inputUsd > 0 ? ((inputUsd - outputUsd) / inputUsd) * 100 : 100
  const blocked = !Number.isFinite(lossPercent) || inputUsd <= 0 || outputUsd <= 0 || lossPercent > maxLossPercent

  return {
    inputUsd,
    outputUsd,
    lossPercent,
    maxLossPercent,
    blocked,
    reason: blocked
      ? `Route blocked: estimated value loss is ${lossPercent.toFixed(2)}%, above the ${maxLossPercent.toFixed(2)}% safety limit.`
      : undefined,
  }
}

export function assessRouteUsdValues(input: RouteUsdAssessmentInput): RouteValueAssessment {
  const maxLossPercent = input.maxLossPercent ?? 5
  const inputUsd = toNumber(input.inputUsd)
  const outputUsd = toNumber(input.outputUsd)
  const lossPercent = inputUsd > 0 ? ((inputUsd - outputUsd) / inputUsd) * 100 : 100
  const blocked = !Number.isFinite(lossPercent) || inputUsd <= 0 || outputUsd <= 0 || lossPercent > maxLossPercent

  return {
    inputUsd,
    outputUsd,
    lossPercent,
    maxLossPercent,
    blocked,
    reason: blocked
      ? `Route blocked: estimated value loss is ${lossPercent.toFixed(2)}%, above the ${maxLossPercent.toFixed(2)}% safety limit.`
      : undefined,
  }
}
