/**
 * ./AGNT Protocol — MPP Configuration
 * Machine Payments Protocol integration via mppx SDK.
 * Currency: USDC.e now → $AGNT post-TGE (swap via env var).
 */

import { Mppx, tempo } from 'mppx/server'

// USDC.e on Tempo — switch to $AGNT post-TGE via AGNT_PAYMENT_CURRENCY env var
const USDC_E = '0x20C000000000000000000000b9537d11c60E8b50'

const DEFAULT_RECIPIENT = '0x0000000000000000000000000000000000000000'

export const mppx = Mppx.create({
  methods: [tempo({
    currency: (process.env.AGNT_PAYMENT_CURRENCY || USDC_E) as `0x${string}`,
    recipient: (process.env.AGNT_RECIPIENT || DEFAULT_RECIPIENT) as `0x${string}`,
    waitForConfirmation: false,
  })],
})

export const PRICING = {
  free: { amount: '0' },
  standard: { amount: '0.001' },   // $0.001 per call
  premium: { amount: '0.01' },     // $0.01 per call
} as const

export type PricingTier = keyof typeof PRICING
