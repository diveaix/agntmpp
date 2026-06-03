export type PolymarketOrderMode = 'limit' | 'market_fok' | 'market_fak'
export type PolymarketOrderSide = 'BUY' | 'SELL'
export type PolymarketSetupBlocker = 'wallet' | 'funding' | 'gas' | 'approval'

export interface ParsedPolymarketMode {
  mode: PolymarketOrderMode
  orderType: 'GTC' | 'FOK' | 'FAK'
  isMarket: boolean
}

export interface PolymarketSetupStatus {
  hasWallet: boolean
  walletName?: string
  address?: string
  pusdBalance?: string | number
  requiredPusd?: number
  polBalance?: string | number
  collateralReady?: boolean
  outcomeTokensReady?: boolean
}

export function parsePolymarketOrderMode(value: unknown): ParsedPolymarketMode {
  const mode = ((value as string | undefined) || 'limit').toLowerCase()

  if (mode === 'limit') return { mode, orderType: 'GTC', isMarket: false }
  if (mode === 'market_fok') return { mode, orderType: 'FOK', isMarket: true }
  if (mode === 'market_fak') return { mode, orderType: 'FAK', isMarket: true }

  throw new Error('Invalid mode. Use limit, market_fok, or market_fak.')
}

export function validatePolymarketPrice(price: number, label = 'price'): number {
  if (!Number.isFinite(price) || price < 0.01 || price > 0.99) {
    throw new Error(`${label} must be between 0.01 and 0.99.`)
  }
  return Math.round(price * 10000) / 10000
}

export function resolvePolymarketExecutionPrice(params: {
  side: PolymarketOrderSide
  mode: ParsedPolymarketMode
  marketPrice: number
  price?: number
  maxPrice?: number
  minPrice?: number
}): number {
  if (!params.mode.isMarket) {
    return validatePolymarketPrice(params.price ?? params.marketPrice)
  }

  if (params.side === 'BUY') {
    const guard = params.maxPrice ?? params.price
    if (guard === undefined) throw new Error('Market buys require maxPrice (or price) as the worst acceptable fill price.')
    return validatePolymarketPrice(guard, 'maxPrice')
  }

  const guard = params.minPrice ?? params.price
  if (guard === undefined) throw new Error('Market sells require minPrice (or price) as the worst acceptable fill price.')
  return validatePolymarketPrice(guard, 'minPrice')
}

export function calculateLimitBuySize(usdcAmount: number, price: number): number {
  if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) throw new Error('amount must be greater than 0.')
  return Math.floor((usdcAmount / price) * 100) / 100
}

function numericBalance(value: string | number | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export function getPolymarketSetupBlocker(action: string, status: PolymarketSetupStatus): PolymarketSetupBlocker | null {
  if (['search', 'markets', 'market', 'orderbook'].includes(action)) return null
  if (!status.hasWallet) return 'wallet'

  const pusdBalance = numericBalance(status.pusdBalance)
  if (action === 'buy' && pusdBalance <= 0) return 'funding'
  if (action === 'buy' && status.requiredPusd !== undefined && pusdBalance < status.requiredPusd) return 'funding'

  const needsBuyApproval = action === 'buy' && !status.collateralReady
  const needsSellApproval = action === 'sell' && !status.outcomeTokensReady
  const needsAnyApproval = action === 'approve' && (!status.collateralReady || !status.outcomeTokensReady)

  if ((needsBuyApproval || needsSellApproval || needsAnyApproval) && numericBalance(status.polBalance) <= 0) {
    return 'gas'
  }
  if (needsBuyApproval || needsSellApproval) return 'approval'

  return null
}

export function isPolymarketSetupGuideQuery(query: unknown): boolean {
  if (typeof query !== 'string') return false
  const q = query.toLowerCase()
  if (!q.includes('polymarket') && !q.includes('setup') && !q.includes('guide') && !q.includes('help')) return false

  return (
    q.includes('setup') ||
    q.includes('guide') ||
    q.includes('help') ||
    q.includes('how do i use') ||
    q.includes('how to use') ||
    q.includes('getting started')
  )
}

export function formatPolymarketSetupGuide(status: PolymarketSetupStatus = { hasWallet: false }, blocker?: PolymarketSetupBlocker | null): string {
  const lines = ['Polymarket First-Time Setup', '']

  if (blocker) {
    const reasons: Record<PolymarketSetupBlocker, string> = {
      wallet: 'Blocked: no active wallet is selected.',
      funding: 'Blocked: Polygon USDC funding is missing or too low.',
      gas: 'Blocked: POL gas is needed for the approval transaction.',
      approval: 'Blocked: required Polymarket approvals are missing.',
    }
    lines.push(reasons[blocker], '')
  }

  lines.push('Current status:')
  if (status.hasWallet) {
    lines.push(`  Wallet: ${status.walletName || 'Active'} (${status.address || 'address unavailable'})`)
    lines.push(`  Polygon USDC: ${status.pusdBalance ?? 'unknown'}`)
    lines.push(`  POL for one-time setup gas: ${status.polBalance ?? 'unknown'}`)
    lines.push(`  Polygon USDC approvals: ${status.collateralReady ? 'Ready' : 'Needs approval'}`)
    lines.push(`  Outcome token approvals: ${status.outcomeTokensReady ? 'Ready' : 'Needs approval'}`)
  } else {
    lines.push('  Wallet: not selected')
  }

  lines.push(
    '',
    'What to do first:',
    '  1. Make sure you have a wallet selected.',
    '  2. Add Polygon USDC. This is the money used to buy shares.',
    '  3. Keep a little POL on Polygon. This is only for the first approval step.',
    '  4. Approve Polymarket once. After that, normal buy/sell orders are quick.',
    '',
    'Funding and withdrawals:',
    '  Funding: use the Deposit button in the Polymarket app to move Polygon USDC into your Polymarket trading balance.',
    '  This MCP tool can check your wallet setup, but it cannot create a Polymarket deposit route or deposit address yet.',
    '  If your wallet has Polygon USDC but Polymarket trading balance is 0, deposit through the Polymarket app first.',
    '  Withdrawal: withdraw USDC from Polymarket to a wallet or exchange address that supports Polygon USDC.',
    '  Polymarket does not charge its own deposit or withdrawal fee, but wallets, bridges, exchanges, or providers may charge network or route fees.',
    '  This tool can guide withdrawals, but live Polymarket withdrawal execution is not wired here yet.',
    '',
    'Simple things you can ask me:',
    '  Ask me: "Check my Polymarket balance"',
    '  Ask me: "Approve Polymarket trading"',
    '  Ask me: "How do I withdraw from Polymarket?"',
    '  Ask me: "Search Polymarket for Bitcoin"',
    '  Ask me: "Show me the most liquid Polymarket markets"',
    '  Ask me: "Buy $5 of YES"',
    '  Ask me: "Sell half of my YES shares"',
    '',
    'Trading tip:',
    '  For a first trade, use a small amount like $1 or $5 and tell me the max price you accept, for example: "Buy $5 of YES, but do not pay more than 45 cents."',
    '',
    'Gas note: approvals and other on-chain actions use wallet gas in this tool. Normal buy/sell orders do not require wallet gas after setup because they are signed and posted to the CLOB.',
  )

  return lines.join('\n')
}
