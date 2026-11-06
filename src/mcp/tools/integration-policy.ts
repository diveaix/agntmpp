import { SUPPORTED_CHAINS } from '../chains.js'

// Keep removed providers out of third-party discovery and routed transactions.
const REMOVED_NAMES = ['tempo', 'dune', 'arc', 'arctestnet', 'hyperevm', 'polymarket', 'sol', 'wsol', 'wrappedsolana', 'hype', 'eigen', 'dln']
const REMOVED_PREFIXES = ['tempo', 'debridge', 'stargate', 'eigenlayer', 'hyperliquid', 'solana']

export function isRemovedIntegration(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const name = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  return REMOVED_NAMES.includes(name) || REMOVED_PREFIXES.some(prefix => name.startsWith(prefix))
}

export function hasRemovedIntegration(value: unknown): boolean {
  if (isRemovedIntegration(value)) return true
  if (Array.isArray(value)) return value.some(hasRemovedIntegration)
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some(hasRemovedIntegration)
}

export function assertSupportedRoute(route: unknown): void {
  if (hasRemovedIntegration(route)) throw new Error('Route uses an unsupported integration.')
  const chainIds = new Set(Object.values(SUPPORTED_CHAINS).map(config => config.chain.id))
  function checkChains(value: unknown): void {
    if (Array.isArray(value)) return value.forEach(checkChains)
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (/^(chainId|fromChainId|toChainId|originChainId|destinationChainId)$/.test(key) && !chainIds.has(Number(item))) {
        throw new Error('Route uses an unsupported chain.')
      }
      checkChains(item)
    }
  }
  checkChains(route)
}
