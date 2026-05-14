import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAutomationReadiness } from './automation-readiness.js'

test('blocks Polymarket event automations when Polygon USDC funding is missing', () => {
  const result = evaluateAutomationReadiness({
    protocol: 'polymarket',
    marketId: 'market-1',
    side: 'YES',
    maxSpend: 10,
  }, {
    polymarket: {
      hasWallet: true,
      walletName: 'Main',
      address: '0x123',
      pusdBalance: 0,
      polBalance: 1,
      collateralReady: true,
      outcomeTokensReady: true,
    },
  })

  assert.equal(result.allowed, false)
  assert.match(result.message || '', /Polygon USDC funding is missing or too low/i)
})

test('blocks Hyperliquid event automations when available margin is below trade size', () => {
  const result = evaluateAutomationReadiness({
    protocol: 'hyperliquid',
    kind: 'trade',
    market: 'ETH',
    side: 'short',
    amountUsd: 50,
    leverage: 2,
  }, {
    hyperliquid: {
      hasWallet: true,
      walletName: 'Main',
      address: '0x123',
      accountValue: 25,
      availableMargin: 25,
      openPositions: 0,
      requiredMargin: 50,
    },
  })

  assert.equal(result.allowed, false)
  assert.match(result.message || '', /no available USDC margin|fund/i)
})

test('allows event automations when the target account is funded and approved', () => {
  const polymarket = evaluateAutomationReadiness({
    protocol: 'polymarket',
    marketId: 'market-1',
    side: 'YES',
    maxSpend: 10,
  }, {
    polymarket: {
      hasWallet: true,
      walletName: 'Main',
      address: '0x123',
      pusdBalance: 25,
      polBalance: 1,
      collateralReady: true,
      outcomeTokensReady: true,
    },
  })

  const hyperliquid = evaluateAutomationReadiness({
    protocol: 'hyperliquid',
    kind: 'trade',
    market: 'BTC',
    side: 'long',
    amountUsd: 20,
    leverage: 2,
  }, {
    hyperliquid: {
      hasWallet: true,
      walletName: 'Main',
      address: '0xabc',
      accountValue: 100,
      availableMargin: 100,
      openPositions: 0,
      requiredMargin: 20,
    },
  })

  assert.equal(polymarket.allowed, true)
  assert.equal(hyperliquid.allowed, true)
})
