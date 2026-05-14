import type { AuthContext } from '../access-types.js'
import { applyCryptoAccessPayment, createCryptoAccessQuote } from '../crypto-access.js'
import { formatBillingCatalog } from '../billing-catalog.js'
import type { ToolModule } from './index.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const TOOLS = [
  {
    name: 'billing',
    description: 'Billing and access tools. Shows plan details, explains how to get access, creates crypto/MPP payment quotes, and confirms crypto payments after verification.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['plans', 'access', 'crypto_quote', 'crypto_confirm'],
          description: 'plans/access shows plan details and payment steps; crypto_quote creates a crypto/MPP quote; crypto_confirm confirms a paid quote.',
        },
        plan: { type: 'string', enum: ['pro', 'max'], description: 'Plan to buy for crypto_quote.' },
        provider: { type: 'string', enum: ['mpp', 'crypto'], description: 'Payment provider. Default: mpp.' },
        months: { type: 'number', description: 'Number of months to buy. Default: 1.' },
        quoteId: { type: 'string', description: 'Quote id for crypto_confirm.' },
        txHash: { type: 'string', description: 'Payment transaction hash for crypto_confirm.' },
        payer: { type: 'string', description: 'Wallet that paid, if known.' },
      },
      required: ['action'],
    },
  },
]

function titlePlan(plan: string) {
  return plan === 'max' ? 'Ultra' : 'Pro'
}

async function handle(name: string, args: Record<string, unknown>, auth?: AuthContext) {
  if (name !== 'billing') return null

  switch (args.action) {
    case 'plans':
    case 'access':
      return text(`${formatBillingCatalog()}\n\nIf you already have an API key, use it as x-agnt-api-key or Authorization: Bearer agnt_live_...`)

    case 'crypto_quote': {
      if (!auth) return err('API key required before creating a payment quote.')
      if (args.plan !== 'pro' && args.plan !== 'max') return err('Choose plan="pro" or plan="max".')
      try {
        const quote = createCryptoAccessQuote({
          userId: auth.userId,
          plan: args.plan,
          provider: args.provider === 'crypto' ? 'crypto' : 'mpp',
          months: typeof args.months === 'number' ? args.months : 1,
        })
        return text([
          'Payment quote created',
          '',
          `Plan: ${titlePlan(quote.plan)}`,
          `Provider: ${quote.provider.toUpperCase()}`,
          `Amount: ${quote.amount} USDC-equivalent`,
          `Network: ${quote.network}`,
          `Chain ID: ${quote.chainId}`,
          `Recipient: ${quote.recipient}`,
          `Quote ID: ${quote.id}`,
          `Expires: ${quote.expiresAt}`,
          '',
          'After paying, confirm it with:',
          `billing action="crypto_confirm" quoteId="${quote.id}" provider="${quote.provider}" txHash="<transaction hash>"`,
          '',
          'Access activates only after payment verification.',
        ].join('\n'))
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }

    case 'crypto_confirm':
      if (!auth) return err('API key required before confirming a payment.')
      if (typeof args.quoteId !== 'string' || !args.quoteId) return err('quoteId is required.')
      if (args.provider !== 'mpp' && args.provider !== 'crypto') return err('provider must be "mpp" or "crypto".')
      if (typeof args.txHash !== 'string' || !args.txHash) return err('txHash is required.')
      try {
        const result = await applyCryptoAccessPayment({
          quoteId: args.quoteId,
          userId: auth.userId,
          provider: args.provider,
          txHash: args.txHash,
          payer: typeof args.payer === 'string' ? args.payer : undefined,
        })
        if (!result.applied) return err(result.reason)
        return text([
          'Access activated',
          '',
          `Plan: ${titlePlan(result.plan || 'pro')}`,
          `Current period ends: ${result.currentPeriodEnd}`,
          '',
          'Your existing API key now resolves to the paid plan on future MCP calls.',
        ].join('\n'))
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }

    default:
      return err(`Unknown billing action: ${String(args.action)}`)
  }
}

export default { tools: TOOLS, handle } satisfies ToolModule
