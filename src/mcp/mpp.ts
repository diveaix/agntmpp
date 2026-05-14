/**
 * AGNT MPP configuration.
 *
 * Keep pricing import-safe: the backend should not construct Tempo payment
 * sessions until settlement is explicitly needed and configured.
 */

const USDC_E = '0x20C000000000000000000000b9537d11c60E8b50'
const DEFAULT_RECIPIENT = '0x0000000000000000000000000000000000000000'

export const PRICING = {
  free: { amount: '0' },
  standard: { amount: '0.001' },
  premium: { amount: '0.01' },
} as const

export type PricingTier = keyof typeof PRICING

type MppxServer = Awaited<ReturnType<typeof createMppx>>

let cachedMppx: MppxServer | null = null

function getSettlementPrivateKey(): `0x${string}` | undefined {
  const raw = process.env.AGNT_MPP_PRIVATE_KEY || process.env.AGNT_SETTLEMENT_PRIVATE_KEY
  if (!raw?.trim()) return undefined
  const trimmed = raw.trim()
  return (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as `0x${string}`
}

export function isMppSettlementConfigured(): boolean {
  return Boolean(getSettlementPrivateKey())
}

export async function createMppx() {
  const privateKey = getSettlementPrivateKey()
  if (!privateKey) {
    throw new Error('MPP settlement is not configured. Set AGNT_MPP_PRIVATE_KEY to enable Tempo session settlement.')
  }

  const [{ Mppx, tempo }, { privateKeyToAccount }] = await Promise.all([
    import('mppx/server'),
    import('viem/accounts'),
  ])

  return Mppx.create({
    methods: [tempo({
      account: privateKeyToAccount(privateKey),
      currency: (process.env.AGNT_PAYMENT_CURRENCY || USDC_E) as `0x${string}`,
      recipient: (process.env.AGNT_RECIPIENT || DEFAULT_RECIPIENT) as `0x${string}`,
      waitForConfirmation: false,
    })],
  })
}

export async function getMppx() {
  if (!cachedMppx) cachedMppx = await createMppx()
  return cachedMppx
}
