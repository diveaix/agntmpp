import { createPublicClient, formatUnits, http, parseUnits, type Address, type Hex, type PublicClient } from 'viem'
import { tempo } from 'viem/chains'
import type { CryptoPaymentVerifier, CryptoPaymentVerificationInput, CryptoPaymentVerificationResult } from './crypto-access.js'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export interface Erc20TransferLog {
  address: string
  topics: readonly string[]
  data: string
}

export interface Erc20TransactionReceipt {
  status: 'success' | 'reverted'
  blockNumber: bigint
  logs: readonly Erc20TransferLog[]
}

export interface Erc20PaymentVerifierClient {
  chainId: number
  getBlockNumber(): Promise<bigint>
  getTransactionReceipt(args: { hash: string }): Promise<Erc20TransactionReceipt | null>
}

export interface OnChainErc20PaymentVerifierOptions {
  client?: Erc20PaymentVerifierClient
  rpcUrl?: string
  chainId?: number
  decimals?: number
  minConfirmations?: number
}

function normalizeAddress(value: string | undefined): string {
  return (value || '').toLowerCase()
}

function topicToAddress(topic: string | undefined): string | null {
  if (!topic || !topic.startsWith('0x') || topic.length !== 66) return null
  return `0x${topic.slice(-40)}`.toLowerCase()
}

function parseUint256Hex(data: string): bigint {
  if (!data || data === '0x') return 0n
  return BigInt(data)
}

function receiptFromViem(receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>): Erc20TransactionReceipt {
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics as readonly string[],
      data: log.data,
    })),
  }
}

function defaultRpcUrl(): string | undefined {
  return process.env.CRYPTO_ACCESS_RPC_URL || process.env.AGNT_PAYMENT_RPC_URL || process.env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz'
}

function createDefaultClient(chainId: number, rpcUrl: string): Erc20PaymentVerifierClient {
  const client = createPublicClient({
    chain: chainId === tempo.id ? tempo : { ...tempo, id: chainId, name: `Chain ${chainId}` },
    transport: http(rpcUrl),
  })
  return {
    chainId,
    getBlockNumber: () => client.getBlockNumber(),
    getTransactionReceipt: async ({ hash }) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash: hash as Hex })
        return receiptFromViem(receipt)
      } catch {
        return null
      }
    },
  }
}

export class OnChainErc20PaymentVerifier implements CryptoPaymentVerifier {
  private readonly client: Erc20PaymentVerifierClient | null
  private readonly decimals: number
  private readonly minConfirmations: number

  constructor(options: OnChainErc20PaymentVerifierOptions = {}) {
    const chainId = options.chainId || Number(process.env.CRYPTO_ACCESS_CHAIN_ID || process.env.AGNT_PAYMENT_CHAIN_ID || tempo.id)
    const rpcUrl = options.rpcUrl || defaultRpcUrl()
    this.client = options.client || (rpcUrl ? createDefaultClient(chainId, rpcUrl) : null)
    this.decimals = options.decimals ?? Number(process.env.CRYPTO_ACCESS_TOKEN_DECIMALS || 6)
    this.minConfirmations = options.minConfirmations ?? Number(process.env.CRYPTO_ACCESS_MIN_CONFIRMATIONS || 2)
  }

  async verify(input: CryptoPaymentVerificationInput): Promise<CryptoPaymentVerificationResult> {
    if (!this.client) {
      return { verified: false, reason: 'No RPC client configured for crypto payment verification.' }
    }

    if (input.expectedChainId && this.client.chainId !== input.expectedChainId) {
      return { verified: false, reason: `Payment was checked on chain ${this.client.chainId}, but quote expects chain ${input.expectedChainId}.` }
    }

    const receipt = await this.client.getTransactionReceipt({ hash: input.txHash })
    if (!receipt) return { verified: false, reason: 'Transaction receipt not found.' }
    if (receipt.status !== 'success') return { verified: false, reason: 'Transaction was not successful.' }

    const currentBlock = await this.client.getBlockNumber()
    const confirmations = currentBlock >= receipt.blockNumber ? currentBlock - receipt.blockNumber + 1n : 0n
    if (confirmations < BigInt(this.minConfirmations)) {
      return { verified: false, reason: `Transaction has ${confirmations.toString()} confirmation(s); ${this.minConfirmations} required.` }
    }

    const expectedToken = normalizeAddress(input.expectedCurrency)
    const expectedRecipient = normalizeAddress(input.expectedRecipient)
    const expectedPayer = normalizeAddress(input.payer)
    const minimumAmount = parseUnits(String(input.expectedAmount), this.decimals)

    for (const log of receipt.logs) {
      if (normalizeAddress(log.address) !== expectedToken) continue
      if (normalizeAddress(log.topics[0]) !== TRANSFER_TOPIC) continue
      const from = topicToAddress(log.topics[1])
      const to = topicToAddress(log.topics[2])
      if (!from || !to) continue
      if (to !== expectedRecipient) continue
      if (expectedPayer && from !== expectedPayer) continue

      const amount = parseUint256Hex(log.data)
      if (amount < minimumAmount) continue

      return {
        verified: true,
        reason: 'Verified ERC-20 transfer matched the quote.',
        amount: Number(formatUnits(amount, this.decimals)),
        currency: input.expectedCurrency,
      }
    }

    return { verified: false, reason: 'No matching ERC-20 transfer found for the expected token, recipient, payer, and amount.' }
  }
}
