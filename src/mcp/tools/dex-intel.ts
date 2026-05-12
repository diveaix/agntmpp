/**
 * ./AGNT Protocol — DEX Intelligence & Smart Swap
 * Discovers the best pools via DexScreener, then routes trades to the exact DEX.
 * Supports: Uniswap, PancakeSwap, Aerodrome (Base), Velodrome (Optimism), Enshrined AMM (Tempo).
 */

import type { ToolModule } from './index.js'
import { getOrCreateWallet, getAccount } from '../wallet.js'
import { getPublicClient, getWalletClient as getChainsWalletClient, explorerTxUrl, SUPPORTED_CHAINS } from '../chains.js'
import { parseUnits, formatUnits } from 'viem'
import {
  getNativeEthPlan,
  isNativeEthRequest as isExplicitNativeEthRequest,
  resolveToWeth as resolveNativeToWeth,
  waitForTokenBalanceIncrease,
  wethAbi as nativeWethAbi,
} from './native-eth.js'
import { buildTradeSafetyNotice } from './trade-safety.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const DS_BASE = 'https://api.dexscreener.com'

// ─── WETH per chain (DEX routers require ERC-20, not native ETH) ─────

// Native ETH/WETH handling lives in native-eth.ts.

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

// ─── DexScreener chain mapping ───────────────────────────

const DS_CHAIN_TO_KEY: Record<string, string> = {
  ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum',
  optimism: 'optimism', polygon: 'polygon', avalanche: 'avalanche',
  bsc: 'bsc', tempo: 'tempo', abstract: 'abstract',
}

const CHAIN_KEY_TO_DS: Record<string, string> = Object.fromEntries(
  Object.entries(DS_CHAIN_TO_KEY).map(([ds, key]) => [key, ds])
)

// ─── Supported DEX → Router mapping ─────────────────────

interface RouterInfo {
  address: `0x${string}`
  type: 'solidly' | 'v2' | 'v3' // determines which ABI to use
  label: string
  factory?: `0x${string}`
}

// Maps: chainKey → dexId → router info
const DEX_ROUTERS: Record<string, Record<string, RouterInfo>> = {
  ethereum: {
    uniswap: { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', type: 'v3', label: 'Uniswap V3' },
  },
  base: {
    uniswap: { address: '0x2626664c2603336E57B271c5C0b26F421741e481', type: 'v3', label: 'Uniswap V3' },
    aerodrome: {
      address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1BeB874E43',
      type: 'solidly',
      label: 'Aerodrome',
      factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    },
  },
  arbitrum: {
    uniswap: { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', type: 'v3', label: 'Uniswap V3' },
    pancakeswap: { address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', type: 'v3', label: 'PancakeSwap V3' },
  },
  optimism: {
    uniswap: { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', type: 'v3', label: 'Uniswap V3' },
    velodrome: {
      address: '0xa062aE8A9c5e11aaA026fc2670B0D65cCC8B2858',
      type: 'solidly',
      label: 'Velodrome V2',
      factory: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a',
    },
  },
  polygon: {
    uniswap: { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', type: 'v3', label: 'Uniswap V3' },
  },
  bsc: {
    pancakeswap: { address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', type: 'v3', label: 'PancakeSwap V3' },
  },
  abstract: {
    uniswap: { address: '0xad1eCa41E6F772bE3cb5A48A6141f9bcc1AF9F7c', type: 'v2', label: 'Uniswap V2 (Abstract)' },
  },
}

// ─── ABIs ────────────────────────────────────────────────

const erc20Abi = [
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'decimals', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

// Uniswap V3 SwapRouter (original — includes deadline in params)
const v3SwapAbi = [
  {
    name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' }, { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ]}],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

// SwapRouter02 (Base, etc.) — NO deadline in params struct
const v3SwapRouter02Abi = [
  {
    name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ]}],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

// Known SwapRouter02 addresses (no deadline in struct)
const SWAP_ROUTER_02_ADDRS = new Set([
  '0x2626664c2603336E57B271c5C0b26F421741e481'.toLowerCase(), // Base
])

// Uniswap V2 Router (swapExactTokensForTokens with address[] path)
const v2SwapAbi = [
  {
    name: 'swapExactTokensForTokens', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    name: 'getAmountsOut', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

// Aerodrome / Velodrome Router (swapExactTokensForTokens with Route[] path)
const solidlySwapAbi = [
  {
    name: 'swapExactTokensForTokens', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      {
        name: 'routes',
        type: 'tuple[]',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'stable', type: 'bool' },
          { name: 'factory', type: 'address' },
        ],
      },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

// ─── DexScreener types ───────────────────────────────────

interface DsPair {
  chainId: string
  dexId: string
  pairAddress: string
  url: string
  baseToken: { address: string; symbol: string; name: string }
  quoteToken: { address: string; symbol: string; name: string }
  priceUsd: string
  priceNative: string
  txns: { h24: { buys: number; sells: number }; h1: { buys: number; sells: number } }
  volume: { h24: number; h6: number; h1: number }
  priceChange: { h1?: number; h6?: number; h24?: number }
  liquidity: { usd: number; base: number; quote: number }
  fdv?: number
  marketCap?: number
  labels?: string[]
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'dex_intel',
    description: 'Discover token pairs, pools, and liquidity across all DEXes via DexScreener. Find the best venue to trade any token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['search', 'token', 'pair', 'trending'], description: 'Action to perform' },
        query: { type: 'string', description: 'Search query — token name, symbol, or pair (for search)' },
        tokenAddress: { type: 'string', description: 'Token contract address (for token)' },
        chainId: { type: 'string', description: 'Chain ID on DexScreener (for pair, trending). e.g. ethereum, base, arbitrum' },
        pairAddress: { type: 'string', description: 'Pair/pool address (for pair)' },
        limit: { type: 'number', description: 'Max results to return. Default: 10' },
      },
      required: ['action'],
    },
  },
  {
    name: 'smart_swap',
    description: 'Intelligent swap: discovers the best pool via DexScreener, then executes the trade on that exact DEX. Supports Uniswap, PancakeSwap, Aerodrome, Velodrome.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['find_and_swap', 'find_best'], description: 'find_and_swap = discover + execute. find_best = discover only (read-only)' },
        query: { type: 'string', description: 'Token name or symbol to search for' },
        tokenIn: { type: 'string', description: 'Input token address (the token you are selling)' },
        amount: { type: 'number', description: 'Amount to swap (in human units)' },
        chain: { type: 'string', description: 'Preferred chain (optional — auto-selects best if omitted)' },
        slippage: { type: 'number', description: 'Slippage tolerance in %. Default: 1' },
        feeTier: { type: 'number', description: 'Uniswap V3 fee tier. Default: 3000 (0.3%)' },
      },
      required: ['action', 'query'],
    },
  },
]

// ─── Helpers ─────────────────────────────────────────────

function formatPair(p: DsPair, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : ''
  const liq = p.liquidity?.usd ? `$${(p.liquidity.usd / 1e3).toFixed(1)}K` : '?'
  const vol = p.volume?.h24 ? `$${(p.volume.h24 / 1e3).toFixed(1)}K` : '?'
  const change = p.priceChange?.h24 !== undefined ? `${p.priceChange.h24 >= 0 ? '+' : ''}${p.priceChange.h24.toFixed(2)}%` : ''
  const supported = isSupportedPair(p) ? '✅' : '⬜'
  return `${prefix}${supported} ${p.baseToken.symbol}/${p.quoteToken.symbol} on ${p.dexId} (${p.chainId})\n` +
    `   Price: $${parseFloat(p.priceUsd || '0').toLocaleString()} ${change}\n` +
    `   Liquidity: ${liq} | 24h Vol: ${vol}\n` +
    `   Pool: ${p.pairAddress.slice(0, 10)}... | ${p.url}`
}

function isSupportedPair(p: DsPair): boolean {
  const chainKey = DS_CHAIN_TO_KEY[p.chainId]
  if (!chainKey) return false
  const routers = DEX_ROUTERS[chainKey]
  if (!routers) return false
  // Check if the dexId (or a prefix of it) matches a supported DEX
  return Object.keys(routers).some(dex => p.dexId.toLowerCase().startsWith(dex))
}

function findRouter(chainId: string, dexId: string): { chainKey: string; router: RouterInfo } | null {
  const chainKey = DS_CHAIN_TO_KEY[chainId]
  if (!chainKey) return null
  const routers = DEX_ROUTERS[chainKey]
  if (!routers) return null
  // Find matching DEX
  const matchKey = Object.keys(routers).find(dex => dexId.toLowerCase().startsWith(dex))
  if (!matchKey) return null
  return { chainKey, router: routers[matchKey] }
}

function isStableSymbol(symbol: string): boolean {
  return /^(USDC|USDC\.E|USDT|DAI|LUSD|FRAX|USDE|SUSDE)$/i.test(symbol)
}

function buildSolidlyRoutes(pair: DsPair, tokenIn: `0x${string}`, tokenOut: `0x${string}`, factory: `0x${string}`) {
  const stable = isStableSymbol(pair.baseToken.symbol) && isStableSymbol(pair.quoteToken.symbol)
  return [{ from: tokenIn, to: tokenOut, stable, factory }]
}

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  // ═══════════════════════════════════════════════════════
  // DEX INTEL — Pool Discovery
  // ═══════════════════════════════════════════════════════
  if (name === 'dex_intel') {
    switch (args.action) {
      case 'search': {
        if (!args.query) return err('Missing query parameter')
        const query = encodeURIComponent(args.query as string)
        const limit = (args.limit as number) || 10

        try {
          const data = await fetchJson(`${DS_BASE}/latest/dex/search?q=${query}`) as { pairs: DsPair[] }
          const pairs = (data.pairs || []).slice(0, limit)

          if (!pairs.length) return text(`No pools found for "${args.query}".`)

          const lines: string[] = [`🔍 DexScreener: "${args.query}" — ${pairs.length} pools\n`]
          lines.push(`✅ = Supported for auto-swap | ⬜ = View only\n`)

          for (let i = 0; i < pairs.length; i++) {
            lines.push(formatPair(pairs[i], i))
            lines.push('')
          }

          const supported = pairs.filter(isSupportedPair)
          if (supported.length > 0) {
            lines.push(`\n💡 ${supported.length} pool(s) support auto-swap via smart_swap tool.`)
          }

          return text(lines.join('\n'))
        } catch (e) {
          return err(`DexScreener search failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'token': {
        if (!args.tokenAddress) return err('Missing tokenAddress')
        const addr = args.tokenAddress as string
        const limit = (args.limit as number) || 10

        try {
          const data = await fetchJson(`${DS_BASE}/latest/dex/tokens/${addr}`) as { pairs: DsPair[] }
          const pairs = (data.pairs || [])
            .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
            .slice(0, limit)

          if (!pairs.length) return text(`No pools found for token ${addr}.`)

          const tokenName = pairs[0].baseToken.address.toLowerCase() === addr.toLowerCase()
            ? pairs[0].baseToken.symbol : pairs[0].quoteToken.symbol

          const lines: string[] = [`🪙 Pools for ${tokenName} (${addr.slice(0, 10)}...) — sorted by liquidity\n`]
          for (let i = 0; i < pairs.length; i++) {
            lines.push(formatPair(pairs[i], i))
            lines.push('')
          }
          return text(lines.join('\n'))
        } catch (e) {
          return err(`Token lookup failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'pair': {
        if (!args.chainId || !args.pairAddress) return err('Missing chainId or pairAddress')
        const chain = args.chainId as string
        const pair = args.pairAddress as string

        try {
          const data = await fetchJson(`${DS_BASE}/latest/dex/pairs/${chain}/${pair}`) as { pairs: DsPair[] }
          const p = data.pairs?.[0]
          if (!p) return text(`Pool not found on ${chain}.`)

          const routerInfo = findRouter(p.chainId, p.dexId)
          const lines = [
            `📊 Pool Detail\n`,
            formatPair(p),
            `\nBase: ${p.baseToken.name} (${p.baseToken.address})`,
            `Quote: ${p.quoteToken.name} (${p.quoteToken.address})`,
            `24h Txns: ${p.txns.h24.buys} buys / ${p.txns.h24.sells} sells`,
            p.fdv ? `FDV: $${(p.fdv / 1e6).toFixed(2)}M` : '',
            p.marketCap ? `Market Cap: $${(p.marketCap / 1e6).toFixed(2)}M` : '',
            routerInfo ? `\n✅ Auto-swap supported via ${routerInfo.router.label}` : '\n⬜ Auto-swap not supported for this DEX/chain',
          ].filter(Boolean)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Pair lookup failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'trending': {
        try {
          const data = await fetchJson(`${DS_BASE}/token-boosts/latest/v1`) as { url: string; chainId: string; tokenAddress: string; description?: string; amount?: number }[]
          const items = (Array.isArray(data) ? data : []).slice(0, (args.limit as number) || 10)

          if (!items.length) return text('No trending tokens at the moment.')

          const lines: string[] = ['🔥 Trending / Boosted Tokens\n']
          for (let i = 0; i < items.length; i++) {
            const t = items[i]
            lines.push(`${i + 1}. ${t.chainId} — ${t.tokenAddress.slice(0, 10)}...`)
            if (t.description) lines.push(`   ${t.description.slice(0, 80)}`)
            lines.push(`   ${t.url}`)
            lines.push('')
          }
          return text(lines.join('\n'))
        } catch (e) {
          return err(`Trending fetch failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      default: return err(`Unknown dex_intel action: ${args.action}`)
    }
  }

  // ═══════════════════════════════════════════════════════
  // SMART SWAP — Discover + Execute
  // ═══════════════════════════════════════════════════════
  if (name === 'smart_swap') {
    switch (args.action) {
      case 'find_best':
      case 'find_and_swap': {
        if (!args.query) return err('Missing query — provide a token name, symbol, or pair like "PEPE USDC"')

        const query = args.query as string
        const preferredChain = (args.chain as string || '').toLowerCase()
        const amount = args.amount as number | undefined
        const slippage = (args.slippage as number) || 1
        const feeTier = (args.feeTier as number) || 3000

        // Step 1: Search DexScreener
        let pairs: DsPair[]
        try {
          const data = await fetchJson(`${DS_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`) as { pairs: DsPair[] }
          pairs = data.pairs || []
        } catch (e) {
          return err(`DexScreener search failed: ${e instanceof Error ? e.message : String(e)}`)
        }

        if (!pairs.length) return err(`No pools found for "${query}". Try a different search term.`)

        // Step 2: Filter to supported DEXes and chains
        let supported = pairs.filter(isSupportedPair)
        if (preferredChain) {
          const chainFiltered = supported.filter(p => DS_CHAIN_TO_KEY[p.chainId] === preferredChain)
          if (chainFiltered.length > 0) supported = chainFiltered
        }

        if (!supported.length) {
          // Show what was found but not supported
          const topUnsupported = pairs.slice(0, 5)
          const lines = [
            `⚠️ Found ${pairs.length} pools for "${query}" but none on supported DEXes.\n`,
            `Top pools found (not auto-swappable):`,
            ...topUnsupported.map((p, i) => formatPair(p, i)),
            `\nSupported DEXes: Uniswap, PancakeSwap, Aerodrome (Base), Velodrome (Optimism)`,
            `Supported chains: Ethereum, Base, Arbitrum, Optimism, Polygon`,
          ]
          return text(lines.join('\n'))
        }

        // Step 3: Rank by liquidity × volume (best execution)
        supported.sort((a, b) => {
          const scoreA = (a.liquidity?.usd || 0) * Math.log1p(a.volume?.h24 || 0)
          const scoreB = (b.liquidity?.usd || 0) * Math.log1p(b.volume?.h24 || 0)
          return scoreB - scoreA
        })

        const best = supported[0]
        const routerInfo = findRouter(best.chainId, best.dexId)!

        // Step 4: Build recommendation
        const recLines = [
          `🎯 Best Pool for "${query}":\n`,
          formatPair(best),
          `\n📍 Route: ${routerInfo.router.label} on ${routerInfo.chainKey}`,
          `   Router: ${routerInfo.router.address}`,
          `   Type: ${routerInfo.router.type.toUpperCase()}`,
        ]

        if (supported.length > 1) {
          recLines.push(`\n📋 Other options:`)
          for (let i = 1; i < Math.min(supported.length, 4); i++) {
            const alt = supported[i]
            const altRouter = findRouter(alt.chainId, alt.dexId)
            recLines.push(`  ${i + 1}. ${alt.baseToken.symbol}/${alt.quoteToken.symbol} on ${altRouter?.router.label || alt.dexId} (${alt.chainId}) — Liq: $${((alt.liquidity?.usd || 0) / 1e3).toFixed(1)}K`)
          }
        }

        // If find_best, return the recommendation only
        if (args.action === 'find_best') {
          if (amount) {
            recLines.push(`\n💡 To execute: use smart_swap with action 'find_and_swap', amount: ${amount}`)
          }
          return text(recLines.join('\n'))
        }

        // ═══ EXECUTE: find_and_swap ═══

        if (!amount) return err('Missing amount for find_and_swap. How much do you want to swap?')
        if (!args.tokenIn) return err('Missing tokenIn — provide the address of the token you are selling')

        const chainKey = routerInfo.chainKey
        const tokenInForPairSelection = resolveNativeToWeth(args.tokenIn as string, chainKey)

        // Determine tokenOut from the best pair (also resolve if native ETH)
        const rawTokenOut = (tokenInForPairSelection.toLowerCase() === best.baseToken.address.toLowerCase()
          ? best.quoteToken.address
          : best.baseToken.address)
        // Check if the output resolves to WETH — user probably wants native ETH
        const rawTokenOutForPlan = isExplicitNativeEthRequest(query) ? 'ETH' : rawTokenOut
        const ethPlan = getNativeEthPlan(args.tokenIn as string, rawTokenOutForPlan, chainKey)
        const { tokenIn, tokenOut } = ethPlan
        const safetyNotice = await buildTradeSafetyNotice(chainKey, [args.tokenIn as string, rawTokenOut])

        try {
          const w = getOrCreateWallet()
          const pub = getPublicClient(chainKey)
          const wc = getChainsWalletClient(chainKey, w)
          const account = getAccount(w)
          const chainConfig = SUPPORTED_CHAINS[chainKey]

          // Get decimals
          const decimals = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'decimals' }) as number
          const amountIn = parseUnits(String(amount), decimals)
          const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)

          if (ethPlan.directWrap) {
            const hash = await wc.writeContract({
              account, chain: chainConfig.chain,
              address: ethPlan.weth,
              abi: nativeWethAbi,
              functionName: 'deposit',
              args: [],
              value: amountIn,
            })
            await pub.waitForTransactionReceipt({ hash })
            recLines.push(
              `\nSwap Executed!`,
              `   From: ${amount} ETH`,
              `   To: WETH`,
              `   Chain: ${chainKey}`,
              `   Wallet: ${w.name} (${w.address})`,
              `   Tx: ${explorerTxUrl(chainKey, hash)}`,
            )
            return text(recLines.join('\n'))
          }

          if (ethPlan.directUnwrap) {
            const balance = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] }) as bigint
            if (balance < amountIn) return err(`Insufficient WETH balance. Need ${amount}, available ${formatUnits(balance, decimals)}.`)
            const hash = await wc.writeContract({
              account, chain: chainConfig.chain,
              address: tokenIn,
              abi: nativeWethAbi,
              functionName: 'withdraw',
              args: [amountIn],
            })
            await pub.waitForTransactionReceipt({ hash })
            recLines.push(
              `\nSwap Executed!`,
              `   From: ${amount} WETH`,
              `   To: ETH`,
              `   Chain: ${chainKey}`,
              `   Wallet: ${w.name} (${w.address})`,
              `   Tx: ${explorerTxUrl(chainKey, hash)}`,
            )
            return text(recLines.join('\n'))
          }

          if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
            return err(`Input and output resolve to the same token (${tokenIn}). Choose two different assets for a swap.`)
          }

          if (ethPlan.wrapInput) {
            const wrapTx = await wc.writeContract({
              account, chain: chainConfig.chain,
              address: ethPlan.weth,
              abi: nativeWethAbi,
              functionName: 'deposit',
              args: [],
              value: amountIn,
            })
            await pub.waitForTransactionReceipt({ hash: wrapTx })
          }

          const preUnwrapWethBalance = ethPlan.unwrapOutput
            ? await pub.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] }) as bigint
            : 0n

          // Approve only this swap amount. If an older broader approval exists,
          // replace it so the router cannot keep unused allowance.
          const allowance = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [w.address, routerInfo.router.address] }) as bigint
          if (allowance !== amountIn) {
            if (allowance > 0n) {
              const resetTx = await wc.writeContract({
                account, chain: chainConfig.chain,
                address: tokenIn, abi: erc20Abi, functionName: 'approve',
                args: [routerInfo.router.address, 0n],
              })
              await pub.waitForTransactionReceipt({ hash: resetTx })
            }
            const approveTx = await wc.writeContract({
              account, chain: chainConfig.chain,
              address: tokenIn, abi: erc20Abi, functionName: 'approve',
              args: [routerInfo.router.address, amountIn],
            })
            await pub.waitForTransactionReceipt({ hash: approveTx })
          }

          let hash: `0x${string}`

          if (routerInfo.router.type === 'v3') {
            const isRouter02 = SWAP_ROUTER_02_ADDRS.has(routerInfo.router.address.toLowerCase())
            if (isRouter02) {
              hash = await wc.writeContract({
                account, chain: chainConfig.chain,
                address: routerInfo.router.address,
                abi: v3SwapRouter02Abi,
                functionName: 'exactInputSingle',
                args: [{
                  tokenIn, tokenOut, fee: feeTier,
                  recipient: w.address, amountIn,
                  amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
                }],
              })
            } else {
              hash = await wc.writeContract({
                account, chain: chainConfig.chain,
                address: routerInfo.router.address,
                abi: v3SwapAbi,
                functionName: 'exactInputSingle',
                args: [{
                  tokenIn, tokenOut, fee: feeTier,
                  recipient: w.address, deadline, amountIn,
                  amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
                }],
              })
            }
          } else if (routerInfo.router.type === 'solidly') {
            if (!routerInfo.router.factory) throw new Error(`${routerInfo.router.label} factory is not configured.`)
            hash = await wc.writeContract({
              account, chain: chainConfig.chain,
              address: routerInfo.router.address,
              abi: solidlySwapAbi,
              functionName: 'swapExactTokensForTokens',
              args: [amountIn, 0n, buildSolidlyRoutes(best, tokenIn, tokenOut, routerInfo.router.factory), w.address, deadline],
            })
          } else {
            // V2 style with address[] path
            hash = await wc.writeContract({
              account, chain: chainConfig.chain,
              address: routerInfo.router.address,
              abi: v2SwapAbi,
              functionName: 'swapExactTokensForTokens',
              args: [amountIn, 0n, [tokenIn, tokenOut], w.address, deadline],
            })
          }

          await pub.waitForTransactionReceipt({ hash })

          // Convert router WETH output back to native ETH when ETH was requested.
          if (ethPlan.unwrapOutput) {
            const amountToUnwrap = await waitForTokenBalanceIncrease(pub, tokenOut, w.address, preUnwrapWethBalance)
            if (amountToUnwrap > 0n) {
              const unwrapHash = await wc.writeContract({
                account, chain: chainConfig.chain,
                address: tokenOut,
                abi: nativeWethAbi,
                functionName: 'withdraw',
                args: [amountToUnwrap],
              })
              await pub.waitForTransactionReceipt({ hash: unwrapHash })
            }
          }

          const explorer = explorerTxUrl(chainKey, hash)
          const outSymbol = best.baseToken.address.toLowerCase() === tokenIn.toLowerCase() ? best.quoteToken.symbol : best.baseToken.symbol
          const inputLabel = ethPlan.inputIsNative ? 'ETH' : `${tokenIn.slice(0, 10)}...`
          const outputLabel = ethPlan.outputIsNative ? 'ETH' : outSymbol

          recLines.push(
            safetyNotice.trim() ? `\n${safetyNotice.trim()}` : '',
            `\nSwap Executed!`,
            `   From: ${amount} (${inputLabel})`,
            `   To: ${outputLabel}`,
            `   Chain: ${chainKey}`,
            `   DEX: ${routerInfo.router.label}`,
            `   Wallet: ${w.name} (${w.address})`,
            `   Tx: ${explorer}`,
          )

          return text(recLines.join('\n'))
        } catch (e) {
          recLines.push(`\n❌ Execution failed: ${e instanceof Error ? e.message : String(e)}`)
          return { content: [{ type: 'text' as const, text: recLines.join('\n') }], isError: true }
        }
      }

      default: return err(`Unknown smart_swap action: ${args.action}`)
    }
  }

  return null
}

// ─── Module Export ────────────────────────────────────────

const dexIntelModule: ToolModule = { tools: TOOLS, handle }
export default dexIntelModule
