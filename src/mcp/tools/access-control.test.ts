import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiKey, createConnectorLink, createUser } from '../access-store.js'
import { extractApiKeyFromUrl, extractConnectorTokenFromUrl, isAccessRequired, resolveAuthContextFromRequest } from '../access-control.js'

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

test('env-only broad access keys are not accepted', async () => {
  await withAccessPath(() => {
    const previous = process.env.AGNT_TEMP_API_KEY
    process.env.AGNT_TEMP_API_KEY = 'agnt_temp_old_shortcut'
    try {
      const auth = resolveAuthContextFromRequest({ 'x-agnt-api-key': 'agnt_temp_old_shortcut' }, '/mcp')
      assert.equal(auth, null)
    } finally {
      if (previous === undefined) delete process.env.AGNT_TEMP_API_KEY
      else process.env.AGNT_TEMP_API_KEY = previous
    }
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

test('lockdown accepts only configured api keys and ignores stored keys', async () => {
  await withAccessPath(() => {
    const previousKeys = process.env.AGNT_LOCKDOWN_API_KEYS
    const previousPlan = process.env.AGNT_LOCKDOWN_PLAN
    process.env.AGNT_LOCKDOWN_API_KEYS = 'agnt_judge_allowed,agnt_live_owner_allowed'
    process.env.AGNT_LOCKDOWN_PLAN = 'max'
    try {
      const user = createUser({ email: 'stored@example.com' })
      createApiKey(user.id, 'stored', undefined, 'agnt_live_stored_secret')

      const judge = resolveAuthContextFromRequest({ 'x-agnt-api-key': 'agnt_judge_allowed' }, '/mcp')
      const owner = resolveAuthContextFromRequest({ authorization: 'Bearer agnt_live_owner_allowed' }, '/mcp')
      const stored = resolveAuthContextFromRequest({ 'x-agnt-api-key': 'agnt_live_stored_secret' }, '/mcp')
      const missing = resolveAuthContextFromRequest({}, '/mcp')

      assert.equal(judge?.plan, 'max')
      assert.equal(owner?.subscriptionStatus, 'active')
      assert.equal(stored, null)
      assert.equal(missing, null)
      assert.equal(isAccessRequired(), true)
    } finally {
      if (previousKeys === undefined) delete process.env.AGNT_LOCKDOWN_API_KEYS
      else process.env.AGNT_LOCKDOWN_API_KEYS = previousKeys
      if (previousPlan === undefined) delete process.env.AGNT_LOCKDOWN_PLAN
      else process.env.AGNT_LOCKDOWN_PLAN = previousPlan
    }
  })
})

test('access is required by default unless local dev explicitly opts out', () => {
  const previousRequired = process.env.AGNT_ACCESS_REQUIRED
  const previousNodeEnv = process.env.NODE_ENV
  const previousKeys = process.env.AGNT_LOCKDOWN_API_KEYS
  try {
    delete process.env.AGNT_ACCESS_REQUIRED
    delete process.env.AGNT_LOCKDOWN_API_KEYS
    process.env.NODE_ENV = 'development'
    assert.equal(isAccessRequired(), true)

    process.env.AGNT_ACCESS_REQUIRED = 'false'
    assert.equal(isAccessRequired(), false)

    process.env.NODE_ENV = 'production'
    assert.equal(isAccessRequired(), true)
  } finally {
    if (previousRequired === undefined) delete process.env.AGNT_ACCESS_REQUIRED
    else process.env.AGNT_ACCESS_REQUIRED = previousRequired
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousKeys === undefined) delete process.env.AGNT_LOCKDOWN_API_KEYS
    else process.env.AGNT_LOCKDOWN_API_KEYS = previousKeys
  }
})
