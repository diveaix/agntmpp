import { getPassphrase } from './crypto.js'

export function allowedOrigins(): string[] {
  const configured = process.env.AGNT_ALLOWED_ORIGINS
  if (configured) return configured.split(',').map((value) => value.trim()).filter(Boolean)
  if (process.env.NODE_ENV === 'production') return []
  return ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173']
}

export function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return

  const errors: string[] = []
  try {
    getPassphrase()
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const origins = allowedOrigins()
  if (origins.length === 0) errors.push('AGNT_ALLOWED_ORIGINS must list the public dashboard origin(s).')
  if (origins.includes('*')) errors.push('AGNT_ALLOWED_ORIGINS cannot contain a wildcard in production.')
  if (process.env.AGNT_SINGLE_INSTANCE !== 'true') {
    errors.push('AGNT_SINGLE_INSTANCE=true is required because the encrypted file stores do not support multiple replicas.')
  }
  if (process.env.AGNT_EMAIL_PROVIDER !== 'webhook' || !process.env.AGNT_EMAIL_WEBHOOK_URL) {
    errors.push('Set AGNT_EMAIL_PROVIDER=webhook and AGNT_EMAIL_WEBHOOK_URL for verification-code delivery.')
  }
  if (process.env.AGNT_MPP_ENABLED === 'true') {
    errors.push('AGNT_MPP_ENABLED is no longer supported. Disable per-call settlement and use account access.')
  }
  if (process.env.STRIPE_SECRET_KEY) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) errors.push('STRIPE_WEBHOOK_SECRET is required when Stripe is enabled.')
    if (!process.env.STRIPE_PRICE_PRO) errors.push('STRIPE_PRICE_PRO is required when Stripe is enabled.')
    if (!process.env.STRIPE_PRICE_MAX) errors.push('STRIPE_PRICE_MAX is required when Stripe is enabled.')
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration is invalid:\n- ${errors.join('\n- ')}`)
  }
}

export function liveExecutionEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.AGNT_LIVE_EXECUTION_ENABLED === 'true'
}
