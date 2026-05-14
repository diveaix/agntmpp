import { encodeFunctionData, formatUnits, isAddress, parseUnits, type Address } from 'viem'
import type { ToolModule, ToolResult } from './index.js'
import { getOrCreateWallet, getAccount } from '../wallet.js'
import { getPublicClient, getWalletClient, explorerTxUrl, SUPPORTED_CHAINS } from '../chains.js'
import {
  assertNativeBalanceCoversTx,
  isNativeToken,
  knownTokenDecimals,
  resolveRouteAmount,
  resolveTokenAddress,
  isMaxRouteAmount,
} from './aggregator-assets.js'

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const err = (e: string): ToolResult => ({ content: [{ type: 'text', text: `❌ ${e}` }], isError: true })

const erc20TransferAbi = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const

export function normalizeSendChain(value: unknown): string {
  const chain = String(value || '').trim().toLowerCase()
  if (!chain) throw new Error('Missing chain. Use base, arbitrum, optimism, polygon, ethereum, avalanche, bsc, linea, zksync, hyperevm, or tempo.')
  if (!SUPPORTED_CHAINS[chain]) throw new Error(`Unknown chain "${chain}". Available: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`)
  return chain
}

export function normalizeRecipient(value: unknown): Address {
  const recipient = String(value || '').trim()
  if (!isAddress(recipient)) throw new Error('Recipient must be a valid 0x address.')
  return recipient
}

export function buildSendSummary(input: {
  action: 'quote' | 'send'
  chainLabel: string
  walletName: string
  from: Address
  to: Address
  tokenLabel: string
  amountLabel: string
  gasCostLabel: string
  txUrl?: string
}): string {
  const header = input.action === 'quote' ? 'Send quote ready' : 'Send complete'
  return [
    header,
    `Chain: ${input.chainLabel}`,
    `From: ${input.walletName} (${input.from})`,
    `To: ${input.to}`,
    `Amount: ${input.amountLabel} ${input.tokenLabel}`,
    `Estimated gas: ${input.gasCostLabel}`,
    input.txUrl ? `Tx: ${input.txUrl}` : undefined,
  ].filter(Boolean).join('\n')
}

function isConfirmed(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'string') return ['true', 'yes', 'confirm', 'confirmed'].includes(value.trim().toLowerCase())
  return false
}

export function needsSendConfirmation(input: {
  amount: bigint
  decimals: number
  native: boolean
  maxAmount: boolean
  tokenLabel: string
  nativeThreshold?: string
  tokenThreshold?: string
}): { required: boolean; reason?: string } {
  if (input.maxAmount) {
    return { required: true, reason: `You are sending all/max ${input.tokenLabel}. Re-run with confirm=true after checking the chain, wallet, recipient, and amount.` }
  }
  const threshold = input.native
    ? parseUnits(input.nativeThreshold || process.env.AGNT_SEND_CONFIRM_NATIVE_ETH || '0.1', 18)
    : parseUnits(input.tokenThreshold || process.env.AGNT_SEND_CONFIRM_TOKEN_AMOUNT || '10000', input.decimals)
  if (threshold > 0n && input.amount >= threshold) {
    return {
      required: true,
      reason: `This send is above the configured confirmation threshold for ${input.tokenLabel}. Re-run with confirm=true after checking the chain, wallet, recipient, and amount.`,
    }
  }
  return { required: false }
}

async function readTokenMetadata(chain: string, token: Address, rawToken: string): Promise<{ decimals: number; symbol: string }> {
  const client = getPublicClient(chain)
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: erc20TransferAbi, functionName: 'decimals' }).catch(() => knownTokenDecimals(chain, token)),
    client.readContract({ address: token, abi: erc20TransferAbi, functionName: 'symbol' }).catch(() => rawToken),
  ])
  return { decimals: Number(decimals), symbol: String(symbol || rawToken) }
}

async function getTxStatus(chain: string, hashInput: unknown): Promise<ToolResult> {
  const chainKey = normalizeSendChain(chain)
  const hash = String(hashInput || '').trim() as `0x${string}`
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Provide a valid transaction hash.')
  const client = getPublicClient(chainKey)
  const chainConfig = SUPPORTED_CHAINS[chainKey]
  try {
    const receipt = await client.getTransactionReceipt({ hash })
    return text(
      `Transaction status\n` +
      `Chain: ${chainConfig.label}\n` +
      `Status: ${receipt.status === 'success' ? 'success' : 'reverted'}\n` +
      `Block: ${receipt.blockNumber}\n` +
      `Gas used: ${receipt.gasUsed}\n` +
      `Tx: ${explorerTxUrl(chainKey, hash)}`
    )
  } catch {
    try {
      const tx = await client.getTransaction({ hash })
      return text(
        `Transaction status\n` +
        `Chain: ${chainConfig.label}\n` +
        `Status: pending\n` +
        `From: ${tx.from}\n` +
        `To: ${tx.to || '(contract creation)'}\n` +
        `Tx: ${explorerTxUrl(chainKey, hash)}`
      )
    } catch {
      return text(
        `Transaction status\n` +
        `Chain: ${chainConfig.label}\n` +
        `Status: not found yet\n` +
        `Tx: ${explorerTxUrl(chainKey, hash)}`
      )
    }
  }
}

export async function executeWalletSend(args: Record<string, unknown>): Promise<ToolResult> {
  const action = String(args.action || 'send').toLowerCase()
  if (action === 'status') return getTxStatus(args.chain as string, args.hash)
  if (action !== 'send' && action !== 'quote') return err(`Unknown wallet_send action: ${args.action}`)

  const chain = normalizeSendChain(args.chain)
  const to = normalizeRecipient(args.to)
  const tokenInput = String(args.token || 'ETH').trim()
  const wallet = getOrCreateWallet()
  const account = getAccount(wallet)
  const client = getPublicClient(chain)
  const walletClient = getWalletClient(chain, wallet)
  const chainConfig = SUPPORTED_CHAINS[chain]
  const native = isNativeToken(tokenInput)

  if (native) {
    const maxAmount = isMaxRouteAmount(args.amount)
    const amount = await resolveRouteAmount({
      amount: args.amount,
      decimals: 18,
      token: tokenInput,
      account: wallet.address,
      client,
      nativeReserve: args.nativeReserveEth,
    })
    if (amount <= 0n) throw new Error('Send amount must be greater than zero.')
    const tokenLabel = chain === 'bsc' ? 'BNB' : chain === 'polygon' ? 'MATIC' : chain === 'avalanche' ? 'AVAX' : 'ETH'

    const preflight = await assertNativeBalanceCoversTx({
      client,
      account: wallet.address,
      to,
      value: amount,
      chain,
    })

    if (action === 'quote') {
      return text(buildSendSummary({
        action: 'quote',
        chainLabel: chainConfig.label,
        walletName: wallet.name,
        from: wallet.address,
        to,
        tokenLabel,
        amountLabel: formatUnits(amount, 18),
        gasCostLabel: `${formatUnits(preflight.gasCost, 18)} native`,
      }))
    }

    const confirmation = needsSendConfirmation({ amount, decimals: 18, native: true, maxAmount, tokenLabel })
    if (confirmation.required && !isConfirmed(args.confirm)) {
      return err(`${confirmation.reason}\n\nQuote:\n${buildSendSummary({
        action: 'quote',
        chainLabel: chainConfig.label,
        walletName: wallet.name,
        from: wallet.address,
        to,
        tokenLabel,
        amountLabel: formatUnits(amount, 18),
        gasCostLabel: `${formatUnits(preflight.gasCost, 18)} native`,
      })}`)
    }

    const hash = await walletClient.sendTransaction({
      account,
      chain: chainConfig.chain,
      to,
      value: amount,
    })
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (receipt.status !== 'success') return err(`Send reverted on-chain.\nTx: ${explorerTxUrl(chain, hash)}`)

    return text(buildSendSummary({
      action: 'send',
      chainLabel: chainConfig.label,
      walletName: wallet.name,
      from: wallet.address,
      to,
      tokenLabel,
      amountLabel: formatUnits(amount, 18),
      gasCostLabel: `${formatUnits(preflight.gasCost, 18)} native`,
      txUrl: explorerTxUrl(chain, hash),
    }))
  }

  const token = resolveTokenAddress(chain, tokenInput)
  if (!isAddress(token)) throw new Error(`Token "${tokenInput}" did not resolve to a valid contract address on ${chain}.`)
  const tokenAddress = token as Address
  const meta = await readTokenMetadata(chain, tokenAddress, tokenInput)
  const maxAmount = isMaxRouteAmount(args.amount)
  const amount = await resolveRouteAmount({
    amount: args.amount,
    decimals: meta.decimals,
    token: tokenAddress,
    account: wallet.address,
    client,
  })
  if (amount <= 0n) throw new Error('Send amount must be greater than zero.')

  const balance = await client.readContract({
    address: tokenAddress,
    abi: erc20TransferAbi,
    functionName: 'balanceOf',
    args: [wallet.address],
  }) as bigint
  if (balance < amount) {
    throw new Error(`Insufficient ${meta.symbol}. Requested ${formatUnits(amount, meta.decimals)}, available ${formatUnits(balance, meta.decimals)}.`)
  }

  const data = encodeFunctionData({
    abi: erc20TransferAbi,
    functionName: 'transfer',
    args: [to, amount],
  })
  const preflight = await assertNativeBalanceCoversTx({
    client,
    account: wallet.address,
    to: tokenAddress,
    data,
    value: 0n,
    chain,
  })

  if (action === 'quote') {
    return text(buildSendSummary({
      action: 'quote',
      chainLabel: chainConfig.label,
      walletName: wallet.name,
      from: wallet.address,
      to,
      tokenLabel: meta.symbol,
      amountLabel: formatUnits(amount, meta.decimals),
      gasCostLabel: `${formatUnits(preflight.gasCost, 18)} native`,
    }))
  }

  const confirmation = needsSendConfirmation({ amount, decimals: meta.decimals, native: false, maxAmount, tokenLabel: meta.symbol })
  if (confirmation.required && !isConfirmed(args.confirm)) {
    return err(`${confirmation.reason}\n\nQuote:\n${buildSendSummary({
      action: 'quote',
      chainLabel: chainConfig.label,
      walletName: wallet.name,
      from: wallet.address,
      to,
      tokenLabel: meta.symbol,
      amountLabel: formatUnits(amount, meta.decimals),
      gasCostLabel: `${formatUnits(preflight.gasCost, 18)} native`,
    })}`)
  }

  const hash = await walletClient.sendTransaction({
    account,
    chain: chainConfig.chain,
    to: tokenAddress,
    data,
    value: 0n,
  })
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 })
  if (receipt.status !== 'success') return err(`Send reverted on-chain.\nTx: ${explorerTxUrl(chain, hash)}`)

  return text(buildSendSummary({
    action: 'send',
    chainLabel: chainConfig.label,
    walletName: wallet.name,
    from: wallet.address,
    to,
    tokenLabel: meta.symbol,
    amountLabel: formatUnits(amount, meta.decimals),
    gasCostLabel: `${formatUnits(preflight.gasCost, 18)} native`,
    txUrl: explorerTxUrl(chain, hash),
  }))
}

const TOOLS = [
  {
    name: 'wallet_send',
    description: 'Send native ETH/gas tokens or ERC-20 tokens from the active AGNT wallet on any supported EVM chain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['quote', 'send', 'status'], description: 'quote simulates gas and balance checks; send submits the transfer; status checks a tx hash.' },
        chain: { type: 'string', description: 'Chain key: base, arbitrum, optimism, polygon, ethereum, avalanche, bsc, linea, zksync, hyperevm, tempo.' },
        token: { type: 'string', description: 'ETH/native, a known symbol like USDC/USDT/WETH, or a token contract address.' },
        to: { type: 'string', description: 'Recipient 0x address.' },
        amount: { type: 'string', description: 'Amount to send, or all/max. Native all/max keeps a gas reserve.' },
        nativeReserveEth: { type: 'string', description: 'Optional native reserve for all/max native sends. Default AGNT_NATIVE_MAX_RESERVE_ETH or 0.0005.' },
        confirm: { type: 'boolean', description: 'Required for all/max sends or sends above configured thresholds.' },
        hash: { type: 'string', description: 'Transaction hash for status checks.' },
      },
      required: ['action', 'chain'],
    },
  },
]

async function handle(name: string, args: Record<string, unknown>) {
  if (name !== 'wallet_send') return null
  try {
    return await executeWalletSend(args)
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

export default { tools: TOOLS, handle } satisfies ToolModule
