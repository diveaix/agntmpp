import { DASHBOARD_ENABLED } from './product-mode.js'

export const DASHBOARD_DISABLED_RESPONSE = {
  error: 'dashboard_disabled',
  error_description: 'The dashboard is temporarily unavailable.',
}

export function isDashboardDisabledPath(path: string): boolean {
  if (DASHBOARD_ENABLED) return false
  let decodedPath: string
  try { decodedPath = decodeURIComponent(path) } catch { return false }
  // Email verification and logout are also used by sale authentication.
  return /^\/(?:dashboard(?:\/|$)|auth\/(?:login|signup|password)(?:\/|$))/i.test(decodedPath)
}
