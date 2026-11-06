import test from 'node:test'
import assert from 'node:assert/strict'
import { getToolPrice, getToolTier } from '../pricing.js'
import { handleTool } from './index.js'

test('tool calls have no per-call charge under account access', () => {
  assert.equal(getToolTier('wallet'), 'free')
  assert.equal(getToolPrice('wallet'), '0')
})

test('obsolete payment gate fails closed even with supplied credentials', async () => {
  const previous = process.env.AGNT_MPP_ENABLED
  try {
    process.env.AGNT_MPP_ENABLED = 'true'
    const result = await handleTool('wallet', { action: 'list' }, {
      'org.paymentauth/credential': { source: 'payer', payload: { hash: 'payment' } },
    })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /no longer supported/)
    assert.equal(result._meta, undefined)
  } finally {
    if (previous === undefined) delete process.env.AGNT_MPP_ENABLED
    else process.env.AGNT_MPP_ENABLED = previous
  }
})
