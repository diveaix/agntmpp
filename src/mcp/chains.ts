/**
 * ./AGNT Protocol — Multi-Chain Client Registry
 * Creates viem read/write clients for any supported EVM chain on demand.
 * Same private key works on every chain — one wallet, all networks.
 */

import { createPublicClient, createWalletClient, http, type Chain, type PublicClient, type WalletClient } from 'viem'
import { mainnet, arbitrum, base, optimism, polygon, avalanche, abstract, hyperEvm, bsc, linea, zkSync } from 'viem/chains'
import { tempo } from 'viem/chains'
import { getAccount, type WalletEntry } from './wallet.js'

// ─── Chain Definitions ──────────────────────────────────

export interface ChainConfig {
  key: string
  chain: Chain
  rpc: string
  explorer: string
  label: string
}

export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  tempo: {
    key: 'tempo',
    chain: tempo,
    rpc: 'https://rpc.tempo.xyz',
    explorer: 'https://explore.tempo.xyz',
    label: 'Tempo',
  },
  ethereum: {
    key: 'ethereum',
    chain: mainnet,
    rpc: 'https://eth.drpc.org',
    explorer: 'https://etherscan.io',
    label: 'Ethereum',
  },
  arbitrum: {
    key: 'arbitrum',
    chain: arbitrum,
    rpc: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
    label: 'Arbitrum',
  },
  base: {
    key: 'base',
    chain: base,
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    label: 'Base',
  },
  optimism: {
    key: 'optimism',
    chain: optimism,
    rpc: 'https://mainnet.optimism.io',
    explorer: 'https://optimistic.etherscan.io',
    label: 'Optimism',
  },
  polygon: {
    key: 'polygon',
    chain: polygon,
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'https://polygonscan.com',
    label: 'Polygon',
  },
  avalanche: {
    key: 'avalanche',
    chain: avalanche,
    rpc: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'https://snowtrace.io',
    label: 'Avalanche',
  },
  abstract: {
    key: 'abstract',
    chain: abstract,
    rpc: 'https://api.mainnet.abs.xyz',
    explorer: 'https://abscan.org',
    label: 'Abstract',
  },
  'hyperevm': {
    key: 'hyperevm',
    chain: hyperEvm,
    rpc: 'https://rpc.hyperliquid.xyz/evm',
    explorer: 'https://hyperevmscan.io',
    label: 'HyperEVM',
  },
  bsc: {
    key: 'bsc',
    chain: bsc,
    rpc: 'https://bsc-dataseed.binance.org',
    explorer: 'https://bscscan.com',
    label: 'BNB Chain',
  },
  linea: {
    key: 'linea',
    chain: linea,
    rpc: 'https://rpc.linea.build',
    explorer: 'https://lineascan.build',
    label: 'Linea',
  },
  zksync: {
    key: 'zksync',
    chain: zkSync,
    rpc: 'https://mainnet.era.zksync.io',
    explorer: 'https://era.zksync.network',
    label: 'zkSync Era',
  },
}

// ─── Client Cache ────────────────────────────────────────

const publicClients = new Map<string, PublicClient>()

/** Get a cached read-only client for any supported chain. */
export function getPublicClient(chainKey: string): PublicClient {
  const existing = publicClients.get(chainKey)
  if (existing) return existing

  const config = SUPPORTED_CHAINS[chainKey]
  if (!config) throw new Error(`Unknown chain "${chainKey}". Available: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`)

  const client = createPublicClient({ chain: config.chain, transport: http(config.rpc) })
  publicClients.set(chainKey, client)
  return client
}

/** Create a write client for a specific chain + wallet. Not cached (wallet may change). */
export function getWalletClient(chainKey: string, wallet: WalletEntry): WalletClient {
  const config = SUPPORTED_CHAINS[chainKey]
  if (!config) throw new Error(`Unknown chain "${chainKey}". Available: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`)

  return createWalletClient({
    account: getAccount(wallet),
    chain: config.chain,
    transport: http(config.rpc),
  })
}

/** Get explorer URL for a tx on a specific chain. */
export function explorerTxUrl(chainKey: string, hash: string): string {
  const config = SUPPORTED_CHAINS[chainKey]
  return config ? `${config.explorer}/tx/${hash}` : hash
}

/** Get explorer URL for an address on a specific chain. */
export function explorerAddressUrl(chainKey: string, address: string): string {
  const config = SUPPORTED_CHAINS[chainKey]
  return config ? `${config.explorer}/address/${address}` : address
}
