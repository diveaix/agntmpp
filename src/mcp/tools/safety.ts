/**
 * ./AGNT Protocol — Safety & Operations Tools
 * Revoke approvals, spending limits, emergency stop, tx simulation, liquidation monitoring.
 */

import type { ToolModule } from './index.js'
import { getActiveWallet, listWallets } from '../wallet.js'
import { getPublicClient } from '../chains.js'
import { loadAutomations, cancelAutomation, type AutomationEntry } from '../scheduler.js'
import { setLimits, removeLimits, getLimits, getAllLimits, getSpentToday, resetSpendLedger } from '../spending-guard.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const TOOLS = [
  {
    name: 'safety',
    description: 'Safety & Operations Tools for approvals, spending limits, emergency stop, and liquidation monitoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['revoke_approvals', 'set_spending_limit', 'view_limits', 'remove_limits', 'reset_spent', 'emergency_stop', 'simulate_tx', 'liquidations', 'export_history'], description: 'Action to perform' },
        chain: { type: 'string', description: 'Chain to check or simulate on (for revoke_approvals, simulate_tx)' },
        token: { type: 'string', description: 'Specific token address (for revoke_approvals)' },
        dailyLimit: { type: 'number', description: 'Maximum USD value the agent can spend per day (for set_spending_limit)' },
        perTradeLimit: { type: 'number', description: 'Maximum USD value per individual trade (for set_spending_limit)' },
        to: { type: 'string', description: 'Contract address to call (for simulate_tx)' },
        data: { type: 'string', description: 'Encoded calldata (hex) (for simulate_tx)' },
        value: { type: 'string', description: 'ETH value to send (in wei). Default: 0 (for simulate_tx)' },
        format: { type: 'string', enum: ['summary', 'detailed'], description: 'Report format. Default: summary (for export_history)' },
      },
      required: ['action'],
    },
  },
]

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'safety') {
    switch (args.action) {
      case 'revoke_approvals': {
        const w = getActiveWallet()
        if (!w) return err('No wallet.')
        if (!args.chain) return err('Missing chain parameter')
        const chain = (args.chain as string).toLowerCase()

        const lines: string[] = [`🔐 Token Approvals — ${chain}\n`]
        lines.push(`Wallet: ${w.name} (${w.address})\n`)
        lines.push(`To check and revoke approvals:`)
        lines.push(`  • Etherscan: https://etherscan.io/tokenapprovalchecker`)
        lines.push(`  • Revoke.cash: https://revoke.cash/?address=${w.address}`)
        lines.push(`  • DeBank: https://debank.com/profile/${w.address}`)
        lines.push(`\n💡 To revoke a specific approval, call the token's approve() with amount 0.`)
        lines.push(`⚠️ Always revoke approvals for contracts you no longer use.`)

        return text(lines.join('\n'))
      }

      case 'set_spending_limit': {
        const w = getActiveWallet()
        if (!w) return err('No wallet.')
        
        const dailyLimit = (args.dailyLimit as number) ?? 0
        const perTradeLimit = (args.perTradeLimit as number) ?? 0

        if (dailyLimit <= 0 && perTradeLimit <= 0) {
          return err('Provide at least one limit: dailyLimit (USD/day) and/or perTradeLimit (USD/trade).')
        }

        // Merge with existing limits if only one is provided
        const existing = getLimits(w.address)
        const finalDaily = dailyLimit > 0 ? dailyLimit : (existing?.dailyLimitUsd || 0)
        const finalPerTrade = perTradeLimit > 0 ? perTradeLimit : (existing?.perTradeLimitUsd || 0)

        const limit = setLimits(w.address, finalDaily, finalPerTrade)
        const { total } = getSpentToday(w.address)

        const lines: string[] = ['✅ Spending Limits Updated\n']
        lines.push(`Wallet: ${w.name} (${w.address})`)
        lines.push(`Daily Limit: ${limit.dailyLimitUsd > 0 ? '$' + limit.dailyLimitUsd.toLocaleString() : 'Unlimited'}`)
        lines.push(`Per-Trade Limit: ${limit.perTradeLimitUsd > 0 ? '$' + limit.perTradeLimitUsd.toLocaleString() : 'Unlimited'}`)
        lines.push(`Spent Today: $${total.toFixed(2)}`)
        if (limit.dailyLimitUsd > 0) {
          lines.push(`Remaining: $${Math.max(0, limit.dailyLimitUsd - total).toFixed(2)}`)
        }
        lines.push(`\n🛡️ All transactions will be checked against these limits before execution.`)
        lines.push(`Use 'view_limits' to see current status, or 'remove_limits' to disable.`)

        return text(lines.join('\n'))
      }

      case 'view_limits': {
        const w = getActiveWallet()
        const allLimits = getAllLimits()

        if (allLimits.length === 0) {
          return text('📊 No spending limits configured.\n\nUse set_spending_limit to protect your wallets with daily and per-trade caps.')
        }

        const lines: string[] = ['📊 Spending Limits\n']

        for (const limit of allLimits) {
          const { total, entries } = getSpentToday(limit.walletAddress)
          const isActive = w && w.address.toLowerCase() === limit.walletAddress
          const label = isActive ? ' (active)' : ''

          lines.push(`${limit.walletAddress.slice(0, 6)}...${limit.walletAddress.slice(-4)}${label}:`)
          lines.push(`  Daily:     ${limit.dailyLimitUsd > 0 ? '$' + limit.dailyLimitUsd.toLocaleString() : 'Unlimited'}`)
          lines.push(`  Per-Trade: ${limit.perTradeLimitUsd > 0 ? '$' + limit.perTradeLimitUsd.toLocaleString() : 'Unlimited'}`)
          lines.push(`  Spent 24h: $${total.toFixed(2)} (${entries.length} txns)`)
          if (limit.dailyLimitUsd > 0) {
            const remaining = Math.max(0, limit.dailyLimitUsd - total)
            const pct = ((total / limit.dailyLimitUsd) * 100).toFixed(0)
            lines.push(`  Remaining: $${remaining.toFixed(2)} (${pct}% used)`)
          }
          lines.push('')
        }

        return text(lines.join('\n'))
      }

      case 'remove_limits': {
        const w = getActiveWallet()
        if (!w) return err('No wallet.')

        const removed = removeLimits(w.address)
        if (!removed) return text(`No spending limits were set for ${w.name}. Nothing to remove.`)

        return text(
          `✅ Spending Limits Removed\n\n` +
          `Wallet: ${w.name} (${w.address})\n` +
          `Daily Limit: Unlimited\n` +
          `Per-Trade Limit: Unlimited\n\n` +
          `⚠️ This wallet now has no spending restrictions.`
        )
      }

      case 'reset_spent': {
        const w = getActiveWallet()
        if (!w) return err('No wallet.')

        const cleared = resetSpendLedger(w.address)
        return text(
          `✅ Spend Ledger Reset\n\n` +
          `Wallet: ${w.name}\n` +
          `Entries cleared: ${cleared}\n` +
          `Spent today: $0.00\n\n` +
          `The daily spending counter has been reset to zero.`
        )
      }

      case 'emergency_stop': {
        const lines: string[] = ['🚨 EMERGENCY STOP ACTIVATED\n']

        // 1. Cancel all automations
        const store = loadAutomations()
        let cancelled = 0
        for (const auto of store.automations) {
          if (auto.status === 'active') {
            cancelAutomation(auto.id)
            cancelled++
          }
        }
        lines.push(`Automations cancelled: ${cancelled}`)

        // 2. Report HL positions to manually close
        const w = getActiveWallet()
        if (w) {
          try {
            const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'clearinghouseState', user: w.address }),
            })
            const hlData = await hlRes.json() as {
              assetPositions: { position: { coin: string; szi: string } }[]
            }
            const openPositions = hlData.assetPositions.filter((p) => parseFloat(p.position.szi) !== 0)
            lines.push(`Open HL positions: ${openPositions.length}`)
            if (openPositions.length) {
              lines.push(`  ⚠️ Close manually: ${openPositions.map((p) => p.position.coin).join(', ')}`)
            }
          } catch {
            lines.push('Hyperliquid: Could not check positions.')
          }
          lines.push(`\nWallet: ${w.name} (${w.address})`)
        }

        lines.push(`\n🔒 All automated strategies have been stopped.`)
        lines.push(`⚠️ Open positions on Hyperliquid must be closed manually via hl_place_order (reduce-only).`)

        return text(lines.join('\n'))
      }

      case 'simulate_tx': {
        if (!args.to || !args.data) return err('Missing to or data parameter')
        const to = args.to as string
        const data = args.data as string
        const value = (args.value as string) || '0'
        const chain = (args.chain as string || 'ethereum').toLowerCase()
        const w = getActiveWallet()

        const lines: string[] = ['🔬 Transaction Simulation\n']
        lines.push(`Chain: ${chain}`)
        lines.push(`From: ${w?.address || 'No wallet'}`)
        lines.push(`To: ${to}`)
        lines.push(`Data: ${data.slice(0, 20)}...${data.slice(-8)}`)
        lines.push(`Value: ${value} wei\n`)

        try {
          const pub = getPublicClient(chain)
          const result = await pub.call({
            to: to as `0x${string}`,
            data: data as `0x${string}`,
            value: BigInt(value),
            account: w?.address as `0x${string}` || undefined,
          })

          lines.push(`✅ Simulation SUCCESS`)
          lines.push(`Return data: ${result.data || '(empty)'}`)
        } catch (e) {
          lines.push(`❌ Simulation FAILED`)
          lines.push(`Error: ${e instanceof Error ? e.message : String(e)}`)
          lines.push(`\n⚠️ This transaction would revert if executed on-chain.`)
        }

        return text(lines.join('\n'))
      }

      case 'liquidations': {
        const w = getActiveWallet()
        if (!w) return text('No wallet. Create one first.')

        const lines: string[] = ['🏥 Liquidation Monitor\n']
        let anyRisk = false

        // Check Hyperliquid positions
        try {
          const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: w.address }),
          })
          const hlData = await hlRes.json() as {
            marginSummary: { accountValue: string; totalMarginUsed: string }
            assetPositions: { position: { coin: string; liquidationPx: string | null; szi: string; positionValue: string; leverage: { value: number } } }[]
          }

          const positions = hlData.assetPositions.filter((p) => parseFloat(p.position.szi) !== 0)
          if (positions.length) {
            const acctVal = parseFloat(hlData.marginSummary.accountValue)
            const marginUsed = parseFloat(hlData.marginSummary.totalMarginUsed)
            const marginRatio = acctVal > 0 ? marginUsed / acctVal : 0

            lines.push(`Hyperliquid:`)
            lines.push(`  Account Value: $${acctVal.toFixed(2)}`)
            lines.push(`  Margin Used: ${(marginRatio * 100).toFixed(1)}% ${marginRatio > 0.8 ? '🔴 CRITICAL' : marginRatio > 0.5 ? '🟡 WARNING' : '🟢 OK'}`)

            for (const { position: p } of positions) {
              const liqPx = p.liquidationPx ? `$${parseFloat(p.liquidationPx).toFixed(2)}` : 'N/A'
              const leverage = p.leverage?.value || 1
              lines.push(`  ${p.coin.padEnd(8)} Liq: ${liqPx} | ${leverage}x leverage`)
              if (p.liquidationPx) anyRisk = true
            }
          } else {
            lines.push('Hyperliquid: No open positions.')
          }
        } catch {
          lines.push('Hyperliquid: Could not check.')
        }

        lines.push('')

        // Check Aave
        const AAVE_POOLS: Record<string, `0x${string}`> = {
          ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
          arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
          base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
        }

        const aaveAbi = [{ name: 'getUserAccountData', type: 'function', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' }, { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' }, { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' }] }] as const

        for (const [chain, pool] of Object.entries(AAVE_POOLS)) {
          try {
            const pub = getPublicClient(chain)
            const data = await pub.readContract({ address: pool, abi: aaveAbi, functionName: 'getUserAccountData', args: [w.address] }) as [bigint, bigint, bigint, bigint, bigint, bigint]
            const [col, debt, , , , hf] = data
            const colUsd = Number(col) / 1e8
            const debtUsd = Number(debt) / 1e8
            const healthFactor = Number(hf) / 1e18

            if (debtUsd > 0) {
              const status = healthFactor < 1.1 ? '🔴 CRITICAL' : healthFactor < 1.5 ? '🟡 WARNING' : '🟢 SAFE'
              lines.push(`Aave ${chain}: HF ${healthFactor.toFixed(2)} ${status} | Col: $${colUsd.toFixed(0)} | Debt: $${debtUsd.toFixed(0)}`)
              if (healthFactor < 1.5) anyRisk = true
            }
          } catch { /* chain not reachable */ }
        }

        if (!anyRisk) lines.push('\n✅ No positions at liquidation risk.')
        else lines.push('\n⚠️ Some positions are at risk. Consider reducing leverage or adding collateral.')

        return text(lines.join('\n'))
      }

      case 'export_history': {
        const w = getActiveWallet()
        if (!w) return err('No wallet.')
        const format = (args.format as string) || 'summary'

        const { wallets } = listWallets()
        const autos = loadAutomations().automations

        const lines: string[] = ['📋 Export — Account History\n']
        lines.push(`Generated: ${new Date().toISOString()}`)
        lines.push(`Active Wallet: ${w.name} (${w.address})\n`)

        lines.push(`Wallets: ${wallets.length}`)
        for (const wallet of wallets) {
          lines.push(`  ${wallet.name} — ${wallet.address} (created ${wallet.createdAt.slice(0, 10)})`)
        }

        lines.push(`\nAutomations: ${autos.length}`)
        for (const auto of autos) {
          lines.push(`  [${auto.id}] ${auto.name} — ${auto.status} (${auto.runCount} runs)`)
        }

        if (format === 'detailed') {
          lines.push(`\nAutomation Execution History:`)
          for (const auto of autos) {
            if (auto.history.length) {
              lines.push(`\n  ${auto.name}:`)
              for (const h of auto.history.slice(-5)) {
                lines.push(`    ${h.time.slice(0, 16)} ${h.success ? '✅' : '❌'} ${h.result.slice(0, 60)}`)
              }
            }
          }
        }

        lines.push(`\n💡 For on-chain transaction history, use a block explorer:`)
        lines.push(`  Tempo: https://explore.tempo.xyz/address/${w.address}`)
        lines.push(`  Arbiscan: https://arbiscan.io/address/${w.address}`)

        return text(lines.join('\n'))
      }

      default: return err(`Unknown safety action: ${args.action}`)
    }
  }

  return null
}

const safetyModule: ToolModule = { tools: TOOLS, handle }
export default safetyModule
