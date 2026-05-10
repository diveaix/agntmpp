import test from 'node:test'
import assert from 'node:assert/strict'
import { listActivityForUser, recordActivity, recordToolActivity } from '../activity-log.js'
import type { AuthContext } from '../access-types.js'

function testPath(name: string): string {
  return `./.agnt/test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.enc`
}

async function withActivityPath<T>(fn: () => Promise<T> | T): Promise<T> {
  const previousPath = process.env.AGNT_ACTIVITY_LOG_PATH
  process.env.AGNT_ACTIVITY_LOG_PATH = testPath('activity')
  try {
    return await fn()
  } finally {
    if (previousPath === undefined) delete process.env.AGNT_ACTIVITY_LOG_PATH
    else process.env.AGNT_ACTIVITY_LOG_PATH = previousPath
  }
}

const auth: AuthContext = {
  userId: 'user_1',
  apiKeyId: 'key_1',
  plan: 'pro',
  subscriptionStatus: 'active',
  source: 'api_key',
  entitlement: {
    plan: 'pro',
    dataAutomationSlots: 5,
    customSourceSlots: 25,
    autoExecuteAllowed: true,
    priorityQueue: false,
    eventEvaluationsMonthly: 5000,
    executionsMonthly: 500,
  },
}

test('records manual swap activity for the authenticated dashboard user', async () => {
  await withActivityPath(() => {
    recordToolActivity('tempo_swap', {
      action: 'swap',
      amount: 10,
      tokenIn: 'USDC.e',
      tokenOut: 'ETH',
    }, {
      content: [{ type: 'text', text: 'Swapped 10 USDC.e to ETH\nTx: 0x1111111111111111111111111111111111111111111111111111111111111111' }],
    }, auth)

    const history = listActivityForUser('user_1')
    assert.equal(history.length, 1)
    assert.equal(history[0].title, 'Swap 10 USDC.e to ETH')
    assert.equal(history[0].tool, 'tempo_swap')
    assert.equal(history[0].txHash, '0x1111111111111111111111111111111111111111111111111111111111111111')
  })
})

test('local dashboard can include unowned dev activity, hosted dashboard cannot', async () => {
  await withActivityPath(() => {
    recordActivity({
      tool: 'relay',
      action: 'bridge',
      title: 'Bridge ETH to Arbitrum',
      result: 'Bridge submitted',
      success: true,
    })

    assert.equal(listActivityForUser('user_1').length, 0)
    assert.equal(listActivityForUser('user_1', { includeLocalUnowned: true }).length, 1)
  })
})
