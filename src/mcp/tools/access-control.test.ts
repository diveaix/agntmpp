import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiKey, createConnectorLink, createUser } from '../access-store.js'
import { extractApiKeyFromUrl, extractConnectorTokenFromUrl, resolveAuthContextFromRequest } from '../access-control.js'

function testPath(name: string): string {
  return `./.agnt/test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.enc`
}

async function withAccessPath<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.AGNT_ACCESS_STORE_PATH
  process.env.AGNT_ACCESS_STORE_PATH = testPath('access-control')
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.AGNT_ACCESS_STORE_PATH
    else process.env.AGNT_ACCESS_STORE_PATH = previous
  }
}

async function withJudgeKeyEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const previousKey = process.env.AGNT_JUDGE_API_KEY
  const previousUserId = process.env.AGNT_JUDGE_USER_ID
  const previousPlan = process.env.AGNT_JUDGE_PLAN
  process.env.AGNT_JUDGE_API_KEY = 'agnt_judge_test_secret'
  process.env.AGNT_JUDGE_USER_ID = 'judge-hackathon'
  process.env.AGNT_JUDGE_PLAN = 'max'
  try {
    return await fn()
  } finally {
    if (previousKey === undefined) delete process.env.AGNT_JUDGE_API_KEY
    else process.env.AGNT_JUDGE_API_KEY = previousKey
    if (previousUserId === undefined) delete process.env.AGNT_JUDGE_USER_ID
    else process.env.AGNT_JUDGE_USER_ID = previousUserId
    if (previousPlan === undefined) delete process.env.AGNT_JUDGE_PLAN
    else process.env.AGNT_JUDGE_PLAN = previousPlan
  }
}

test('extracts api key from Claude-friendly MCP URL query param', () => {
  assert.equal(
    extractApiKeyFromUrl('/mcp?agnt_api_key=agnt_live_claude_key'),
    'agnt_live_claude_key',
  )
  assert.equal(extractApiKeyFromUrl('/mcp?agnt_api_key=not_an_agnt_key'), undefined)
})

test('request auth accepts URL api key when headers are unavailable', async () => {
  await withAccessPath(() => {
    const user = createUser({ email: 'claude@example.com' })
    createApiKey(user.id, 'claude', undefined, 'agnt_live_claude_secret')

    const auth = resolveAuthContextFromRequest({}, '/mcp?agnt_api_key=agnt_live_claude_secret')
    assert.equal(auth?.userId, user.id)
    assert.equal(auth?.source, 'api_key')
  })
})

test('request auth accepts env-provided judge key without an access-store record', async () => {
  await withAccessPath(async () => {
    await withJudgeKeyEnv(() => {
      const headerAuth = resolveAuthContextFromRequest({ 'x-agnt-api-key': 'agnt_judge_test_secret' }, '/mcp')
      assert.equal(headerAuth?.userId, 'judge-hackathon')
      assert.equal(headerAuth?.apiKeyId, 'judge-demo-env')
      assert.equal(headerAuth?.plan, 'max')
      assert.equal(headerAuth?.source, 'api_key')

      const urlAuth = resolveAuthContextFromRequest({}, '/sse?agnt_api_key=agnt_judge_test_secret')
      assert.equal(urlAuth?.userId, 'judge-hackathon')
    })
  })
})

test('request auth accepts revokable connector token from URL', async () => {
  await withAccessPath(() => {
    const user = createUser({ email: 'connector@example.com' })
    const key = createApiKey(user.id, 'primary', undefined, 'agnt_live_connector_secret')
    createConnectorLink(user.id, { apiKeyId: key.record.id, label: 'Claude' }, undefined, 'agnt_conn_claude_secret')

    assert.equal(extractConnectorTokenFromUrl('/mcp?agnt_connector_token=agnt_conn_claude_secret'), 'agnt_conn_claude_secret')
    const auth = resolveAuthContextFromRequest({}, '/mcp?agnt_connector_token=agnt_conn_claude_secret')
    assert.equal(auth?.userId, user.id)
    assert.equal(auth?.apiKeyId, key.record.id)
  })
})
