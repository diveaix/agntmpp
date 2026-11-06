/**
 * ./AGENT Protocol — Bridge Tools
 * Relay and Jumper/LI.FI cross-chain routes.
 * All bridge actions execute real on-chain transactions.
 */

import type { ToolModule } from './index.js'
import { assertSupportedRoute } from './integration-policy.js'
import { getOrCreateWallet, getAccount } from '../wallet.js'
import { getWalletClient as getChainsWalletClient, getPublicClient, explorerTxUrl, SUPPORTED_CHAINS } from '../chains.js'
import { decodeFunctionData, encodeFunctionData, formatUnits } from 'viem'
import { buildTradeSafetyNotice } from './trade-safety.js'
import { assessRouteUsdValues, assessRouteValue } from './route-safety.js'
import { assertNativeBalanceCoversTx, isNativeToken, knownTokenDecimals, resolveRouteAmount, resolveTokenAddress } from './aggregator-assets.js'
import { planExactApproval } from './approval-policy.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

async function fetchJson(url: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

function normalizeRelayCurrency(chain: string, currency: string | undefined, fallback: string): string {
  return resolveTokenAddress(chain, currency || fallback)
}

// ─── Chain ID Map ────────────────────────────────────────

const CHAIN_IDS: Record<string, number> = {
  ethereum: 1, arbitrum: 42161, base: 8453, optimism: 10,
  polygon: 137, avalanche: 43114, bsc: 56, linea: 59144, zksync: 324,
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Minimal ERC-20 ABI for approvals
const erc20Abi = [
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

async function approveExactIfNeeded(input: {
  chain: string
  token: `0x${string}`
  owner: `0x${string}`
  spender: `0x${string}`
  amount: bigint
  pub: ReturnType<typeof getPublicClient>
  wc: ReturnType<typeof getChainsWalletClient>
  wallet: ReturnType<typeof getAccount>
}) {
  const current = await input.pub.readContract({
    address: input.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [input.owner, input.spender],
  }) as bigint

  const plan = planExactApproval(current, input.amount)
  if (plan.alreadyExact) return []

  const hashes: `0x${string}`[] = []
  if (plan.resetAmount !== null) {
    const resetData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.spender, 0n] })
    await assertNativeBalanceCoversTx({ client: input.pub, account: input.owner, to: input.token, data: resetData, value: 0n, chain: input.chain })
    const resetHash = await input.wc.sendTransaction({
      account: input.wallet,
      chain: SUPPORTED_CHAINS[input.chain].chain,
      to: input.token,
      data: resetData,
      value: 0n,
    })
    await input.pub.waitForTransactionReceipt({ hash: resetHash as `0x${string}` })
    hashes.push(resetHash as `0x${string}`)
  }

  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.spender, plan.approveAmount!] })
  await assertNativeBalanceCoversTx({ client: input.pub, account: input.owner, to: input.token, data: approveData, value: 0n, chain: input.chain })
  const approveHash = await input.wc.sendTransaction({
    account: input.wallet,
    chain: SUPPORTED_CHAINS[input.chain].chain,
    to: input.token,
    data: approveData,
    value: 0n,
  })
  await input.pub.waitForTransactionReceipt({ hash: approveHash as `0x${string}` })
  hashes.push(approveHash as `0x${string}`)
  return hashes
}

function decodeApproval(data: string): { spender: `0x${string}`; amount: bigint } | null {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: data as `0x${string}` })
    if (decoded.functionName !== 'approve') return null
    const [spender, amount] = decoded.args
    return { spender, amount }
  } catch {
    return null
  }
}

// ─── Tool Definitions ────────────────────────────────────

function approvalSummary(chain: string, hashes: `0x${string}`[]): string {
  if (!hashes.length) return ''
  const lines = hashes.map((hash) => `- ${explorerTxUrl(chain, hash)}`).join('\n')
  return `\nApproval transaction${hashes.length === 1 ? '' : 's'}:\n${lines}\n`
}

const TOOLS = [
  {
    name: 'jumper',
    description: 'Cross-chain swaps via Jumper/LI.FI aggregator',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['swap', 'quote', 'routes'], description: 'Action to perform' },
        fromChain: { type: 'string', description: 'Source chain' },
        toChain: { type: 'string', description: 'Destination chain.' },
        tokenIn: { type: 'string', description: 'Input token address' },
        tokenOut: { type: 'string', description: 'Output token address.' },
        amount: { type: 'string', description: 'Human-readable amount, or all/max. For native ETH all/max, gas is reserved automatically.' },
        nativeReserveEth: { type: 'string', description: 'ETH to keep for gas when amount is all/max for the native token. Default: 0.0005 ETH.' },
        slippage: { type: 'number', description: 'Slippage %. Default: 1' },
        maxLossPercent: { type: 'number', description: 'Maximum allowed estimated value loss in %. Default 10, cannot be raised above 10.' },
        toAddress: { type: 'string', description: 'Destination address (defaults to sender)' },
      },
      required: ['action', 'fromChain', 'toChain', 'tokenIn', 'amount'],
    },
  },
  {
    name: 'relay',
    description: 'Relay bridge for ultra-fast cross-chain transfers',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['bridge', 'quote'], description: 'Action to perform' },
        fromChain: { type: 'string', description: 'Source chain' },
        toChain: { type: 'string', description: 'Destination chain' },
        token: { type: 'string', description: 'Token address on source chain (use 0x0000000000000000000000000000000000000000 for the native gas token)' },
        toToken: { type: 'string', description: 'Token address on destination chain. Defaults to same as token.' },
        amount: { type: 'string', description: 'Amount in human-readable units, or all/max. For native ETH all/max, gas is reserved automatically.' },
        nativeReserveEth: { type: 'string', description: 'ETH to keep for gas when amount is all/max for the native token. Default: 0.0005 ETH.' },
        decimals: { type: 'number', description: 'Token decimals. Default: 6 for stablecoins, 18 for ETH' },
        maxLossPercent: { type: 'number', description: 'Maximum allowed estimated value loss in %. Default 10, cannot be raised above 10.' },
        toAddress: { type: 'string', description: 'Destination address (defaults to sender)' },
      },
      required: ['action', 'fromChain', 'toChain', 'token', 'amount'],
    },
  },
]

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'jumper' || name === 'relay') {
    for (const key of ['fromChain', 'toChain']) {
      if (!CHAIN_IDS[String(args[key] || '').toLowerCase()]) return err(`Unknown chain. Available: ${Object.keys(CHAIN_IDS).join(', ')}`)
    }
  }
  if (name === 'jumper') {
    const w = getOrCreateWallet()
    const fromChain = (args.fromChain as string | undefined || '').toLowerCase()
    const toChain = (args.toChain as string | undefined || '').toLowerCase()
    const tokenIn = args.tokenIn ? resolveTokenAddress(fromChain, args.tokenIn as string, { lifiNative: true }) : undefined
    const tokenOut = args.tokenOut as string | undefined
    const resolvedTokenOut = tokenOut ? resolveTokenAddress(toChain, tokenOut, { lifiNative: true }) : undefined
    const rawAmount = args.amount as string | undefined
    const slippage = ((args.slippage as number | undefined) ?? 1) / 100
    const maxLossPercent = Math.min((args.maxLossPercent as number | undefined) ?? 10, 10)
    const toAddress = (args.toAddress as string | undefined) || w.address
    const fromId = CHAIN_IDS[fromChain]
    const toId = CHAIN_IDS[toChain]

    if (!fromId || !toId) return err(`Unknown chain. Available: ${Object.keys(CHAIN_IDS).join(', ')}`)
    if (!tokenIn || !resolvedTokenOut || !rawAmount) return err('Missing tokenIn, tokenOut, or amount.')
    if (!SUPPORTED_CHAINS[fromChain]) return err(`Execution from ${fromChain} is not wired in this server yet.`)

    try {
      const pub = getPublicClient(fromChain)
      const inputDecimals = knownTokenDecimals(fromChain, tokenIn)
      const amount = (await resolveRouteAmount({
        amount: rawAmount,
        decimals: inputDecimals,
        token: tokenIn,
        account: w.address as `0x${string}`,
        client: pub,
        nativeReserve: args.nativeReserveEth,
      })).toString()
      const qs = new URLSearchParams({
        fromChain: String(fromId),
        toChain: String(toId),
        fromToken: tokenIn,
        toToken: resolvedTokenOut,
        fromAmount: amount,
        fromAddress: w.address,
        toAddress,
        slippage: String(slippage),
        integrator: 'agnt',
      })

      const quote = await fetchJson(`https://li.quest/v1/quote?${qs.toString()}`) as {
        id?: string
        tool?: string
        action?: {
          fromAmount?: string
          fromToken?: { symbol?: string; decimals?: number; chainId?: number; priceUSD?: string }
          toToken?: { symbol?: string; decimals?: number; chainId?: number; name?: string; priceUSD?: string }
        }
        estimate?: {
          toAmount?: string
          toAmountMin?: string
          approvalAddress?: string
          executionDuration?: number
          feeCosts?: { name?: string; amountUSD?: string }[]
          gasCosts?: { amountUSD?: string }[]
        }
        transactionRequest?: { to: string; data: string; value?: string }
      }

      assertSupportedRoute(quote)
      const fromDecimals = quote.action?.fromToken?.decimals ?? inputDecimals
      const toDecimals = quote.action?.toToken?.decimals ?? 6
      const inAmount = formatUnits(BigInt(quote.action?.fromAmount || amount), fromDecimals)
      const outAmount = quote.estimate?.toAmount ? formatUnits(BigInt(quote.estimate.toAmount), toDecimals) : '?'
      const minOutAmount = quote.estimate?.toAmountMin ? formatUnits(BigInt(quote.estimate.toAmountMin), toDecimals) : '?'
      const sourceGasUsd = quote.estimate?.gasCosts?.reduce((sum, c) => sum + Number(c.amountUSD || 0), 0) ?? 0
      const routeFeesUsd = quote.estimate?.feeCosts?.reduce((sum, c) => sum + Number(c.amountUSD || 0), 0) ?? 0
      const routeValue = assessRouteValue({
        fromAmount: BigInt(quote.action?.fromAmount || amount),
        fromDecimals,
        fromPriceUsd: quote.action?.fromToken?.priceUSD,
        toAmount: quote.estimate?.toAmount ? BigInt(quote.estimate.toAmount) : undefined,
        toDecimals,
        toPriceUsd: quote.action?.toToken?.priceUSD,
        maxLossPercent,
      })
      const destinationLabel = toChain
      const preview =
        `Jumper / LI.FI Route\n\n` +
        `You send: ${inAmount} ${quote.action?.fromToken?.symbol || 'token'} on ${fromChain}\n` +
        `You receive: about ${outAmount} ${quote.action?.toToken?.symbol || 'token'} on ${destinationLabel}\n` +
        `Estimated value: $${routeValue.inputUsd.toFixed(2)} in → $${routeValue.outputUsd.toFixed(2)} out\n` +
        `Estimated value loss: ${routeValue.lossPercent.toFixed(2)}% (limit: ${routeValue.maxLossPercent.toFixed(2)}%)\n` +
        `Minimum received after slippage: ${minOutAmount}\n` +
        `Recipient: ${toAddress}\n` +
        `Route: ${quote.tool || quote.id || 'LI.FI'}\n` +
        `Estimated time: ${quote.estimate?.executionDuration || '?'} seconds\n` +
        `Estimated source-chain gas: $${sourceGasUsd.toFixed(2)}\n` +
        `Estimated route fees: $${routeFeesUsd.toFixed(2)}\n\n` +
        `No live route was executed.`

      if (routeValue.blocked) {
        return err(
          `${routeValue.reason}\n\n` +
          preview +
          `\nThis route is too expensive to use. Try a larger amount, a different source token or a different source token.`
        )
      }

      if (args.action === 'quote' || args.action === 'routes') return text(preview)
      if (args.action !== 'swap') return err(`Unknown jumper action: ${args.action}`)
      if (!quote.transactionRequest?.to || !quote.transactionRequest?.data) return err('LI.FI returned no executable transaction.')

      const safetyNotice =
        (await buildTradeSafetyNotice(fromChain, [tokenIn])) +
        (await buildTradeSafetyNotice(toChain, [resolvedTokenOut]))

      const wc = getChainsWalletClient(fromChain, w)
      const txTo = quote.transactionRequest.to as `0x${string}`
      const txData = quote.transactionRequest.data as `0x${string}`
      const txValue = BigInt(quote.transactionRequest.value || '0')
      await assertNativeBalanceCoversTx({
        client: pub,
        account: w.address,
        to: txTo,
        data: txData,
        value: txValue,
        chain: fromChain,
      })

      let approvalHashes: `0x${string}`[] = []
      if (!isNativeToken(tokenIn) && quote.estimate?.approvalAddress) {
        approvalHashes = await approveExactIfNeeded({
          chain: fromChain,
          token: tokenIn as `0x${string}`,
          owner: w.address as `0x${string}`,
          spender: quote.estimate.approvalAddress as `0x${string}`,
          amount: BigInt(amount),
          pub,
          wc,
          wallet: getAccount(w),
        })
      }

      const hash = await wc.sendTransaction({
        account: getAccount(w),
        chain: SUPPORTED_CHAINS[fromChain].chain,
        to: txTo,
        data: txData,
        value: txValue,
      })
      const explorer = explorerTxUrl(fromChain, hash)

      return text(
        safetyNotice +
        preview.replace('No live route was executed.', 'Live route was submitted.') +
        approvalSummary(fromChain, approvalHashes) +
        `\nSource transaction: ${explorer}\n\n`
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('AMOUNT_TOO_LOW')) {
        return err('Jumper has no route for this amount. Try a larger amount or a different source token.')
      }
      if (msg.includes('No available quotes') || msg.includes('None of the available routes')) {
        return err('Jumper has no executable route for this source chain, token, and amount right now. Try another source chain, a larger amount, or a different source token.')
      }
      return err(`Jumper route failed: ${msg}`)
    }
  }

  if (name === 'relay') {
    switch (args.action) {
      case 'bridge': {
        const w = getOrCreateWallet()
        const fromChain = (args.fromChain as string).toLowerCase()
        const toChain = (args.toChain as string).toLowerCase()
        const token = normalizeRelayCurrency(fromChain, args.token as string, ZERO_ADDRESS)
        const toToken = normalizeRelayCurrency(toChain, args.toToken as string | undefined, token)
        const rawAmount = args.amount as string
        const decimals = (args.decimals as number) || knownTokenDecimals(fromChain, token)
        const maxLossPercent = Math.min((args.maxLossPercent as number | undefined) ?? 10, 10)
        const pub = getPublicClient(fromChain)
        const amount = (await resolveRouteAmount({
          amount: rawAmount,
          decimals,
          token,
          account: w.address as `0x${string}`,
          client: pub,
          nativeReserve: args.nativeReserveEth,
        })).toString()
        const toAddress = (args.toAddress as string) || w.address

        const fromId = CHAIN_IDS[fromChain]
        const toId = CHAIN_IDS[toChain]
        if (!fromId || !toId) return err(`Unknown chain. Available: ${Object.keys(CHAIN_IDS).join(', ')}`)

        try {
          const safetyNotice =
            (await buildTradeSafetyNotice(fromChain, [token])) +
            (await buildTradeSafetyNotice(toChain, [toToken]))

          // Step 1: Get executable quote from Relay API
          const quoteData = await fetchJson('https://api.relay.link/quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user: w.address,
              originChainId: fromId,
              destinationChainId: toId,
              originCurrency: token,
              destinationCurrency: toToken,
              recipient: toAddress,
              tradeType: 'EXACT_INPUT',
              amount: amount,
              referrer: 'agnt.dev',
            }),
          }) as {
            steps?: { items: { data: { to: string; data: string; value: string }; check?: { endpoint: string } }[] }[]
            details?: { currencyIn?: { amountFormatted: string; amountUsd?: string; currency: { symbol: string } }; currencyOut?: { amountFormatted: string; amountUsd?: string; currency: { symbol: string } }; timeEstimate: number }
          }

          assertSupportedRoute(quoteData)
          if (!quoteData.steps?.length || !quoteData.steps[0]?.items?.length) {
            return err('Relay returned no executable steps. Route may not be available.')
          }
          const routeValue = assessRouteUsdValues({
            inputUsd: quoteData.details?.currencyIn?.amountUsd,
            outputUsd: quoteData.details?.currencyOut?.amountUsd,
            maxLossPercent,
          })
          if (routeValue.blocked) {
            return err(
              `${routeValue.reason}\n\n` +
              `Relay route blocked before any approval or bridge transaction.\n` +
              `You send: $${routeValue.inputUsd.toFixed(2)} value\n` +
              `You receive: $${routeValue.outputUsd.toFixed(2)} value\n` +
              `Try a larger amount, a different source token, or another route.`
            )
          }

          const wc = getChainsWalletClient(fromChain, w)

          // Execute each step (usually 1 approval + 1 bridge tx, or just 1 for native)
          let lastHash = ''
          const approvalHashes: `0x${string}`[] = []
          for (const step of quoteData.steps) {
            for (const item of step.items) {
              const txData = item.data
              const relayApproval = !isNativeToken(token) && txData.to?.toLowerCase() === token.toLowerCase()
                ? decodeApproval(txData.data || '0x')
                : null
              if (relayApproval) {
                approvalHashes.push(...await approveExactIfNeeded({
                  chain: fromChain,
                  token: token as `0x${string}`,
                  owner: w.address as `0x${string}`,
                  spender: relayApproval.spender,
                  amount: BigInt(amount),
                  pub,
                  wc,
                  wallet: getAccount(w),
                }))
                continue
              }
              await assertNativeBalanceCoversTx({
                client: pub,
                account: w.address,
                to: txData.to as `0x${string}`,
                data: (txData.data || '0x') as `0x${string}`,
                value: BigInt(txData.value || '0'),
                chain: fromChain,
              })
              lastHash = await wc.sendTransaction({
                account: getAccount(w),
                chain: SUPPORTED_CHAINS[fromChain].chain,
                to: txData.to as `0x${string}`,
                data: (txData.data || '0x') as `0x${string}`,
                value: BigInt(txData.value || '0'),
              })

              // If there's a check endpoint, wait for confirmation before next step
              if (item.check?.endpoint) {
                await pub.waitForTransactionReceipt({ hash: lastHash as `0x${string}` })
              }
            }
          }

          const explorer = explorerTxUrl(fromChain, lastHash)
          const inFormatted = quoteData.details?.currencyIn?.amountFormatted || amount
          const inSymbol = quoteData.details?.currencyIn?.currency?.symbol || token
          const outFormatted = quoteData.details?.currencyOut?.amountFormatted || '~'
          const outSymbol = quoteData.details?.currencyOut?.currency?.symbol || token
          const timeEst = quoteData.details?.timeEstimate || 30

          return text(
            safetyNotice +
            `✅ Relay Bridge Executed!\n\n` +
            `From: ${inFormatted} ${inSymbol} on ${fromChain}\n` +
            `To: ~${outFormatted} ${outSymbol} on ${toChain}\n` +
            `Estimated value loss: ${routeValue.lossPercent.toFixed(2)}% (limit: ${routeValue.maxLossPercent.toFixed(2)}%)\n` +
            `Recipient: ${toAddress}\n` +
            `Est. Time: ~${timeEst}s\n\n` +
            `Wallet: ${w.name} (${w.address})\n` +
            approvalSummary(fromChain, approvalHashes) +
            `Tx: ${explorer}`
          )
        } catch (e) {
          return err(`Relay bridge failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'quote': {
        const w = getOrCreateWallet()
        const fromChain = (args.fromChain as string).toLowerCase()
        const toChain = (args.toChain as string).toLowerCase()
        const token = normalizeRelayCurrency(fromChain, args.token as string, ZERO_ADDRESS)
        const toToken = normalizeRelayCurrency(toChain, args.toToken as string | undefined, token)
        const rawAmount = args.amount as string
        const decimals = (args.decimals as number) || knownTokenDecimals(fromChain, token)
        const maxLossPercent = Math.min((args.maxLossPercent as number | undefined) ?? 10, 10)
        const amount = (await resolveRouteAmount({
          amount: rawAmount,
          decimals,
          token,
          account: w.address as `0x${string}`,
          client: getPublicClient(fromChain),
          nativeReserve: args.nativeReserveEth,
        })).toString()

        const fromId = CHAIN_IDS[fromChain]
        const toId = CHAIN_IDS[toChain]
        if (!fromId || !toId) return err(`Unknown chain.`)

        try {
          const quoteData = await fetchJson('https://api.relay.link/quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user: w.address,
              originChainId: fromId,
              destinationChainId: toId,
              originCurrency: token,
              destinationCurrency: toToken,
              recipient: w.address,
              tradeType: 'EXACT_INPUT',
              amount: amount,
            }),
          }) as {
            details?: {
              currencyIn?: { amountFormatted: string; amountUsd?: string; currency: { symbol: string } }
              currencyOut?: { amountFormatted: string; amountUsd?: string; currency: { symbol: string } }
              rate: string
              timeEstimate: number
              totalFees?: { priceImpact: string; relayerGas: { amountFormatted: string } }
            }
          }

          assertSupportedRoute(quoteData)
          const details = quoteData.details
          if (!details) return err('No quote available for this route.')
          const routeValue = assessRouteUsdValues({
            inputUsd: details.currencyIn?.amountUsd,
            outputUsd: details.currencyOut?.amountUsd,
            maxLossPercent,
          })
          if (routeValue.blocked) {
            return err(
              `${routeValue.reason}\n\n` +
              `Relay quote blocked before any approval or bridge transaction.\n` +
              `You send: $${routeValue.inputUsd.toFixed(2)} value\n` +
              `You receive: $${routeValue.outputUsd.toFixed(2)} value\n` +
              `Try a larger amount, a different source token, or another route.`
            )
          }

          return text(
            `📊 Relay Bridge Quote\n\n` +
            `Route: ${fromChain} → ${toChain}\n` +
            `Input: ${details.currencyIn?.amountFormatted || amount} ${details.currencyIn?.currency?.symbol || token}\n` +
            `Output: ~${details.currencyOut?.amountFormatted || '?'} ${details.currencyOut?.currency?.symbol || token}\n` +
            `Estimated value loss: ${routeValue.lossPercent.toFixed(2)}% (limit: ${routeValue.maxLossPercent.toFixed(2)}%)\n` +
            `Est. Time: ~${details.timeEstimate || 30}s\n` +
            `Rate: ${details.rate || '~1:1'}\n\n` +
            `💡 Use action 'bridge' to execute this route.\n` +
            `💡 Relay is one of the fastest bridges available (~10-30 seconds).`
          )
        } catch (e) {
          return err(`Relay quote failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      default: return err(`Unknown relay action: ${args.action}`)
    }
  }

  return null
}

const bridgesModule: ToolModule = { tools: TOOLS, handle }
export default bridgesModule
