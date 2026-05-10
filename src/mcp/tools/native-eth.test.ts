import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getNativeEthPlan,
  isNativeEthRequest,
  resolveToWeth,
  waitForTokenBalanceIncrease,
} from './native-eth.js'

test('detects common native ETH inputs', () => {
  assert.equal(isNativeEthRequest('ETH'), true)
  assert.equal(isNativeEthRequest('0x0000000000000000000000000000000000000000'), true)
  assert.equal(isNativeEthRequest('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), true)
  assert.equal(isNativeEthRequest('WETH'), false)
})

test('plans direct WETH unwrap without routing through a DEX', () => {
  const plan = getNativeEthPlan(
    '0x4200000000000000000000000000000000000006',
    'ETH',
    'base',
  )

  assert.equal(plan.directUnwrap, true)
  assert.equal(plan.directWrap, false)
  assert.equal(plan.unwrapOutput, false)
  assert.equal(plan.tokenIn, '0x4200000000000000000000000000000000000006')
  assert.equal(plan.tokenOut, '0x4200000000000000000000000000000000000006')
})

test('plans native ETH input wrapping before a token swap', () => {
  const plan = getNativeEthPlan(
    'ETH',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'base',
  )

  assert.equal(plan.wrapInput, true)
  assert.equal(plan.directWrap, false)
  assert.equal(plan.directUnwrap, false)
  assert.equal(plan.tokenIn, '0x4200000000000000000000000000000000000006')
  assert.equal(plan.tokenOut, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
})

test('plans token swaps to native ETH as WETH output plus unwrap', () => {
  const plan = getNativeEthPlan(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'ETH',
    'base',
  )

  assert.equal(plan.unwrapOutput, true)
  assert.equal(plan.directUnwrap, false)
  assert.equal(plan.tokenOut, '0x4200000000000000000000000000000000000006')
})

test('rejects native ETH wrapping on chains where WETH is not the gas-token wrapper', () => {
  assert.throws(
    () => getNativeEthPlan('ETH', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'bsc'),
    /Native ETH wrapping is not supported/,
  )
})

test('resolves WETH aliases to the chain WETH address', () => {
  assert.equal(resolveToWeth('weth', 'arbitrum'), '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1')
})

test('waits for token balance to rise above a stale pre-swap value', async () => {
  const reads = [10n, 10n, 25n]
  const client = {
    async readContract() {
      return reads.shift() ?? 25n
    },
  }

  const delta = await waitForTokenBalanceIncrease(
    client,
    '0x4200000000000000000000000000000000000006',
    '0x38Fd5CA2b6908f83b33B0618D6cBd5B4334A00EC',
    10n,
    { attempts: 4, delayMs: 0 },
  )

  assert.equal(delta, 15n)
})
