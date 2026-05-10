import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assessLiquidityFromPairs,
  formatTradeSafetyNotice,
  type DexPairLike,
} from './trade-safety.js'

test('liquidity assessment reports top liquidity without blocking execution', () => {
  const pairs: DexPairLike[] = [
    {
      chainId: 'base',
      dexId: 'aerodrome',
      pairAddress: '0xpool1',
      url: 'https://dexscreener.com/base/0xpool1',
      liquidity: { usd: 12_500 },
      volume: { h24: 1_200 },
      baseToken: { symbol: 'ABC' },
      quoteToken: { symbol: 'USDC' },
    },
    {
      chainId: 'base',
      dexId: 'uniswap',
      pairAddress: '0xpool2',
      url: 'https://dexscreener.com/base/0xpool2',
      liquidity: { usd: 8_000 },
      volume: { h24: 900 },
      baseToken: { symbol: 'ABC' },
      quoteToken: { symbol: 'WETH' },
    },
  ]

  const result = assessLiquidityFromPairs(pairs, { minLiquidityUsd: 25_000, minVolume24hUsd: 2_500 })

  assert.equal(result.blocked, false)
  assert.equal(result.liquidityUsd, 12_500)
  assert.equal(result.volume24hUsd, 1_200)
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings[0], /\$12,500/)
})

test('liquidity assessment warns when no pool is found but still does not block', () => {
  const result = assessLiquidityFromPairs([], { minLiquidityUsd: 25_000, minVolume24hUsd: 2_500 })

  assert.equal(result.blocked, false)
  assert.equal(result.liquidityUsd, 0)
  assert.equal(result.pairCount, 0)
  assert.deepEqual(result.warnings, ['No active DEX liquidity pool was found for this token on the selected chain.'])
})

test('formatted safety notice includes liquidity and freewill wording', () => {
  const result = assessLiquidityFromPairs([
    {
      chainId: 'optimism',
      dexId: 'velodrome',
      pairAddress: '0xpool',
      url: 'https://dexscreener.com/optimism/0xpool',
      liquidity: { usd: 4_200 },
      volume: { h24: 300 },
      baseToken: { symbol: 'RISK' },
      quoteToken: { symbol: 'USDT' },
    },
  ], { minLiquidityUsd: 25_000, minVolume24hUsd: 2_500 })

  const notice = formatTradeSafetyNotice(result)

  assert.match(notice, /Pre-trade Token Check/)
  assert.match(notice, /Liquidity: \$4,200/)
  assert.match(notice, /User choice: trade is not blocked by liquidity warnings/)
})

test('formatted safety notice does not add warnings for healthy liquid tokens', () => {
  const result = assessLiquidityFromPairs([
    {
      chainId: 'base',
      dexId: 'uniswap',
      pairAddress: '0xpool',
      url: 'https://dexscreener.com/base/0xpool',
      liquidity: { usd: 1_200_000 },
      volume: { h24: 500_000 },
      baseToken: { symbol: 'USDC' },
      quoteToken: { symbol: 'WETH' },
    },
  ], { minLiquidityUsd: 25_000, minVolume24hUsd: 2_500 })

  const notice = formatTradeSafetyNotice({ ...result, tokenSymbol: 'USDC' })

  assert.equal(result.warnings.length, 0)
  assert.match(notice, /Pre-trade Token Check/)
  assert.match(notice, /Liquidity: \$1,200,000/)
  assert.doesNotMatch(notice, /Warnings:/)
  assert.doesNotMatch(notice, /User choice: trade is not blocked/)
})
