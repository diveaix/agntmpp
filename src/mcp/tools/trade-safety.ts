const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const CHAIN_IDS: Record<string, string> = {
  ethereum: '1',
  arbitrum: '42161',
  base: '8453',
  optimism: '10',
  polygon: '137',
  avalanche: '43114',
  bsc: '56',
}

const DS_CHAIN_IDS: Record<string, string> = {
  ethereum: 'ethereum',
  arbitrum: 'arbitrum',
  base: 'base',
  optimism: 'optimism',
  polygon: 'polygon',
  avalanche: 'avalanche',
  bsc: 'bsc',
}

export interface DexPairLike {
  chainId: string
  dexId: string
  pairAddress: string
  url?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  baseToken?: { symbol?: string; address?: string }
  quoteToken?: { symbol?: string; address?: string }
}

export interface LiquidityPolicy {
  minLiquidityUsd: number
  minVolume24hUsd: number
}

export interface TradeSafetyAssessment {
  blocked: boolean
  token?: string
  tokenName?: string
  tokenSymbol?: string
  liquidityUsd: number
  volume24hUsd: number
  pairCount: number
  topPair?: DexPairLike
  warnings: string[]
}

const DEFAULT_POLICY: LiquidityPolicy = {
  minLiquidityUsd: 25_000,
  minVolume24hUsd: 2_500,
}

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function isAddress(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

function isNativeToken(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === ZERO_ADDRESS || normalized === 'eth' || normalized === 'native'
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

function sortPairsByLiquidity(pairs: DexPairLike[]): DexPairLike[] {
  return [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
}

export function assessLiquidityFromPairs(
  pairs: DexPairLike[],
  policy: LiquidityPolicy = DEFAULT_POLICY,
): TradeSafetyAssessment {
  const sortedPairs = sortPairsByLiquidity(pairs)
  const topPair = sortedPairs[0]
  const liquidityUsd = topPair?.liquidity?.usd || 0
  const volume24hUsd = topPair?.volume?.h24 || 0
  const warnings: string[] = []

  if (!topPair) {
    warnings.push('No active DEX liquidity pool was found for this token on the selected chain.')
  } else {
    if (liquidityUsd < policy.minLiquidityUsd) {
      warnings.push(`Low liquidity: ${usd(liquidityUsd)} available in the top pool. Trades may have high slippage or poor execution.`)
    }
    if (volume24hUsd < policy.minVolume24hUsd) {
      warnings.push(`Low 24h volume: ${usd(volume24hUsd)} traded in the top pool. Exiting this token may be difficult.`)
    }
  }

  return {
    blocked: false,
    liquidityUsd,
    volume24hUsd,
    pairCount: pairs.length,
    topPair,
    warnings,
  }
}

export function formatTradeSafetyNotice(assessment: TradeSafetyAssessment): string {
  const symbol = assessment.tokenSymbol || assessment.token || 'Token'
  const lines = [`Pre-trade Token Check — ${symbol}`]
  lines.push(`Liquidity: ${usd(assessment.liquidityUsd)}${assessment.pairCount ? ` across ${assessment.pairCount} pool(s)` : ''}`)
  lines.push(`24h Volume: ${usd(assessment.volume24hUsd)}`)

  if (assessment.topPair) {
    const base = assessment.topPair.baseToken?.symbol || '?'
    const quote = assessment.topPair.quoteToken?.symbol || '?'
    lines.push(`Top Pool: ${base}/${quote} on ${assessment.topPair.dexId}`)
  }

  if (assessment.warnings.length) {
    lines.push('Warnings:')
    for (const warning of assessment.warnings) lines.push(`- ${warning}`)
    lines.push('User choice: trade is not blocked by liquidity warnings.')
  }

  return lines.join('\n')
}

async function fetchDexPairs(chain: string, token: string): Promise<DexPairLike[]> {
  const dsChain = DS_CHAIN_IDS[chain] || chain

  try {
    const direct = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${dsChain}/${token}`) as DexPairLike[]
    if (Array.isArray(direct)) return direct.filter((p) => p.chainId === dsChain)
  } catch {
    // Fall through to the broader endpoint; DexScreener has a few chain-specific quirks.
  }

  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`) as { pairs?: DexPairLike[] }
  return (data.pairs || []).filter((p) => p.chainId === dsChain)
}

async function fetchSecurityWarnings(chain: string, token: string): Promise<{ name?: string; symbol?: string; warnings: string[] }> {
  const chainId = CHAIN_IDS[chain]
  if (!chainId) return { warnings: [] }

  try {
    const data = await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${token}`) as {
      result?: Record<string, {
        token_name?: string
        token_symbol?: string
        is_honeypot?: string
        cannot_sell_all?: string
        buy_tax?: string
        sell_tax?: string
        is_open_source?: string
        is_proxy?: string
        is_mintable?: string
        owner_address?: string
        lp_holder_count?: string
      }>
    }
    const info = data.result?.[token.toLowerCase()] || Object.values(data.result || {})[0]
    if (!info) return { warnings: ['Token was not found in the GoPlus security database.'] }

    const warnings: string[] = []
    const buyTax = parseFloat(info.buy_tax || '0') * 100
    const sellTax = parseFloat(info.sell_tax || '0') * 100

    if (info.is_honeypot === '1') warnings.push('Security risk: GoPlus flags this token as a honeypot.')
    if (info.cannot_sell_all === '1') warnings.push('Security risk: GoPlus says holders may be unable to sell all tokens.')
    if (sellTax > 10) warnings.push(`High sell tax: ${sellTax.toFixed(1)}%.`)
    if (buyTax > 10) warnings.push(`High buy tax: ${buyTax.toFixed(1)}%.`)
    if (info.is_open_source === '0') warnings.push('Contract source is not verified/open source.')
    if (info.is_proxy === '1' && info.is_open_source !== '1') warnings.push('Unverified proxy contract: implementation can be upgraded and source is not verified.')
    if (info.is_mintable === '1' && info.is_open_source !== '1') warnings.push('Unverified mintable token: supply can increase.')
    if (info.lp_holder_count === '0') warnings.push('No LP holders reported by GoPlus; liquidity lock status may be unclear.')

    return { name: info.token_name, symbol: info.token_symbol, warnings }
  } catch {
    return { warnings: ['Security API check was unavailable; review contract risk manually.'] }
  }
}

export async function assessTokenTradeSafety(
  chain: string,
  token: string,
  policy: LiquidityPolicy = DEFAULT_POLICY,
): Promise<TradeSafetyAssessment | null> {
  if (!token || isNativeToken(token) || !isAddress(token)) return null

  const [pairs, security] = await Promise.all([
    fetchDexPairs(chain, token),
    fetchSecurityWarnings(chain, token),
  ])
  const liquidity = assessLiquidityFromPairs(pairs, policy)

  return {
    ...liquidity,
    token,
    tokenName: security.name,
    tokenSymbol: security.symbol || liquidity.topPair?.baseToken?.symbol,
    warnings: [...security.warnings, ...liquidity.warnings],
  }
}

export async function buildTradeSafetyNotice(chain: string, tokens: string[]): Promise<string> {
  const uniqueTokens = [...new Set(tokens.map((t) => t?.trim()).filter(Boolean))]
  const assessments = await Promise.all(uniqueTokens.map((token) => assessTokenTradeSafety(chain, token)))
  const notices = assessments
    .filter((assessment): assessment is TradeSafetyAssessment => !!assessment && (assessment.warnings.length > 0 || assessment.pairCount > 0))
    .map(formatTradeSafetyNotice)

  return notices.length ? `${notices.join('\n\n')}\n\n` : ''
}
