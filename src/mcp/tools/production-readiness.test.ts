import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedOrigins, liveExecutionEnabled, validateProductionConfig } from '../production-readiness.js'

const KEYS = [
  'NODE_ENV', 'AGNT_PASSPHRASE', 'AGNT_ALLOWED_ORIGINS', 'AGNT_SINGLE_INSTANCE',
  'AGNT_EMAIL_PROVIDER', 'AGNT_EMAIL_WEBHOOK_URL', 'AGNT_MPP_ENABLED',
  'AGNT_LIVE_EXECUTION_ENABLED',
] as const

test('production config fails closed when required settings are absent', () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of KEYS) delete process.env[key]
    process.env.NODE_ENV = 'production'
    assert.throws(() => validateProductionConfig(), /AGNT_PASSPHRASE/)
    assert.equal(liveExecutionEnabled(), false)
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

test('production config accepts the supported single-instance topology', () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  try {
    process.env.NODE_ENV = 'production'
    process.env.AGNT_PASSPHRASE = 'a-production-passphrase-at-least-32-characters'
    process.env.AGNT_ALLOWED_ORIGINS = 'https://app.example.com'
    process.env.AGNT_SINGLE_INSTANCE = 'true'
    process.env.AGNT_EMAIL_PROVIDER = 'webhook'
    process.env.AGNT_EMAIL_WEBHOOK_URL = 'https://mailer.example.com/send'
    delete process.env.AGNT_MPP_ENABLED
    assert.doesNotThrow(() => validateProductionConfig())
    assert.deepEqual(allowedOrigins(), ['https://app.example.com'])
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})
