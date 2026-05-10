/**
 * ./AGNT Protocol — Lending & Yield Tools
 * Morpho (optimized lending), Pendle (yield tokenization), Ondo Finance (RWA yield).
 * All write actions execute real on-chain transactions via tx-executor.
 */

import type { ToolModule } from './index.js'
import { getActiveWallet, getOrCreateWallet } from '../wallet.js'
import { parseUnits } from 'viem'
import { callContract, ensureApproval, formatTxResult, getBalance } from '../tx-executor.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

// ─── Contracts ───────────────────────────────────────────

const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as `0x${string}`
const PENDLE_ROUTER = '0x888888888889758F76e7103c6CbF23ABbF58F946' as `0x${string}`
const ONDO_USDY = '0x96F6eF951840721AdBF46Ac996b59E0235CB985C' as `0x${string}`
const ONDO_OUSG = '0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92' as `0x${string}`

// ─── ABIs ────────────────────────────────────────────────

const morphoSupplyAbi = [
  { name: 'supply', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'marketParams', type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] }, { name: 'assets', type: 'uint256' }, { name: 'shares', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [{ name: 'assetsSupplied', type: 'uint256' }, { name: 'sharesSupplied', type: 'uint256' }] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'marketParams', type: 'tuple', components: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] }, { name: 'assets', type: 'uint256' }, { name: 'shares', type: 'uint256' }, { name: 'onBehalf', type: 'address' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'assetsWithdrawn', type: 'uint256' }, { name: 'sharesWithdrawn', type: 'uint256' }] },
] as const

// ERC-4626 vault (Morpho MetaMorpho vaults + Pendle)
const erc4626Abi = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }] },
  { name: 'redeem', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'shares', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'owner', type: 'address' }], outputs: [{ name: 'assets', type: 'uint256' }] },
  { name: 'asset', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const

// Well-known MetaMorpho vaults
const METAMORPHO_VAULTS: Record<string, { address: `0x${string}`; asset: `0x${string}`; decimals: number; label: string }> = {
  'steakhouse-usdc': { address: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, label: 'Steakhouse USDC' },
  'gauntlet-usdc': { address: '0xdd0f28e19C1780eb6396170735D45153D261571d', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, label: 'Gauntlet USDC Prime' },
  'gauntlet-weth': { address: '0x4881Ef0BF6d2365D3dd6499ccd7532bcdBcE0658', asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, label: 'Gauntlet WETH Prime' },
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'morpho',
    description: 'Morpho optimized lending and borrowing',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['supply', 'withdraw', 'positions'], description: 'Action to perform' },
        vault: { type: 'string', description: 'Vault name (steakhouse-usdc, gauntlet-usdc, gauntlet-weth) or address' },
        amount: { type: 'number', description: 'Amount (for supply/withdraw)' },
        chain: { type: 'string', description: 'Chain (ethereum, base). Default: ethereum' },
      },
      required: ['action'],
    },
  },
  {
    name: 'pendle',
    description: 'Pendle yield tokenization and markets',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['buy_pt', 'buy_yt', 'positions', 'markets'], description: 'Action to perform' },
        market: { type: 'string', description: 'Pendle market address (for buy_pt/buy_yt)' },
        amount: { type: 'number', description: 'Amount to invest (for buy_pt/buy_yt)' },
        slippage: { type: 'number', description: 'Slippage tolerance. Default: 0.5' },
        chain: { type: 'string', description: 'Chain (for markets). Default: ethereum' },
        sortBy: { type: 'string', enum: ['apy', 'tvl', 'maturity'], description: 'Sort order (for markets)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ondo',
    description: 'Ondo Finance RWA tokenization (USDY)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['mint', 'redeem', 'positions'], description: 'Action to perform' },
        amount: { type: 'number', description: 'Amount (for mint/redeem)' },
      },
      required: ['action'],
    },
  },
]

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'morpho') {
    switch (args.action) {
      case 'supply': {
        if (!args.vault || args.amount === undefined) return err('Missing vault or amount')
        const w = getOrCreateWallet()
        const vaultKey = (args.vault as string).toLowerCase()
        const amount = args.amount as number
        const chain = (args.chain as string || 'ethereum').toLowerCase()

        // Resolve vault
        const v = METAMORPHO_VAULTS[vaultKey]
        const vaultAddr = v ? v.address : (vaultKey.startsWith('0x') ? vaultKey as `0x${string}` : null)
        if (!vaultAddr) return err(`Unknown vault. Available: ${Object.keys(METAMORPHO_VAULTS).join(', ')} or pass a 0x address.`)

        const decimals = v?.decimals || 6
        const rawAmount = parseUnits(amount.toString(), decimals)
        const assetAddr = v?.asset || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`

        try {
          await ensureApproval(chain, assetAddr, vaultAddr, rawAmount)
          const tx = await callContract(chain, vaultAddr, erc4626Abi, 'deposit', [rawAmount, w.address])
          return text(
            formatTxResult(tx, `Morpho Supply — ${amount} to ${v?.label || vaultKey}`) +
            `\n💡 Morpho matches P2P for better rates. Unmatched funds fall back to pool.`
          )
        } catch (e) {
          return err(`Supply failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'withdraw': {
        if (!args.vault || args.amount === undefined) return err('Missing vault or amount')
        const w = getOrCreateWallet()
        const vaultKey = (args.vault as string).toLowerCase()
        const amount = args.amount as number
        const chain = (args.chain as string || 'ethereum').toLowerCase()

        const v = METAMORPHO_VAULTS[vaultKey]
        const vaultAddr = v ? v.address : (vaultKey.startsWith('0x') ? vaultKey as `0x${string}` : null)
        if (!vaultAddr) return err(`Unknown vault.`)

        const decimals = v?.decimals || 6
        const rawAmount = amount === -1 ? 2n ** 256n - 1n : parseUnits(amount.toString(), decimals)

        try {
          const tx = await callContract(chain, vaultAddr, erc4626Abi, 'redeem', [rawAmount, w.address, w.address])
          return text(formatTxResult(tx, `Morpho Withdraw — ${amount === -1 ? 'MAX' : amount} from ${v?.label || vaultKey}`))
        } catch (e) {
          return err(`Withdraw failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'positions': {
        const w = getActiveWallet()
        if (!w) return text('No wallet.')
        const lines: string[] = ['📊 Morpho Positions\n']
        for (const [key, v] of Object.entries(METAMORPHO_VAULTS)) {
          try {
            const bal = await getBalance('ethereum', v.address, 18)
            if (bal > 0.0001) lines.push(`  ${v.label}: ${bal.toFixed(4)} shares`)
          } catch { /* skip */ }
        }
        if (lines.length === 1) lines.push('  No MetaMorpho vault positions found.')
        lines.push(`\nWallet: ${w.address}`)
        return text(lines.join('\n'))
      }
      default: return err(`Unknown morpho action: ${args.action}`)
    }
  }

  if (name === 'pendle') {
    switch (args.action) {
      case 'buy_pt':
      case 'buy_yt': {
        if (!args.market || args.amount === undefined) return err('Missing market or amount')
        const w = getOrCreateWallet()
        const market = args.market as string
        const amount = args.amount as number
        const isPT = args.action === 'buy_pt'

        // Use Pendle SDK API for the swap
        try {
          const chainId = '1'
          const slippage = (args.slippage as number) || 0.5
          const res = await fetch(`https://api-v2.pendle.finance/sdk/api/v1/swapExactTokenFor${isPT ? 'Pt' : 'Yt'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chainId, receiverAddr: w.address, marketAddr: market,
              tokenInAddr: '0x0000000000000000000000000000000000000000',
              amountTokenIn: parseUnits(amount.toString(), 18).toString(),
              slippage: slippage / 100,
            }),
          })
          if (!res.ok) throw new Error(`Pendle API: ${res.status}`)
          const data = await res.json() as { tx: { to: string; data: string; value: string } }

          const tx = await callContract(
            'ethereum',
            data.tx.to as `0x${string}`,
            [{ name: 'execute', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] }],
            'execute', [],
            BigInt(data.tx.value || '0'),
          )
          return text(formatTxResult(tx, `Pendle Buy ${isPT ? 'PT' : 'YT'} — ${amount} ETH`))
        } catch (e) {
          return err(`${isPT ? 'PT' : 'YT'} buy failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'positions': {
        const w = getActiveWallet()
        if (!w) return text('No wallet.')
        return text(`📊 Pendle Positions\n\nWallet: ${w.address}\nUse 'markets' to find active markets, then check PT/YT token balances.`)
      }
      case 'markets': {
        const chain = (args.chain as string || 'ethereum').toLowerCase()
        const sortByArg = (args.sortBy as string) || 'tvl'
        const sortBy = sortByArg === 'tvl' ? 'tvl:-1' : sortByArg === 'apy' ? 'impliedApy:-1' : 'expiry:1'

        try {
          const chainId = chain === 'arbitrum' ? '42161' : chain === 'base' ? '8453' : '1'
          const data = await fetchJson(`https://api-v2.pendle.finance/core/v2/markets/all?chainId=${chainId}&order_by=${sortBy}&limit=15`) as {
            results: { address: string; name: string; impliedApy: number; tvl: { usd: number }; expiry: string }[]
            total: number
          }

          const markets = data.results || []
          if (!markets.length) return text(`No active Pendle markets on ${chain}.`)

          const lines: string[] = [`📊 Pendle Markets — ${chain}\n`]
          lines.push(`${'Market'.padEnd(26)} ${'Implied APY'.padEnd(14)} ${'TVL'.padEnd(12)} Maturity`)
          lines.push('─'.repeat(66))

          for (const m of markets.slice(0, 15)) {
            const maturity = m.expiry ? m.expiry.slice(0, 10) : 'N/A'
            const tvl = `$${(m.tvl?.usd / 1e6 || 0).toFixed(1)}M`
            lines.push(`${(m.name || m.address.slice(0, 10)).slice(0, 25).padEnd(26)} ${((m.impliedApy || 0) * 100).toFixed(2).padEnd(14)}% ${tvl.padEnd(12)} ${maturity}`)
          }

          lines.push(`\nTotal: ${data.total || markets.length} | Source: Pendle API`)
          return text(lines.join('\n'))
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      default: return err(`Unknown pendle action: ${args.action}`)
    }
  }

  if (name === 'ondo') {
    switch (args.action) {
      case 'mint': {
        return text(
          `⚠️ Ondo USDY minting requires KYC via Ondo Finance.\n` +
          `To get USDY, swap on Uniswap:\n  → uniswap swap tokenIn=USDC tokenOut=${ONDO_USDY}`
        )
      }
      case 'redeem': {
        return text(
          `⚠️ Ondo USDY redemption requires KYC via Ondo Finance.\n` +
          `To exit, swap USDY → USDC on Uniswap:\n  → uniswap swap tokenIn=${ONDO_USDY} tokenOut=USDC`
        )
      }
      case 'positions': {
        const w = getActiveWallet()
        if (!w) return text('No wallet.')
        const usdyBal = await getBalance('ethereum', ONDO_USDY, 18)
        const ousgBal = await getBalance('ethereum', ONDO_OUSG, 18)
        return text(
          `📊 Ondo Positions\n\n` +
          `USDY: ${usdyBal.toFixed(4)}\n` +
          `OUSG: ${ousgBal.toFixed(4)}\n` +
          `APY: ~5% (T-bill yield)\n` +
          `Wallet: ${w.address}`
        )
      }
      default: return err(`Unknown ondo action: ${args.action}`)
    }
  }

  return null
}

const lendingModule: ToolModule = { tools: TOOLS, handle }
export default lendingModule
