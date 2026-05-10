import test from 'node:test'
import assert from 'node:assert/strict'
import { assessRouteUsdValues, assessRouteValue } from './route-safety.js'

test('blocks routes with severe value loss', () => {
  const assessment = assessRouteValue({
    fromAmount: 1000000000000000n,
    fromDecimals: 18,
    fromPriceUsd: '2340',
    toAmount: 1122686n,
    toDecimals: 6,
    toPriceUsd: '1',
  })

  assert.equal(assessment.blocked, true)
  assert.ok(assessment.lossPercent > 50)
  assert.match(assessment.reason || '', /Route blocked/)
})

test('allows routes within the loss limit', () => {
  const assessment = assessRouteValue({
    fromAmount: 25000000n,
    fromDecimals: 6,
    fromPriceUsd: '1',
    toAmount: 23715128n,
    toDecimals: 6,
    toPriceUsd: '1',
    maxLossPercent: 6,
  })

  assert.equal(assessment.blocked, false)
  assert.ok(assessment.lossPercent < 6)
})

test('blocks relay-style quotes with high total USD loss', () => {
  const assessment = assessRouteUsdValues({
    inputUsd: '4.693373',
    outputUsd: '3.470111',
    maxLossPercent: 10,
  })

  assert.equal(assessment.blocked, true)
  assert.equal(Math.round(assessment.lossPercent), 26)
})
