import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUnits } from 'viem'
import { NATIVE_TOKEN, resolveRouteAmount } from './aggregator-assets.js'

const account = '0x1111111111111111111111111111111111111111' as const

function mockClient(balance: bigint) {
  return {
    getBalance: async () => balance,
    readContract: async () => 123n,
  } as never
}

test('resolves all native routes while keeping an ETH gas reserve', async () => {
  const amount = await resolveRouteAmount({
    amount: 'all',
    decimals: 18,
    token: NATIVE_TOKEN,
    account,
    client: mockClient(parseUnits('0.002', 18)),
    nativeReserve: '0.0005',
  })

  assert.equal(amount, parseUnits('0.0015', 18))
})

test('blocks all native routes when the reserve would consume the balance', async () => {
  await assert.rejects(
    () => resolveRouteAmount({
      amount: 'max',
      decimals: 18,
      token: NATIVE_TOKEN,
      account,
      client: mockClient(parseUnits('0.0004', 18)),
      nativeReserve: '0.0005',
    }),
    /Not enough native ETH/,
  )
})
