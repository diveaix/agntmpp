/**
 * ./AGNT Protocol — Analytics & Intelligence Tools
 * Portfolio tracking, PnL, whale activity, sentiment, and token security.
 */

import type { ToolModule } from './index.js'
import { getActiveWallet } from '../wallet.js'
import { getPublicClient } from '../chains.js'
import { assessTokenTradeSafety, formatTradeSafetyNotice } from './trade-safety.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

const TOOLS = [
  {
    name: 'analytics',
    description: 'Analytics & Intelligence Tools for portfolio, PnL, whale activity, sentiment, security, and ENS.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['portfolio', 'pnl', 'whale_activity', 'token_security', 'sentiment', 'resolve_ens'], description: 'Action to perform' },
        period: { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Time period. Default: 7d (for pnl)' },
        token: { type: 'string', description: 'Token symbol or address (for whale_activity, token_security)' },
        minUsd: { type: 'number', description: 'Minimum transaction size in USD. Default: 100000 (for whale_activity)' },
        chain: { type: 'string', description: 'Chain to check on. Default: ethereum (for token_security)' },
        name: { type: 'string', description: 'ENS name or address (for resolve_ens)' },
      },
      required: ['action'],
    },
  },
]

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'analytics') {
    switch (args.action) {
      case 'portfolio': {
        const w = getActiveWallet()
        if (!w) return text('No wallet. Create one first.')

        // Aggregate from Hyperliquid positions if available
        const lines: string[] = ['📊 Portfolio Summary\n']
        lines.push(`Wallet: ${w.name} (${w.address})\n`)

        // Check HL account
        try {
          const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: w.address }),
          })
          const hlData = await hlRes.json() as { marginSummary: { accountValue: string } }
          const hlValue = parseFloat(hlData.marginSummary.accountValue)
          if (hlValue > 0) {
            lines.push(`  Hyperliquid:  $${hlValue.toFixed(2)}`)
          }
        } catch { /* HL not connected */ }

        lines.push(`\n💡 For on-chain balances per chain, use wallet_info or get_balance.`)
        lines.push(`💡 For Aave positions, use aave_positions.`)
        return text(lines.join('\n'))
      }

      case 'pnl': {
        const w = getActiveWallet()
        if (!w) return text('No wallet. Create one first.')
        const period = (args.period as string) || '7d'

        // Pull from HL if available
        const lines: string[] = [`📊 PnL Report (${period})\n`]
        lines.push(`Wallet: ${w.name}\n`)

        try {
          const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: w.address }),
          })
          const hlData = await hlRes.json() as {
            marginSummary: { accountValue: string }
            assetPositions: { position: { coin: string; unrealizedPnl: string; szi: string } }[]
          }

          const positions = hlData.assetPositions.filter((p) => parseFloat(p.position.szi) !== 0)
          if (positions.length) {
            let totalUpnl = 0
            lines.push('Hyperliquid Positions:')
            for (const { position: p } of positions) {
              const upnl = parseFloat(p.unrealizedPnl)
              totalUpnl += upnl
              lines.push(`  ${p.coin.padEnd(8)} uPnL: ${upnl >= 0 ? '+' : ''}$${upnl.toFixed(2)}`)
            }
            lines.push(`\n  Total Unrealized: ${totalUpnl >= 0 ? '+' : ''}$${totalUpnl.toFixed(2)}`)
          } else {
            lines.push('  No open Hyperliquid positions.')
          }
        } catch {
          lines.push('  Hyperliquid: Not connected or no positions.')
        }

        lines.push(`\n💡 On-chain PnL tracking requires indexing transaction history.`)
        return text(lines.join('\n'))
      }

      case 'whale_activity': {
        const token = (args.token as string).toLowerCase()
        const minUsd = (args.minUsd as number) || 100_000

        // Use a free whale alert approximation via CoinGecko trending + market data
        try {
          const lines: string[] = [`🐋 Whale Activity — ${token.toUpperCase()}\n`]
          lines.push(`Min Transaction: $${minUsd.toLocaleString()}\n`)

          // For now, provide market context that indicates whale activity
          const CG_MAP: Record<string, string> = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', hype: 'hyperliquid', doge: 'dogecoin', arb: 'arbitrum', op: 'optimism' }
          const id = CG_MAP[token] || token
          const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`) as {
            market_data: { total_volume: { usd: number }; price_change_percentage_24h: number; market_cap: { usd: number } }
            name: string
          }

          const vol = data.market_data.total_volume.usd
          const change = data.market_data.price_change_percentage_24h
          const mcap = data.market_data.market_cap.usd

          lines.push(`Market Context:`)
          lines.push(`  24h Volume: $${(vol / 1e6).toFixed(1)}M`)
          lines.push(`  24h Change: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`)
          lines.push(`  Market Cap: $${(mcap / 1e9).toFixed(2)}B`)
          lines.push(`  Vol/MCap Ratio: ${(vol / mcap * 100).toFixed(2)}% ${vol / mcap > 0.15 ? '⚠️ HIGH — unusual activity' : ''}`)
          lines.push(`\n💡 High volume/mcap ratio often indicates whale accumulation or distribution.`)
          lines.push(`💡 For real-time whale alerts, connect a Whale Alert API integration.`)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Failed to fetch whale data: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'token_security': {
        const token = args.token as string
        const chain = (args.chain as string || 'ethereum').toLowerCase()

        const lines: string[] = [`🛡️ Token Security Check\n`]
        lines.push(`Token: ${token}`)
        lines.push(`Chain: ${chain}\n`)

        // Use GoPlus Security API (free, no key needed)
        try {
          const chainIds: Record<string, string> = { ethereum: '1', arbitrum: '42161', base: '8453', optimism: '10', polygon: '137', avalanche: '43114', bsc: '56' }
          const chainId = chainIds[chain] || '1'
          const data = await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${token}`) as {
            result: Record<string, {
              is_honeypot?: string; is_open_source?: string; is_proxy?: string;
              owner_address?: string; can_take_back_ownership?: string;
              buy_tax?: string; sell_tax?: string; is_mintable?: string;
              holder_count?: string; lp_holder_count?: string;
              is_anti_whale?: string; cannot_sell_all?: string;
              token_name?: string; token_symbol?: string;
            }>
          }

          const addr = Object.keys(data.result)[0]
          const info = data.result[addr]

          if (!info) {
            lines.push('⚠️ Token not found in security database.')
            return text(lines.join('\n'))
          }

          lines.push(`Name: ${info.token_name || 'Unknown'} (${info.token_symbol || '?'})`)
          lines.push(`\nSecurity Checks:`)
          lines.push(`  Honeypot: ${info.is_honeypot === '1' ? '🔴 YES — DANGER' : '🟢 No'}`)
          lines.push(`  Open Source: ${info.is_open_source === '1' ? '🟢 Yes' : '🟡 No — unverified'}`)
          lines.push(`  Proxy Contract: ${info.is_proxy === '1' ? '🟡 Yes — upgradeable' : '🟢 No'}`)
          lines.push(`  Mintable: ${info.is_mintable === '1' ? '🟡 Yes — supply can increase' : '🟢 No'}`)
          lines.push(`  Can't Sell All: ${info.cannot_sell_all === '1' ? '🔴 YES — DANGER' : '🟢 No'}`)

          const buyTax = parseFloat(info.buy_tax || '0') * 100
          const sellTax = parseFloat(info.sell_tax || '0') * 100
          lines.push(`\nTax:`)
          lines.push(`  Buy Tax: ${buyTax.toFixed(1)}% ${buyTax > 10 ? '🔴 HIGH' : buyTax > 5 ? '🟡' : '🟢'}`)
          lines.push(`  Sell Tax: ${sellTax.toFixed(1)}% ${sellTax > 10 ? '🔴 HIGH' : sellTax > 5 ? '🟡' : '🟢'}`)

          lines.push(`\nHolders: ${info.holder_count || 'Unknown'}`)
          lines.push(`LP Holders: ${info.lp_holder_count || 'Unknown'}`)

          const dangers = [info.is_honeypot === '1', info.cannot_sell_all === '1', sellTax > 20].filter(Boolean).length
          lines.push(`\nRisk Level: ${dangers > 0 ? '🔴 HIGH RISK' : buyTax > 5 || sellTax > 5 ? '🟡 MEDIUM RISK' : '🟢 LOW RISK'}`)

          const tradability = await assessTokenTradeSafety(chain, token)
          if (tradability) {
            lines.push(`\n${formatTradeSafetyNotice(tradability)}`)
            lines.push(`Tradability: ${tradability.pairCount > 0 ? 'Market found' : 'No active DEX market found'}`)
          }

          lines.push(`Source: GoPlus Security API`)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Security check failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'sentiment': {
        try {
          // Fear & Greed Index
          const fgData = await fetchJson('https://api.alternative.me/fng/?limit=1') as { data: { value: string; value_classification: string; timestamp: string }[] }
          const fg = fgData.data[0]

          // CoinGecko trending
          const trending = await fetchJson('https://api.coingecko.com/api/v3/search/trending') as { coins: { item: { name: string; symbol: string; market_cap_rank: number; data: { price_change_percentage_24h: { usd: number } } } }[] }

          const lines: string[] = ['📊 Crypto Market Sentiment\n']

          // Fear & Greed
          const fgVal = parseInt(fg.value)
          const fgBar = '█'.repeat(Math.floor(fgVal / 5)) + '░'.repeat(20 - Math.floor(fgVal / 5))
          lines.push(`Fear & Greed Index: ${fg.value}/100 — ${fg.value_classification}`)
          lines.push(`[${fgBar}]`)
          lines.push('')

          // Trending coins
          lines.push('🔥 Trending on CoinGecko:')
          for (const { item } of trending.coins.slice(0, 8)) {
            const change = item.data?.price_change_percentage_24h?.usd
            const changeStr = change !== undefined ? ` (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)` : ''
            lines.push(`  ${item.symbol.toUpperCase().padEnd(8)} ${item.name}${changeStr} — #${item.market_cap_rank || '?'}`)
          }

          lines.push('\nSources: Alternative.me, CoinGecko')
          return text(lines.join('\n'))
        } catch (e) {
          return err(`Sentiment fetch failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'resolve_ens': {
        const input = args.name as string

        try {
          const pub = getPublicClient('ethereum')

          if (input.endsWith('.eth') || input.includes('.')) {
            // Forward lookup: name → address
            const address = await pub.getEnsAddress({ name: input })
            if (!address) return text(`❌ ENS name "${input}" not found.`)
            return text(`🔗 ${input} → ${address}`)
          } else {
            // Reverse lookup: address → name
            const ensName = await pub.getEnsName({ address: input as `0x${string}` })
            if (!ensName) return text(`No ENS name found for ${input}`)
            return text(`🔗 ${input} → ${ensName}`)
          }
        } catch (e) {
          return err(`ENS lookup failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      default: return err(`Unknown analytics action: ${args.action}`)
    }
  }

  return null
}

const analyticsModule: ToolModule = { tools: TOOLS, handle }
export default analyticsModule
