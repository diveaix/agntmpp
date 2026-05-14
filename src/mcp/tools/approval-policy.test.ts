import test from 'node:test'
import assert from 'node:assert/strict'
import { planExactApproval } from './approval-policy.js'

test('keeps exact allowance unchanged', () => {
  const plan = planExactApproval(2000000n, 2000000n)

  assert.equal(plan.alreadyExact, true)
  assert.equal(plan.resetAmount, null)
  assert.equal(plan.approveAmount, null)
})

test('approves exact amount when allowance is zero', () => {
  const plan = planExactApproval(0n, 2000000n)

  assert.equal(plan.alreadyExact, false)
  assert.equal(plan.resetAmount, null)
  assert.equal(plan.approveAmount, 2000000n)
})

test('resets broader or stale allowance before approving exact amount', () => {
  const plan = planExactApproval(5000000n, 2000000n)

  assert.equal(plan.alreadyExact, false)
  assert.equal(plan.resetAmount, 0n)
  assert.equal(plan.approveAmount, 2000000n)
})

test('rejects zero approval amounts', () => {
  assert.throws(() => planExactApproval(100n, 0n), /greater than zero/i)
})
