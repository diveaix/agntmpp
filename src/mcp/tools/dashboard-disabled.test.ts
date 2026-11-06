import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DASHBOARD_DISABLED_RESPONSE } from '../../dashboard-access.js'

const paths = [
  '/dashboard', '/dashboard/', '/DASHBOARD/snapshot', '/dashboard/me',
  '/dashboard/api-keys', '/dashboard/api-keys/test/reveal',
  '/dashboard/connector-links', '/dashboard/connector-links/test',
  '/dashboard/wallets/password', '/dashboard/wallets/test/reveal',
  '/dashboard/wallets/test', '/dashboard/history', '/dashboard/future/endpoint',
  '/auth/login', '/auth/login/', '/auth/signup', '/auth/password/reset',
  '/dashboard%2Fapi-keys', '/%64ashboard/me', '/auth%2Fsignup',
]

for (const backend of ['mcp', 'web'] as const) {
  test(`${backend} denies dashboard access before parsing, authentication or side effects`, { timeout: 30_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnt-dashboard-disabled-'))
    const portReservation = createServer().listen(0, '127.0.0.1')
    await once(portReservation, 'listening')
    const port = (portReservation.address() as AddressInfo).port
    await new Promise<void>((resolve) => portReservation.close(() => resolve()))
    const entry = fileURLToPath(new URL(backend === 'mcp' ? '../serve.ts' : '../../server/index.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), entry], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: 'test', AGNT_PORT: String(port), PORT: String(port),
        AGNT_PASSPHRASE: 'isolated-dashboard-disabled-test-passphrase',
        AGNT_ACCESS_REQUIRED: 'true', AGNT_SALE_PROVIDERS_ENABLED: 'false',
        AGNT_MCP_HTTP_URL: 'http://127.0.0.1:1',
        AGNT_ACCESS_STORE_PATH: join(directory, 'access.enc'),
        AGNT_WALLET_VAULT_PATH: join(directory, 'wallet-vault.enc'),
        AGNT_MEMORY_PATH: join(directory, 'memory.enc'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', (data) => { errors += String(data) })
    const base = `http://127.0.0.1:${port}`
    try {
      const health = backend === 'mcp' ? '/health' : '/api/health'
      const deadline = Date.now() + 20_000
      while (true) {
        assert.equal(child.exitCode, null, `Server exited: ${errors}`)
        try { if ((await fetch(base + health)).ok) break } catch { /* starting */ }
        assert.ok(Date.now() < deadline, `Server did not start: ${errors}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const filesBefore = readdirSync(directory, { recursive: true })
      for (const path of paths) {
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
          const response = await fetch(base + path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'X-AGNT-Dashboard-Session': 'invalid-session',
              Cookie: 'agnt_dashboard_session=invalid-session',
            },
            // An invalid body must never reach a parser or a mutation handler.
            body: ['GET', 'HEAD'].includes(method) ? undefined : '{invalid',
          })
          assert.equal(response.status, 503, `${method} ${path}`)
          assert.equal(response.headers.get('cache-control'), 'no-store')
          if (method !== 'HEAD') assert.deepEqual(await response.json(), DASHBOARD_DISABLED_RESPONSE)
        }
      }
      assert.deepEqual(readdirSync(directory, { recursive: true }), filesBefore)

      if (backend === 'mcp') {
        for (const path of ['/mcp', '/sse', '/access/me', '/api/sale/account']) {
          assert.equal((await fetch(base + path)).status, 401, `Authentication remains required on ${path}`)
        }
        for (const path of ['/auth/email/start', '/auth/email/verify']) {
          const response = await fetch(base + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          })
          assert.equal(response.status, 400, `Shared sale authentication remains available on ${path}`)
        }
        assert.equal((await fetch(base + '/auth/logout', { method: 'POST' })).status, 200)
      } else {
        // Shared sale authentication still uses the upstream, which is deliberately absent.
        assert.equal((await fetch(base + '/auth/email/start', { method: 'POST' })).status, 502)
      }
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
      assert.equal(dirname(directory), resolve(tmpdir()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
