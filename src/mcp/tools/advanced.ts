/**
 * ./AGENT Protocol — Advanced Strategy Tools
 * Cross-chain swaps and historical backtesting.
 */

import type { ToolModule } from './index.js'
import { isRemovedIntegration } from './integration-policy.js'
import bridgesModule from './bridges.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

const TOOLS = [
  {
    name: 'advanced',
    description: 'Cross-chain swaps and historical backtesting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['swap_any_chain', 'backtest'], description: 'Action to perform' },
        chain: { type: 'string', description: 'Chain to execute on (for swap_any_chain)' },
        tokenIn: { type: 'string', description: 'Input token address (for swap_any_chain)' },
        tokenOut: { type: 'string', description: 'Output token address (for swap_any_chain)' },
        amount: { type: 'string', description: 'Amount (for swap_any_chain, backtest)' },
        slippage: { type: 'number', description: 'Slippage tolerance in % (for swap_any_chain)' },
        interval: { type: 'string', description: 'Interval (for backtest)' },
        token: { type: 'string', description: 'Token to backtest' },
        strategyType: { type: 'string', enum: ['dca', 'buy_dip', 'momentum'], description: 'Strategy type (for backtest)' },
        days: { type: 'number', description: 'Days to backtest (for backtest)' },
      },
      required: ['action'],
    },
  },
]

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'advanced') {
    if ([args.token, args.chain, ...String(args.tokens || '').split(',')].some(isRemovedIntegration)) return err('This integration is not supported.')
    switch (args.action) {
      case 'swap_any_chain': {
        if (!args.chain || !args.tokenIn || !args.tokenOut || !args.amount) return err('Missing chain, tokenIn, tokenOut, or amount')
        const chain = (args.chain as string).toLowerCase()
        return bridgesModule.handle('jumper', {
          action: 'swap',
          fromChain: chain,
          toChain: chain,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amount: args.amount,
          slippage: args.slippage,
        })

      }

      case 'backtest': {
        if (!args.token || !args.strategyType || args.amount === undefined) return err('Missing token, strategyType, or amount')
        const token = (args.token as string).toUpperCase()
        const strategy = args.strategyType as string
        const amount = Number(args.amount)
        const interval = (args.interval as string) || '1d'
        const days = (args.days as number) || 90

        // Map to CoinGecko IDs
        const CG_MAP: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', DOGE: 'dogecoin', AVAX: 'avalanche-2', LINK: 'chainlink' }
        const id = CG_MAP[token] || token.toLowerCase()

        try {
          const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`) as { prices: number[][] }
          const prices = data.prices

          if (!prices.length) return err(`No price data for ${token}.`)

          // Simulate DCA
          const intervalDays = interval === '7d' ? 7 : interval === '30d' ? 30 : 1
          let totalInvested = 0
          let totalTokens = 0
          let buys = 0

          for (let i = 0; i < prices.length; i += intervalDays * 24) { // Approx hourly data
            if (i >= prices.length) break
            const price = prices[i][1]

            if (strategy === 'dca') {
              totalTokens += amount / price
              totalInvested += amount
              buys++
            } else if (strategy === 'buy_dip') {
              // Only buy if price is below 7-day moving average
              const lookback = Math.min(i, 7 * 24)
              const maSlice = prices.slice(Math.max(0, i - lookback), i + 1)
              const ma = maSlice.reduce((s, p) => s + p[1], 0) / maSlice.length
              if (price < ma * 0.97) { // 3% below MA
                totalTokens += amount / price
                totalInvested += amount
                buys++
              }
            } else if (strategy === 'momentum') {
              // Buy when 24h change is positive
              if (i >= 24) {
                const prev = prices[i - 24][1]
                if (price > prev) {
                  totalTokens += amount / price
                  totalInvested += amount
                  buys++
                }
              }
            }
          }

          const currentPrice = prices[prices.length - 1][1]
          const currentValue = totalTokens * currentPrice
          const pnl = currentValue - totalInvested
          const pnlPct = totalInvested > 0 ? (pnl / totalInvested * 100) : 0
          const avgPrice = totalInvested / totalTokens

          const startPrice = prices[0][1]
          const hodlTokens = (buys * amount) / startPrice
          const hodlValue = hodlTokens * currentPrice
          const hodlPnl = hodlValue - totalInvested

          return text(
            `📊 Backtest Results — ${strategy.toUpperCase()} on ${token}\n\n` +
            `Period: ${days} days\n` +
            `Strategy: ${strategy === 'dca' ? 'Dollar Cost Average' : strategy === 'buy_dip' ? 'Buy the Dip (3% below 7d MA)' : 'Momentum (buy on green days)'}\n` +
            `Amount per buy: $${amount}\n` +
            `Interval: ${interval}\n\n` +
            `Results:\n` +
            `  Total Invested: $${totalInvested.toFixed(2)}\n` +
            `  Buys Executed: ${buys}\n` +
            `  ${token} Acquired: ${totalTokens.toFixed(6)}\n` +
            `  Avg Buy Price: $${avgPrice.toFixed(2)}\n` +
            `  Current Value: $${currentValue.toFixed(2)}\n` +
            `  PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\n\n` +
            `vs. Lump Sum (buy all at start):\n` +
            `  Lump Sum Value: $${hodlValue.toFixed(2)}\n` +
            `  Lump Sum PnL: ${hodlPnl >= 0 ? '+' : ''}$${hodlPnl.toFixed(2)}\n` +
            `  ${strategy.toUpperCase()} ${pnl > hodlPnl ? 'outperformed' : 'underperformed'} lump sum by $${Math.abs(pnl - hodlPnl).toFixed(2)}\n\n` +
            `Source: CoinGecko historical data`
          )
        } catch (e) {
          return err(`Backtest failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      default: return err(`Unknown advanced action: ${args.action}`)
    }
  }

  return null
}

const advancedModule: ToolModule = { tools: TOOLS, handle }
export default advancedModule
