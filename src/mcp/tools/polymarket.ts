/**
 * ./AGNT Protocol — Polymarket Trading (CLOB v2) — Full Suite
 * 
 * Real trading via @polymarket/clob-client-v2 on Polygon.
 * Features: buy, sell, search, positions, P&L, orderbook, stop-loss,
 *           take-profit, DCA-on-dip, auto-approve, redeem winnings.
 */

import type { ToolModule } from './index.js'
import { AssetType, ClobClient, Side, SignatureTypeV2, OrderType, type TickSize } from '@polymarket/clob-client-v2'
import { createWalletClient, createPublicClient, http, parseAbi, encodeFunctionData, formatUnits, maxUint256, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, resolve } from 'path'
import { getActiveWallet } from '../wallet.js'
import { SUPPORTED_CHAINS } from '../chains.js'
import { decrypt, encrypt, getPassphrase } from '../crypto.js'
import { getCurrentWalletScope } from '../tool-context.js'
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
const POLYMARKET_BRIDGE_API = 'https://bridge.polymarket.com'
const POLYGON_RPC = process.env.AGNT_POLYGON_RPC_URL || SUPPORTED_CHAINS.polygon.rpc
const PUSD_POLYGON = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
const NATIVE_USDC_POLYGON = '0x3c499c542cef5e3811E1192ce70d8cC03d5c3359'
const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
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
  'function transfer(address,uint256) returns (bool)',
])

const erc1155Abi = parseAbi([
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
])

// ─── Client singleton ────────────────────────────────────

let _client: ClobClient | null = null
let _clientKey: string | null = null

interface PolymarketAccountConfig {
  signatureType: SignatureTypeV2
  signerAddress: `0x${string}`
  funderAddress: `0x${string}`
  modeLabel: string
  usesSeparateFunder: boolean
}

interface StoredPolymarketAccountConfig {
  signatureType?: number | string
  funderAddress?: string
  updatedAt?: string
}

interface PolymarketBridgeDepositResponse {
  address?: {
    evm?: string
  }
  warnings?: Array<{ code?: string, message?: string }>
}

function resolveGlobalConfigPath(custom?: string): string {
  const p = custom || process.env.AGNT_POLYMARKET_CONFIG_PATH || '.agnt/polymarket.enc'
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function resolveConfigPath(custom?: string): string {
  if (!custom) {
    const scope = getCurrentWalletScope()
    if (scope) {
      const safeScope = createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 32)
      const baseDir = process.env.AGNT_POLYMARKET_CONFIG_DIR
        ? (isAbsolute(process.env.AGNT_POLYMARKET_CONFIG_DIR) ? process.env.AGNT_POLYMARKET_CONFIG_DIR : resolve(process.cwd(), process.env.AGNT_POLYMARKET_CONFIG_DIR))
        : resolve(dirname(resolveGlobalConfigPath(process.env.AGNT_POLYMARKET_CONFIG_PATH)), 'polymarket')
      return resolve(baseDir, `${safeScope}.enc`)
    }
  }
  return resolveGlobalConfigPath(custom)
}

function loadStoredPolymarketConfig(custom?: string): StoredPolymarketAccountConfig {
  const fp = resolveConfigPath(custom)
  if (!existsSync(fp)) return {}
  try {
    const raw = readFileSync(fp, 'utf-8')
    const json = raw.trim().startsWith('{') ? raw : decrypt(raw, getPassphrase())
    return JSON.parse(json) as StoredPolymarketAccountConfig
  } catch {
    return {}
  }
}

function saveStoredPolymarketConfig(config: StoredPolymarketAccountConfig, custom?: string): StoredPolymarketAccountConfig {
  const fp = resolveConfigPath(custom)
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const saved = { ...config, updatedAt: new Date().toISOString() }
  writeFileSync(fp, encrypt(JSON.stringify(saved, null, 2), getPassphrase()), 'utf-8')
  _client = null
  _clientKey = null
  return saved
}

function parseSignatureType(value: unknown): SignatureTypeV2 {
  const raw = String(value ?? '').trim()
  if (!raw) return SignatureTypeV2.EOA
  const normalized = raw.toLowerCase()
  if (normalized === 'eoa' || normalized === '0') return SignatureTypeV2.EOA
  if (normalized === 'proxy' || normalized === 'poly_proxy' || normalized === '1') return SignatureTypeV2.POLY_PROXY
  if (normalized === 'safe' || normalized === 'gnosis' || normalized === 'poly_gnosis_safe' || normalized === '2') return SignatureTypeV2.POLY_GNOSIS_SAFE
  if (normalized === 'deposit' || normalized === 'deposit_wallet' || normalized === 'poly_1271' || normalized === '1271' || normalized === '3') return SignatureTypeV2.POLY_1271
  throw new Error('Invalid AGNT_POLYMARKET_SIGNATURE_TYPE. Use 0/eoa, 1/proxy, 2/safe, or 3/deposit.')
}

function getPolymarketAccountConfig(signerAddress: `0x${string}`): PolymarketAccountConfig {
  const stored = loadStoredPolymarketConfig()
  const signatureType = parseSignatureType(stored.signatureType ?? process.env.AGNT_POLYMARKET_SIGNATURE_TYPE)
  const configuredFunder = (
    stored.funderAddress ||
    process.env.AGNT_POLYMARKET_FUNDER_ADDRESS ||
    process.env.AGNT_POLYMARKET_DEPOSIT_WALLET_ADDRESS ||
    ''
  ).trim()
  const funderAddress = (configuredFunder || signerAddress) as `0x${string}`
  const modeLabel = signatureType === SignatureTypeV2.POLY_1271
    ? 'deposit wallet'
    : signatureType === SignatureTypeV2.POLY_PROXY
      ? 'Polymarket proxy wallet'
      : signatureType === SignatureTypeV2.POLY_GNOSIS_SAFE
        ? 'Polymarket safe'
        : 'direct wallet'

  return {
    signatureType,
    signerAddress,
    funderAddress,
    modeLabel,
    usesSeparateFunder: funderAddress.toLowerCase() !== signerAddress.toLowerCase(),
  }
}

function formatClobUsdc(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return formatUnits(BigInt(String(value)), 6)
  } catch {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? String(numeric) : undefined
  }
}

async function getPolymarketBridgeDepositAddress(recipient: `0x${string}`): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const builderCode = process.env.POLYMARKET_BUILDER_CODE || process.env.AGNT_POLYMARKET_BUILDER_CODE
  if (builderCode) headers['x-builder-code'] = builderCode

  const res = await fetch(`${POLYMARKET_BRIDGE_API}/deposit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ address: recipient }),
  })
  const body = await res.json().catch(() => null) as PolymarketBridgeDepositResponse | null
  if (!res.ok) {
    throw new Error(`Polymarket bridge deposit address failed: HTTP ${res.status}`)
  }
  const evm = body?.address?.evm
  if (!evm || !/^0x[a-fA-F0-9]{40}$/.test(evm)) {
    throw new Error('Polymarket bridge did not return a valid EVM deposit address.')
  }
  return evm
}

async function getClient(): Promise<ClobClient> {
  const w = getActiveWallet()
  if (!w) throw new Error('No active wallet. Create one with the wallet tool first.')

  const account = privateKeyToAccount(w.privateKey as `0x${string}`)
  const cfg = getPolymarketAccountConfig(account.address)
  const clientKey = `${account.address.toLowerCase()}:${cfg.funderAddress.toLowerCase()}:${cfg.signatureType}`
  if (_client && _clientKey === clientKey) return _client

  const signer = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) })

  const k = process.env.AGNT_POLYMARKET_KEY
  const s = process.env.AGNT_POLYMARKET_SECRET
  const p = process.env.AGNT_POLYMARKET_PASSPHRASE
  let creds: { key: string; secret: string; passphrase: string }

  if (k && s && p) {
    creds = { key: k, secret: s, passphrase: p }
  } else {
    const tmp = new ClobClient({
      host: HOST,
      chain: CHAIN_ID,
      signer,
      signatureType: cfg.signatureType,
      funderAddress: cfg.funderAddress,
    })
    creds = await tmp.createOrDeriveApiKey()
  }

  _client = new ClobClient({
    host: HOST, chain: CHAIN_ID, signer, creds,
    signatureType: cfg.signatureType, funderAddress: cfg.funderAddress,
  })
  _clientKey = clientKey
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
  const cfg = getPolymarketAccountConfig(account.address)
  const client = await getClient()
  const [pusdBalance, funderPusdBalance, nativeUsdcBalance, funderNativeUsdcBalance, usdcEbalance, funderUsdcEbalance, polBalance, pusdAllowances, outcomeApprovals, clobCollateral] = await Promise.all([
    pub.readContract({ address: PUSD_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    pub.readContract({ address: PUSD_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [cfg.funderAddress] }) as Promise<bigint>,
    pub.readContract({ address: NATIVE_USDC_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    pub.readContract({ address: NATIVE_USDC_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [cfg.funderAddress] }) as Promise<bigint>,
    pub.readContract({ address: USDC_E_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    pub.readContract({ address: USDC_E_POLYGON as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [cfg.funderAddress] }) as Promise<bigint>,
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
    client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => null),
  ])

  const clobBalance = formatClobUsdc((clobCollateral as any)?.balance)
  const clobAllowance = formatClobUsdc((clobCollateral as any)?.allowance)
  const clobAllowanceReady = Number.parseFloat(clobAllowance || '0') > 0
  const walletAllowanceReady = pusdAllowances.every(item => item.allowance >= BigInt(1e12))

  return {
    wallet: w,
    address: account.address,
    funderAddress: cfg.funderAddress,
    signatureType: cfg.signatureType,
    modeLabel: cfg.modeLabel,
    usesSeparateFunder: cfg.usesSeparateFunder,
    pusdBalance,
    funderPusdBalance,
    nativeUsdcBalance,
    funderNativeUsdcBalance,
    usdcEbalance,
    funderUsdcEbalance,
    polBalance,
    clobBalance,
    clobAllowance,
    pusdAllowances,
    outcomeApprovals,
    collateralReady: clobAllowanceReady || walletAllowanceReady,
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
      nativeUsdcBalance: formatUnits(readiness.nativeUsdcBalance, 6),
      usdcEbalance: formatUnits(readiness.usdcEbalance, 6),
      funderAddress: readiness.funderAddress,
      signatureType: readiness.signatureType,
      accountMode: readiness.modeLabel,
      usesSeparateFunder: readiness.usesSeparateFunder,
      funderPusdBalance: formatUnits(readiness.funderPusdBalance, 6),
      funderNativeUsdcBalance: formatUnits(readiness.funderNativeUsdcBalance, 6),
      funderUsdcEbalance: formatUnits(readiness.funderUsdcEbalance, 6),
      tradingBalance: readiness.clobBalance,
      tradingAllowance: readiness.clobAllowance,
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
  let status = await getPolymarketSetupStatus(requiredPusd)
  let blocker = getPolymarketSetupBlocker(action, status)
  const funderHasEnough = Number.parseFloat(String(status.funderPusdBalance || '0')) >= (requiredPusd || 0)
  if (action === 'buy' && blocker === 'funding' && funderHasEnough) {
    await syncPolymarketBalanceAllowance().catch(() => undefined)
    status = await getPolymarketSetupStatus(requiredPusd)
    blocker = getPolymarketSetupBlocker(action, status)
  }
  if (!blocker) return null
  return formatPolymarketSetupGuide(status, blocker)
}

// ─── Auto-approve Polygon USDC and outcome tokens ──────────

async function ensureApproval(): Promise<string> {
  const { account, pub, wallet } = getPolygonWallet()
  const client = await getClient()
  const cfg = getPolymarketAccountConfig(account.address)
  if (cfg.usesSeparateFunder) {
    const sync = await syncPolymarketBalanceAllowance()
    return `${sync}\n\nThis setup uses a separate ${cfg.modeLabel} as the Polymarket funder. AGNT did not approve the active signer wallet, because orders spend from ${cfg.funderAddress}. If CLOB allowance is still 0, the funder/deposit wallet needs to be initialized or approved through Polymarket's wallet/relayer flow.`
  }
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
      approvals.push(`Approved Polymarket pUSD for ${spender.label} (tx: ${hash.slice(0, 14)}...)`)
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
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
  approvals.push('Synced Polymarket CLOB pUSD balance and allowance')
  return approvals.length ? approvals.join('\n') : 'Polymarket pUSD and outcome-token approvals are already ready'
}

async function syncPolymarketBalanceAllowance(tokenId?: string): Promise<string> {
  const client = await getClient()
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
  if (tokenId) {
    await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId })
  }
  const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
  return `Synced Polymarket CLOB.\nTrading USDC: ${formatClobUsdc((collateral as any).balance) ?? 'unknown'}\npUSD allowance: ${formatClobUsdc((collateral as any).allowance) ?? 'unknown'}`
}

async function fundPolymarket(amount?: number, sourceToken?: string): Promise<string> {
  const { account, pub, wallet } = getPolygonWallet()
  const cfg = getPolymarketAccountConfig(account.address)
  const readiness = await getReadiness()

  const lines = [
    'Polymarket Funding',
    '',
    `Active wallet: ${account.address}`,
    `Trading/funder address: ${cfg.funderAddress}`,
    `Mode: ${cfg.modeLabel} (signature type ${cfg.signatureType})`,
  ]

  if (!amount) {
    lines.push(
      '',
      'How to fund:',
      `  Send native Polygon USDC or USDC.e through Polymarket bridge to: ${cfg.funderAddress}`,
      '  Then run polymarket action=sync so the CLOB sees the new balance.',
      '',
      `Current active wallet native Polygon USDC: ${formatUnits(readiness.nativeUsdcBalance, 6)}`,
      `Current active wallet USDC.e: ${formatUnits(readiness.usdcEbalance, 6)}`,
      `Current active wallet Polymarket pUSD: ${formatUnits(readiness.pusdBalance, 6)}`,
    )
    if (!cfg.usesSeparateFunder) {
      lines.push('', 'This setup uses your active wallet as the trading address, so no internal transfer is needed.')
    }
    return lines.join('\n')
  }

  const rawAmount = parseUnits(String(amount), 6)
  const preferredSource = String(sourceToken || 'auto').toLowerCase()
  const pusdBalance = readiness.pusdBalance as bigint
  const nativeUsdcBalance = readiness.nativeUsdcBalance as bigint
  const usdcEbalance = readiness.usdcEbalance as bigint
  const canUsePusd = pusdBalance >= rawAmount
  const canUseNativeUsdc = nativeUsdcBalance >= rawAmount
  const canUseUsdcE = usdcEbalance >= rawAmount

  if (!cfg.usesSeparateFunder && (preferredSource === 'pusd' || (preferredSource === 'auto' && canUsePusd))) {
    await syncPolymarketBalanceAllowance()
    lines.push(
      '',
      'No transfer sent.',
      'This setup already uses the active wallet as the Polymarket trading address and pUSD is already in that wallet.',
      'Synced the CLOB balance/allowance. If trading USDC still shows 0, run polymarket action=approve once.',
    )
    return lines.join('\n')
  }

  const bridgeSources = [
    { key: 'usdc', label: 'native Polygon USDC', address: NATIVE_USDC_POLYGON, balance: nativeUsdcBalance },
    { key: 'native_usdc', label: 'native Polygon USDC', address: NATIVE_USDC_POLYGON, balance: nativeUsdcBalance },
    { key: 'usdc.e', label: 'USDC.e', address: USDC_E_POLYGON, balance: usdcEbalance },
    { key: 'usdce', label: 'USDC.e', address: USDC_E_POLYGON, balance: usdcEbalance },
  ]
  const selectedBridgeSource = preferredSource === 'auto'
    ? (canUseNativeUsdc ? bridgeSources[0] : canUseUsdcE ? bridgeSources[2] : undefined)
    : bridgeSources.find(source => source.key === preferredSource)

  if (selectedBridgeSource) {
    if (amount < 2) {
      throw new Error('Polymarket bridge deposits on Polygon require at least $2. Use amount=2 or higher, or use pUSD if it is already in the wallet.')
    }
    if (selectedBridgeSource.balance < rawAmount) {
      throw new Error(`Insufficient ${selectedBridgeSource.label}. Need ${amount}, available ${formatUnits(selectedBridgeSource.balance, 6)}.`)
    }

    const depositAddress = await getPolymarketBridgeDepositAddress(cfg.funderAddress)
    const hash = await wallet.sendTransaction({
      to: selectedBridgeSource.address as `0x${string}`,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [depositAddress as `0x${string}`, rawAmount],
      }),
    })
    await pub.waitForTransactionReceipt({ hash })

    lines.push(
      '',
      `Sent ${amount} ${selectedBridgeSource.label} to Polymarket bridge for ${cfg.funderAddress}.`,
      `Bridge deposit address: ${depositAddress}`,
      `Tx: https://polygonscan.com/tx/${hash}`,
      '',
      'Polymarket should convert this into trading pUSD/USDC for the configured account. This can take a little time.',
      'After it lands, run polymarket action=sync and then polymarket action=balance.',
    )
    return lines.join('\n')
  }

  if (!canUsePusd) {
    throw new Error(`Insufficient funding asset. Need ${amount}. Available: ${formatUnits(nativeUsdcBalance, 6)} native Polygon USDC, ${formatUnits(usdcEbalance, 6)} USDC.e, ${formatUnits(pusdBalance, 6)} pUSD.`)
  }

  const hash = await wallet.sendTransaction({
    to: PUSD_POLYGON as `0x${string}`,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [cfg.funderAddress, rawAmount],
    }),
  })
  await pub.waitForTransactionReceipt({ hash })
  await syncPolymarketBalanceAllowance()

  lines.push(
    '',
    `Sent ${amount} Polymarket pUSD to the Polymarket trading/funder address.`,
    `Tx: https://polygonscan.com/tx/${hash}`,
    '',
    'CLOB balance sync requested. If the CLOB still shows the old balance, wait a few seconds and run polymarket action=sync again.',
  )
  return lines.join('\n')
}

function configurePolymarket(args: Record<string, unknown>): string {
  const signatureTypeInput = args.signatureType ?? args.accountMode ?? args.mode
  const funderAddress = String(args.funderAddress || args.depositAddress || args.depositWalletAddress || '').trim()
  const signatureType = parseSignatureType(signatureTypeInput ?? (funderAddress ? 'deposit' : 'eoa'))

  if (signatureType !== SignatureTypeV2.EOA && !funderAddress) {
    throw new Error('A separate Polymarket funder/deposit address is required for proxy, safe, or deposit wallet mode.')
  }
  if (funderAddress && !/^0x[a-fA-F0-9]{40}$/.test(funderAddress)) {
    throw new Error('Invalid Polymarket funder/deposit address.')
  }

  const saved = saveStoredPolymarketConfig({
    signatureType,
    funderAddress: funderAddress || undefined,
  })

  return [
    'Polymarket config saved for this AGNT user/scope.',
    '',
    `Signature type: ${saved.signatureType}`,
    `Funder/deposit address: ${saved.funderAddress || 'active wallet'}`,
    '',
    'Next:',
    '  1. Run polymarket action=balance',
    '  2. Fund the shown trading/funder address with Polymarket pUSD/trading collateral',
    '  3. Run polymarket action=sync',
  ].join('\n')
}

function showPolymarketConfig(): string {
  const stored = loadStoredPolymarketConfig()
  const w = getActiveWallet()
  const cfg = w ? getPolymarketAccountConfig(w.address) : null
  return [
    'Polymarket Config',
    '',
    `Stored signature type: ${stored.signatureType ?? 'not set'}`,
    `Stored funder/deposit address: ${stored.funderAddress || 'not set'}`,
    `Effective mode: ${cfg?.modeLabel || 'unknown until wallet selected'}`,
    `Effective trading/funder address: ${cfg?.funderAddress || 'unknown until wallet selected'}`,
    '',
    'Note: env vars are only fallback defaults. Hosted AGNT users should configure this per API key/user scope.',
  ].join('\n')
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
          enum: ['search', 'markets', 'market', 'setup', 'guide', 'help', 'configure', 'config', 'clear_config', 'balance', 'deposit', 'fund', 'sync', 'withdraw', 'buy', 'sell', 'positions', 'pnl', 'orders', 'cancel', 'orderbook', 'approve', 'stop_loss', 'take_profit', 'redeem', 'copy_trade', 'batch_buy', 'correlations', 'history', 'heatmap'],
          description: 'Action to perform',
        },
        query: { type: 'string', description: 'Search query (for search, correlations)' },
        marketUrl: { type: 'string', description: 'Polymarket URL, slug, or ID' },
        marketId: { type: 'string', description: 'Market ID (alternative to marketUrl)' },
        tokenId: { type: 'string', description: 'CLOB token ID for conditional token allowance sync' },
        signatureType: { type: 'string', description: 'Polymarket signature type: 0/eoa, 1/proxy, 2/safe, 3/deposit' },
        accountMode: { type: 'string', description: 'Polymarket account mode: eoa, proxy, safe, or deposit' },
        funderAddress: { type: 'string', description: 'Per-user Polymarket funder/deposit wallet address' },
        depositAddress: { type: 'string', description: 'Alias for funderAddress' },
        sourceToken: { type: 'string', description: 'Funding source for deposit/fund: auto, USDC, USDC.e, or pUSD. Default: auto' },
        date: { type: 'string', description: 'Date or deadline hint for event pages with multiple child markets. Example: June 30, 2026' },
        marketHint: { type: 'string', description: 'Plain-English child market hint for event pages. Example: June 30 one' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome to trade' },
        amount: { type: 'number', description: 'Polymarket trading USDC to spend (buy) or shares to sell (sell)' },
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
        maxPerTrade: { type: 'number', description: 'Max Polymarket trading USDC per copied trade (for copy_trade). Default: 10' },
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

      case 'configure': {
        return text(configurePolymarket(args))
      }

      case 'config': {
        return text(showPolymarketConfig())
      }

      case 'clear_config': {
        saveStoredPolymarketConfig({})
        return text('Polymarket config cleared for this AGNT user/scope. Env fallback may still apply if set on the server.')
      }

      // ── Balance / readiness ──────────────────────────
      case 'balance': {
        const setupGuide = await getSetupGuideIfBlocked('balance')
        if (setupGuide) return text(setupGuide)

        const readiness = await getReadiness()
        const client = await getClient()
        const openOrders = await client.getOpenOrders().catch(() => [])
        const ready = readiness.collateralReady && readiness.outcomeTokensReady
        const pusdPermissions = [
          { label: 'Position setup permission', ready: readiness.pusdAllowances[0]?.allowance >= BigInt(1e12) },
          { label: 'Buy regular markets', ready: readiness.pusdAllowances[1]?.allowance >= BigInt(1e12) },
          { label: 'Buy neg-risk markets', ready: readiness.pusdAllowances[2]?.allowance >= BigInt(1e12) },
        ]
        const outcomeTokenPermissions = [
          { label: 'Sell regular markets', ready: readiness.outcomeApprovals[0]?.approved },
          { label: 'Sell neg-risk markets', ready: readiness.outcomeApprovals[1]?.approved },
        ]
        const pusdPermissionLines = pusdPermissions
          .map(item => `  ${item.label}: ${item.ready ? 'Ready' : 'Needs approval'}`)
          .join('\n')
        const outcomePermissionLines = outcomeTokenPermissions
          .map(item => `  ${item.label}: ${item.ready ? 'Ready' : 'Needs approval'}`)
          .join('\n')

        return text(
          `Polymarket Readiness\n\n` +
          `Wallet: ${readiness.wallet.name} (${readiness.address})\n` +
          `Account Mode: ${readiness.modeLabel} (signature type ${readiness.signatureType})\n` +
          `Trading/Funder Address: ${readiness.funderAddress}\n` +
          `Network: Polygon\n` +
          `Polymarket Trading USDC: ${readiness.clobBalance ?? 'unknown'}\n` +
          `CLOB USDC Allowance: ${readiness.clobAllowance ?? 'unknown'}\n` +
          `Active Wallet Polymarket pUSD: ${formatUnits(readiness.pusdBalance, 6)}\n` +
          `Active Wallet Native Polygon USDC: ${formatUnits(readiness.nativeUsdcBalance, 6)}\n` +
          `Active Wallet Bridged Polygon USDC.e: ${formatUnits(readiness.usdcEbalance, 6)}\n` +
          `Funder Wallet Polymarket pUSD: ${formatUnits(readiness.funderPusdBalance, 6)}\n` +
          `Funder Wallet Native Polygon USDC: ${formatUnits(readiness.funderNativeUsdcBalance, 6)}\n` +
          `Funder Wallet Bridged Polygon USDC.e: ${formatUnits(readiness.funderUsdcEbalance, 6)}\n` +
          `POL: ${formatUnits(readiness.polBalance, 18)}\n` +
          `Open Orders: ${openOrders.length}\n\n` +
          `Polymarket pUSD Permissions:\n${pusdPermissionLines}\n\n` +
          `Share Selling Permissions:\n${outcomePermissionLines}\n\n` +
          `${ready ? 'Ready to place buy and sell orders.' : 'Run polymarket action=setup for first-time setup, then action=approve before trading.'}\n` +
          `Note: approval is a one-time wallet permission. It uses POL gas, but normal buy/sell order placement does not use wallet gas after setup.`
        )
      }

      case 'deposit':
      case 'fund': {
        const setupGuide = await getSetupGuideIfBlocked('fund')
        if (setupGuide) return text(setupGuide)
        return text(await fundPolymarket(args.amount as number | undefined, args.sourceToken as string | undefined))
      }

      case 'sync': {
        return text(await syncPolymarketBalanceAllowance(args.tokenId as string | undefined))
      }

      case 'withdraw': {
        const w = getActiveWallet()
        const amount = args.amount as number | undefined
        const destination = (args.destination || args.toAddress) as string | undefined
        const lines = ['Withdraw from Polymarket', '']

        if (w) lines.push(`Wallet: ${w.name} (${w.address})`)
        if (amount !== undefined) lines.push(`Amount: ${amount} Polymarket trading USDC`)
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
          (size !== null ? `Size: ${size} shares\n` : `Spend: $${amount.toFixed(2)} Polymarket trading USDC\n`) +
          `Cost: ~$${amount.toFixed(2)} Polymarket trading USDC\n` +
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
          `Revenue: ~$${(size * price).toFixed(2)} Polymarket trading USDC\n` +
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
      return err(`${msg}\n\n💡 Run: polymarket approve — to auto-approve Polymarket pUSD and outcome tokens for trading.`)
    }
    return err(msg)
  }
}

export default { tools: TOOLS, handle } satisfies ToolModule
