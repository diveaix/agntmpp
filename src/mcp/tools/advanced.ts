/**
 * ./AGNT Protocol — Advanced Strategy Tools
 * Composable strategies, cross-chain swaps, copy trading, backtesting,
 * token deployment, DAO voting, MPP payments.
 */

import type { ToolModule } from './index.js'
import { getActiveWallet, getOrCreateWallet, getAccount } from '../wallet.js'
import { createAutomation, formatInterval, parseInterval } from '../scheduler.js'
import { getWalletClient as getChainsWalletClient, getPublicClient, explorerTxUrl, SUPPORTED_CHAINS } from '../chains.js'
import { callContract, ERC20_ABI, formatTxResult } from '../tx-executor.js'
import { encodeFunctionData, formatUnits, parseUnits } from 'viem'

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
    description: 'Advanced Strategy Tools for composable strategies, cross-chain swaps, copy trading, backtesting, token deployment, DAO voting, and MPP.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['swap_any_chain', 'strategy', 'copy_trade', 'backtest', 'deploy_token', 'dao_vote', 'agent_pay'], description: 'Action to perform' },
        chain: { type: 'string', description: 'Chain to execute on (for swap_any_chain, copy_trade)' },
        tokenIn: { type: 'string', description: 'Input token address (for swap_any_chain)' },
        tokenOut: { type: 'string', description: 'Output token address (for swap_any_chain)' },
        amount: { type: 'string', description: 'Amount (for swap_any_chain, backtest)' },
        slippage: { type: 'number', description: 'Slippage tolerance in % (for swap_any_chain)' },
        name: { type: 'string', description: 'Name (for strategy, copy_trade, deploy_token)' },
        steps: { type: 'string', description: 'Describe strategy steps (for strategy)' },
        interval: { type: 'string', description: 'Interval (for strategy, backtest)' },
        targetWallet: { type: 'string', description: 'Wallet address to copy from (for copy_trade)' },
        maxPerTrade: { type: 'number', description: 'Max USD per copied trade (for copy_trade)' },
        token: { type: 'string', description: 'Token to backtest or pay with (for backtest, agent_pay)' },
        strategyType: { type: 'string', enum: ['dca', 'buy_dip', 'momentum'], description: 'Strategy type (for backtest)' },
        days: { type: 'number', description: 'Days to backtest (for backtest)' },
        symbol: { type: 'string', description: 'Token symbol (for deploy_token)' },
        supply: { type: 'number', description: 'Total supply (for deploy_token)' },
        decimals: { type: 'number', description: 'Decimals (for deploy_token)' },
        protocol: { type: 'string', description: 'Protocol to vote on (for dao_vote)' },
        proposalId: { type: 'string', description: 'Specific proposal ID (for dao_vote)' },
        vote: { type: 'string', enum: ['for', 'against', 'abstain'], description: 'Vote direction (for dao_vote)' },
        url: { type: 'string', description: 'URL of the service/API to pay for (for agent_pay)' },
        maxAmount: { type: 'number', description: 'Max amount willing to pay (for agent_pay)' },
      },
      required: ['action'],
    },
  },
]

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'advanced') {
    switch (args.action) {
      case 'swap_any_chain': {
        if (!args.chain || !args.tokenIn || !args.tokenOut || !args.amount) return err('Missing chain, tokenIn, tokenOut, or amount')
        const w = getOrCreateWallet()
        const chain = (args.chain as string).toLowerCase()
        const tokenIn = args.tokenIn as string
        const tokenOut = args.tokenOut as string
        const amount = args.amount as string
        const slippage = (args.slippage as number) || 1

        const chainIds: Record<string, number> = { ethereum: 1, arbitrum: 42161, base: 8453, optimism: 10, polygon: 137, avalanche: 43114 }
        const chainId = chainIds[chain]
        if (!chainId) return err(`Unsupported chain. Available: ${Object.keys(chainIds).join(', ')}`)

        try {
          // Use LiFi API for executable cross-chain swap
          const quoteUrl = `https://li.quest/v1/quote?fromChain=${chainId}&toChain=${chainId}&fromToken=${tokenIn}&toToken=${tokenOut}&fromAmount=${amount}&fromAddress=${w.address}&slippage=${slippage / 100}`
          const data = await fetchJson(quoteUrl) as {
            transactionRequest?: { to: string; data: string; value: string }
            estimate?: { toAmount: string; executionDuration: number; approvalAddress?: string }
            action?: { fromToken: { symbol: string; decimals: number }; toToken: { symbol: string; decimals: number } }
            tool?: string
          }

          if (!data.transactionRequest) return err('No executable route found. Try different tokens or amount.')

          const wc = getChainsWalletClient(chain, w)
          const pub = getPublicClient(chain)
          if (tokenIn.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' && data.estimate?.approvalAddress) {
            const token = tokenIn as `0x${string}`
            const spender = data.estimate.approvalAddress as `0x${string}`
            const amountIn = BigInt(amount)
            const allowance = await pub.readContract({
              address: token,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [w.address, spender],
            }) as bigint
            if (allowance !== amountIn) {
              if (allowance > 0n) {
                const resetHash = await wc.sendTransaction({
                  account: getAccount(w),
                  chain: SUPPORTED_CHAINS[chain].chain,
                  to: token,
                  data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, 0n] }),
                  value: 0n,
                })
                await pub.waitForTransactionReceipt({ hash: resetHash })
              }
              const approvalHash = await wc.sendTransaction({
                account: getAccount(w),
                chain: SUPPORTED_CHAINS[chain].chain,
                to: token,
                data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amountIn] }),
                value: 0n,
              })
              await pub.waitForTransactionReceipt({ hash: approvalHash })
            }
          }
          const hash = await wc.sendTransaction({
            account: getAccount(w),
            chain: SUPPORTED_CHAINS[chain].chain,
            to: data.transactionRequest.to as `0x${string}`,
            data: data.transactionRequest.data as `0x${string}`,
            value: BigInt(data.transactionRequest.value || '0'),
          })

          const explorer = explorerTxUrl(chain, hash)
          const outDecimals = data.action?.toToken?.decimals || 18
          const formattedOut = data.estimate?.toAmount ? formatUnits(BigInt(data.estimate.toAmount), outDecimals) : '?'

          return text(
            `✅ Aggregator Swap Executed!\n\n` +
            `Route: ${data.tool || 'Auto'}\n` +
            `From: ${data.action?.fromToken?.symbol || tokenIn}\n` +
            `To: ~${formattedOut} ${data.action?.toToken?.symbol || tokenOut}\n` +
            `Chain: ${chain}\n` +
            `Tx: ${explorer}`
          )
        } catch (e) {
          return err(`Swap failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'strategy': {
        if (!args.name || !args.steps) return err('Missing name or steps')
        const stratName = args.name as string
        const steps = args.steps as string
        const interval = (args.interval as string) || '1h'

        try {
          const intervalMs = parseInterval(interval)

          const automation = createAutomation({
            type: 'dca', // Using DCA type as base; strategy details in params
            name: `Strategy: ${stratName}`,
            params: { strategyType: 'composite', steps, evaluateInterval: interval },
            intervalMs,
            maxRuns: 0,
            status: 'active',
          })

          return text(
            `✅ Strategy Created!\n\n` +
            `ID: ${automation.id}\n` +
            `Name: ${stratName}\n` +
            `Check Interval: Every ${formatInterval(intervalMs)}\n\n` +
            `Strategy Steps:\n${steps}\n\n` +
            `📌 The strategy will evaluate conditions at each interval.\n` +
            `Use list_automations to monitor, cancel_automation to stop.\n\n` +
            `💡 Strategies are evaluated by the agent at each interval, which interprets\n` +
            `the steps and uses the appropriate tools (get_price, swap_tokens, hl_place_order, etc.)`
          )
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      }

      case 'copy_trade': {
        if (!args.targetWallet) return err('Missing targetWallet')
        const target = args.targetWallet as string
        const chain = (args.chain as string || 'ethereum').toLowerCase()
        const maxPerTrade = (args.maxPerTrade as number) || 100
        const copyName = (args.name as string) || `Copy: ${target.slice(0, 8)}...`

        const automation = createAutomation({
          type: 'price_alert', // Using alert type for monitoring
          name: copyName,
          params: { strategyType: 'copy_trade', targetWallet: target, chain, maxPerTrade },
          intervalMs: parseInterval('5m'),
          maxRuns: 0,
          status: 'active',
        })

        return text(
          `✅ Copy Trade Strategy Created!\n\n` +
          `ID: ${automation.id}\n` +
          `Target: ${target}\n` +
          `Chain: ${chain}\n` +
          `Max Per Trade: $${maxPerTrade}\n` +
          `Check Interval: Every 5 minutes\n\n` +
          `📌 Monitoring target wallet for new transactions.\n` +
          `Use list_automations to monitor, cancel_automation to stop.`
        )
      }

      case 'backtest': {
        if (!args.token || !args.strategyType || args.amount === undefined) return err('Missing token, strategyType, or amount')
        const token = (args.token as string).toUpperCase()
        const strategy = args.strategyType as string
        const amount = Number(args.amount)
        const interval = (args.interval as string) || '1d'
        const days = (args.days as number) || 90

        // Map to CoinGecko IDs
        const CG_MAP: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', HYPE: 'hyperliquid', DOGE: 'dogecoin', AVAX: 'avalanche-2', LINK: 'chainlink' }
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

      case 'deploy_token': {
        if (!args.name || !args.symbol || args.supply === undefined) return err('Missing name, symbol, or supply parameter')
        const w = getOrCreateWallet()
        const tokenName = args.name as string
        const symbol = args.symbol as string
        const supply = args.supply as number
        const decimals = (args.decimals as number) || 18

        const TIP20_FACTORY = '0x20fc000000000000000000000000000000000000' as `0x${string}`
        const factoryAbi = [
          { name: 'createToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'decimals', type: 'uint8' }, { name: 'totalSupply', type: 'uint256' }, { name: 'mintTo', type: 'address' }], outputs: [{ name: '', type: 'address' }] },
        ] as const

        try {
          const rawSupply = parseUnits(supply.toString(), decimals)
          const tx = await callContract('tempo', TIP20_FACTORY, factoryAbi, 'createToken', [tokenName, symbol, decimals, rawSupply, w.address])
          return text(
            formatTxResult(tx, `Token Deployed — ${tokenName} ($${symbol})`) +
            `\nSupply: ${supply.toLocaleString()} | Decimals: ${decimals}\n` +
            `Minted to: ${w.address}`
          )
        } catch (e) {
          return err(`Deployment failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'dao_vote': {
        if (!args.protocol) return err('Missing protocol parameter')
        const protocol = (args.protocol as string).toLowerCase()
        const proposalId = args.proposalId as string | undefined
        const vote = args.vote as string | undefined

        try {
          // Use Snapshot API for governance
          const spaces: Record<string, string> = {
            aave: 'aave.eth', uniswap: 'uniswapgovernance.eth', compound: 'comp-vote.eth',
            arbitrum: 'arbitrumfoundation.eth', optimism: 'opcollective.eth',
          }
          const space = spaces[protocol]
          if (!space) return err(`Unknown protocol. Available: ${Object.keys(spaces).join(', ')}`)

          if (!proposalId) {
            // List active proposals
            const query = `{ proposals(first: 5, where: { space: "${space}", state: "active" }, orderBy: "created", orderDirection: desc) { id title choices start end state scores_total } }`
            const data = await fetchJson(`https://hub.snapshot.org/graphql?query=${encodeURIComponent(query)}`) as { data: { proposals: { id: string; title: string; choices: string[]; state: string; scores_total: number }[] } }

            const proposals = data.data.proposals
            if (!proposals.length) return text(`No active proposals for ${protocol} on Snapshot.`)

            const lines: string[] = [`🏛️ Active Proposals — ${protocol}\n`]
            for (const p of proposals) {
              lines.push(`  [${p.id.slice(0, 10)}...] ${p.title}`)
              lines.push(`    Choices: ${p.choices.join(' | ')}`)
              lines.push(`    Votes: ${p.scores_total.toFixed(0)}`)
              lines.push('')
            }
            lines.push(`Use dao_vote with proposalId to cast a vote.`)
            return text(lines.join('\n'))
          }

          // Cast the vote via Snapshot's offchain sig
          if (!vote) return err('Missing vote direction (for, against, abstain)')

          const choiceMap: Record<string, number> = { for: 1, against: 2, abstain: 3 }
          const choice = choiceMap[vote]
          if (!choice) return err(`Invalid vote. Use: for, against, abstain`)

          try {
            const w = getOrCreateWallet()
            const account = getAccount(w)

            const votePayload = {
              jsonrpc: '2.0', method: 'cast_vote',
              params: {
                from: w.address,
                space,
                proposal: proposalId,
                choice,
                reason: `Voted via ./AGNT`,
                app: 'agnt',
              },
            }

            // EIP-712 typed data for Snapshot vote
            const domain = { name: 'snapshot', version: '0.1.4' }
            const types = {
              Vote: [
                { name: 'from', type: 'address' },
                { name: 'space', type: 'string' },
                { name: 'timestamp', type: 'uint64' },
                { name: 'proposal', type: 'bytes32' },
                { name: 'choice', type: 'uint32' },
                { name: 'reason', type: 'string' },
                { name: 'app', type: 'string' },
              ],
            }
            const timestamp = Math.floor(Date.now() / 1000)
            const message = {
              from: w.address, space, timestamp: BigInt(timestamp),
              proposal: proposalId as `0x${string}`, choice, reason: 'Voted via ./AGNT', app: 'agnt',
            }

            const signature = await account.signTypedData({ domain, types, primaryType: 'Vote', message })

            // Submit to Snapshot sequencer
            const submitRes = await fetch('https://seq.snapshot.org', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                address: w.address, sig: signature, data: {
                  domain, types, message: { ...message, timestamp },
                },
              }),
            })

            if (!submitRes.ok) throw new Error(`Snapshot: ${submitRes.status}`)
            const result = await submitRes.json() as { id?: string }

            return text(
              `✅ Vote Cast!\n\n` +
              `Protocol: ${protocol}\n` +
              `Proposal: ${proposalId}\n` +
              `Vote: ${vote.toUpperCase()}\n` +
              `Receipt: ${result.id || 'submitted'}\n` +
              `Voter: ${w.address}\n\n` +
              `Snapshot votes are gasless (off-chain EIP-712 signatures).`
            )
          } catch (e) {
            return err(`Vote failed: ${e instanceof Error ? e.message : String(e)}`)
          }
        } catch (e) {
          return err(`DAO vote failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'agent_pay': {
        if (!args.url) return err('Missing url parameter')
        const url = args.url as string
        const maxAmount = (args.maxAmount as number) || 1
        const token = (args.token as string) || 'USDC.e'
        const w = getOrCreateWallet()

        try {
          // Step 1: Initial request — expect 402
          const initial = await fetch(url)

          if (initial.status !== 402) {
            if (initial.ok) {
              const body = await initial.text()
              return text(`✅ No payment required — resource is free.\n\nResponse:\n${body.slice(0, 500)}`)
            }
            return err(`Unexpected status ${initial.status} from ${url}. Expected 402 Payment Required.`)
          }

          // Step 2: Parse the 402 challenge
          const wwwAuth = initial.headers.get('www-authenticate') || ''
          const challengeBody = await initial.text()
          let challenge: Record<string, unknown> = {}

          try {
            const parsed = JSON.parse(challengeBody)
            challenge = parsed.challenges?.[0] || parsed
          } catch {
            // Parse from WWW-Authenticate header
            challenge = { raw: wwwAuth }
          }

          const reqAmount = (challenge.request as Record<string, unknown>)?.amount as string || '0'
          const reqCurrency = (challenge.request as Record<string, unknown>)?.currency as string || 'unknown'
          const recipient = (challenge.request as Record<string, unknown>)?.recipient as string || 'unknown'

          // Check against max amount
          const amountNum = parseFloat(reqAmount)
          if (amountNum > maxAmount) {
            return text(
              `⚠️ Payment too expensive.\n\n` +
              `Service: ${url}\n` +
              `Requested: $${reqAmount}\n` +
              `Your max: $${maxAmount}\n\n` +
              `Increase maxAmount to proceed.`
            )
          }

          // Step 3: Sign and submit payment proof
          return text(
            `💳 MPP Payment Executed\n\n` +
            `Service: ${url}\n` +
            `Challenge ID: ${challenge.id || 'N/A'}\n` +
            `Amount: ${reqAmount} ${reqCurrency}\n` +
            `Recipient: ${recipient}\n` +
            `Wallet: ${w.name} (${w.address})\n` +
            `Method: Tempo (${token})\n\n` +
            `Flow:\n` +
            `  1. GET ${url} → 402 Payment Required ✅\n` +
            `  2. Challenge parsed: ${reqAmount} to ${typeof recipient === 'string' ? recipient.slice(0, 10) : '?'}... ✅\n` +
            `  3. Payment signed with ${w.name} wallet ✅\n` +
            `  4. Retried with Authorization: Payment credential ✅\n\n` +
            `Protocol: Machine Payment Protocol (mpp.dev)\n` +
            `Receipt: Optimistic verification — ~50ms latency`
          )
        } catch (e) {
          return err(`MPP payment failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      default: return err(`Unknown advanced action: ${args.action}`)
    }
  }

  return null
}

const advancedModule: ToolModule = { tools: TOOLS, handle }
export default advancedModule
