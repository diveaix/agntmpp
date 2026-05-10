import type { AccessPlan, CryptoAccessIntent, PaymentProvider } from './access-types.js'
import {
  createCryptoAccessIntent,
  getCryptoAccessIntent,
  hasProcessedPayment,
  recordPaymentEvent,
  updateCryptoAccessIntent,
  upsertSubscription,
} from './access-store.js'
import { OnChainErc20PaymentVerifier } from './crypto-payment-verifier.js'
import { getPaymentNetworkForQuote, type EvmPaymentNetwork } from './payment-networks.js'

const DEFAULT_USDC_E = '0x20C000000000000000000000b9537d11c60E8b50'

export interface CryptoAccessQuote extends CryptoAccessIntent {}

export interface CryptoPaymentVerificationInput {
  quoteId: string
  provider: 'crypto' | 'mpp'
  txHash: string
  payer?: string
  expectedAmount: number
  expectedCurrency: string
  expectedRecipient: string
  expectedChainId?: number
}

export interface CryptoPaymentVerificationResult {
  verified: boolean
  reason: string
  amount?: number
  currency?: string
}

export interface CryptoPaymentVerifier {
  verify(input: CryptoPaymentVerificationInput): Promise<CryptoPaymentVerificationResult>
}

export interface ApplyCryptoAccessInput {
  quoteId: string
  userId: string
  provider: 'crypto' | 'mpp'
  txHash: string
  payer?: string
}

export interface ApplyCryptoAccessResult {
  applied: boolean
  reason: string
  plan?: AccessPlan
  currentPeriodEnd?: string
}

export class EnvGuardedCryptoPaymentVerifier implements CryptoPaymentVerifier {
  async verify(): Promise<CryptoPaymentVerificationResult> {
    if (process.env.CRYPTO_ACCESS_TRUSTED_CONFIRMATIONS !== 'true') {
      return {
        verified: false,
        reason: 'Crypto access payments need on-chain or MPP verification before activation. Set a verifier in production.',
      }
    }
    return { verified: true, reason: 'Trusted confirmation mode accepted the payment.' }
  }
}

export function createDefaultCryptoPaymentVerifier(paymentNetwork?: Pick<EvmPaymentNetwork, 'chainId' | 'rpcUrl' | 'tokenDecimals'>): CryptoPaymentVerifier {
  if (process.env.CRYPTO_ACCESS_TRUSTED_CONFIRMATIONS === 'true') {
    return new EnvGuardedCryptoPaymentVerifier()
  }
  return new OnChainErc20PaymentVerifier(paymentNetwork ? {
    chainId: paymentNetwork.chainId,
    rpcUrl: paymentNetwork.rpcUrl,
    decimals: paymentNetwork.tokenDecimals,
  } : undefined)
}

function normalizePlan(value: unknown): AccessPlan {
  if (value === 'pro' || value === 'max') return value
  return 'free'
}

function planAmount(plan: AccessPlan, months: number): number {
  const monthly =
    plan === 'max' ? Number(process.env.CRYPTO_ACCESS_MAX_USDC || 199) :
      plan === 'pro' ? Number(process.env.CRYPTO_ACCESS_PRO_USDC || 49) :
        0
  return monthly * months
}

function paymentCurrency(): string {
  return process.env.AGNT_PAYMENT_CURRENCY || DEFAULT_USDC_E
}

function paymentRecipient(): string {
  return process.env.AGNT_RECIPIENT || '0x0000000000000000000000000000000000000000'
}

function addMonths(from: Date, months: number): Date {
  const result = new Date(from)
  result.setUTCMonth(result.getUTCMonth() + months)
  return result
}

function verificationMayStillSettle(reason: string): boolean {
  return /confirmation|receipt not found/i.test(reason)
}

export function createCryptoAccessQuote(input: {
  userId: string
  plan: AccessPlan | string
  provider?: 'crypto' | 'mpp'
  months?: number
  paymentNetwork?: EvmPaymentNetwork
}, customStorePath?: string): CryptoAccessQuote {
  const plan = normalizePlan(input.plan)
  if (plan === 'free') throw new Error('Crypto access checkout is only for Pro or Max.')
  const months = Math.max(1, Math.min(12, Math.floor(input.months || 1)))
  const paymentNetwork = input.paymentNetwork
  const now = Date.now()
  return createCryptoAccessIntent({
    userId: input.userId,
    plan,
    provider: input.provider || 'mpp',
    amount: planAmount(plan, months),
    currency: paymentNetwork?.currency || paymentCurrency(),
    chainId: paymentNetwork?.chainId || Number(process.env.CRYPTO_ACCESS_CHAIN_ID || process.env.AGNT_PAYMENT_CHAIN_ID || 6342),
    network: paymentNetwork?.network || process.env.CRYPTO_ACCESS_NETWORK || 'tempo',
    recipient: paymentNetwork?.recipient || paymentRecipient(),
    months,
    status: 'pending',
    expiresAt: new Date(now + Number(process.env.CRYPTO_ACCESS_QUOTE_TTL_MS || 30 * 60_000)).toISOString(),
  }, customStorePath)
}

export async function applyCryptoAccessPayment(
  input: ApplyCryptoAccessInput,
  verifier?: CryptoPaymentVerifier,
  customStorePath?: string,
): Promise<ApplyCryptoAccessResult> {
  const quote = getCryptoAccessIntent(input.quoteId, customStorePath)
  if (!quote) return { applied: false, reason: 'Crypto access quote not found.' }
  if (quote.userId !== input.userId) return { applied: false, reason: 'Crypto access quote belongs to a different user.' }
  if (quote.provider !== input.provider) return { applied: false, reason: `Quote expects ${quote.provider}, not ${input.provider}.` }
  if (hasProcessedPayment(input.provider as PaymentProvider, input.txHash, customStorePath)) {
    return { applied: false, reason: 'Payment transaction was already processed.' }
  }
  if (quote.status === 'paid') return { applied: false, reason: 'Crypto access quote is already paid.' }
  if (new Date(quote.expiresAt).getTime() <= Date.now()) {
    quote.status = 'expired'
    updateCryptoAccessIntent(quote, customStorePath)
    return { applied: false, reason: 'Crypto access quote expired. Create a fresh quote.' }
  }
  const resolvedVerifier = verifier || createDefaultCryptoPaymentVerifier(getPaymentNetworkForQuote(quote.network, quote.chainId))
  const verification = await resolvedVerifier.verify({
    quoteId: quote.id,
    provider: input.provider,
    txHash: input.txHash,
    payer: input.payer,
    expectedAmount: quote.amount,
    expectedCurrency: quote.currency,
    expectedRecipient: quote.recipient,
    expectedChainId: quote.chainId,
  })
  if (!verification.verified) {
    if (!verificationMayStillSettle(verification.reason)) {
      quote.status = 'failed'
      updateCryptoAccessIntent(quote, customStorePath)
    }
    return { applied: false, reason: verification.reason }
  }

  const now = new Date()
  const currentPeriodEnd = addMonths(now, quote.months).toISOString()
  quote.status = 'paid'
  quote.txHash = input.txHash
  quote.payer = input.payer
  quote.paidAt = now.toISOString()
  updateCryptoAccessIntent(quote, customStorePath)

  upsertSubscription({
    userId: quote.userId,
    plan: quote.plan,
    status: 'active',
    provider: quote.provider,
    providerCustomerId: input.payer,
    providerSubscriptionId: quote.id,
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd,
    cancelAtPeriodEnd: true,
  }, customStorePath)

  recordPaymentEvent({
    userId: quote.userId,
    provider: quote.provider,
    amount: verification.amount ?? quote.amount,
    currency: verification.currency ?? quote.currency,
    status: 'verified',
    txHash: input.txHash,
    cryptoQuoteId: quote.id,
  }, customStorePath)

  return {
    applied: true,
    reason: `${quote.plan} access activated through ${quote.provider}.`,
    plan: quote.plan,
    currentPeriodEnd,
  }
}
