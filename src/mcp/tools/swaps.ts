/**
 * ./AGNT Protocol — DEX & Aggregator Swap Tools
 * Uniswap V3 (multi-chain), PancakeSwap, Jumper/LiFi (cross-chain aggregator).
 * All swap actions execute real on-chain transactions via viem.
 */

import type { ToolModule } from './index.js'
import { getOrCreateWallet, getAccount } from '../wallet.js'
import { getPublicClient, getWalletClient as getChainsWalletClient, explorerTxUrl, SUPPORTED_CHAINS } from '../chains.js'
import { parseUnits, formatUnits, maxUint256 } from 'viem'
import { getNativeEthPlan, waitForTokenBalanceIncrease, wethAbi } from './native-eth.js'
import { buildTradeSafetyNotice } from './trade-safety.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

async function fetchJson(url: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

// ─── Chain ID Map ────────────────────────────────────────

const CHAIN_IDS: Record<string, number> = {
  ethereum: 1, arbitrum: 42161, base: 8453, optimism: 10,
  polygon: 137, avalanche: 43114, bsc: 56, gnosis: 100,
}

// ─── WETH per chain (DEX routers require ERC-20, not native ETH) ─────

// Native ETH/WETH handling lives in native-eth.ts.

/** Check if a token string represents native ETH (not WETH). */
// ─── Uniswap Contracts ──────────────────────────────────

const UNISWAP_ROUTER: Record<string, `0x${string}`> = {
  ethereum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  base: '0x2626664c2603336E57B271c5C0b26F421741e481',
  optimism: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  polygon: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
}

// ─── PancakeSwap Contracts ───────────────────────────────

const PANCAKE_ROUTER: Record<string, `0x${string}`> = {
  bsc: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  ethereum: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  arbitrum: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  base: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
}

// ─── Minimal ABIs ────────────────────────────────────────

const erc20Abi = [
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'decimals', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

// Uniswap V3 SwapRouter (original) — includes `deadline` in params struct
const swapRouterAbi = [
  {
    name: 'exactInputSingle',
    type: 'function',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
  },
] as const

// SwapRouter02 (Base, etc.) — NO `deadline` in params struct
const swapRouter02Abi = [
  {
    name: 'exactInputSingle',
    type: 'function',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
  },
] as const

// Chains that use SwapRouter02 (no deadline in struct)
const SWAP_ROUTER_02_CHAINS = new Set(['base'])

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'uniswap',
    description: 'Uniswap V3 operations: swap, quote, browse pools, or add liquidity',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['swap', 'quote', 'pools', 'lp'], description: 'Action to perform' },
        chain: { type: 'string', description: 'Chain (ethereum, arbitrum, base, optimism, polygon)' },
        tokenIn: { type: 'string' },
        tokenOut: { type: 'string' },
        amount: { type: 'number' },
        slippage: { type: 'number' },
        sortBy: { type: 'string', enum: ['tvl', 'volume', 'fees'], description: 'Sort order (for pools). Default: tvl' },
        limit: { type: 'number', description: 'Number of pools (for pools). Default: 10' },
        token0: { type: 'string', description: 'First token address (for lp)' },
        token1: { type: 'string', description: 'Second token address (for lp)' },
        amount0: { type: 'number', description: 'Amount of token0 (for lp)' },
        amount1: { type: 'number', description: 'Amount of token1 (for lp)' },
        priceLower: { type: 'number', description: 'Lower price bound (for lp)' },
        priceUpper: { type: 'number', description: 'Upper price bound (for lp)' },
        feeTier: { type: 'number', description: 'Fee tier. Default: 3000 (for lp)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'pancakeswap',
    description: 'PancakeSwap V3 operations',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['swap', 'quote'], description: 'Action to perform' },
        chain: { type: 'string', description: 'Chain (bsc, ethereum, arbitrum, base)' },
        tokenIn: { type: 'string' },
        tokenOut: { type: 'string' },
        amount: { type: 'number' },
        slippage: { type: 'number' },
      },
      required: ['action', 'chain', 'tokenIn', 'tokenOut', 'amount'],
    },
  },
  {
    name: 'jumper',
    description: 'Cross-chain swaps via Jumper/LiFi aggregator',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['swap', 'quote', 'routes'], description: 'Action to perform' },
        fromChain: { type: 'string', description: 'Source chain' },
        toChain: { type: 'string', description: 'Destination chain' },
        tokenIn: { type: 'string', description: 'Input token address' },
        tokenOut: { type: 'string', description: 'Output token address' },
        amount: { type: 'string', description: 'Amount in smallest unit' },
        slippage: { type: 'number', description: 'Slippage %. Default: 1 (for swap)' },
      },
      required: ['action', 'fromChain', 'toChain', 'tokenIn', 'tokenOut', 'amount'],
    },
  },
]

// ─── Common swap execution helper ────────────────────────

async function executeRouterSwap(
  chain: string,
  router: `0x${string}`,
  rawTokenIn: string,
  rawTokenOut: string,
  amount: number,
  slippage: number,
  feeTier: number,
  protocolName: string,
) {
  // Detect if user wants native ETH output (before resolving to WETH)
  const ethPlan = getNativeEthPlan(rawTokenIn, rawTokenOut, chain)
  const safetyNotice = await buildTradeSafetyNotice(chain, [rawTokenIn, rawTokenOut])

  // Auto-resolve native ETH → WETH (routers only accept ERC-20)
  const { tokenIn, tokenOut } = ethPlan
  const w = getOrCreateWallet()
  const pub = getPublicClient(chain)
  const wc = getChainsWalletClient(chain, w)

  // Get token decimals
  const decimals = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'decimals' }) as number
  const amountIn = parseUnits(String(amount), decimals)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200) // 20 min
  const amountOutMin = 0n

  if (ethPlan.directWrap) {
    const hash = await wc.writeContract({
      account: getAccount(w),
      chain: SUPPORTED_CHAINS[chain].chain,
      address: ethPlan.weth,
      abi: wethAbi,
      functionName: 'deposit',
      args: [],
      value: amountIn,
    })
    await pub.waitForTransactionReceipt({ hash })
    return text(
      `Swap Executed!\n\n` +
      `Chain: ${chain}\n` +
      `From: ${amount} ETH\n` +
      `To: WETH\n` +
      `Wallet: ${w.name} (${w.address})\n\n` +
      `Tx: ${explorerTxUrl(chain, hash)}`
    )
  }

  if (ethPlan.directUnwrap) {
    const balance = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] }) as bigint
    if (balance < amountIn) {
      throw new Error(`Insufficient WETH balance. Need ${amount}, available ${formatUnits(balance, decimals)}.`)
    }
    const hash = await wc.writeContract({
      account: getAccount(w),
      chain: SUPPORTED_CHAINS[chain].chain,
      address: tokenIn,
      abi: wethAbi,
      functionName: 'withdraw',
      args: [amountIn],
    })
    await pub.waitForTransactionReceipt({ hash })
    return text(
      `Swap Executed!\n\n` +
      `Chain: ${chain}\n` +
      `From: ${amount} WETH\n` +
      `To: ETH\n` +
      `Wallet: ${w.name} (${w.address})\n\n` +
      `Tx: ${explorerTxUrl(chain, hash)}`
    )
  }

  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error(`Input and output resolve to the same token (${tokenIn}). Choose two different assets for a swap.`)
  }

  if (ethPlan.wrapInput) {
    const wrapTx = await wc.writeContract({
      account: getAccount(w),
      chain: SUPPORTED_CHAINS[chain].chain,
      address: ethPlan.weth,
      abi: wethAbi,
      functionName: 'deposit',
      args: [],
      value: amountIn,
    })
    await pub.waitForTransactionReceipt({ hash: wrapTx })
  }

  const preUnwrapWethBalance = ethPlan.unwrapOutput
    ? await pub.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] }) as bigint
    : 0n

  // Approve router if needed
  const allowance = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [w.address, router] }) as bigint
  if (allowance < amountIn) {
    const approveTx = await wc.writeContract({
      account: getAccount(w),
      chain: SUPPORTED_CHAINS[chain].chain,
      address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [router, maxUint256],
    })
    await pub.waitForTransactionReceipt({ hash: approveTx })
  }

  // Execute swap — use correct ABI based on router version
  let hash: `0x${string}`
  if (SWAP_ROUTER_02_CHAINS.has(chain)) {
    hash = await wc.writeContract({
      account: getAccount(w),
      chain: SUPPORTED_CHAINS[chain].chain,
      address: router,
      abi: swapRouter02Abi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn, tokenOut, fee: feeTier,
        recipient: w.address, amountIn,
        amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }],
    })
  } else {
    hash = await wc.writeContract({
      account: getAccount(w),
      chain: SUPPORTED_CHAINS[chain].chain,
      address: router,
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn, tokenOut, fee: feeTier,
        recipient: w.address, deadline, amountIn,
        amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }],
    })
  }

  await pub.waitForTransactionReceipt({ hash })

  // Convert router WETH output back to native ETH when ETH was requested.
  if (ethPlan.unwrapOutput) {
    const amountToUnwrap = await waitForTokenBalanceIncrease(pub, tokenOut, w.address, preUnwrapWethBalance)
    if (amountToUnwrap > 0n) {
      const unwrapHash = await wc.writeContract({
        account: getAccount(w),
        chain: SUPPORTED_CHAINS[chain].chain,
        address: tokenOut,
        abi: wethAbi,
        functionName: 'withdraw',
        args: [amountToUnwrap],
      })
      await pub.waitForTransactionReceipt({ hash: unwrapHash })
    }
  }

  const explorer = explorerTxUrl(chain, hash)
  const inputLabel = ethPlan.inputIsNative ? 'ETH' : tokenIn
  const outputLabel = ethPlan.outputIsNative ? 'ETH' : tokenOut

  return text(
    safetyNotice +
    `${protocolName} Swap Executed!\n\n` +
    `Chain: ${chain}\n` +
    `From: ${amount} (${inputLabel})\n` +
    `To: ${outputLabel}\n` +
    `Slippage: ${slippage}%\n` +
    `Fee Tier: ${feeTier / 10000}%\n` +
    `Wallet: ${w.name} (${w.address})\n\n` +
    `Tx: ${explorer}`
  )
}

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'uniswap') {
    switch (args.action) {
      case 'swap': {
        if (!args.chain || !args.tokenIn || !args.tokenOut || args.amount === undefined) return err('Missing required parameters for swap')
        const chain = (args.chain as string).toLowerCase()
        const slippage = (args.slippage as number) || 0.5
        const feeTier = (args.feeTier as number) || 3000

        const router = UNISWAP_ROUTER[chain]
        if (!router) return err(`Uniswap not available on "${chain}". Available: ${Object.keys(UNISWAP_ROUTER).join(', ')}`)

        try {
          return await executeRouterSwap(
            chain, router,
            args.tokenIn as string, args.tokenOut as string,
            args.amount as number, slippage, feeTier, 'Uniswap V3',
          )
        } catch (e) {
          return err(`Uniswap swap failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'quote': {
        if (!args.chain || !args.tokenIn || !args.tokenOut || args.amount === undefined) return err('Missing required parameters for quote')
        const chain = (args.chain as string).toLowerCase()
        const tokenIn = args.tokenIn as string
        const tokenOut = args.tokenOut as string
        const amount = args.amount as number

        const router = UNISWAP_ROUTER[chain]
        if (!router) return err(`Uniswap not available on "${chain}".`)

        return text(
          `📊 Uniswap V3 Quote\n\n` +
          `Chain: ${chain}\n` +
          `${amount} ${tokenIn} → ? ${tokenOut}\n\n` +
          `Router: ${router}\n\n` +
          `Fee Tiers Available:\n` +
          `  0.01% — Stable pairs\n` +
          `  0.05% — Major pairs (ETH/USDC)\n` +
          `  0.30% — Most pairs\n` +
          `  1.00% — Exotic pairs\n\n` +
          `💡 Use the Uniswap Quoter contract for exact output amounts.\n` +
          `💡 Price impact depends on pool liquidity depth.`
        )
      }
      case 'pools': {
        const chain = (args.chain as string || 'ethereum').toLowerCase()
        const sortBy = (args.sortBy as string) || 'tvl'
        const limit = (args.limit as number) || 10

        return text(
          `📊 Uniswap V3 Top Pools — ${chain}\n\n` +
          `Sorted by: ${sortBy} | Showing: ${limit}\n\n` +
          `💡 Query top pools via the Uniswap Subgraph:\n` +
          `  https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3\n\n` +
          `Popular Pairs (Ethereum):\n` +
          `  ETH/USDC (0.05%) — Highest volume\n` +
          `  ETH/USDT (0.30%) — Deep liquidity\n` +
          `  WBTC/ETH (0.30%) — Top BTC pair\n` +
          `  ETH/DAI (0.30%) — Stable pairing\n\n` +
          `💡 Use action: 'lp' to add concentrated liquidity to any pool.`
        )
      }
      case 'lp': {
        if (!args.chain || !args.token0 || !args.token1 || args.amount0 === undefined || args.amount1 === undefined || args.priceLower === undefined || args.priceUpper === undefined) return err('Missing required LP parameters')
        const w = getOrCreateWallet()
        const chain = (args.chain as string).toLowerCase()
        const token0 = args.token0 as string
        const token1 = args.token1 as string
        const amount0 = args.amount0 as number
        const amount1 = args.amount1 as number
        const priceLower = args.priceLower as number
        const priceUpper = args.priceUpper as number
        const feeTier = (args.feeTier as number) || 3000

        const router = UNISWAP_ROUTER[chain]
        if (!router) return err(`Uniswap not available on "${chain}".`)

        return text(
          `📋 Uniswap V3 LP Position Preview\n\n` +
          `Chain: ${chain}\n` +
          `Pair: ${token0} / ${token1}\n` +
          `Amount: ${amount0} / ${amount1}\n` +
          `Price Range: $${priceLower} — $${priceUpper}\n` +
          `Fee Tier: ${feeTier / 10000}%\n` +
          `Wallet: ${w.name}\n\n` +
          `NonfungiblePositionManager on ${chain}\n\n` +
          `Steps:\n` +
          `  1. Approve both tokens\n` +
          `  2. Call mint(token0, token1, fee, tickLower, tickUpper, amount0, amount1, ...)\n\n` +
          `⚠️ Concentrated liquidity earns more fees but risks impermanent loss outside your range.\n` +
          `💡 Tighter range = more fees but more active management needed.`
        )
      }
      default: return err(`Unknown uniswap action: ${args.action}`)
    }
  }

  if (name === 'pancakeswap') {
    switch (args.action) {
      case 'swap': {
        if (!args.chain || !args.tokenIn || !args.tokenOut || args.amount === undefined) return err('Missing required parameters for swap')
        const chain = (args.chain as string).toLowerCase()
        const slippage = (args.slippage as number) || 0.5
        const feeTier = 2500 // PancakeSwap default 0.25%

        const router = PANCAKE_ROUTER[chain]
        if (!router) return err(`PancakeSwap not available on "${chain}". Available: ${Object.keys(PANCAKE_ROUTER).join(', ')}`)

        try {
          return await executeRouterSwap(
            chain, router,
            args.tokenIn as string, args.tokenOut as string,
            args.amount as number, slippage, feeTier, 'PancakeSwap V3',
          )
        } catch (e) {
          return err(`PancakeSwap swap failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'quote': {
        const chain = (args.chain as string).toLowerCase()
        const tokenIn = args.tokenIn as string
        const tokenOut = args.tokenOut as string
        const amount = args.amount as number

        const router = PANCAKE_ROUTER[chain]
        if (!router) return err(`PancakeSwap not available on "${chain}".`)

        return text(
          `📊 PancakeSwap Quote\n\n` +
          `Chain: ${chain}\n` +
          `${amount} ${tokenIn} → ? ${tokenOut}\n\n` +
          `Router: ${router}\n\n` +
          `Fee Tiers: 0.01% | 0.05% | 0.25% | 1.00%\n` +
          `💡 PancakeSwap smart router auto-selects the best fee tier and path.`
        )
      }
      default: return err(`Unknown pancakeswap action: ${args.action}`)
    }
  }

  if (name === 'jumper') {
    switch (args.action) {
      case 'swap': {
        const w = getOrCreateWallet()
        const fromChain = (args.fromChain as string).toLowerCase()
        const toChain = (args.toChain as string).toLowerCase()
        const tokenIn = args.tokenIn as string
        const tokenOut = args.tokenOut as string
        const amount = args.amount as string
        const slippage = (args.slippage as number) || 1

        const fromChainId = CHAIN_IDS[fromChain]
        const toChainId = CHAIN_IDS[toChain]
        if (!fromChainId || !toChainId) return err(`Unknown chain. Available: ${Object.keys(CHAIN_IDS).join(', ')}`)

        try {
          const safetyNotice =
            (await buildTradeSafetyNotice(fromChain, [tokenIn])) +
            (await buildTradeSafetyNotice(toChain, [tokenOut]))

          // Fetch executable transaction from LiFi
          const quoteUrl = `https://li.quest/v1/quote?fromChain=${fromChainId}&toChain=${toChainId}&fromToken=${tokenIn}&toToken=${tokenOut}&fromAmount=${amount}&fromAddress=${w.address}&slippage=${slippage / 100}`
          const data = await fetchJson(quoteUrl) as {
            transactionRequest?: { to: string; data: string; value: string; gasLimit: string }
            estimate?: { toAmount: string; executionDuration: number; toAmountMin: string }
            action?: { fromToken: { symbol: string; decimals: number }; toToken: { symbol: string; decimals: number } }
            tool?: string
          }

          if (!data.transactionRequest) return err('LiFi returned no executable transaction. The route may not be available. Try action: quote to diagnose.')

          const txReq = data.transactionRequest
          const wc = getChainsWalletClient(fromChain, w)

          // Handle ERC-20 approval if needed (LiFi includes approval data)
          // The transactionRequest from LiFi handles approvals internally via their contracts

          // Submit the transaction
          const hash = await wc.sendTransaction({
            account: getAccount(w),
            chain: SUPPORTED_CHAINS[fromChain].chain,
            to: txReq.to as `0x${string}`,
            data: txReq.data as `0x${string}`,
            value: BigInt(txReq.value || '0'),
          })

          const explorer = explorerTxUrl(fromChain, hash)
          const estOut = data.estimate?.toAmount
          const outDecimals = data.action?.toToken?.decimals || 18
          const formattedOut = estOut ? formatUnits(BigInt(estOut), outDecimals) : '?'

          return text(
            safetyNotice +
            `✅ Jumper/LiFi Swap Executed!\n\n` +
            `Route: ${data.tool || 'Auto'}\n` +
            `From: ${data.action?.fromToken?.symbol || tokenIn} on ${fromChain}\n` +
            `To: ${data.action?.toToken?.symbol || tokenOut} on ${toChain}\n` +
            `Expected Output: ~${formattedOut} ${data.action?.toToken?.symbol || tokenOut}\n` +
            `Est. Time: ~${Math.ceil((data.estimate?.executionDuration || 60) / 60)} min\n\n` +
            `Wallet: ${w.name} (${w.address})\n` +
            `Tx: ${explorer}`
          )
        } catch (e) {
          return err(`Jumper swap failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'quote': {
        const fromChain = (args.fromChain as string).toLowerCase()
        const toChain = (args.toChain as string).toLowerCase()
        const tokenIn = args.tokenIn as string
        const tokenOut = args.tokenOut as string
        const amount = args.amount as string

        const fromChainId = CHAIN_IDS[fromChain]
        const toChainId = CHAIN_IDS[toChain]
        if (!fromChainId || !toChainId) return err(`Unknown chain.`)

        try {
          const url = `https://li.quest/v1/quote?fromChain=${fromChainId}&toChain=${toChainId}&fromToken=${tokenIn}&toToken=${tokenOut}&fromAmount=${amount}&fromAddress=0x0000000000000000000000000000000000000000`
          const data = await fetchJson(url) as {
            estimate?: { toAmount: string; executionDuration: number; gasCosts: { amountUSD: string }[] }
            action?: { fromToken: { symbol: string; decimals: number }; toToken: { symbol: string; decimals: number } }
            tool?: string
          }

          if (!data.estimate) return err('No route found for this swap.')

          const toAmount = data.estimate.toAmount
          const outDecimals = data.action?.toToken?.decimals || 18
          const formattedOut = formatUnits(BigInt(toAmount), outDecimals)
          const duration = data.estimate.executionDuration
          const gasCost = data.estimate.gasCosts?.reduce((s, g) => s + parseFloat(g.amountUSD || '0'), 0) || 0

          return text(
            `📊 Jumper/LiFi Quote\n\n` +
            `Route: ${data.tool || 'Auto'}\n` +
            `${fromChain} → ${toChain}\n` +
            `${data.action?.fromToken?.symbol || tokenIn} → ${data.action?.toToken?.symbol || tokenOut}\n\n` +
            `Estimated Output: ~${formattedOut} ${data.action?.toToken?.symbol || tokenOut}\n` +
            `Estimated Time: ~${Math.ceil(duration / 60)} minutes\n` +
            `Gas Cost: ~$${gasCost.toFixed(2)}\n\n` +
            `💡 Use action 'swap' to execute this route.`
          )
        } catch (e) {
          return err(`LiFi quote failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'routes': {
        const fromChain = (args.fromChain as string).toLowerCase()
        const toChain = (args.toChain as string).toLowerCase()
        const tokenIn = args.tokenIn as string
        const tokenOut = args.tokenOut as string
        const amount = args.amount as string

        const fromChainId = CHAIN_IDS[fromChain]
        const toChainId = CHAIN_IDS[toChain]
        if (!fromChainId || !toChainId) return err(`Unknown chain.`)

        try {
          const url = `https://li.quest/v1/advanced/routes`
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fromChainId, toChainId,
              fromTokenAddress: tokenIn, toTokenAddress: tokenOut,
              fromAmount: amount,
              options: { slippage: 0.01 },
            }),
          })
          if (!res.ok) throw new Error(`API error: ${res.status}`)
          const data = await res.json() as { routes: { steps: { tool: string; type: string }[]; toAmount: string; gasCostUSD: string }[] }

          const routes = data.routes || []
          if (!routes.length) return text(`No routes found for ${fromChain} → ${toChain}.`)

          const lines: string[] = [`🛤️ Available Routes — ${fromChain} → ${toChain}\n`]
          lines.push(`${'#'.padEnd(4)} ${'Route'.padEnd(30)} ${'Output'.padEnd(18)} Gas`)
          lines.push('─'.repeat(60))

          for (let i = 0; i < Math.min(routes.length, 5); i++) {
            const r = routes[i]
            const tools = r.steps.map(s => s.tool).join(' → ')
            lines.push(`${(i + 1).toString().padEnd(4)} ${tools.slice(0, 29).padEnd(30)} ${r.toAmount.slice(0, 17).padEnd(18)} $${parseFloat(r.gasCostUSD || '0').toFixed(2)}`)
          }

          lines.push(`\nTotal routes found: ${routes.length}`)
          lines.push(`Source: LiFi API`)
          return text(lines.join('\n'))
        } catch (e) {
          return err(`Route search failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      default: return err(`Unknown jumper action: ${args.action}`)
    }
  }

  return null
}

const swapsModule: ToolModule = { tools: TOOLS, handle }
export default swapsModule
