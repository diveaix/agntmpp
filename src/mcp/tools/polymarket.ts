/**
 * ./AGNT Protocol — Polymarket Trading (CLOB v2) — Full Suite
 * 
 * Real trading via @polymarket/clob-client-v2 on Polygon.
 * Features: buy, sell, search, positions, P&L, orderbook, stop-loss,
 *           take-profit, DCA-on-dip, auto-approve, redeem winnings.
 */

import type { ToolModule } from './index.js'
import { ClobClient, Side, OrderType, type TickSize } from '@polymarket/clob-client-v2'
import { createWalletClient, createPublicClient, http, parseAbi, encodeFunctionData, formatUnits, maxUint256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { getActiveWallet } from '../wallet.js'
import { SUPPORTED_CHAINS } from '../chains.js'
import {
  calculateLimitBuySize,
  formatPolymarketSetupGuide,
  getPolymarketSetupBlocker,
  isPolymarketSetupGuideQuery,
  parsePolymarketOrderMode,
  resolvePolymarketExecutionPrice,
  type PolymarketSetupStatus,
} from './polymarket-helpers.js'

const HOST = 'https://clob.polymarket.com'
const CHAIN_ID = 137
const GAMMA_API = 'https://gamma-api.polymarket.com'
const POLYGON_RPC = process.env.AGNT_POLYGON_RPC_URL || SUPPORTED_CHAINS.polygon.rpc
const PUSD_POLYGON = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'
const CTF_EXCHANGE = '0xE111180000d2663C0091e4f400237545B87B996B'
const NEG_RISK_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59'

const PUSD_SPENDERS = [
  { label: 'Conditional Tokens', address: CONDITIONAL_TOKENS },
  { label: 'CTF Exchange V2', address: CTF_EXCHANGE },
  { label: 'Neg Risk Exchange V2', address: NEG_RISK_EXCHANGE },
] as const

const OUTCOME_TOKEN_OPERATORS = [
  { label: 'CTF Exchange V2', address: CTF_EXCHANGE },
  { label: 'Neg Risk Exchange V2', address: NEG_RISK_EXCHANGE },
] as const

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

const erc1155Abi = parseAbi([
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
])

// ─── Client singleton ────────────────────────────────────

let _client: ClobClient | null = null
let _clientAddr: string | null = null

async function getClient(): Promise<ClobClient> {
  const w = getActiveWallet()
  if (!w) throw new Error('No active wallet. Create one with the wallet tool first.')
  if (_client && _clientAddr === w.address) return _client

  const account = privateKeyToAccount(w.privateKey as `0x${string}`)
  const signer = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) })

  const k = process.env.AGNT_POLYMARKET_KEY
  const s = process.env.AGNT_POLYMARKET_SECRET
  const p = process.env.AGNT_POLYMARKET_PASSPHRASE
  let creds: { key: string; secret: string; passphrase: string }

  if (k && s && p) {
    creds = { key: k, secret: s, passphrase: p }
  } else {
    const tmp = new ClobClient({ host: HOST, chain: CHAIN_ID, signer })
    creds = await tmp.createOrDeriveApiKey()
  }

  _client = new ClobClient({
    host: HOST, chain: CHAIN_ID, signer, creds,
    signatureType: 0, funderAddress: account.address,
  })
  _clientAddr = w.address
  return _client
}

// ─── Helpers ─────────────────────────────────────────────

async function gammaGet(path: string): Promise<unknown> {
  const res = await fetch(`${GAMMA_API}${path}`)
  if (!res.ok) throw new Error(`Gamma API ${res.status}`)
  return res.json()
}

async function gammaGetOptional<T>(path: string, fallback: T): Promise<T> {
  try {
    return await gammaGet(path) as T
  } catch {
    return fallback
  }
}

function parseJsonArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseUrl(input: string): { slug: string; pageType?: 'event' | 'market' } {
  try {
    const u = new URL(input)
    if (u.hostname.includes('polymarket.com')) {
      const parts = u.pathname.split('/').filter(Boolean)
      const pageType = parts[0] === 'event' || parts[0] === 'market' ? parts[0] : undefined
      return { slug: parts[parts.length - 1], pageType }
    }
  } catch { /* not a URL */ }
  return { slug: input.trim() }
}

interface MarketInfo {
  id: string; question: string; tokenId: string; noTokenId: string
  negRisk: boolean; yesPrice: number; noPrice: number
  volume: number; liquidity: number; tickSize: TickSize
  endDate: string; resolved: boolean; outcomes: string[]
}

interface ResolveMarketOptions {
  date?: string
  hint?: string
}

class PolymarketEventSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolymarketEventSelectionError'
  }
}

function normalizeText(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function searchScore(market: any, hints: string[]): number {
  const haystack = normalizeText(`${market.question || ''} ${market.title || ''} ${market.slug || ''}`)
  let score = 0
  for (const hint of hints.map(normalizeText).filter(Boolean)) {
    const words = hint.split(/\s+/).filter(w => w.length > 1)
    for (const word of words) if (haystack.includes(word)) score += 1
    if (hint && haystack.includes(hint)) score += 6
  }
  return score
}

function formatMarketChoice(market: any): string {
  const info = fmt(market)
  return `  - ${info.question} | YES ${(info.yesPrice * 100).toFixed(1)}c / NO ${(info.noPrice * 100).toFixed(1)}c | Vol $${info.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ID ${info.id} | slug ${market.slug || 'n/a'}`
}

function selectEventMarket(event: any, input: string, opts: ResolveMarketOptions): MarketInfo {
  const markets = (event?.markets || [])
    .filter((m: any) => !m.closed && m.active !== false)
    .filter((m: any) => parseJsonArray(m.clobTokenIds).length >= 2)

  if (!markets.length) throw new Error(`No tradable child markets found for event: "${input}"`)
  if (markets.length === 1) return fmt(markets[0])

  const hints = [opts.date, opts.hint].filter((v): v is string => Boolean(v))
  if (hints.length) {
    const ranked = markets
      .map((market: any) => ({ market, score: searchScore(market, hints) }))
      .sort((a: any, b: any) => b.score - a.score)
    if (ranked[0]?.score > 0 && ranked[0].score > (ranked[1]?.score || 0)) return fmt(ranked[0].market)
  }

  throw new PolymarketEventSelectionError(
    `That Polymarket event has multiple tradable markets. Pick one by passing a date/hint, for example date="June 30, 2026", or use one of these market IDs:\n\n` +
    markets.map(formatMarketChoice).join('\n')
  )
}

async function resolveMarket(input: string, opts: ResolveMarketOptions = {}): Promise<MarketInfo> {
  const parsed = parseUrl(input)
  const slug = parsed.slug

  // Try direct ID
  if (parsed.pageType !== 'event') {
    try {
      const m = await gammaGet(`/markets/${slug}`) as any
      if (m?.id) return fmt(m)
    } catch { /* search */ }
  }

  // Search by slug
  try {
    const r = await gammaGet(`/markets?slug=${slug}&limit=1`) as any[]
    if (r?.length) return fmt(r[0])
  } catch { /* text search */ }

  // Event pages often contain several child markets. Resolve those instead of
  // forcing users to know Polymarket's hidden child market IDs.
  const events = await gammaGetOptional<any[]>(`/events?slug=${encodeURIComponent(slug)}&limit=1`, [])
  if (events?.length) return selectEventMarket(events[0], input, opts)

  const search = await gammaGetOptional<any>(`/public-search?q=${encodeURIComponent(slug)}&limit_per_type=10&events_status=active`, {})
  const searchedMarkets = [
    ...(search?.markets || []),
    ...(search?.events || []).flatMap((event: any) => (event?.markets || []).map((market: any) => ({ ...market, eventTitle: event.title || event.question }))),
  ].filter((m: any) => m?.id && !m.closed && m.active !== false)
  if (searchedMarkets.length) {
    const ranked = searchedMarkets
      .map((market: any) => ({ market, score: searchScore(market, [slug, opts.date, opts.hint].filter(Boolean) as string[]) }))
      .sort((a: any, b: any) => b.score - a.score)
    if (ranked[0]?.score > 0) return fmt(ranked[0].market)
  }

  // Text search fallback
  const [marketMatches, eventMatches, topMarkets] = await Promise.all([
    gammaGetOptional<any[]>(`/markets?search=${encodeURIComponent(slug)}&limit=20&active=true&closed=false`, []),
    gammaGetOptional<any[]>(`/events?search=${encodeURIComponent(slug)}&limit=10&active=true&closed=false`, []),
    gammaGetOptional<any[]>(`/markets?limit=100&active=true&closed=false&order=volume&ascending=false`, []),
  ])
  const directMatch = [...marketMatches, ...topMarkets].find((m: any) =>
    normalizeText(m.question).includes(normalizeText(slug)) || m.id === slug
  )
  if (directMatch) return fmt(directMatch)
  if (eventMatches?.length) return selectEventMarket(eventMatches[0], input, opts)
  throw new Error(`Market not found: "${input}"`)
}

function fmt(m: any): MarketInfo {
  const prices = parseJsonArray(m.outcomePrices)
  const tokens = parseJsonArray(m.clobTokenIds)
  const outcomes = parseJsonArray(m.outcomes)
  return {
    id: m.id || m.condition_id, question: m.question || 'Unknown',
    tokenId: tokens[0] || '', noTokenId: tokens[1] || '',
    negRisk: m.negRisk || false,
    yesPrice: parseFloat(prices[0] || '0.5'), noPrice: parseFloat(prices[1] || '0.5'),
    volume: parseFloat(m.volume || '0'), liquidity: parseFloat(m.liquidity || '0'),
    tickSize: (m.minimumTickSize || '0.01') as TickSize,
    endDate: m.endDate || '', resolved: m.resolved || false, outcomes: outcomes.length ? outcomes : ['Yes', 'No'],
  }
}

function getPolygonWallet() {
  const w = getActiveWallet()
  if (!w) throw new Error('No active wallet. Create one with the wallet tool first.')
  const account = privateKeyToAccount(w.privateKey as `0x${string}`)
  const pub = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) })
  const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) })
  return { w, account, pub, wallet }
}

async function getReadiness() {
  const { w, account, pub } = getPolygonWallet()
  const [pusdBalance, polBalance, pusdAllowances, outcomeApprovals] = await Promise.all([
    pub.readContract({ address: PUSD_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    pub.getBalance({ address: account.address }),
    Promise.all(PUSD_SPENDERS.map(async spender => ({
      ...spender,
      allowance: await pub.readContract({
        address: PUSD_POLYGON as `0x${string}`,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, spender.address as `0x${string}`],
      }) as bigint,
    }))),
    Promise.all(OUTCOME_TOKEN_OPERATORS.map(async operator => ({
      ...operator,
      approved: await pub.readContract({
        address: CONDITIONAL_TOKENS as `0x${string}`,
        abi: erc1155Abi,
        functionName: 'isApprovedForAll',
        args: [account.address, operator.address as `0x${string}`],
      }) as boolean,
    }))),
  ])

  return {
    wallet: w,
    address: account.address,
    pusdBalance,
    polBalance,
    pusdAllowances,
    outcomeApprovals,
    collateralReady: pusdAllowances.every(item => item.allowance >= BigInt(1e12)),
    outcomeTokensReady: outcomeApprovals.every(item => item.approved),
  }
}

export async function getPolymarketSetupStatus(requiredPusd?: number): Promise<PolymarketSetupStatus> {
  try {
    const readiness = await getReadiness()
    return {
      hasWallet: true,
      walletName: readiness.wallet.name,
      address: readiness.address,
      pusdBalance: formatUnits(readiness.pusdBalance, 6),
      requiredPusd,
      polBalance: formatUnits(readiness.polBalance, 18),
      collateralReady: readiness.collateralReady,
      outcomeTokensReady: readiness.outcomeTokensReady,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('No active wallet')) return { hasWallet: false, requiredPusd }
    throw e
  }
}

async function getSetupGuideIfBlocked(action: string, requiredPusd?: number): Promise<string | null> {
  const status = await getPolymarketSetupStatus(requiredPusd)
  const blocker = getPolymarketSetupBlocker(action, status)
  if (!blocker) return null
  return formatPolymarketSetupGuide(status, blocker)
}

// ─── Auto-approve Polygon USDC and outcome tokens ──────────

async function ensureApproval(): Promise<string> {
  const { account, pub, wallet } = getPolygonWallet()
  const approvals: string[] = []

  for (const spender of PUSD_SPENDERS) {
    const allowance = await pub.readContract({
      address: PUSD_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'allowance',
      args: [account.address, spender.address as `0x${string}`],
    })
    if ((allowance as bigint) < BigInt(1e12)) {
      const hash = await wallet.sendTransaction({
        to: PUSD_POLYGON as `0x${string}`,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender.address as `0x${string}`, maxUint256] }),
      })
      await pub.waitForTransactionReceipt({ hash })
      approvals.push(`Approved Polygon USDC for ${spender.label} (tx: ${hash.slice(0, 14)}...)`)
    }
  }

  for (const operator of OUTCOME_TOKEN_OPERATORS) {
    const approved = await pub.readContract({
      address: CONDITIONAL_TOKENS as `0x${string}`, abi: erc1155Abi, functionName: 'isApprovedForAll',
      args: [account.address, operator.address as `0x${string}`],
    })
    if (!approved) {
      const hash = await wallet.sendTransaction({
        to: CONDITIONAL_TOKENS as `0x${string}`,
        data: encodeFunctionData({ abi: erc1155Abi, functionName: 'setApprovalForAll', args: [operator.address as `0x${string}`, true] }),
      })
      await pub.waitForTransactionReceipt({ hash })
      approvals.push(`Approved outcome tokens for ${operator.label} (tx: ${hash.slice(0, 14)}...)`)
    }
  }
  return approvals.length ? approvals.join('\n') : 'Polygon USDC and outcome-token approvals are already ready'
}

// ─── Tool Definition ─────────────────────────────────────

const TOOLS = [
  {
    name: 'polymarket',
    description: 'Full Polymarket trading suite. Search, buy/sell, stop-loss, take-profit, copy trading, batch orders, correlations, win/loss history, portfolio heatmap, and more. Accepts market URLs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'markets', 'market', 'setup', 'guide', 'help', 'balance', 'withdraw', 'buy', 'sell', 'positions', 'pnl', 'orders', 'cancel', 'orderbook', 'approve', 'stop_loss', 'take_profit', 'redeem', 'copy_trade', 'batch_buy', 'correlations', 'history', 'heatmap'],
          description: 'Action to perform',
        },
        query: { type: 'string', description: 'Search query (for search, correlations)' },
        marketUrl: { type: 'string', description: 'Polymarket URL, slug, or ID' },
        marketId: { type: 'string', description: 'Market ID (alternative to marketUrl)' },
        date: { type: 'string', description: 'Date or deadline hint for event pages with multiple child markets. Example: June 30, 2026' },
        marketHint: { type: 'string', description: 'Plain-English child market hint for event pages. Example: June 30 one' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome to trade' },
        amount: { type: 'number', description: 'Polygon USDC to spend (buy) or shares to sell (sell)' },
        destination: { type: 'string', description: 'Destination address for withdrawal guidance' },
        toAddress: { type: 'string', description: 'Destination address for withdrawal guidance' },
        price: { type: 'number', description: 'Limit price 0.01-0.99. Omit for market price.' },
        mode: { type: 'string', enum: ['limit', 'market_fok', 'market_fak'], description: 'Execution mode. limit rests a GTC order. market_fok fills all or cancels. market_fak fills available shares and cancels the rest.' },
        maxPrice: { type: 'number', description: 'Worst acceptable price for market buys (0.01-0.99).' },
        minPrice: { type: 'number', description: 'Worst acceptable price for market sells (0.01-0.99).' },
        percent: { type: 'number', description: 'Sell this % of position (for sell). E.g. 50 = half.' },
        stopPrice: { type: 'number', description: 'Trigger price for stop-loss/take-profit (0.01-0.99)' },
        orderId: { type: 'string', description: 'Order ID (for cancel)' },
        sortBy: { type: 'string', enum: ['volume', 'liquidity', 'newest'], description: 'Sort (for markets)' },
        limit: { type: 'number', description: 'Max results. Default: 10' },
        trader: { type: 'string', description: 'Trader wallet address or Polymarket profile URL (for copy_trade)' },
        maxPerTrade: { type: 'number', description: 'Max Polygon USDC per copied trade (for copy_trade). Default: 10' },
        marketIds: { type: 'string', description: 'Comma-separated market IDs (for batch_buy)' },
      },
      required: ['action'],
    },
  },
]

// ─── Handler ─────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name !== 'polymarket') return null

  try {
    switch (args.action as string) {

      // ── Search by text ───────────────────────────────
      case 'search': {
        if (!args.query) return err('Provide a search query')
        if (isPolymarketSetupGuideQuery(args.query)) {
          const status = await getPolymarketSetupStatus()
          const blocker = getPolymarketSetupBlocker('approve', status)
          return text(formatPolymarketSetupGuide(status, blocker))
        }
        const q = args.query as string
        const limit = Math.min((args.limit as number) || 10, 20)

        const [searchResults, marketResults, eventResults, fallbackMarkets] = await Promise.all([
          gammaGetOptional<any>(`/public-search?q=${encodeURIComponent(q)}&limit_per_type=20&events_status=active`, {}),
          gammaGetOptional<any[]>(`/markets?search=${encodeURIComponent(q)}&limit=50&active=true&closed=false`, []),
          gammaGetOptional<any[]>(`/events?search=${encodeURIComponent(q)}&limit=20&active=true&closed=false`, []),
          gammaGetOptional<any[]>(`/markets?limit=100&active=true&closed=false&order=volume&ascending=false`, []),
        ])

        const byId = new Map<string, any>()
        for (const m of searchResults?.markets || []) if (m?.id) byId.set(String(m.id), m)
        for (const event of searchResults?.events || []) {
          for (const m of event?.markets || []) {
            if (m?.id && !m.closed && m.active !== false) byId.set(String(m.id), { ...m, eventTitle: event.title || event.question })
          }
        }
        for (const m of marketResults) if (m?.id) byId.set(String(m.id), m)
        for (const event of eventResults) {
          for (const m of event?.markets || []) {
            if (m?.id && !m.closed && m.active !== false) byId.set(String(m.id), { ...m, eventTitle: event.title || event.question })
          }
        }
        const normalizedQuery = normalizeText(q)
        for (const m of fallbackMarkets) {
          if (m?.id && normalizeText(m.question).includes(normalizedQuery)) byId.set(String(m.id), m)
        }

        const matches = [...byId.values()]
          .filter((m: any) => searchScore(m, [q]) > 0)
          .sort((a: any, b: any) => parseFloat(b.volume || '0') - parseFloat(a.volume || '0'))
          .slice(0, limit)

        if (!matches.length) return text(`No markets found for "${args.query}"`)

        const lines: string[] = [`🔍 Search: "${args.query}" (${matches.length} results)\n`]
        for (const m of matches) {
          const p = m.outcomePrices ? JSON.parse(m.outcomePrices) : []
          const yes = p[0] ? (parseFloat(p[0]) * 100).toFixed(0) : '?'
          const vol = parseFloat(m.volume || '0')
          lines.push(`  ${m.question?.slice(0, 70)}`)
          lines.push(`    YES: ${yes}¢ | Vol: $${(vol / 1e6).toFixed(1)}M | ID: ${m.id}`)
          lines.push('')
        }
        return text(lines.join('\n'))
      }

      // ── Browse markets ───────────────────────────────
      case 'markets': {
        const sortBy = (args.sortBy as string) || 'volume'
        const limit = Math.min((args.limit as number) || 10, 20)
        const data = await gammaGet(`/markets?limit=${limit}&active=true&closed=false&order=${sortBy}&ascending=false`) as any[]
        if (!data?.length) return text('No active markets.')

        const lines: string[] = ['📊 Polymarket — Active Markets\n']
        for (const m of data.slice(0, limit)) {
          const p = m.outcomePrices ? JSON.parse(m.outcomePrices) : []
          const yes = p[0] ? (parseFloat(p[0]) * 100).toFixed(0) : '?'
          const no = p[1] ? (parseFloat(p[1]) * 100).toFixed(0) : '?'
          lines.push(`  ${m.question?.slice(0, 70)}`)
          lines.push(`    YES: ${yes}¢ | NO: ${no}¢ | Vol: $${(parseFloat(m.volume || '0') / 1e6).toFixed(1)}M`)
          lines.push(`    ID: ${m.id}\n`)
        }
        return text(lines.join('\n'))
      }

      // ── Market detail ────────────────────────────────
      case 'market': {
        const input = (args.marketUrl || args.marketId) as string
        if (!input) return err('Provide marketUrl or marketId')
        const m = await resolveMarket(input, {
          date: args.date as string | undefined,
          hint: args.marketHint as string | undefined,
        })
        return text(
          `📊 ${m.question}\n\n` +
          `YES: ${(m.yesPrice * 100).toFixed(1)}¢  |  NO: ${(m.noPrice * 100).toFixed(1)}¢\n` +
          `Volume: $${(m.volume / 1e6).toFixed(2)}M  |  Liquidity: $${(m.liquidity / 1e3).toFixed(0)}K\n` +
          `End Date: ${m.endDate?.slice(0, 10) || 'TBD'}\n` +
          `Resolved: ${m.resolved}  |  Neg Risk: ${m.negRisk}\n` +
          `Tick Size: ${m.tickSize}\n` +
          `Market ID: ${m.id}\n` +
          `YES Token: ${m.tokenId.slice(0, 20)}...\n` +
          `NO Token: ${m.noTokenId.slice(0, 20)}...`
        )
      }

      // ── First-time setup guide ────────────────────────
      case 'setup':
      case 'guide':
      case 'help': {
        const status = await getPolymarketSetupStatus()
        const blocker = getPolymarketSetupBlocker('approve', status)
        return text(formatPolymarketSetupGuide(status, blocker))
      }

      // ── Balance / readiness ──────────────────────────
      case 'balance': {
        const setupGuide = await getSetupGuideIfBlocked('balance')
        if (setupGuide) return text(setupGuide)

        const readiness = await getReadiness()
        const client = await getClient()
        const openOrders = await client.getOpenOrders().catch(() => [])
        const ready = readiness.collateralReady && readiness.outcomeTokensReady
        const polygonUsdcPermissions = [
          { label: 'Position setup permission', ready: readiness.pusdAllowances[0]?.allowance >= BigInt(1e12) },
          { label: 'Buy regular markets', ready: readiness.pusdAllowances[1]?.allowance >= BigInt(1e12) },
          { label: 'Buy neg-risk markets', ready: readiness.pusdAllowances[2]?.allowance >= BigInt(1e12) },
        ]
        const outcomeTokenPermissions = [
          { label: 'Sell regular markets', ready: readiness.outcomeApprovals[0]?.approved },
          { label: 'Sell neg-risk markets', ready: readiness.outcomeApprovals[1]?.approved },
        ]
        const polygonUsdcPermissionLines = polygonUsdcPermissions
          .map(item => `  ${item.label}: ${item.ready ? 'Ready' : 'Needs approval'}`)
          .join('\n')
        const outcomePermissionLines = outcomeTokenPermissions
          .map(item => `  ${item.label}: ${item.ready ? 'Ready' : 'Needs approval'}`)
          .join('\n')

        return text(
          `Polymarket Readiness\n\n` +
          `Wallet: ${readiness.wallet.name} (${readiness.address})\n` +
          `Network: Polygon\n` +
          `Polygon USDC: ${formatUnits(readiness.pusdBalance, 6)}\n` +
          `POL: ${formatUnits(readiness.polBalance, 18)}\n` +
          `Open Orders: ${openOrders.length}\n\n` +
          `Polygon USDC Permissions:\n${polygonUsdcPermissionLines}\n\n` +
          `Share Selling Permissions:\n${outcomePermissionLines}\n\n` +
          `${ready ? 'Ready to place buy and sell orders.' : 'Run polymarket action=setup for first-time setup, then action=approve before trading.'}\n` +
          `Note: approval is a one-time wallet permission. It uses POL gas, but normal buy/sell order placement does not use wallet gas after setup.`
        )
      }

      case 'withdraw': {
        const w = getActiveWallet()
        const amount = args.amount as number | undefined
        const destination = (args.destination || args.toAddress) as string | undefined
        const lines = ['Withdraw from Polymarket', '']

        if (w) lines.push(`Wallet: ${w.name} (${w.address})`)
        if (amount !== undefined) lines.push(`Amount: ${amount} Polygon USDC`)
        if (destination) lines.push(`Recipient: ${destination}`)
        if (w || amount !== undefined || destination) lines.push('')

        lines.push(
          'What happens:',
          '  Polymarket withdrawals send Polygon USDC to a wallet or exchange address you choose.',
          '  Make sure the receiving wallet or exchange supports USDC on Polygon.',
          '',
          'Best path:',
          '  Use the Withdraw button in the Polymarket app until this tool has a live withdrawal API.',
          '  Send a small test withdrawal first for any large amount.',
          '',
          'Fees:',
          '  Polymarket says it does not charge its own deposit or withdrawal fee.',
          '  Wallets, bridges, exchanges, or payment providers may still charge route or network fees.',
          '',
          'No live withdrawal was sent from this tool.',
        )

        return text(lines.join('\n'))
      }

      // ── Buy shares ───────────────────────────────────
      case 'buy': {
        const input = (args.marketUrl || args.marketId) as string
        if (!input || !args.outcome || !args.amount) return err('Need marketUrl/marketId, outcome, and amount')
        const amount = args.amount as number
        const setupGuide = await getSetupGuideIfBlocked('buy', amount)
        if (setupGuide) return text(setupGuide)

        const m = await resolveMarket(input, {
          date: args.date as string | undefined,
          hint: args.marketHint as string | undefined,
        })
        const client = await getClient()
        const outcome = (args.outcome as string).toUpperCase()
        const tokenId = outcome === 'YES' ? m.tokenId : m.noTokenId
        const mktPrice = outcome === 'YES' ? m.yesPrice : m.noPrice
        const mode = parsePolymarketOrderMode(args.mode)
        const price = resolvePolymarketExecutionPrice({
          side: 'BUY',
          mode,
          marketPrice: mktPrice,
          price: args.price as number | undefined,
          maxPrice: args.maxPrice as number | undefined,
        })

        let order: unknown
        let size: number | null = null
        if (mode.isMarket) {
          order = await client.createAndPostMarketOrder(
            { tokenID: tokenId, price, amount, side: Side.BUY },
            { tickSize: m.tickSize, negRisk: m.negRisk },
            mode.orderType as OrderType.FOK | OrderType.FAK,
          )
        } else {
          size = calculateLimitBuySize(amount, price)
          order = await client.createAndPostOrder(
            { tokenID: tokenId, price, size, side: Side.BUY },
            { tickSize: m.tickSize, negRisk: m.negRisk },
            OrderType.GTC,
          )
        }

        return text(
          `✅ BUY Order Placed\n\n` +
          `Market: ${m.question}\n` +
          `Side: BUY ${outcome}\n` +
          `Mode: ${mode.mode}\n` +
          `${mode.isMarket ? `Max Price: ${(price * 100).toFixed(1)}¢\n` : `Limit Price: ${(price * 100).toFixed(1)}¢ per share\n`}` +
          (size !== null ? `Size: ${size} shares\n` : `Spend: $${amount.toFixed(2)} Polygon USDC\n`) +
          `Cost: ~$${amount.toFixed(2)} Polygon USDC\n` +
          (size !== null ? `Potential payout: $${size.toFixed(2)} (if ${outcome} wins)\n` : '') +
          `Order ID: ${(order as any).orderID || 'pending'}\n` +
          `Status: ${(order as any).status || 'submitted'}`
        )
      }

      // ── Sell shares ──────────────────────────────────
      case 'sell': {
        const input = (args.marketUrl || args.marketId) as string
        if (!input || !args.outcome) return err('Need marketUrl/marketId and outcome')
        const setupGuide = await getSetupGuideIfBlocked('sell')
        if (setupGuide) return text(setupGuide)

        const m = await resolveMarket(input, {
          date: args.date as string | undefined,
          hint: args.marketHint as string | undefined,
        })
        const client = await getClient()
        const outcome = (args.outcome as string).toUpperCase()
        const tokenId = outcome === 'YES' ? m.tokenId : m.noTokenId
        const mktPrice = outcome === 'YES' ? m.yesPrice : m.noPrice
        const mode = parsePolymarketOrderMode(args.mode)
        const price = resolvePolymarketExecutionPrice({
          side: 'SELL',
          mode,
          marketPrice: mktPrice,
          price: args.price as number | undefined,
          minPrice: args.minPrice as number | undefined,
        })

        let size: number
        if (args.percent) {
          // TODO: fetch actual position size from CTF contract
          if (!args.amount) return err('Provide amount (total shares) with percent')
          size = Math.floor(((args.amount as number) * (args.percent as number) / 100) * 100) / 100
        } else if (args.amount) {
          size = args.amount as number
        } else {
          return err('Provide amount (shares) or percent + amount')
        }

        const order = mode.isMarket
          ? await client.createAndPostMarketOrder(
            { tokenID: tokenId, price, amount: size, side: Side.SELL },
            { tickSize: m.tickSize, negRisk: m.negRisk },
            mode.orderType as OrderType.FOK | OrderType.FAK,
          )
          : await client.createAndPostOrder(
            { tokenID: tokenId, price, size, side: Side.SELL },
            { tickSize: m.tickSize, negRisk: m.negRisk },
            OrderType.GTC,
          )

        return text(
          `✅ SELL Order Placed\n\n` +
          `Market: ${m.question}\n` +
          `Side: SELL ${outcome}\n` +
          `Mode: ${mode.mode}\n` +
          `${mode.isMarket ? `Min Price: ${(price * 100).toFixed(1)}¢\n` : `Limit Price: ${(price * 100).toFixed(1)}¢\n`}` +
          `Size: ${size} shares\n` +
          `Revenue: ~$${(size * price).toFixed(2)} Polygon USDC\n` +
          `Order ID: ${(order as any).orderID || 'pending'}\n` +
          `Status: ${(order as any).status || 'submitted'}`
        )
      }

      // ── Stop-Loss ────────────────────────────────────
      case 'stop_loss': {
        const input = (args.marketUrl || args.marketId) as string
        if (!input || !args.outcome || !args.amount || !args.stopPrice)
          return err('Need marketUrl, outcome, amount (shares), and stopPrice')

        const m = await resolveMarket(input, {
          date: args.date as string | undefined,
          hint: args.marketHint as string | undefined,
        })
        const client = await getClient()
        const outcome = (args.outcome as string).toUpperCase()
        const tokenId = outcome === 'YES' ? m.tokenId : m.noTokenId
        const stopPrice = args.stopPrice as number
        const size = args.amount as number

        // Place a limit sell at the stop price
        const order = await client.createAndPostOrder(
          { tokenID: tokenId, price: stopPrice, size, side: Side.SELL },
          { tickSize: m.tickSize, negRisk: m.negRisk },
          OrderType.GTC,
        )

        return text(
          `🛑 Protective Limit Sell Placed\n\n` +
          `Market: ${m.question}\n` +
          `Outcome: ${outcome}\n` +
          `Limit Price: ${(stopPrice * 100).toFixed(1)}¢\n` +
          `Size: ${size} shares\n` +
          `Current price: ${((outcome === 'YES' ? m.yesPrice : m.noPrice) * 100).toFixed(1)}¢\n` +
          `Max loss: ~$${(size * (1 - stopPrice)).toFixed(2)}\n` +
          `Order ID: ${(order as any).orderID || 'pending'}\n\n` +
          `Note: this is a resting limit sell order, not a watched conditional trigger.`
        )
      }

      // ── Take-Profit ──────────────────────────────────
      case 'take_profit': {
        const input = (args.marketUrl || args.marketId) as string
        if (!input || !args.outcome || !args.amount || !args.stopPrice)
          return err('Need marketUrl, outcome, amount (shares), and stopPrice (target)')

        const m = await resolveMarket(input, {
          date: args.date as string | undefined,
          hint: args.marketHint as string | undefined,
        })
        const client = await getClient()
        const outcome = (args.outcome as string).toUpperCase()
        const tokenId = outcome === 'YES' ? m.tokenId : m.noTokenId
        const targetPrice = args.stopPrice as number
        const size = args.amount as number

        const order = await client.createAndPostOrder(
          { tokenID: tokenId, price: targetPrice, size, side: Side.SELL },
          { tickSize: m.tickSize, negRisk: m.negRisk },
          OrderType.GTC,
        )

        return text(
          `🎯 Take-Profit Limit Sell Placed\n\n` +
          `Market: ${m.question}\n` +
          `Outcome: ${outcome}\n` +
          `Limit Price: ${(targetPrice * 100).toFixed(1)}¢\n` +
          `Size: ${size} shares\n` +
          `Current price: ${((outcome === 'YES' ? m.yesPrice : m.noPrice) * 100).toFixed(1)}¢\n` +
          `Profit per share: ~$${(targetPrice - (outcome === 'YES' ? m.yesPrice : m.noPrice)).toFixed(4)}\n` +
          `Order ID: ${(order as any).orderID || 'pending'}\n\n` +
          `Note: this is a resting limit sell order, not a watched conditional trigger.`
        )
      }

      // ── Positions ────────────────────────────────────
      case 'positions': {
        const client = await getClient()
        const orders = await client.getOpenOrders()
        const trades = await client.getTrades()

        const lines: string[] = ['📋 Your Polymarket Positions\n']
        if (orders.length) {
          lines.push(`Open Orders (${orders.length}):`)
          for (const o of orders.slice(0, 10)) {
            const oo = o as any
            lines.push(`  ${oo.side} ${oo.size} @ ${(oo.price * 100).toFixed(1)}¢ — ${oo.status || 'open'}`)
            lines.push(`    ID: ${oo.orderID || '?'}`)
          }
        } else lines.push('No open orders.')

        if (trades.length) {
          lines.push(`\nRecent Trades (${Math.min(trades.length, 10)}):`)
          for (const t of trades.slice(0, 10)) {
            const tt = t as any
            lines.push(`  ${tt.side} ${tt.size} @ ${(tt.price * 100).toFixed(1)}¢ — ${tt.status || 'filled'}`)
          }
        }
        return text(lines.join('\n'))
      }

      // ── P&L ──────────────────────────────────────────
      case 'pnl': {
        const client = await getClient()
        const trades = await client.getTrades()
        if (!trades.length) return text('No trades yet — P&L is $0.')

        let totalSpent = 0, totalReceived = 0, buyCount = 0, sellCount = 0
        for (const t of trades) {
          const tt = t as any
          const value = (tt.size || 0) * (tt.price || 0)
          if (tt.side === 'BUY') { totalSpent += value; buyCount++ }
          else { totalReceived += value; sellCount++ }
        }
        const realized = totalReceived - totalSpent
        return text(
          `📊 Your Polymarket P&L\n\n` +
          `Total Buys: ${buyCount} trades ($${totalSpent.toFixed(2)} spent)\n` +
          `Total Sells: ${sellCount} trades ($${totalReceived.toFixed(2)} received)\n` +
          `Realized P&L: ${realized >= 0 ? '+' : ''}$${realized.toFixed(2)}\n\n` +
          `⚠️ Does not include unredeemed winning positions.`
        )
      }

      // ── Orders ───────────────────────────────────────
      case 'orders': {
        const client = await getClient()
        const orders = await client.getOpenOrders()
        if (!orders.length) return text('No open orders.')

        const lines: string[] = [`📋 Open Orders (${orders.length})\n`]
        for (const o of orders.slice(0, 20)) {
          const oo = o as any
          lines.push(`  ${oo.orderID?.slice(0, 12)}… | ${oo.side} ${oo.size} @ ${(oo.price * 100).toFixed(1)}¢`)
        }
        return text(lines.join('\n'))
      }

      // ── Cancel ───────────────────────────────────────
      case 'cancel': {
        if (!args.orderId) return err('Provide orderId')
        const client = await getClient()
        await client.cancelOrder({ orderID: args.orderId as string })
        return text(`✅ Cancelled order ${(args.orderId as string).slice(0, 16)}...`)
      }

      // ── Orderbook ────────────────────────────────────
      case 'orderbook': {
        const input = (args.marketUrl || args.marketId) as string
        if (!input) return err('Provide marketUrl or marketId')
        const m = await resolveMarket(input, {
          date: args.date as string | undefined,
          hint: args.marketHint as string | undefined,
        })
        const client = await getClient()
        const book = await client.getOrderBook(m.tokenId)
        const asks = ((book as any).asks || []).slice(0, 5)
        const bids = ((book as any).bids || []).slice(0, 5)

        const lines: string[] = [`📊 Orderbook — ${m.question.slice(0, 50)}\n`]
        lines.push('ASKS (sells):')
        for (const a of asks) lines.push(`  ${(a.price * 100).toFixed(1)}¢  |  ${a.size} shares`)
        lines.push(`\n  --- midpoint: ${((m.yesPrice) * 100).toFixed(1)}¢ ---\n`)
        lines.push('BIDS (buys):')
        for (const b of bids) lines.push(`  ${(b.price * 100).toFixed(1)}¢  |  ${b.size} shares`)
        return text(lines.join('\n'))
      }

      // ── Auto-approve Polygon USDC and outcome tokens ─
      case 'approve': {
        const setupGuide = await getSetupGuideIfBlocked('approve')
        if (setupGuide) return text(setupGuide)

        const result = await ensureApproval()
        return text(
          `✅ ${result}\n\n` +
          `You're ready to place buy and sell orders on Polymarket.\n\n` +
          `Gas note: this direct wallet approval uses Polygon gas from your wallet. Polymarket relayer gas sponsorship requires relayer/builder API integration, which this tool does not use yet.`
        )
      }

      // ── Redeem winnings ──────────────────────────────
      case 'redeem': {
        const input = (args.marketUrl || args.marketId) as string
        if (!input) return err('Provide marketUrl or marketId of a resolved market')
        const m = await resolveMarket(input, {
          date: args.date as string | undefined,
          hint: args.marketHint as string | undefined,
        })

        if (!m.resolved) {
          return text(
            `⏳ Market not yet resolved\n\n` +
            `"${m.question}"\n\n` +
            `Current: YES ${(m.yesPrice * 100).toFixed(1)}¢ | NO ${(m.noPrice * 100).toFixed(1)}¢\n` +
            `End Date: ${m.endDate?.slice(0, 10) || 'TBD'}\n\n` +
            `Redemption is only available after the market resolves.`
          )
        }

        // Determine winning outcome
        const winningOutcome = m.yesPrice > 0.9 ? 'YES' : 'NO'
        return text(
          `🏆 Market Resolved — ${winningOutcome} Won!\n\n` +
          `"${m.question}"\n\n` +
          `To redeem your winning ${winningOutcome} shares:\n` +
          `1. Your shares are automatically redeemable at $1.00 each\n` +
          `2. Call the CTF Exchange redeemPositions() function\n` +
          `3. Contract: ${m.negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE}\n\n` +
          `💡 Polymarket also auto-redeems after resolution for active users.`
        )
      }

      // ── Copy Trading ─────────────────────────────────
      case 'copy_trade': {
        if (!args.trader) return err('Provide trader wallet address or Polymarket profile URL')
        let addr = args.trader as string
        // Parse profile URL → address
        try {
          const u = new URL(addr)
          if (u.hostname.includes('polymarket.com')) {
            const parts = u.pathname.split('/').filter(Boolean)
            addr = parts[parts.length - 1] // last segment = address or username
          }
        } catch { /* raw address */ }

        const maxPer = (args.maxPerTrade as number) || 10

        // Fetch trader's recent activity from the CLOB
        const res = await fetch(`${HOST}/trades?maker_address=${addr}&limit=20`)
        let traderTrades: any[] = []
        if (res.ok) traderTrades = (await res.json()) as any[]

        if (!traderTrades.length) {
          // Try as taker
          const res2 = await fetch(`${HOST}/trades?taker_address=${addr}&limit=20`)
          if (res2.ok) traderTrades = (await res2.json()) as any[]
        }

        if (!traderTrades.length) {
          return text(
            `📋 Copy Trade — ${addr.slice(0, 10)}...\n\n` +
            `No recent public trades found for this address.\n\n` +
            `Tips:\n` +
            `  • Ensure you have the correct wallet address (not username)\n` +
            `  • Check: https://polymarket.com/profile/${addr}\n` +
            `  • The trader may use a proxy wallet`
          )
        }

        // Aggregate: find their most active positions
        const posMap = new Map<string, { side: string; totalSize: number; avgPrice: number; count: number; tokenId: string }>()
        for (const t of traderTrades) {
          const key = t.market || t.asset_id || t.token_id || 'unknown'
          const existing = posMap.get(key)
          if (existing) {
            existing.totalSize += parseFloat(t.size || '0')
            existing.count++
          } else {
            posMap.set(key, {
              side: t.side || 'BUY', totalSize: parseFloat(t.size || '0'),
              avgPrice: parseFloat(t.price || '0.5'), count: 1, tokenId: key,
            })
          }
        }

        const lines: string[] = [
          `🔄 Copy Trade — ${addr.slice(0, 10)}...\n`,
          `Recent positions (${traderTrades.length} trades):\n`,
        ]

        const client = await getClient()
        let copiedCount = 0
        for (const [tokenId, pos] of posMap) {
          if (pos.side !== 'BUY' || copiedCount >= 5) continue
          const size = Math.min(maxPer / pos.avgPrice, pos.totalSize)
          if (size < 1) continue

          try {
            await client.createAndPostOrder(
              { tokenID: tokenId, price: pos.avgPrice, size: Math.floor(size * 100) / 100, side: Side.BUY },
              { tickSize: '0.01', negRisk: false },
              OrderType.GTC,
            )
            lines.push(`  ✅ BUY ${size.toFixed(1)} @ ${(pos.avgPrice * 100).toFixed(0)}¢ — token ${tokenId.slice(0, 12)}...`)
            copiedCount++
          } catch (e) {
            lines.push(`  ⚠️ Failed: ${tokenId.slice(0, 12)}... — ${e instanceof Error ? e.message : 'error'}`)
          }
        }

        if (!copiedCount) lines.push('  No actionable BUY trades to copy.')
        lines.push(`\nMax per trade: $${maxPer} | Copied: ${copiedCount} trades`)
        return text(lines.join('\n'))
      }

      // ── Batch Buy ──────────────────────────────────────
      case 'batch_buy': {
        if (!args.outcome || !args.amount) return err('Need outcome and amount per market')

        let marketIds: string[] = []
        if (args.marketIds) {
          marketIds = (args.marketIds as string).split(',').map(s => s.trim())
        } else if (args.query) {
          // Search and buy all matching
          const q = (args.query as string).toLowerCase()
          const data = await gammaGet(`/markets?limit=50&active=true&closed=false&order=volume&ascending=false`) as any[]
          marketIds = (data || [])
            .filter((m: any) => m.question?.toLowerCase().includes(q))
            .slice(0, (args.limit as number) || 5)
            .map((m: any) => m.id)
        }

        if (!marketIds.length) return err('No markets. Provide marketIds (comma-separated) or query to search.')

        const outcome = (args.outcome as string).toUpperCase()
        const amountEach = args.amount as number
        const client = await getClient()
        const lines: string[] = [`📦 Batch Buy — ${outcome} on ${marketIds.length} markets ($${amountEach} each)\n`]
        let successCount = 0

        for (const id of marketIds) {
          try {
            const m = await resolveMarket(id)
            const tokenId = outcome === 'YES' ? m.tokenId : m.noTokenId
            const price = outcome === 'YES' ? m.yesPrice : m.noPrice
            const size = Math.floor((amountEach / price) * 100) / 100

            const order = await client.createAndPostOrder(
              { tokenID: tokenId, price, size, side: Side.BUY },
              { tickSize: m.tickSize, negRisk: m.negRisk },
              OrderType.GTC,
            )
            lines.push(`  ✅ ${m.question.slice(0, 50)}… — ${size} @ ${(price * 100).toFixed(0)}¢`)
            successCount++
          } catch (e) {
            lines.push(`  ❌ ${id.slice(0, 12)}… — ${e instanceof Error ? e.message : 'failed'}`)
          }
        }

        lines.push(`\nResult: ${successCount}/${marketIds.length} orders placed | Total: ~$${(successCount * amountEach).toFixed(2)}`)
        return text(lines.join('\n'))
      }

      // ── Event Correlation ──────────────────────────────
      case 'correlations': {
        const input = (args.marketUrl || args.marketId || args.query) as string
        if (!input) return err('Provide a marketUrl/marketId or query to find correlated markets')

        // Get the reference market
        let refQuestion: string
        try {
          const ref = await resolveMarket(input)
          refQuestion = ref.question
        } catch {
          refQuestion = input
        }

        // Extract keywords from the reference
        const stopWords = new Set(['will', 'the', 'be', 'in', 'a', 'an', 'of', 'to', 'by', 'on', 'at', 'or', 'and', 'is', 'it', 'for', 'this', 'that', 'with', 'from', 'before', 'after'])
        const keywords = refQuestion.toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 2 && !stopWords.has(w))

        // Search all active markets for keyword overlap
        const all = await gammaGet(`/markets?limit=100&active=true&closed=false&order=volume&ascending=false`) as any[]
        const scored = (all || [])
          .filter((m: any) => m.question !== refQuestion)
          .map((m: any) => {
            const q = (m.question || '').toLowerCase()
            const hits = keywords.filter(kw => q.includes(kw))
            return { market: m, score: hits.length, matchedKeywords: hits }
          })
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, (args.limit as number) || 10)

        if (!scored.length) return text(`No correlated markets found for: "${refQuestion}"`)

        const lines: string[] = [`🔗 Correlated Markets\n`, `Reference: "${refQuestion.slice(0, 60)}"\n`]
        for (const s of scored) {
          const p = s.market.outcomePrices ? JSON.parse(s.market.outcomePrices) : []
          const yes = p[0] ? (parseFloat(p[0]) * 100).toFixed(0) : '?'
          lines.push(`  [${s.score} match] ${s.market.question?.slice(0, 60)}`)
          lines.push(`    YES: ${yes}¢ | Keywords: ${s.matchedKeywords.join(', ')} | ID: ${s.market.id}`)
          lines.push('')
        }
        lines.push(`Keywords used: ${keywords.join(', ')}`)
        return text(lines.join('\n'))
      }

      // ── Win/Loss History ───────────────────────────────
      case 'history': {
        const client = await getClient()
        const trades = await client.getTrades()
        if (!trades.length) return text('No trade history yet.')

        // Group by token (market position)
        const positions = new Map<string, { buys: number; sells: number; spent: number; received: number; side: string }>()
        for (const t of trades) {
          const tt = t as any
          const key = tt.asset_id || tt.token_id || tt.market || 'unknown'
          const pos = positions.get(key) || { buys: 0, sells: 0, spent: 0, received: 0, side: tt.side }
          const value = (parseFloat(tt.size) || 0) * (parseFloat(tt.price) || 0)
          if (tt.side === 'BUY') { pos.buys++; pos.spent += value }
          else { pos.sells++; pos.received += value }
          positions.set(key, pos)
        }

        let wins = 0, losses = 0, breakeven = 0
        for (const [, pos] of positions) {
          if (pos.sells > 0) {
            const pnl = pos.received - pos.spent
            if (pnl > 0.01) wins++
            else if (pnl < -0.01) losses++
            else breakeven++
          }
        }

        const total = wins + losses + breakeven
        const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0'

        const lines: string[] = [
          `📊 Win/Loss History\n`,
          `Total Positions: ${positions.size}`,
          `Closed Positions: ${total}`,
          `  ✅ Wins: ${wins}`,
          `  ❌ Losses: ${losses}`,
          `  ➖ Break-even: ${breakeven}`,
          `  📈 Win Rate: ${winRate}%`,
          `\nTotal Trades: ${trades.length}`,
          `  Buys: ${trades.filter((t: any) => t.side === 'BUY').length}`,
          `  Sells: ${trades.filter((t: any) => t.side === 'SELL').length}`,
        ]
        return text(lines.join('\n'))
      }

      // ── Portfolio Heatmap ──────────────────────────────
      case 'heatmap': {
        const client = await getClient()
        const trades = await client.getTrades()
        const orders = await client.getOpenOrders()

        if (!trades.length && !orders.length) return text('No positions to display.')

        // Build position map from trades
        const positions = new Map<string, { netShares: number; avgCost: number; totalSpent: number; side: string }>()
        for (const t of trades) {
          const tt = t as any
          const key = tt.asset_id || tt.token_id || tt.market || 'unknown'
          const pos = positions.get(key) || { netShares: 0, avgCost: 0, totalSpent: 0, side: 'BUY' }
          const size = parseFloat(tt.size) || 0
          const price = parseFloat(tt.price) || 0
          if (tt.side === 'BUY') {
            pos.totalSpent += size * price
            pos.netShares += size
          } else {
            pos.netShares -= size
          }
          if (pos.netShares > 0) pos.avgCost = pos.totalSpent / pos.netShares
          positions.set(key, pos)
        }

        // Filter to active positions (net > 0)
        const active = [...positions.entries()].filter(([, p]) => p.netShares > 0.01)

        const lines: string[] = [`🗺️ Portfolio Heatmap\n`]

        if (active.length) {
          lines.push(`Active Positions (${active.length}):`)
          lines.push(`${'Token'.padEnd(16)} ${'Shares'.padEnd(10)} ${'Avg Cost'.padEnd(10)} ${'Invested'.padEnd(10)} Status`)
          lines.push('─'.repeat(60))

          let totalInvested = 0
          for (const [token, pos] of active) {
            const invested = pos.netShares * pos.avgCost
            totalInvested += invested
            const bar = pos.avgCost < 0.3 ? '🟢' : pos.avgCost < 0.6 ? '🟡' : '🔴'
            lines.push(
              `${bar} ${token.slice(0, 14).padEnd(14)} ` +
              `${pos.netShares.toFixed(1).padEnd(10)} ` +
              `${(pos.avgCost * 100).toFixed(0).padEnd(8)}¢ ` +
              `$${invested.toFixed(2).padEnd(10)}`
            )
          }

          lines.push('─'.repeat(60))
          lines.push(`Total Invested: $${totalInvested.toFixed(2)}`)
          lines.push(`\nLegend: 🟢 <30¢ (deep value) | 🟡 30-60¢ (moderate) | 🔴 >60¢ (expensive)`)
        } else {
          lines.push('No active positions (all sold).')
        }

        if (orders.length) {
          lines.push(`\nPending Orders: ${orders.length}`)
        }

        return text(lines.join('\n'))
      }

      default:
        return err(`Unknown action: ${args.action}`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('allowance') || msg.includes('approve')) {
      return err(`${msg}\n\n💡 Run: polymarket approve — to auto-approve Polygon USDC and outcome tokens for trading.`)
    }
    return err(msg)
  }
}

export default { tools: TOOLS, handle } satisfies ToolModule
