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
