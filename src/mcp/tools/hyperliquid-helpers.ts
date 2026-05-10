export type HyperliquidSetupBlocker = 'wallet' | 'funding'
export type HyperliquidOrderKind =
  | 'market'
  | 'limit'
  | 'scale'
  | 'stop_market'
  | 'stop_limit'
  | 'take_market'
  | 'take_limit'
  | 'twap'

export interface HyperliquidSetupStatus {
  hasWallet: boolean
  walletName?: string
  address?: string
  accountValue?: number
  availableMargin?: number
  openPositions?: number
}

export interface HyperliquidSimulationParams {
  kind: HyperliquidOrderKind
  market: string
  side: 'buy' | 'sell'
  markPrice: number
  amountUsd?: number
  size?: number
  price?: number
  leverage?: number
  stopPrice?: number
  takeProfit?: number
  stopLoss?: number
  startPrice?: number
  endPrice?: number
  totalOrders?: number
  durationMinutes?: number
  reduceOnly?: boolean
}

export interface HyperliquidChildOrder {
  index: number
  price: number
  size: number
  notional: number
}

export interface HyperliquidSimulationResult {
  kind: HyperliquidOrderKind
  market: string
  side: 'buy' | 'sell'
  size: number
  notional: number
  margin: number
  fee: number
  liquidationPrice: number
  childOrders: HyperliquidChildOrder[]
  summary: string
}

const READ_ONLY_ACTIONS = new Set([
  'setup',
  'guide',
  'help',
  'markets',
  'account',
  'positions',
  'orderbook',
  'funding',
  'pnl',
  'risk',
  'scanner',
  'fund',
  'simulate',
])

export function isHyperliquidSetupGuideQuery(query: unknown): boolean {
  if (typeof query !== 'string') return false
  const q = query.toLowerCase()
  if (!q.includes('hyperliquid') && !q.includes('hl') && !q.includes('setup') && !q.includes('guide') && !q.includes('help')) return false

  return (
    q.includes('setup') ||
    q.includes('guide') ||
    q.includes('help') ||
    q.includes('how do i use') ||
    q.includes('how to use') ||
    q.includes('getting started')
  )
}

export function getHyperliquidSetupBlocker(action: string, status: HyperliquidSetupStatus): HyperliquidSetupBlocker | null {
  if (READ_ONLY_ACTIONS.has(action)) return null
  if (!status.hasWallet) return 'wallet'
  if ((status.availableMargin ?? 0) <= 0) return 'funding'
  return null
}

export function formatHyperliquidSetupGuide(status: HyperliquidSetupStatus = { hasWallet: false }, blocker?: HyperliquidSetupBlocker | null): string {
  const lines = ['Hyperliquid First-Time Setup', '']

  if (blocker) {
    lines.push(blocker === 'wallet' ? 'Blocked: no active wallet is selected.' : 'Blocked: your Hyperliquid account has no available USDC margin.', '')
  }

  lines.push('Current status:')
  if (status.hasWallet) {
    lines.push(`  Wallet: ${status.walletName || 'Active'} (${status.address || 'address unavailable'})`)
    lines.push(`  Account value: $${(status.accountValue ?? 0).toFixed(2)}`)
    lines.push(`  Available to trade: $${(status.availableMargin ?? 0).toFixed(2)}`)
    lines.push(`  Open positions: ${status.openPositions ?? 0}`)
  } else {
    lines.push('  Wallet: not selected')
  }

  lines.push(
    '',
    'What to do first:',
    '  1. Make sure you have a wallet selected.',
    '  2. Fund your Hyperliquid account with USDC. Deposits for trading land in USDC (Perps).',
    '  3. Check your account before trading.',
    '  4. Simulate the trade first, including leverage, stop loss, and take profit.',
    '  5. Place the live order only after the preview looks right.',
    '',
    'Funding and withdrawals:',
    '  Funding: prefer Relay when it gives the best safe quote into Hyperliquid USDC (Perps).',
    '  Use Jumper or LI.FI only when Relay is unavailable or worse.',
    '  I block routes with high value loss before approval or transaction.',
    '  Fallback funding: send USDC from Arbitrum through Hyperliquid deposit.',
    '  Withdrawal: USDC leaves Hyperliquid USDC (Perps) and arrives as USDC on Arbitrum.',
    '  Gas: funding uses source-chain gas. Trading on Hyperliquid itself does not use wallet gas.',
    '',
    'Simple things you can ask me:',
    '  Ask me: "Check my Hyperliquid account"',
    '  Ask me: "Fund my Hyperliquid account"',
    '  Ask me: "Withdraw $25 from Hyperliquid to my wallet"',
    '  Ask me: "Show all Hyperliquid markets"',
    '  Ask me: "Show BTC orderbook"',
    '  Ask me: "Simulate longing BTC with $20 at 2x"',
    '  Ask me: "Simulate a BTC limit long at 2x with stop loss and take profit"',
    '  Ask me: "Simulate scaling into ETH over 5 orders"',
    '  Ask me: "Show my Hyperliquid positions"',
    '',
    'Trading note: I will show a preview first. Nothing live is placed unless you clearly choose live execution.',
  )

  return lines.join('\n')
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function assertPositive(value: number | undefined, label: string): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) throw new Error(`${label} must be greater than 0.`)
  return value as number
}

function orderVerb(side: 'buy' | 'sell') {
  return side === 'buy' ? 'LONG' : 'SHORT'
}

export function simulateHyperliquidOrder(params: HyperliquidSimulationParams): HyperliquidSimulationResult {
  const leverage = params.leverage ?? 1
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 50) throw new Error('leverage must be between 1 and 50.')
  const markPrice = assertPositive(params.markPrice, 'markPrice')
  const referencePrice = params.price ?? params.startPrice ?? markPrice
  const amountUsd = params.amountUsd ?? (params.size !== undefined ? params.size * referencePrice / leverage : undefined)
  const margin = assertPositive(amountUsd, 'amountUsd')
  const notional = margin * leverage
  const size = round(params.size ?? notional / referencePrice)
  const fee = round(notional * 0.00035, 4)
  const liquidationPrice = params.side === 'buy'
    ? round(referencePrice * (1 - 1 / leverage * 0.9), 2)
    : round(referencePrice * (1 + 1 / leverage * 0.9), 2)

  const childOrders: HyperliquidChildOrder[] = []
  if (params.kind === 'scale') {
    const totalOrders = Math.max(2, Math.floor(params.totalOrders ?? 3))
    const start = assertPositive(params.startPrice, 'startPrice')
    const end = assertPositive(params.endPrice, 'endPrice')
    const sizePerOrder = round(size / totalOrders)
    for (let i = 0; i < totalOrders; i++) {
      const price = round(start + ((end - start) * i) / (totalOrders - 1), 2)
      childOrders.push({ index: i + 1, price, size: sizePerOrder, notional: round(sizePerOrder * price, 2) })
    }
  }

  const triggerParts: string[] = []
  if (params.stopLoss) triggerParts.push(`stop loss $${params.stopLoss.toLocaleString()}`)
  if (params.takeProfit) triggerParts.push(`take profit $${params.takeProfit.toLocaleString()}`)
  if (params.stopPrice) triggerParts.push(`trigger $${params.stopPrice.toLocaleString()}`)
  if (params.durationMinutes) triggerParts.push(`over ${params.durationMinutes} minutes`)

  const summaryLines = [
    `${params.kind.toUpperCase()} ${orderVerb(params.side)} ${params.market.toUpperCase()}-PERP`,
    `Size: ${size} ${params.market.toUpperCase()} | Notional: $${notional.toFixed(2)} | Margin: $${margin.toFixed(2)} | Leverage: ${leverage}x`,
    `Reference price: $${referencePrice.toLocaleString()} | Est. liquidation: $${liquidationPrice.toLocaleString()} | Est. fee: $${fee.toFixed(4)}`,
  ]
  if (childOrders.length) summaryLines.push(`Scale: ${childOrders.length} child orders from $${childOrders[0].price} to $${childOrders[childOrders.length - 1].price}`)
  if (childOrders.length) summaryLines.push(`${childOrders.length} child orders`)
  if (triggerParts.length) summaryLines.push(`Protection: ${triggerParts.join(', ')}`)
  if (params.reduceOnly) summaryLines.push('Reduce only: yes')

  return {
    kind: params.kind,
    market: params.market.toUpperCase(),
    side: params.side,
    size,
    notional: round(notional, 2),
    margin: round(margin, 2),
    fee,
    liquidationPrice,
    childOrders,
    summary: summaryLines.join('\n'),
  }
}
