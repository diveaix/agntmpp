import test from 'node:test'
import assert from 'node:assert/strict'
import { getToolPrice, getToolTier, isFreeTool, isMppPaymentGateEnabled } from '../pricing.js'

test('MPP payment gate is disabled by default for API-key access', () => {
  const previous = process.env.AGNT_MPP_ENABLED
  try {
    delete process.env.AGNT_MPP_ENABLED

    assert.equal(isMppPaymentGateEnabled(), false)
    assert.equal(getToolTier('account'), 'free')
    assert.equal(getToolTier('billing'), 'free')
    assert.equal(getToolTier('hyperliquid'), 'free')
    assert.equal(getToolPrice('wallet'), '0')
    assert.equal(isFreeTool('polymarket'), true)
  } finally {
    if (previous === undefined) delete process.env.AGNT_MPP_ENABLED
    else process.env.AGNT_MPP_ENABLED = previous
  }
})

test('MPP payment gate can be enabled explicitly', () => {
  const previous = process.env.AGNT_MPP_ENABLED
  try {
    process.env.AGNT_MPP_ENABLED = 'true'

    assert.equal(isMppPaymentGateEnabled(), true)
    assert.equal(getToolTier('account'), 'standard')
    assert.equal(getToolPrice('account'), '0.001')
  } finally {
    if (previous === undefined) delete process.env.AGNT_MPP_ENABLED
    else process.env.AGNT_MPP_ENABLED = previous
  }
})
