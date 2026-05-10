import type { AutomationPlan } from './automation-types.js'
import type { AutomationEntitlement } from './automation-entitlements.js'

export type AccessPlan = AutomationPlan

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'

export type PaymentProvider = 'stripe' | 'crypto' | 'mpp' | 'manual'

export interface AccessUser {
  id: string
  email?: string
  walletAddress?: string
  passwordSalt?: string
  passwordHash?: string
  status: 'active' | 'disabled'
  createdAt: string
  updatedAt: string
}

export interface AccessApiKey {
  id: string
  userId: string
  keyHash: string
  keyCiphertext?: string
  prefix: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface AccessConnectorLink {
  id: string
  userId: string
  apiKeyId: string
  tokenHash: string
  prefix: string
  label: string
  client: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface SubscriptionRecord {
  id: string
  userId: string
  plan: AccessPlan
  status: SubscriptionStatus
  provider: PaymentProvider
  providerCustomerId?: string
  providerSubscriptionId?: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd?: boolean
  createdAt: string
  updatedAt: string
}

export interface PaymentRecord {
  id: string
  userId?: string
  provider: PaymentProvider
  amount?: number
  currency?: string
  status: string
  txHash?: string
  stripeInvoiceId?: string
  stripeEventId?: string
  cryptoQuoteId?: string
  createdAt: string
}

export interface CryptoAccessIntent {
  id: string
  userId: string
  plan: AccessPlan
  provider: 'crypto' | 'mpp'
  amount: number
  currency: string
  chainId?: number
  network: string
  recipient: string
  months: number
  status: 'pending' | 'paid' | 'expired' | 'failed'
  txHash?: string
  payer?: string
  createdAt: string
  expiresAt: string
  paidAt?: string
}

export interface EmailVerificationCode {
  id: string
  email: string
  codeHash: string
  expiresAt: string
  attempts: number
  createdAt: string
  consumedAt?: string
}

export interface DashboardSession {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string
  revokedAt?: string
}

export interface CustomTwitterSource {
  id: string
  userId: string
  handle: string
  displayName?: string
  topics: string[]
  keywords: string[]
  enabled: boolean
  trustScore: number
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
}

export interface UsageRecord {
  userId: string
  periodStart: string
  periodEnd: string
  activeDataAutomations: number
  eventEvaluationsUsed: number
  executionsUsed: number
  twitterTweetsIngested: number
  grokCallsUsed: number
  updatedAt: string
}

export interface AccessStore {
  users: AccessUser[]
  apiKeys: AccessApiKey[]
  connectorLinks: AccessConnectorLink[]
  subscriptions: SubscriptionRecord[]
  usage: UsageRecord[]
  payments: PaymentRecord[]
  cryptoAccessIntents: CryptoAccessIntent[]
  emailVerificationCodes: EmailVerificationCode[]
  dashboardSessions: DashboardSession[]
  customSources: CustomTwitterSource[]
  processedWebhookEventIds: string[]
}

export interface AccessEntitlement extends AutomationEntitlement {
  eventEvaluationsMonthly: number
  executionsMonthly: number
}

export interface AuthContext {
  userId: string
  apiKeyId: string
  plan: AccessPlan
  subscriptionStatus: SubscriptionStatus
  entitlement: AccessEntitlement
  source: 'api_key' | 'dev'
}

export interface ApiKeyCreationResult {
  apiKey: string
  record: AccessApiKey
}

export interface SafeApiKey {
  id: string
  userId: string
  ownerEmail?: string
  prefix: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  canReveal: boolean
}

export interface SafeConnectorLink {
  id: string
  userId: string
  apiKeyId: string
  prefix: string
  label: string
  client: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}
