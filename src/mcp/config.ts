/**
 * ./AGNT Protocol — Tempo Chain Configuration
 * All contracts, tokens (stablecoins + memecoins + altcoins), and bridge config.
 */

export const TEMPO_CHAIN = {
  id: 4217,
  name: 'Tempo',
  rpc: 'https://rpc.tempo.xyz',
  ws: 'wss://rpc.tempo.xyz',
  explorer: 'https://explore.tempo.xyz',
} as const

export const CONTRACTS = {
  stablecoinDex: '0xdec0000000000000000000000000000000000000' as `0x${string}`,
  ammRouter: '0x1eeba975efc19794bb3b6f66589894625816d493' as `0x${string}`,
  ammFactory: '0x0c44525860cc5fe8a75f4ead9f1a54e532143bd3' as `0x${string}`,
  feeManager: '0xfeec000000000000000000000000000000000000' as `0x${string}`,
  tip20Factory: '0x20fc000000000000000000000000000000000000' as `0x${string}`,
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' as `0x${string}`,
} as const

export interface TokenInfo {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  type: 'stablecoin' | 'memecoin' | 'altcoin' | 'native'
}

/** All known tokens on Tempo */
export const TOKENS: Record<string, TokenInfo> = {
  // ─── Stablecoins ───
  pathUSD:  { address: '0x20c0000000000000000000000000000000000000', symbol: 'pathUSD', name: 'pathUSD', decimals: 6, type: 'stablecoin' },
  'USDC.e': { address: '0x20C000000000000000000000b9537d11c60E8b50', symbol: 'USDC.e', name: 'USD Coin (Bridged)', decimals: 6, type: 'stablecoin' },
  'EURC.e': { address: '0x20c0000000000000000000001621e21F71CF12fb', symbol: 'EURC.e', name: 'Euro Coin (Bridged)', decimals: 6, type: 'stablecoin' },
  USDT0:    { address: '0x20c00000000000000000000014f22ca97301eb73', symbol: 'USDT0', name: 'Tether USD', decimals: 6, type: 'stablecoin' },
  USDG:     { address: '0x20c0000000000000000000003554d28269e0f3c2', symbol: 'USDG', name: 'Global Dollar', decimals: 6, type: 'stablecoin' },
  frxUSD:   { address: '0x20c0000000000000000000000520792dcccccccc', symbol: 'frxUSD', name: 'Frax USD', decimals: 6, type: 'stablecoin' },
  cUSD:     { address: '0x20c0000000000000000000008ee4fcff88888888', symbol: 'cUSD', name: 'Coinbase USD', decimals: 6, type: 'stablecoin' },
  PYUSD:    { address: '0x20c0000000000000000000005c0bac7cef389a11', symbol: 'PYUSD', name: 'PayPal USD', decimals: 6, type: 'stablecoin' },
  // ─── Altcoins / Ecosystem ───
  wBTC:     { address: '0x20c000000000000000000000774254430000b1c0', symbol: 'wBTC', name: 'Wrapped Bitcoin', decimals: 8, type: 'altcoin' },
  // ─── Memecoins (example placeholders — real ones come from on-chain discovery) ───
  AGNT:     { address: '0x20c0000000000000000000004147e7000000a917', symbol: 'AGNT', name: './AGNT Token', decimals: 18, type: 'memecoin' },
}

export const STARGATE = {
  usdcPool: '0x8c76e2F6C5ceDA9AA7772e7efF30280226c44392' as `0x${string}`,
  eurcPool: '0x7753Dc8d4bd48Db599Da21E08b1Ab1D6FDFfdC71' as `0x${string}`,
  lzEndpoint: '0x20Bb7C2E2f4e5ca2B4c57060d1aE2615245dCc9C' as `0x${string}`,
  tempoEid: 30410,
} as const

export const CHAIN_EIDS: Record<string, { eid: number; name: string }> = {
  ethereum:  { eid: 30101, name: 'Ethereum' },
  arbitrum:  { eid: 30110, name: 'Arbitrum' },
  base:      { eid: 30184, name: 'Base' },
  optimism:  { eid: 30111, name: 'Optimism' },
  polygon:   { eid: 30109, name: 'Polygon' },
  avalanche: { eid: 30106, name: 'Avalanche' },
}

export const DEFAULT_SLIPPAGE = 0.005
export const DEX_FEE_BPS = 5 // 0.05% fee on Tempo DEX
