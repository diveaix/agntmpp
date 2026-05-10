import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatHyperliquidSetupGuide,
  getHyperliquidSetupBlocker,
  isHyperliquidSetupGuideQuery,
  simulateHyperliquidOrder,
} from './hyperliquid-helpers.js'
import hyperliquidModule from './hyperliquid.js'

test('formats a plain-English Hyperliquid setup guide', () => {
  const guide = formatHyperliquidSetupGuide({
    hasWallet: true,
    walletName: 'Main',
    address: '0x123',
    accountValue: 0,
    availableMargin: 0,
    openPositions: 0,
  })

  assert.match(guide, /Hyperliquid First-Time Setup/)
  assert.match(guide, /Ask me: "Check my Hyperliquid account"/)
  assert.match(guide, /Ask me: "Show all Hyperliquid markets"/)
  assert.match(guide, /Ask me: "Simulate longing BTC with \$20 at 2x"/)
  assert.match(guide, /Ask me: "Fund my Hyperliquid account"/)
  assert.match(guide, /USDC \(Perps\)/)
  assert.match(guide, /Ask me: "Withdraw \$25 from Hyperliquid to my wallet"/)
  assert.doesNotMatch(guide, /market=|side=|orderType=|tif=/)
  assert.doesNotMatch(guide, /EIP-712|API:|hyperliquid setup|amount=|use action/i)
})

test('hyperliquid setup handler returns plain-English guidance only', async () => {
  const result = await hyperliquidModule.handle('hyperliquid', { action: 'setup' })
  const guide = result?.content?.[0]?.text || ''

  assert.match(guide, /Simple things you can ask me:/)
  assert.match(guide, /Ask me: "Fund my Hyperliquid account"/)
  assert.doesNotMatch(guide, /Useful .*actions|Example funding command|Hyperliquid details from the server/i)
  assert.doesNotMatch(guide, /hyperliquid setup|amount=|market=|side=|source=|EIP-712|API:|App:/i)
})

test('blocks write actions when Hyperliquid account is not funded', () => {
  assert.equal(getHyperliquidSetupBlocker('order', { hasWallet: false }), 'wallet')
  assert.equal(getHyperliquidSetupBlocker('order', { hasWallet: true, availableMargin: 0 }), 'funding')
  assert.equal(getHyperliquidSetupBlocker('order', { hasWallet: true, availableMargin: 25 }), null)
  assert.equal(getHyperliquidSetupBlocker('markets', { hasWallet: false }), null)
})

test('recognizes plain-English Hyperliquid guide queries', () => {
  assert.equal(isHyperliquidSetupGuideQuery('setup guide'), true)
  assert.equal(isHyperliquidSetupGuideQuery('how do I use hyperliquid?'), true)
  assert.equal(isHyperliquidSetupGuideQuery('help me trade on hl'), true)
  assert.equal(isHyperliquidSetupGuideQuery('btc funding'), false)
})

test('simulates market and scale orders with leverage and risk numbers', () => {
  const market = simulateHyperliquidOrder({
    kind: 'market',
    market: 'BTC',
    side: 'buy',
    markPrice: 100000,
    amountUsd: 20,
    leverage: 2,
  })
  assert.equal(market.size, 0.0004)
  assert.equal(market.notional, 40)
  assert.equal(market.margin, 20)
  assert.match(market.summary, /LONG BTC-PERP/)
  assert.match(market.summary, /2x/)

  const scale = simulateHyperliquidOrder({
    kind: 'scale',
    market: 'ETH',
    side: 'sell',
    markPrice: 3000,
    amountUsd: 90,
    leverage: 3,
    startPrice: 3050,
    endPrice: 3150,
    totalOrders: 3,
  })
  assert.equal(scale.childOrders.length, 3)
  assert.deepEqual(scale.childOrders.map(o => o.price), [3050, 3100, 3150])
  assert.match(scale.summary, /3 child orders/)
})

test('simulates trigger and twap order plans in plain language', () => {
  const stop = simulateHyperliquidOrder({
    kind: 'stop_market',
    market: 'ETH',
    side: 'sell',
    markPrice: 3000,
    amountUsd: 50,
    leverage: 2,
    stopPrice: 3100,
    reduceOnly: true,
  })
  assert.match(stop.summary, /STOP_MARKET SHORT ETH-PERP/)
  assert.match(stop.summary, /trigger \$3,100/)
  assert.match(stop.summary, /Reduce only: yes/)

  const twap = simulateHyperliquidOrder({
    kind: 'twap',
    market: 'SOL',
    side: 'buy',
    markPrice: 150,
    amountUsd: 30,
    leverage: 1,
    durationMinutes: 20,
  })
  assert.match(twap.summary, /TWAP LONG SOL-PERP/)
  assert.match(twap.summary, /over 20 minutes/)
})
