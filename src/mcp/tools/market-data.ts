/**
 * ./AGENT Protocol — Market Data Tools
 * Real-time price data, charts and gas prices.
 * Read-only tools — no wallet or signing needed.
 */

import type { ToolModule } from './index.js'
import { isRemovedIntegration } from './integration-policy.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

// ─── CoinGecko Helpers ───────────────────────────────────

const CG_BASE = 'https://api.coingecko.com/api/v3'

// Map common symbols to CoinGecko IDs
const SYMBOL_MAP: Record<string, string> = {
  btc: 'bitcoin', wbtc: 'bitcoin',
  eth: 'ethereum', weth: 'ethereum',
  usdc: 'usd-coin', 'usdc.e': 'usd-coin',
  usdt: 'tether', usdt0: 'tether',
  'eurc.e': 'euro-coin', eurc: 'euro-coin',
  bnb: 'binancecoin',
  avax: 'avalanche-2',
  matic: 'matic-network', pol: 'matic-network',
  arb: 'arbitrum',
  op: 'optimism',
  link: 'chainlink',
  uni: 'uniswap',
  aave: 'aave',
  mkr: 'maker',
  snx: 'havven',
  crv: 'curve-dao-token',
  doge: 'dogecoin',
  pepe: 'pepe',
  sui: 'sui',
  apt: 'aptos',
  near: 'near',
  atom: 'cosmos',
  dot: 'polkadot',
  ada: 'cardano',
  xrp: 'ripple',
}

function resolveCoingeckoId(symbol: string): string {
  const lower = symbol.toLowerCase().replace(/\s+/g, '-')
  return SYMBOL_MAP[lower] || lower
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'market_data',
    description: 'Get real-time market data including prices, charts and gas fees.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['price', 'prices', 'chart', 'gas'], description: 'Action to perform' },
        token: { type: 'string', description: 'Token symbol (for price, chart)' },
        tokens: { type: 'string', description: 'Comma-separated token symbols (for prices)' },
        currency: { type: 'string', description: 'Quote currency. Default: usd (for price, prices)' },
        days: { type: 'number', description: 'Number of days of data. Options: 1, 7, 14, 30, 90, 180, 365. Default: 7 (for chart)' },
        chain: { type: 'string', description: 'Optional specific chain (for gas)' },
      },
      required: ['action'],
    },
  },
]

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'market_data') {
    if ([args.token, args.chain, ...String(args.tokens || '').split(',')].some(isRemovedIntegration)) return err('This integration is not supported.')
    switch (args.action) {
      case 'price': {
        if (!args.token) return err('Missing token parameter')
        const symbol = args.token as string
        const currency = (args.currency as string) || 'usd'
        const id = resolveCoingeckoId(symbol)

        try {
          const data = await fetchJson(`${CG_BASE}/simple/price?ids=${id}&vs_currencies=${currency}&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`) as Record<string, Record<string, number>>
          const info = data[id]
          if (!info) return err(`Token "${symbol}" not found. Try using the full name.`)

          const price = info[currency]
          const change = info[`${currency}_24h_change`]
          const vol = info[`${currency}_24h_vol`]
          const mcap = info[`${currency}_market_cap`]

          const changeStr = change !== undefined ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : 'N/A'
          const volStr = vol !== undefined ? `$${(vol / 1e6).toFixed(2)}M` : 'N/A'
          const mcapStr = mcap !== undefined ? `$${(mcap / 1e9).toFixed(2)}B` : 'N/A'

          return text(`💰 ${symbol.toUpperCase()}: $${price.toLocaleString()}\n\n24h Change: ${changeStr}\n24h Volume: ${volStr}\nMarket Cap: ${mcapStr}\nSource: CoinGecko`)
        } catch (e) {
          return err(`Failed to fetch price for "${symbol}": ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'prices': {
        if (!args.tokens) return err('Missing tokens parameter')
        const symbols = (args.tokens as string).split(',').map((s) => s.trim())
        const currency = (args.currency as string) || 'usd'
        const ids = symbols.map(resolveCoingeckoId).join(',')

        try {
          const data = await fetchJson(`${CG_BASE}/simple/price?ids=${ids}&vs_currencies=${currency}&include_24hr_change=true`) as Record<string, Record<string, number>>
          const lines: string[] = ['💰 Token Prices:\n']

          for (const symbol of symbols) {
            const id = resolveCoingeckoId(symbol)
            const info = data[id]
            if (!info) {
              lines.push(`  ${symbol.toUpperCase().padEnd(8)} — Not found`)
              continue
            }
            const price = info[currency]
            const change = info[`${currency}_24h_change`]
            const changeStr = change !== undefined ? ` (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)` : ''
            lines.push(`  ${symbol.toUpperCase().padEnd(8)} $${price.toLocaleString()}${changeStr}`)
          }

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Failed to fetch prices: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'chart': {
        if (!args.token) return err('Missing token parameter')
        const symbol = args.token as string
        const days = (args.days as number) || 7
        const id = resolveCoingeckoId(symbol)

        try {
          const data = await fetchJson(`${CG_BASE}/coins/${id}/ohlc?vs_currency=usd&days=${days}`) as number[][]
          if (!data || !data.length) return err(`No chart data for "${symbol}".`)

          // Take last 10 candles for readability
          const recent = data.slice(-10)
          const lines: string[] = [
            `📈 ${symbol.toUpperCase()} — ${days}d Chart (last ${recent.length} candles):\n`,
            `${'Date'.padEnd(18)} ${'Open'.padEnd(12)} ${'High'.padEnd(12)} ${'Low'.padEnd(12)} Close`,
            `${'─'.repeat(66)}`,
          ]

          for (const [ts, open, high, low, close] of recent) {
            const date = new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
            lines.push(`${date.padEnd(18)} ${('$' + open.toFixed(2)).padEnd(12)} ${('$' + high.toFixed(2)).padEnd(12)} ${('$' + low.toFixed(2)).padEnd(12)} $${close.toFixed(2)}`)
          }

          const first = data[0][4]
          const last = data[data.length - 1][4]
          const pctChange = ((last - first) / first * 100).toFixed(2)
          lines.push(`\n${days}d Change: ${Number(pctChange) >= 0 ? '+' : ''}${pctChange}%`)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Failed to fetch chart data: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'gas': {
        const chain = args.chain as string | undefined

        // Gas is generally very low on L2s, so we provide estimates
        const GAS_ESTIMATES: Record<string, { label: string; gas: string; note: string }> = {
          ethereum: { label: 'Ethereum', gas: 'Variable', note: 'Check etherscan.io/gastracker' },
          arbitrum: { label: 'Arbitrum', gas: '~0.01-0.10 USD', note: 'L2 — very low fees' },
          base: { label: 'Base', gas: '~0.01-0.05 USD', note: 'L2 — very low fees' },
          optimism: { label: 'Optimism', gas: '~0.01-0.10 USD', note: 'L2 — very low fees' },
          polygon: { label: 'Polygon', gas: '~0.01 USD', note: 'Very low fees' },
          avalanche: { label: 'Avalanche', gas: '~0.02-0.10 USD', note: 'C-Chain' },
        }

        if (chain) {
          const info = GAS_ESTIMATES[chain.toLowerCase()]
          if (!info) return err(`Unknown chain. Available: ${Object.keys(GAS_ESTIMATES).join(', ')}`)
          return text(`⛽ ${info.label} Gas: ${info.gas}\n${info.note}`)
        }

        const lines = ['⛽ Gas Estimates Across Chains:\n']
        for (const [, info] of Object.entries(GAS_ESTIMATES)) {
          lines.push(`  ${info.label.padEnd(12)} ${info.gas.padEnd(18)} ${info.note}`)
        }
        return text(lines.join('\n'))
      }

      default: return err(`Unknown market_data action: ${args.action}`)
    }
  }

  return null
}

// ─── Module Export ────────────────────────────────────────

const marketDataModule: ToolModule = { tools: TOOLS, handle }
export default marketDataModule
