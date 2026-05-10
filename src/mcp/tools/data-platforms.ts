/**
 * ./AGNT Protocol — Data Platforms & Prediction Markets
 * DefiLlama (TVL/yield data), Dune Analytics (on-chain queries), Polymarket (prediction markets).
 */

import type { ToolModule } from './index.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'defillama',
    description: 'Get TVL, yields, protocol details, and stablecoin data from DefiLlama.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['tvl', 'yields', 'protocol', 'stablecoins'], description: 'Action to perform' },
        protocol: { type: 'string', description: 'Protocol slug or chain name (for tvl, protocol)' },
        type: { type: 'string', enum: ['protocol', 'chain'], description: 'Type: protocol or chain (for tvl)' },
        token: { type: 'string', description: 'Token to filter (for yields)' },
        chain: { type: 'string', description: 'Chain to filter (for yields)' },
        minApy: { type: 'number', description: 'Minimum APY (for yields)' },
        minTvl: { type: 'number', description: 'Minimum TVL (for yields)' },
        limit: { type: 'number', description: 'Result limit (for yields)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'dune',
    description: 'Search and execute Dune Analytics queries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['query', 'search'], description: 'Action to perform' },
        queryId: { type: 'number', description: 'Dune query ID (for query)' },
        params: { type: 'string', description: 'JSON string of query parameters (for query)' },
        query: { type: 'string', description: 'Search term (for search)' },
        limit: { type: 'number', description: 'Result limit (for search)' },
      },
      required: ['action'],
    },
  },
  // Polymarket moved to standalone module (polymarket.ts)
]

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'defillama') {
    switch (args.action) {
      case 'tvl': {
        if (!args.protocol) return err('Missing protocol parameter')
        const protocol = (args.protocol as string).toLowerCase()
        const type = (args.type as string) || 'protocol'

        try {
          if (type === 'chain') {
            const data = await fetchJson(`https://api.llama.fi/v2/chains`) as { name: string; tvl: number }[]
            const chain = data.find(c => c.name.toLowerCase() === protocol)
            if (!chain) return err(`Chain "${protocol}" not found. Try: ethereum, arbitrum, base, polygon, etc.`)

            return text(
              `📊 Chain TVL — ${chain.name}\n\n` +
              `Total Value Locked: $${(chain.tvl / 1e9).toFixed(2)}B\n\n` +
              `Source: DefiLlama`
            )
          }

          const data = await fetchJson(`https://api.llama.fi/protocol/${protocol}`) as {
            name: string; tvl: number; chainTvls: Record<string, { tvl: { date: number; totalLiquidityUSD: number }[] }>
            category: string; chains: string[]; url: string
          }

          const lines: string[] = [`📊 ${data.name} — DefiLlama\n`]
          lines.push(`Category: ${data.category || 'N/A'}`)
          lines.push(`Total TVL: $${(data.tvl / 1e9).toFixed(2)}B`)
          lines.push(`Chains: ${data.chains?.slice(0, 8).join(', ') || 'N/A'}`)
          lines.push(`Website: ${data.url || 'N/A'}`)
          lines.push(`\nSource: DefiLlama`)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`TVL fetch failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'yields': {
        const tokenFilter = args.token as string | undefined
        const chainFilter = args.chain as string | undefined
        const minApy = (args.minApy as number) || 0
        const minTvl = (args.minTvl as number) || 1_000_000
        const limit = (args.limit as number) || 15

        try {
          const data = await fetchJson('https://yields.llama.fi/pools') as {
            data: { pool: string; chain: string; project: string; symbol: string; tvlUsd: number; apy: number; apyBase: number }[]
          }

          let pools = data.data
            .filter(p => p.tvlUsd > minTvl)
            .filter(p => p.apy > minApy)

          if (tokenFilter) {
            const tf = tokenFilter.toLowerCase()
            pools = pools.filter(p => p.symbol.toLowerCase().includes(tf))
          }
          if (chainFilter) {
            const cf = chainFilter.toLowerCase()
            pools = pools.filter(p => p.chain.toLowerCase() === cf)
          }

          pools.sort((a, b) => b.apy - a.apy)
          const top = pools.slice(0, limit)

          if (!top.length) return text(`No yield opportunities found matching your filters.`)

          const lines: string[] = [`💰 DeFi Yield Opportunities\n`]
          if (tokenFilter) lines[0] += ` (${tokenFilter})`
          if (chainFilter) lines[0] += ` on ${chainFilter}`
          lines.push(`${'Protocol'.padEnd(18)} ${'Token'.padEnd(14)} ${'Chain'.padEnd(12)} ${'APY'.padEnd(10)} TVL`)
          lines.push('─'.repeat(68))

          for (const p of top) {
            lines.push(
              `${p.project.slice(0, 17).padEnd(18)} ${p.symbol.slice(0, 13).padEnd(14)} ${p.chain.padEnd(12)} ${p.apy.toFixed(2).padEnd(10)}% $${(p.tvlUsd / 1e6).toFixed(1)}M`
            )
          }

          lines.push(`\nFilters: TVL > $${(minTvl / 1e6).toFixed(1)}M | APY > ${minApy}%`)
          lines.push(`Source: DefiLlama Yields API`)
          return text(lines.join('\n'))
        } catch (e) {
          return err(`Yield search failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'protocol': {
        if (!args.protocol) return err('Missing protocol parameter')
        const protocol = (args.protocol as string).toLowerCase()

        try {
          const data = await fetchJson(`https://api.llama.fi/protocol/${protocol}`) as {
            name: string; tvl: number; category: string; chains: string[]
            url: string; description: string; gecko_id: string
            change_1h: number; change_1d: number; change_7d: number
          }

          const lines: string[] = [`📊 Protocol Details — ${data.name}\n`]
          lines.push(`Description: ${data.description?.slice(0, 120) || 'N/A'}`)
          lines.push(`Category: ${data.category || 'N/A'}`)
          lines.push(`TVL: $${(data.tvl / 1e9).toFixed(2)}B`)
          if (data.change_1d !== undefined) lines.push(`TVL Change (24h): ${data.change_1d > 0 ? '+' : ''}${data.change_1d?.toFixed(2)}%`)
          if (data.change_7d !== undefined) lines.push(`TVL Change (7d): ${data.change_7d > 0 ? '+' : ''}${data.change_7d?.toFixed(2)}%`)
          lines.push(`Chains: ${data.chains?.join(', ') || 'N/A'}`)
          lines.push(`Website: ${data.url || 'N/A'}`)
          if (data.gecko_id) lines.push(`CoinGecko: ${data.gecko_id}`)
          lines.push(`\nSource: DefiLlama`)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Protocol fetch failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'stablecoins': {
        try {
          const data = await fetchJson('https://stablecoins.llama.fi/stablecoins?includePrices=true') as {
            peggedAssets: { name: string; symbol: string; pegType: string; circulating: { peggedUSD: number }; price: number }[]
          }

          const stables = data.peggedAssets
            .filter(s => s.circulating?.peggedUSD > 100_000_000)
            .sort((a, b) => (b.circulating?.peggedUSD || 0) - (a.circulating?.peggedUSD || 0))
            .slice(0, 15)

          const lines: string[] = ['📊 Stablecoin Market Data\n']
          lines.push(`${'Token'.padEnd(10)} ${'Supply'.padEnd(14)} ${'Price'.padEnd(10)} Peg Type`)
          lines.push('─'.repeat(44))

          for (const s of stables) {
            const supply = `$${((s.circulating?.peggedUSD || 0) / 1e9).toFixed(2)}B`
            const price = s.price ? `$${s.price.toFixed(4)}` : 'N/A'
            lines.push(`${s.symbol.padEnd(10)} ${supply.padEnd(14)} ${price.padEnd(10)} ${s.pegType || 'USD'}`)
          }

          const totalSupply = stables.reduce((s, t) => s + (t.circulating?.peggedUSD || 0), 0)
          lines.push(`\nTotal Stablecoin Supply: $${(totalSupply / 1e9).toFixed(2)}B`)
          lines.push(`Source: DefiLlama Stablecoins`)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Stablecoin data failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      default: return err(`Unknown defillama action: ${args.action}`)
    }
  }

  if (name === 'dune') {
    switch (args.action) {
      case 'query': {
        if (!args.queryId) return err('Missing queryId parameter')
        const queryId = args.queryId as number
        const params = args.params as string | undefined
        const apiKey = process.env.DUNE_API_KEY

        if (!apiKey) {
          return text(
            `📊 Dune Analytics — Query #${queryId}\n\n` +
            `⚠️ DUNE_API_KEY not configured.\n\n` +
            `To use Dune:\n` +
            `  1. Get an API key at https://dune.com/settings/api\n` +
            `  2. Set it: export DUNE_API_KEY=your_key\n\n` +
            `View this query: https://dune.com/queries/${queryId}\n\n` +
            `Popular Dune Queries:\n` +
            `  #3237721 — DEX Volume by Protocol\n` +
            `  #2030664 — Ethereum Gas Tracker\n` +
            `  #1847009 — Top Whale Wallets\n` +
            `  #3521868 — Stablecoin Flows`
          )
        }

        try {
          // Execute query
          const execRes = await fetch(`https://api.dune.com/api/v1/query/${queryId}/execute`, {
            method: 'POST',
            headers: { 'X-Dune-API-Key': apiKey, 'Content-Type': 'application/json' },
            body: params ? JSON.stringify({ query_parameters: JSON.parse(params) }) : '{}',
          })
          const execData = await execRes.json() as { execution_id: string }

          // Get results (poll)
          const resultRes = await fetch(`https://api.dune.com/api/v1/execution/${execData.execution_id}/results?limit=20`, {
            headers: { 'X-Dune-API-Key': apiKey },
          })
          const resultData = await resultRes.json() as { result?: { rows: Record<string, unknown>[] }; state: string }

          if (resultData.state !== 'QUERY_STATE_COMPLETED') {
            return text(`⏳ Query #${queryId} is still executing (${resultData.state}).\n\nExecution ID: ${execData.execution_id}\nTry again in a few seconds.`)
          }

          const rows = resultData.result?.rows || []
          if (!rows.length) return text(`Query #${queryId} returned no results.`)

          const cols = Object.keys(rows[0])
          const lines: string[] = [`📊 Dune Query #${queryId} Results\n`]
          lines.push(cols.map(c => c.slice(0, 16).padEnd(18)).join(''))
          lines.push('─'.repeat(cols.length * 18))

          for (const row of rows.slice(0, 15)) {
            lines.push(cols.map(c => String(row[c] ?? '').slice(0, 16).padEnd(18)).join(''))
          }

          if (rows.length > 15) lines.push(`\n... and ${rows.length - 15} more rows`)
          lines.push(`\nSource: Dune Analytics`)

          return text(lines.join('\n'))
        } catch (e) {
          return err(`Dune query failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'search': {
        if (!args.query) return err('Missing query parameter')
        const query = args.query as string
        const limit = (args.limit as number) || 5

        return text(
          `🔍 Dune Analytics Search: "${query}"\n\n` +
          `Search on Dune: https://dune.com/browse/queries?q=${encodeURIComponent(query)}\n\n` +
          `Popular Dashboards:\n` +
          `  • DEX Analytics: https://dune.com/hagaetc/dex-metrics\n` +
          `  • Ethereum Overview: https://dune.com/hildobby/ethereum-overview\n` +
          `  • L2 Comparison: https://dune.com/niftytable/l2-comparison\n` +
          `  • Stablecoin Flows: https://dune.com/SebVentures/stablecoins\n` +
          `  • NFT Marketplace: https://dune.com/dune-digest/nft-marketplaces\n\n` +
          `💡 Find the query ID on any Dune query page, then use dune_query to run it.\n` +
          `💡 Set DUNE_API_KEY env var for programmatic access.`
        )
      }

      default: return err(`Unknown dune action: ${args.action}`)
    }
  }

  // Polymarket handled by standalone module

  return null
}

const dataPlatformsModule: ToolModule = { tools: TOOLS, handle }
export default dataPlatformsModule
