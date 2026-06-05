import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateLimitBuySize,
  formatPolymarketSetupGuide,
  getPolymarketSetupBlocker,
  isPolymarketSetupGuideQuery,
  parsePolymarketOrderMode,
  resolvePolymarketExecutionPrice,
} from './polymarket-helpers.js'

test('parses limit and market execution modes', () => {
  assert.deepEqual(parsePolymarketOrderMode(undefined), { mode: 'limit', orderType: 'GTC', isMarket: false })
  assert.deepEqual(parsePolymarketOrderMode('market_fok'), { mode: 'market_fok', orderType: 'FOK', isMarket: true })
  assert.deepEqual(parsePolymarketOrderMode('market_fak'), { mode: 'market_fak', orderType: 'FAK', isMarket: true })
  assert.throws(() => parsePolymarketOrderMode('market'), /Invalid mode/)
})

test('market buy requires an explicit worst acceptable price', () => {
  const mode = parsePolymarketOrderMode('market_fok')
  assert.throws(
    () => resolvePolymarketExecutionPrice({ side: 'BUY', mode, marketPrice: 0.4 }),
    /Market buys require maxPrice/,
  )
  assert.equal(resolvePolymarketExecutionPrice({ side: 'BUY', mode, marketPrice: 0.4, maxPrice: 0.45 }), 0.45)
})

test('market sell requires an explicit worst acceptable price', () => {
  const mode = parsePolymarketOrderMode('market_fak')
  assert.throws(
    () => resolvePolymarketExecutionPrice({ side: 'SELL', mode, marketPrice: 0.4 }),
    /Market sells require minPrice/,
  )
  assert.equal(resolvePolymarketExecutionPrice({ side: 'SELL', mode, marketPrice: 0.4, minPrice: 0.35 }), 0.35)
})

test('limit orders default to displayed market price and size by spend', () => {
  const mode = parsePolymarketOrderMode('limit')
  const price = resolvePolymarketExecutionPrice({ side: 'BUY', mode, marketPrice: 0.42 })
  assert.equal(price, 0.42)
  assert.equal(calculateLimitBuySize(5, price), 11.9)
})

test('formats a first-time Polymarket setup guide with current status', () => {
  const guide = formatPolymarketSetupGuide({
    hasWallet: true,
    walletName: 'Main',
    address: '0x123',
    pusdBalance: '0',
    nativeUsdcBalance: '9.99',
    usdcEbalance: '0',
    polBalance: '0.02',
    collateralReady: false,
    outcomeTokensReady: true,
  })

  assert.match(guide, /Polymarket First-Time Setup/)
  assert.match(guide, /Wallet: Main \(0x123\)/)
  assert.match(guide, /Wallet Polymarket pUSD: 0/)
  assert.match(guide, /Wallet native Polygon USDC: 9.99/)
  assert.match(guide, /not the same as Polymarket CLOB trading collateral/)
  assert.match(guide, /Ask me: "Check my Polymarket balance"/)
  assert.match(guide, /Ask me: "Approve Polymarket trading"/)
  assert.match(guide, /Ask me: "How do I withdraw from Polymarket\?"/)
  assert.match(guide, /withdraw USDC from Polymarket/)
  assert.match(guide, /Ask me: "Search Polymarket for Bitcoin"/)
  assert.match(guide, /Ask me: "Buy \$5 of YES"/)
  assert.match(guide, /Normal buy\/sell orders do not require wallet gas/)
  assert.doesNotMatch(guide, /marketUrl=|outcome=|stopPrice=|take_profit|stop_loss/)
})

test('blocks buy setup only when funding or approvals are missing', () => {
  assert.equal(getPolymarketSetupBlocker('buy', {
    hasWallet: true,
    pusdBalance: 0,
    requiredPusd: 5,
    polBalance: 1,
    collateralReady: true,
    outcomeTokensReady: true,
  }), 'funding')

  assert.equal(getPolymarketSetupBlocker('buy', {
    hasWallet: true,
    pusdBalance: 3,
    requiredPusd: 5,
    polBalance: 1,
    collateralReady: true,
    outcomeTokensReady: true,
  }), 'funding')

  assert.equal(getPolymarketSetupBlocker('buy', {
    hasWallet: true,
    pusdBalance: 10,
    requiredPusd: 5,
    polBalance: 1,
    collateralReady: false,
    outcomeTokensReady: true,
  }), 'approval')

  assert.equal(getPolymarketSetupBlocker('buy', {
    hasWallet: true,
    pusdBalance: 10,
    polBalance: 1,
    collateralReady: true,
    outcomeTokensReady: true,
  }), null)
})

test('does not interrupt read-only Polymarket actions with setup', () => {
  assert.equal(getPolymarketSetupBlocker('search', { hasWallet: false }), null)
  assert.equal(getPolymarketSetupBlocker('market', { hasWallet: false }), null)
  assert.equal(getPolymarketSetupBlocker('orderbook', { hasWallet: false }), null)
})

test('recognizes plain-English setup guide search queries', () => {
  assert.equal(isPolymarketSetupGuideQuery('setup guide'), true)
  assert.equal(isPolymarketSetupGuideQuery('how do I use polymarket?'), true)
  assert.equal(isPolymarketSetupGuideQuery('help me setup polymarket'), true)
  assert.equal(isPolymarketSetupGuideQuery('bitcoin'), false)
})
