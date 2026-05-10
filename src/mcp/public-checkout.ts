import type { AccessPlan, AccessUser } from './access-types.js'
import {
  createApiKey,
  createUser,
  findUserByEmail,
  getCryptoAccessIntent,
  listApiKeysForUser,
} from './access-store.js'
import {
  applyCryptoAccessPayment,
  createCryptoAccessQuote,
  type CryptoAccessQuote,
  type CryptoPaymentVerifier,
} from './crypto-access.js'
import {
  getEvmPaymentNetwork,
  getPaymentNetworkForQuote,
  listPublicPaymentNetworks,
  normalizePaymentNetwork,
  recipientIsConfigured,
  type EvmPaymentNetwork,
  type PaymentNetworkId,
} from './payment-networks.js'

export interface PublicCheckoutQuoteInput {
  email: string
  verifiedUserId?: string
  walletAddress?: string
  plan: AccessPlan | string
  provider?: 'crypto' | 'mpp'
  months?: number
  paymentNetwork?: PaymentNetworkId | string
}

export interface PublicCheckoutQuoteResult {
  user: AccessUser
  quote: CryptoAccessQuote
}

export interface PublicCheckoutQuoteResponse {
  checkoutId: string
  quoteId: string
  plan: AccessPlan
  amount: number
  amountUnits: string
  currency: string
  tokenDecimals: number
  network: string
  chainId?: number
  chainName: string
  rpcUrl: string
  blockExplorerUrls: string[]
  nativeCurrency: EvmPaymentNetwork['nativeCurrency']
  paymentNetworks: Array<Pick<EvmPaymentNetwork, 'id' | 'label' | 'network' | 'chainId' | 'currency'>>
  recipient: string
  months: number
  expiresAt: string
  instructions: string
}

export interface PublicCheckoutConfirmInput {
  email: string
  verifiedUserId?: string
  quoteId: string
  provider: 'crypto' | 'mpp'
  txHash: string
  payer?: string
}

export interface PublicCheckoutConfirmResult {
  applied: boolean
  reason: string
  plan?: AccessPlan
  currentPeriodEnd?: string
  apiKey?: string
  apiKeyId?: string
}

function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') return ''
  return email.trim().toLowerCase()
}

function normalizePlan(value: unknown): AccessPlan {
  if (value === 'pro' || value === 'max') return value
  return 'free'
}

function planLabel(plan: AccessPlan): string {
  if (plan === 'max') return 'Ultra'
  if (plan === 'pro') return 'Pro'
  return 'Free'
}

function requirePaymentRecipient(): void {
  const recipient = (process.env.AGNT_RECIPIENT || '').trim().toLowerCase()
  if (!recipient || recipient === '0x0000000000000000000000000000000000000000') {
    throw new Error('AGNT_RECIPIENT is not configured. Set the payment receiving wallet before creating paid checkout quotes.')
  }
}

function requireNetworkRecipient(network: EvmPaymentNetwork): void {
  if (!recipientIsConfigured(network.recipient)) {
    throw new Error(`${network.label} payment recipient is not configured. Set ${network.id === 'tempo' ? 'AGNT_RECIPIENT' : `AGNT_${network.id.toUpperCase()}_RECIPIENT or AGNT_EVM_RECIPIENT`} before creating paid checkout quotes.`)
  }
}

function tokenDecimals(): number {
  const parsed = Number(process.env.CRYPTO_ACCESS_TOKEN_DECIMALS || 6)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 30) return 6
  return parsed
}

function decimalAmountUnits(amount: number, decimals: number): string {
  const fixed = amount.toFixed(decimals)
  const [whole, fraction = ''] = fixed.split('.')
  const normalizedFraction = fraction.padEnd(decimals, '0').slice(0, decimals)
  return `${whole}${normalizedFraction}`.replace(/^0+(?=\d)/, '') || '0'
}

export function formatPublicCheckoutQuoteResponse(quote: CryptoAccessQuote): PublicCheckoutQuoteResponse {
  const network = getPaymentNetworkForQuote(quote.network, quote.chainId)
  const decimals = network.tokenDecimals || tokenDecimals()
  return {
    checkoutId: quote.id,
    quoteId: quote.id,
    plan: quote.plan,
    amount: quote.amount,
    amountUnits: decimalAmountUnits(quote.amount, decimals),
    currency: quote.currency,
    tokenDecimals: decimals,
    network: quote.network,
    chainId: quote.chainId,
    chainName: network.chainName,
    rpcUrl: network.rpcUrl,
    blockExplorerUrls: network.blockExplorerUrls,
    nativeCurrency: network.nativeCurrency,
    paymentNetworks: listPublicPaymentNetworks().map((item) => ({
      id: item.id,
      label: item.label,
      network: item.network,
      chainId: item.chainId,
      currency: item.currency,
    })),
    recipient: quote.recipient,
    months: quote.months,
    expiresAt: quote.expiresAt,
    instructions: `Connect wallet, send exactly ${quote.amount} USDC-equivalent to ${quote.recipient} on ${quote.network}, then AGNT will verify the transaction and show your API key.`,
  }
}

export function createPublicCryptoCheckoutQuote(
  input: PublicCheckoutQuoteInput,
  customStorePath?: string,
): PublicCheckoutQuoteResult {
  const email = normalizeEmail(input.email)
  if (!email) throw new Error('Email is required for paid checkout.')
  if (!input.verifiedUserId) throw new Error('Confirm your email before creating a payment quote.')
  const plan = normalizePlan(input.plan)
  if (plan === 'free') throw new Error('Free users do not need checkout. Add the MCP server directly.')
  const networkId = normalizePaymentNetwork(input.paymentNetwork)
  const paymentNetwork = getEvmPaymentNetwork(networkId)
  if (networkId === 'tempo') requirePaymentRecipient()
  requireNetworkRecipient(paymentNetwork)

  const existing = findUserByEmail(email, customStorePath)
  if (existing && existing.id !== input.verifiedUserId) throw new Error('Confirmed email does not match this checkout account.')
  const user = existing || createUser({
    email,
    walletAddress: input.walletAddress?.trim() || undefined,
  }, customStorePath)
  if (user.id !== input.verifiedUserId) throw new Error('Confirmed email does not match this checkout account.')
  const quote = createCryptoAccessQuote({
    userId: user.id,
    plan,
    provider: input.provider || 'mpp',
    months: input.months || 1,
    paymentNetwork,
  }, customStorePath)

  return { user, quote }
}

export async function confirmPublicCryptoCheckout(
  input: PublicCheckoutConfirmInput,
  verifier?: CryptoPaymentVerifier,
  customStorePath?: string,
): Promise<PublicCheckoutConfirmResult> {
  const email = normalizeEmail(input.email)
  if (!email) return { applied: false, reason: 'Email is required to confirm checkout.' }
  if (!input.verifiedUserId) return { applied: false, reason: 'Confirm your email before confirming checkout.' }
  if (!input.quoteId) return { applied: false, reason: 'quoteId is required.' }
  if (!input.txHash) return { applied: false, reason: 'txHash is required.' }

  const user = findUserByEmail(email, customStorePath)
  if (!user) return { applied: false, reason: 'Checkout email was not found. Create a fresh quote first.' }
  if (user.id !== input.verifiedUserId) return { applied: false, reason: 'Checkout session does not belong to this email.' }

  const quote = getCryptoAccessIntent(input.quoteId, customStorePath)
  if (!quote) return { applied: false, reason: 'Checkout quote was not found.' }
  if (quote.userId !== user.id) return { applied: false, reason: 'Checkout quote does not belong to this email.' }

  const result = await applyCryptoAccessPayment({
    quoteId: input.quoteId,
    userId: user.id,
    provider: input.provider,
    txHash: input.txHash,
    payer: input.payer,
  }, verifier, customStorePath)
  if (!result.applied) return result

  const activeKeys = listApiKeysForUser(user.id, customStorePath).filter((key) => !key.revokedAt)
  if (activeKeys.length >= 2) {
    return {
      ...result,
      reason: `${result.reason} Access is active, but this account already has 2 active API keys. Remove one in the dashboard before creating another key.`,
    }
  }

  const key = createApiKey(user.id, `${planLabel(result.plan || quote.plan)} website checkout`, customStorePath)
  return {
    ...result,
    apiKey: key.apiKey,
    apiKeyId: key.record.id,
  }
}
