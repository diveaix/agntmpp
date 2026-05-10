/**
 * ./AGNT Protocol — DeFi Lending & Yield Tools
 * Aave V3 supply/withdraw/positions, yield scanning, and ETH staking.
 */

import type { ToolModule } from './index.js'
import { getActiveWallet, getOrCreateWallet } from '../wallet.js'
import { getPublicClient } from '../chains.js'
import { formatUnits, parseUnits } from 'viem'
import { callContract, ensureApproval, formatTxResult, getNativeBalance } from '../tx-executor.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

// Aave V3 Pool addresses by chain
const AAVE_POOLS: Record<string, { pool: `0x${string}`; dataProvider: `0x${string}`; label: string }> = {
  ethereum: { pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', dataProvider: '0x7B4EB56E7CD4b454BA8ff71E4518426c7a803E32', label: 'Aave V3 Ethereum' },
  arbitrum: { pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654', label: 'Aave V3 Arbitrum' },
  base: { pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', dataProvider: '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac', label: 'Aave V3 Base' },
  optimism: { pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654', label: 'Aave V3 Optimism' },
  polygon: { pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654', label: 'Aave V3 Polygon' },
  avalanche: { pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654', label: 'Aave V3 Avalanche' },
}

// Minimal Aave Pool ABI
const aavePoolAbi = [
  { name: 'supply', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'getUserAccountData', type: 'function', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' }, { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' }, { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' }] },
] as const

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'aave',
    description: 'Aave V3 operations: supply, withdraw, or view positions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['supply', 'withdraw', 'positions'], description: 'Action to perform' },
        market: { type: 'string', description: 'Aave market (ethereum, arbitrum, base, polygon)' },
        asset: { type: 'string', description: 'Asset symbol (for supply/withdraw)' },
        amount: { type: 'number', description: 'Amount (for supply/withdraw)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'yield',
    description: 'DeFi yield opportunities and staking',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['scan', 'stake_eth'], description: 'Action to perform' },
        chain: { type: 'string', description: 'Chain to scan (optional)' },
        protocol: { type: 'string', description: 'Specific protocol (for stake_eth)' },
        amount: { type: 'number', description: 'Amount of ETH (for stake_eth)' },
      },
      required: ['action'],
    },
  },
]

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'aave') {
    switch (args.action) {
      case 'supply': {
        const w = getOrCreateWallet()
        const chain = (args.market as string || 'ethereum').toLowerCase()
        const aave = AAVE_POOLS[chain]
        if (!aave) return err(`Aave not available on "${chain}". Available: ${Object.keys(AAVE_POOLS).join(', ')}`)
        if (!args.asset || !args.amount) return err('Need asset and amount')
        const token = args.asset as string
        const amount = args.amount as number

        // Resolve token address (common tokens)
        const TOKEN_MAP: Record<string, { address: `0x${string}`; decimals: number }> = {
          usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
          usdt: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
          dai: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
          weth: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
          wbtc: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
        }
        const tk = TOKEN_MAP[token.toLowerCase()]
        if (!tk) return err(`Unknown token "${token}". Supported: ${Object.keys(TOKEN_MAP).join(', ')}`)

        const rawAmount = parseUnits(amount.toString(), tk.decimals)

        try {
          // 1. Approve
          const approval = await ensureApproval(chain, tk.address, aave.pool, rawAmount)
          // 2. Supply
          const tx = await callContract(chain, aave.pool, aavePoolAbi, 'supply', [tk.address, rawAmount, w.address, 0])
          return text(
            formatTxResult(tx, `Aave Supply — ${amount} ${token.toUpperCase()}`) +
            (approval ? `\nApproval tx: ${approval}` : '') +
            `\nProtocol: ${aave.label}`
          )
        } catch (e) {
          return err(`Supply failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'withdraw': {
        const w = getOrCreateWallet()
        const chain = (args.market as string || 'ethereum').toLowerCase()
        const aave = AAVE_POOLS[chain]
        if (!aave) return err(`Aave not available on "${chain}".`)
        if (!args.asset) return err('Need asset')
        const token = args.asset as string
        const amount = args.amount as number || -1

        const TOKEN_MAP: Record<string, { address: `0x${string}`; decimals: number }> = {
          usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
          usdt: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
          dai: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
          weth: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
          wbtc: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
        }
        const tk = TOKEN_MAP[token.toLowerCase()]
        if (!tk) return err(`Unknown token "${token}".`)

        const rawAmount = amount === -1 ? 2n ** 256n - 1n : parseUnits(amount.toString(), tk.decimals)

        try {
          const tx = await callContract(chain, aave.pool, aavePoolAbi, 'withdraw', [tk.address, rawAmount, w.address])
          return text(
            formatTxResult(tx, `Aave Withdraw — ${amount === -1 ? 'MAX' : amount} ${token.toUpperCase()}`) +
            `\nProtocol: ${aave.label}`
          )
        } catch (e) {
          return err(`Withdraw failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'positions': {
        const w = getActiveWallet()
        if (!w) return text('No wallet. Create one first.')
        const chain = args.market as string | undefined

        const chains = chain ? [chain.toLowerCase()] : Object.keys(AAVE_POOLS)
        const lines: string[] = ['📊 Aave V3 Positions:\n']

        for (const c of chains) {
          const aave = AAVE_POOLS[c]
          if (!aave) continue

          try {
            const pub = getPublicClient(c)
            const data = await pub.readContract({
              address: aave.pool,
              abi: aavePoolAbi,
              functionName: 'getUserAccountData',
              args: [w.address],
            }) as [bigint, bigint, bigint, bigint, bigint, bigint]

            const [collateral, debt, borrowable, liqThreshold, ltv, healthFactor] = data
            const colUsd = Number(formatUnits(collateral, 8))
            const debtUsd = Number(formatUnits(debt, 8))
            const hf = Number(formatUnits(healthFactor, 18))

            if (colUsd > 0 || debtUsd > 0) {
              lines.push(`  ${aave.label}:`)
              lines.push(`    Collateral: $${colUsd.toFixed(2)}`)
              lines.push(`    Debt: $${debtUsd.toFixed(2)}`)
              lines.push(`    Available to Borrow: $${Number(formatUnits(borrowable, 8)).toFixed(2)}`)
              lines.push(`    Health Factor: ${hf > 100 ? '∞ (no debt)' : hf.toFixed(2)}`)
              lines.push(`    LTV: ${Number(ltv) / 100}%`)
              lines.push('')
            }
          } catch {
            // Chain might be unreachable, skip silently
          }
        }

        if (lines.length === 1) lines.push('  No Aave positions found across any chain.')
        return text(lines.join('\n'))
      }
      default: return err(`Unknown aave action: ${args.action}`)
    }
  }

  if (name === 'yield') {
    switch (args.action) {
      case 'scan': {
        const tokenFilter = args.token as string | undefined
        const minApy = (args.minApy as number) || 0

        try {
          // Use DeFiLlama yield API
          const data = await fetchJson('https://yields.llama.fi/pools') as { data: { pool: string; chain: string; project: string; symbol: string; tvlUsd: number; apy: number; apyBase: number }[] }

          let pools = data.data
            .filter((p) => p.tvlUsd > 1_000_000) // Only pools with >$1M TVL
            .filter((p) => p.apy > minApy)
            .filter((p) => ['aave-v3', 'compound-v3', 'lido', 'spark', 'morpho-aavev3'].includes(p.project))

          if (tokenFilter) {
            const tf = tokenFilter.toLowerCase()
            pools = pools.filter((p) => p.symbol.toLowerCase().includes(tf))
          }

          pools.sort((a, b) => b.apy - a.apy)
          const top = pools.slice(0, 15)

          const lines: string[] = [`💰 Top Yield Opportunities${tokenFilter ? ` (${tokenFilter})` : ''}:\n`]
          lines.push(`${'Protocol'.padEnd(16)} ${'Token'.padEnd(12)} ${'Chain'.padEnd(12)} ${'APY'.padEnd(10)} TVL`)
          lines.push('─'.repeat(62))

          for (const p of top) {
            lines.push(`${p.project.padEnd(16)} ${p.symbol.slice(0, 11).padEnd(12)} ${p.chain.padEnd(12)} ${p.apy.toFixed(2).padEnd(10)}% $${(p.tvlUsd / 1e6).toFixed(1)}M`)
          }

          lines.push(`\nSource: DeFiLlama | Filtered: TVL > $1M, APY > ${minApy}%`)
          return text(lines.join('\n'))
        } catch (e) {
          return err(`Failed to fetch yield data: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'stake_eth': {
        const w = getOrCreateWallet()
        if (!args.amount) return err('Need amount of ETH to stake')
        const amount = args.amount as number
        const chain = 'ethereum'

        const LIDO = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as `0x${string}`
        const lidoAbi = [{ name: 'submit', type: 'function', stateMutability: 'payable', inputs: [{ name: '_referral', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const

        try {
          const bal = await getNativeBalance(chain)
          if (bal < amount) return err(`Insufficient ETH. Have ${bal.toFixed(4)}, need ${amount}`)

          const value = parseUnits(amount.toString(), 18)
          const tx = await callContract(chain, LIDO, lidoAbi, 'submit', ['0x0000000000000000000000000000000000000000'], value)
          return text(
            formatTxResult(tx, `Lido Stake — ${amount} ETH → stETH`) +
            `\nAPY: ~3.5% | stETH can be used as collateral on Aave`
          )
        } catch (e) {
          return err(`Staking failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      default: return err(`Unknown yield action: ${args.action}`)
    }
  }

  return null
}

const defiModule: ToolModule = { tools: TOOLS, handle }
export default defiModule
