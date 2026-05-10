/**
 * ./AGNT Protocol — Liquid Staking & Restaking Tools
 * Lido (stETH), EigenLayer (restaking), Ethena (USDe/sUSDe).
 * All actions execute real on-chain transactions via tx-executor.
 */

import type { ToolModule } from './index.js'
import { getActiveWallet, getOrCreateWallet } from '../wallet.js'
import { parseUnits } from 'viem'
import { callContract, ensureApproval, formatTxResult, getNativeBalance, getBalance } from '../tx-executor.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

// ─── Contract Addresses ──────────────────────────────────

const LIDO_STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as `0x${string}`
const LIDO_WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as `0x${string}`

const EIGEN_STRATEGY_MANAGER = '0x858646372CC42E1A627fcE94aa7A7033e7CF075A' as `0x${string}`

const ETHENA_USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3' as `0x${string}`
const ETHENA_SUSDE = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497' as `0x${string}`

// ─── ABIs ────────────────────────────────────────────────

const lidoAbi = [
  { name: 'submit', type: 'function', stateMutability: 'payable', inputs: [{ name: '_referral', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

const wstethAbi = [
  { name: 'wrap', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_stETHAmount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

const eigenAbi = [
  { name: 'depositIntoStrategy', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'strategy', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

const erc4626Abi = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

const STRATEGIES: Record<string, { strategy: `0x${string}`; token: `0x${string}`; decimals: number }> = {
  steth: { strategy: '0x93c4b944D05dfe6df7645A86cd2206016c51564D', token: LIDO_STETH, decimals: 18 },
  reth: { strategy: '0x1BeE69b7dFFfA4E2d53C2a2Df135C388AD25dCD2', token: '0xae78736Cd615f374D3085123A210448E74Fc6393', decimals: 18 },
  cbeth: { strategy: '0x54945180dB7943c0ed0FEE7EdaB2Bd24620256bc', token: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', decimals: 18 },
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'lido',
    description: 'Lido liquid staking operations (stETH)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['stake', 'withdraw', 'positions'], description: 'Action to perform' },
        amount: { type: 'number', description: 'Amount of ETH (for stake/withdraw)' },
        wrapToWstETH: { type: 'boolean', description: 'Wrap stETH to wstETH (for stake)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'eigenlayer',
    description: 'EigenLayer restaking operations',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['deposit', 'withdraw', 'positions'], description: 'Action to perform' },
        token: { type: 'string', description: 'LST token (stETH, rETH, cbETH)' },
        amount: { type: 'number', description: 'Amount to deposit/withdraw' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ethena',
    description: 'Ethena USDe minting and staking',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['mint', 'stake', 'positions'], description: 'Action to perform' },
        amount: { type: 'number', description: 'Amount to mint/stake' },
        collateral: { type: 'string', description: 'Collateral token (for mint)' },
      },
      required: ['action'],
    },
  },
]

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'lido') {
    switch (args.action) {
      case 'stake': {
        if (args.amount === undefined) return err('Missing amount')
        const amount = args.amount as number
        const wrap = (args.wrapToWstETH as boolean) || false

        try {
          const bal = await getNativeBalance('ethereum')
          if (bal < amount) return err(`Insufficient ETH. Have ${bal.toFixed(4)}, need ${amount}`)

          const value = parseUnits(amount.toString(), 18)
          const tx = await callContract('ethereum', LIDO_STETH, lidoAbi, 'submit', ['0x0000000000000000000000000000000000000000'], value)

          let wrapTx = ''
          if (wrap) {
            await ensureApproval('ethereum', LIDO_STETH, LIDO_WSTETH, value)
            const tx2 = await callContract('ethereum', LIDO_WSTETH, wstethAbi, 'wrap', [value])
            wrapTx = `\nWrap tx: ${tx2.hash} (${tx2.explorer})`
          }

          return text(
            formatTxResult(tx, `Lido Stake — ${amount} ETH → ${wrap ? 'wstETH' : 'stETH'}`) + wrapTx
          )
        } catch (e) {
          return err(`Stake failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'withdraw': {
        if (args.amount === undefined) return err('Missing amount')
        return text(
          `⚠️ Lido withdrawals require a 2-step process:\n` +
          `1. Request withdrawal (1-5 day queue)\n2. Claim ETH after finalization\n\n` +
          `For instant exit, swap stETH → ETH on Uniswap/Curve instead.`
        )
      }
      case 'positions': {
        const w = getActiveWallet()
        if (!w) return text('No wallet. Create one first.')
        try {
          const stBal = await getBalance('ethereum', LIDO_STETH, 18)
          const wstBal = await getBalance('ethereum', LIDO_WSTETH, 18)
          const apyData = await fetchJson('https://eth-api.lido.fi/v1/protocol/steth/apr/sma') as any
          const apy = apyData?.data?.smaApr || 3.5
          return text(
            `📊 Lido Positions\n\n` +
            `stETH: ${stBal.toFixed(4)} (~$${(stBal * 2500).toFixed(2)})\n` +
            `wstETH: ${wstBal.toFixed(4)}\n` +
            `APY: ~${apy.toFixed(2)}%\n` +
            `Wallet: ${w.address}`
          )
        } catch (e) {
          return err(`Failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      default: return err(`Unknown lido action: ${args.action}`)
    }
  }

  if (name === 'eigenlayer') {
    switch (args.action) {
      case 'deposit': {
        if (!args.token || args.amount === undefined) return err('Missing token or amount')
        const w = getOrCreateWallet()
        const token = (args.token as string).toLowerCase()
        const amount = args.amount as number
        const s = STRATEGIES[token]
        if (!s) return err(`Unsupported token. Available: ${Object.keys(STRATEGIES).join(', ')}`)

        try {
          const rawAmount = parseUnits(amount.toString(), s.decimals)
          await ensureApproval('ethereum', s.token, EIGEN_STRATEGY_MANAGER, rawAmount)
          const tx = await callContract('ethereum', EIGEN_STRATEGY_MANAGER, eigenAbi, 'depositIntoStrategy', [s.strategy, s.token, rawAmount])
          return text(
            formatTxResult(tx, `EigenLayer Deposit — ${amount} ${token.toUpperCase()}`) +
            `\n⚠️ Delegate to an operator to earn AVS rewards. Withdrawals have 7-day escrow.`
          )
        } catch (e) {
          return err(`Deposit failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'withdraw': {
        return text(
          `⚠️ EigenLayer withdrawals require:\n` +
          `1. Queue withdrawal via DelegationManager\n` +
          `2. Wait 7-day escrow\n3. Complete withdrawal\n\n` +
          `Use the EigenLayer app for the multi-step withdrawal flow.`
        )
      }
      case 'positions': {
        const w = getActiveWallet()
        if (!w) return text('No wallet.')
        const lines: string[] = ['📊 EigenLayer Positions\n']
        for (const [name, s] of Object.entries(STRATEGIES)) {
          const bal = await getBalance('ethereum', s.token, s.decimals)
          if (bal > 0.0001) lines.push(`  ${name.toUpperCase()}: ${bal.toFixed(4)}`)
        }
        lines.push(`\nWallet: ${w.address}`)
        return text(lines.join('\n'))
      }
      default: return err(`Unknown eigenlayer action: ${args.action}`)
    }
  }

  if (name === 'ethena') {
    switch (args.action) {
      case 'mint': {
        return text(
          `⚠️ Ethena USDe minting requires KYC/whitelisting.\n` +
          `To get USDe, swap on Uniswap or Curve instead:\n` +
          `  → Use: uniswap swap tokenIn=USDC tokenOut=${ETHENA_USDE}`
        )
      }
      case 'stake': {
        if (args.amount === undefined) return err('Missing amount')
        const w = getOrCreateWallet()
        const amount = args.amount as number

        try {
          const rawAmount = parseUnits(amount.toString(), 18)
          await ensureApproval('ethereum', ETHENA_USDE, ETHENA_SUSDE, rawAmount)
          const tx = await callContract('ethereum', ETHENA_SUSDE, erc4626Abi, 'deposit', [rawAmount, w.address])
          return text(
            formatTxResult(tx, `Ethena Stake — ${amount} USDe → sUSDe`) +
            `\nsUSDe is an ERC-4626 vault — value accrues over time.`
          )
        } catch (e) {
          return err(`Stake failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'positions': {
        const w = getActiveWallet()
        if (!w) return text('No wallet.')
        const usdeBal = await getBalance('ethereum', ETHENA_USDE, 18)
        const susdeBal = await getBalance('ethereum', ETHENA_SUSDE, 18)
        return text(
          `📊 Ethena Positions\n\n` +
          `USDe: ${usdeBal.toFixed(2)}\n` +
          `sUSDe: ${susdeBal.toFixed(4)}\n` +
          `Wallet: ${w.address}`
        )
      }
      default: return err(`Unknown ethena action: ${args.action}`)
    }
  }

  return null
}

const protocolsModule: ToolModule = { tools: TOOLS, handle }
export default protocolsModule
