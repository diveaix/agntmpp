import type { AuthContext } from '../access-types.js'
import {
  createApiKey,
  getCurrentSubscription,
  loadAccessStore,
  revokeApiKey,
} from '../access-store.js'
import type { ToolModule } from './index.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `Error: ${e}` }], isError: true })

const TOOLS = [
  {
    name: 'account',
    description: 'API key management for AGNT users. API keys and connector tokens keep wallets tied to the account across sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['me', 'create_api_key', 'revoke_api_key'],
          description: 'me shows current access; create_api_key creates another account key; revoke_api_key disables one key.',
        },
        label: { type: 'string', description: 'Label for an API key.' },
        id: { type: 'string', description: 'API key id for revoke_api_key.' },
      },
      required: ['action'],
    },
  },
]

function titlePlan(plan: string): string {
  if (plan === 'max') return 'Ultra'
  if (plan === 'pro') return 'Pro'
  return 'Free'
}

function formatKeyLine(key: { id: string; prefix: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }): string {
  const status = key.revokedAt ? 'revoked' : 'active'
  return `- ${key.label} (${key.id}) ${key.prefix}... ${status}, created ${key.createdAt.slice(0, 10)}${key.lastUsedAt ? `, last used ${key.lastUsedAt.slice(0, 10)}` : ''}`
}

function requireAuth(auth?: AuthContext): AuthContext | { error: string } {
  if (!auth) return { error: 'API key or connector token required for account management. Create access from the AGNT dashboard.' }
  return auth
}

async function handle(name: string, args: Record<string, unknown>, auth?: AuthContext) {
  if (name !== 'account') return null

  switch (args.action) {
    case 'register':
      return err('Use the AGNT dashboard to create an account, then generate API keys and connector URLs from there.')

    case 'me': {
      const checked = requireAuth(auth)
      if ('error' in checked) return err(checked.error)
      const store = loadAccessStore()
      const user = store.users.find((candidate) => candidate.id === checked.userId)
      const subscription = getCurrentSubscription(checked.userId)
      const keys = store.apiKeys.filter((key) => key.userId === checked.userId)

      return text([
        'AGNT account',
        '',
        `User ID: ${checked.userId}`,
        user?.email ? `Email: ${user.email}` : undefined,
        user?.walletAddress ? `Wallet: ${user.walletAddress}` : undefined,
        `Current plan: ${titlePlan(checked.plan)}`,
        `Subscription status: ${checked.subscriptionStatus}`,
        subscription?.currentPeriodEnd ? `Current period ends: ${subscription.currentPeriodEnd}` : undefined,
        '',
        'Entitlements:',
        `- Data automations: ${checked.entitlement.dataAutomationSlots}`,
        `- Custom Twitter sources: ${checked.entitlement.customSourceSlots}`,
        `- Auto-execute: ${checked.entitlement.autoExecuteAllowed ? 'yes' : 'no'}`,
        `- Priority queue: ${checked.entitlement.priorityQueue ? 'yes' : 'no'}`,
        '',
        'API keys:',
        ...(keys.length ? keys.map(formatKeyLine) : ['- none']),
        '',
        'Upgrade path:',
        'Open the Plans page on the AGNT website and complete checkout.',
      ].filter((line): line is string => Boolean(line)).join('\n'))
    }

    case 'create_api_key': {
      const checked = requireAuth(auth)
      if ('error' in checked) return err(checked.error)
      const key = createApiKey(checked.userId, typeof args.label === 'string' ? args.label : 'generated key')
      return text([
        'API key created',
        '',
        `Key ID: ${key.record.id}`,
        `Label: ${key.record.label}`,
        '',
        'This API key is shown once:',
        `AGNT_API_KEY=${key.apiKey}`,
        '',
        'Store it securely. The server only stores a hash.',
      ].join('\n'))
    }

    case 'revoke_api_key': {
      const checked = requireAuth(auth)
      if ('error' in checked) return err(checked.error)
      if (typeof args.id !== 'string' || !args.id) return err('id is required.')
      const revoked = revokeApiKey(args.id, checked.userId)
      if (!revoked) return err(`API key "${args.id}" not found.`)
      return text([
        'API key revoked',
        '',
        `Key ID: ${revoked.id}`,
        `Label: ${revoked.label}`,
        'That key can no longer authenticate.',
      ].join('\n'))
    }

    default:
      return err(`Unknown account action: ${String(args.action)}`)
  }
}

export default { tools: TOOLS, handle } satisfies ToolModule
