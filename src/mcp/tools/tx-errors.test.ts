import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTxError, formatTxError } from '../tx-errors.js'

test('formats missing wallet errors in plain English', () => {
  assert.match(
    classifyTxError(new Error('No active AGNT wallet is selected.')),
    /No active wallet is selected/,
  )
})

test('formats approval failures with exact approval guidance', () => {
  assert.match(
    classifyTxError(new Error('TRANSFER_FROM_FAILED')),
    /exact-amount approvals/,
  )
})

test('redacts secret-looking values from formatted errors', () => {
  const formatted = formatTxError(
    new Error('failed with key 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and token agnt_live_secret'),
    { tool: 'wallet_send', action: 'send', chain: 'base' },
  )
  assert.doesNotMatch(formatted, /agnt_live_secret/)
  assert.doesNotMatch(formatted, /0xaaaaaaaa/)
  assert.match(formatted, /Tool: wallet_send\/send/)
  assert.match(formatted, /Chain: base/)
})
