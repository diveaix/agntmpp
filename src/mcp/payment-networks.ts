export type EvmPaymentNetworkId = 'tempo' | 'base' | 'optimism' | 'arbitrum' | 'polygon' | 'ethereum'
export type PaymentNetworkId = EvmPaymentNetworkId | 'solana'

export interface EvmPaymentNetwork {
  id: EvmPaymentNetworkId
  label: string
  network: string
  chainId: number
  chainName: string
  currency: string
  tokenDecimals: number
  rpcUrl: string
  blockExplorerUrls: string[]
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
  recipient: string
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const defaults: Record<EvmPaymentNetworkId, Omit<EvmPaymentNetwork, 'recipient' | 'rpcUrl' | 'currency' | 'tokenDecimals'>> = {
  tempo: {
    id: 'tempo',
    label: 'Tempo',
    network: 'tempo',
    chainId: 6342,
    chainName: 'Tempo',
    blockExplorerUrls: ['https://tempo.xyz'],
    nativeCurrency: { name: 'Tempo ETH', symbol: 'ETH', decimals: 18 },
  },
  base: {
    id: 'base',
    label: 'Base',
    network: 'base',
    chainId: 8453,
    chainName: 'Base',
    blockExplorerUrls: ['https://basescan.org'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  optimism: {
    id: 'optimism',
    label: 'Optimism',
    network: 'optimism',
    chainId: 10,
    chainName: 'OP Mainnet',
    blockExplorerUrls: ['https://optimistic.etherscan.io'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum',
    network: 'arbitrum',
    chainId: 42161,
    chainName: 'Arbitrum One',
    blockExplorerUrls: ['https://arbiscan.io'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  polygon: {
    id: 'polygon',
    label: 'Polygon',
    network: 'polygon',
    chainId: 137,
    chainName: 'Polygon',
    blockExplorerUrls: ['https://polygonscan.com'],
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  },
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    network: 'ethereum',
    chainId: 1,
    chainName: 'Ethereum',
    blockExplorerUrls: ['https://etherscan.io'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
}

const defaultCurrency: Record<EvmPaymentNetworkId, string> = {
  tempo: '0x20C000000000000000000000b9537d11c60E8b50',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x3c499c542cef5e3811E1192ce70d8cC03d5c3359',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
}

const defaultRpc: Record<EvmPaymentNetworkId, string> = {
  tempo: 'https://rpc.tempo.xyz',
  base: 'https://mainnet.base.org',
  optimism: 'https://mainnet.optimism.io',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  polygon: 'https://polygon-rpc.com',
  ethereum: 'https://ethereum.publicnode.com',
}

function envKey(id: EvmPaymentNetworkId, suffix: string): string {
  return `AGNT_${id.toUpperCase()}_${suffix}`
}

function pickEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

export function normalizePaymentNetwork(value: unknown): PaymentNetworkId {
  if (value === 'base' || value === 'optimism' || value === 'arbitrum' || value === 'polygon' || value === 'ethereum' || value === 'solana') return value
  return 'tempo'
}

export function getEvmPaymentNetwork(value: unknown): EvmPaymentNetwork {
  const id = normalizePaymentNetwork(value)
  if (id === 'solana') {
    throw new Error('Solana payments need SPL-token transaction building and verification. Use Base or another EVM network for now.')
  }
  const base = defaults[id]
  const recipient = pickEnv(envKey(id, 'RECIPIENT'), 'AGNT_EVM_RECIPIENT', 'AGNT_RECIPIENT') || ZERO_ADDRESS
  return {
    ...base,
    recipient,
    currency: pickEnv(envKey(id, 'PAYMENT_CURRENCY'), envKey(id, 'USDC'), id === 'tempo' ? 'AGNT_PAYMENT_CURRENCY' : '', id === 'tempo' ? 'CRYPTO_ACCESS_CURRENCY' : '') || defaultCurrency[id],
    tokenDecimals: Number(pickEnv(envKey(id, 'TOKEN_DECIMALS'), 'CRYPTO_ACCESS_TOKEN_DECIMALS') || 6),
    rpcUrl: pickEnv(envKey(id, 'RPC_URL'), `${id.toUpperCase()}_RPC_URL`, id === 'tempo' ? 'CRYPTO_ACCESS_RPC_URL' : '', id === 'tempo' ? 'TEMPO_RPC_URL' : '') || defaultRpc[id],
  }
}

export function getPaymentNetworkForQuote(network: string | undefined, chainId: number | undefined): EvmPaymentNetwork {
  const byName = normalizePaymentNetwork(network)
  if (byName !== 'solana') return getEvmPaymentNetwork(byName)
  const match = (Object.keys(defaults) as EvmPaymentNetworkId[]).find((id) => defaults[id].chainId === chainId)
  return getEvmPaymentNetwork(match || 'tempo')
}

export function listPublicPaymentNetworks(): EvmPaymentNetwork[] {
  return (['base', 'tempo', 'optimism', 'arbitrum', 'polygon', 'ethereum'] satisfies EvmPaymentNetworkId[]).map(getEvmPaymentNetwork)
}

export function recipientIsConfigured(recipient: string): boolean {
  const normalized = recipient.trim().toLowerCase()
  return Boolean(normalized) && normalized !== ZERO_ADDRESS
}
