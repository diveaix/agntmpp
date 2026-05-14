import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUnits } from 'viem'
import { normalizeRecipient, normalizeSendChain, buildSendSummary, needsSendConfirmation } from './wallet-send.js'

test('normalizes supported EVM send chains', () => {
  assert.equal(normalizeSendChain('Base'), 'base')
  assert.equal(normalizeSendChain(' arbitrum '), 'arbitrum')
  assert.throws(() => normalizeSendChain('notachain'), /Unknown chain/)
})

test('validates send recipients before building transactions', () => {
  assert.equal(
    normalizeRecipient('0x1111111111111111111111111111111111111111'),
    '0x1111111111111111111111111111111111111111',
  )
  assert.throws(() => normalizeRecipient('alice.eth'), /valid 0x address/)
})

test('builds clear send summaries with tx links only after execution', () => {
  const quoted = buildSendSummary({
    action: 'quote',
    chainLabel: 'Base',
    walletName: 'main',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    tokenLabel: 'USDC',
    amountLabel: '2',
    gasCostLabel: '0.00001 native',
  })
  assert.match(quoted, /Send quote ready/)
  assert.doesNotMatch(quoted, /Tx:/)

  const sent = buildSendSummary({
    action: 'send',
    chainLabel: 'Base',
    walletName: 'main',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    tokenLabel: 'ETH',
    amountLabel: '0.001',
    gasCostLabel: '0.00001 native',
    txUrl: 'https://basescan.org/tx/0xabc',
  })
  assert.match(sent, /Send complete/)
  assert.match(sent, /https:\/\/basescan\.org\/tx\/0xabc/)
})

test('requires explicit confirmation for max and high-value sends', () => {
  assert.deepEqual(
    needsSendConfirmation({
      amount: parseUnits('1', 18),
      decimals: 18,
      native: true,
      maxAmount: true,
      tokenLabel: 'ETH',
    }).required,
    true,
  )
  assert.deepEqual(
    needsSendConfirmation({
      amount: parseUnits('0.01', 18),
      decimals: 18,
      native: true,
      maxAmount: false,
      tokenLabel: 'ETH',
      nativeThreshold: '0.1',
    }).required,
    false,
  )
  assert.deepEqual(
    needsSendConfirmation({
      amount: parseUnits('100', 6),
      decimals: 6,
      native: false,
      maxAmount: false,
      tokenLabel: 'USDC',
      tokenThreshold: '50',
    }).required,
    true,
  )
})
