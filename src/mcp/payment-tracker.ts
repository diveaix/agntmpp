/**
 * ./AGENT Protocol — Call and Payment History
 * Tracks calls and preserves historical payment analytics.
 */

import { existsSync, readFileSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { encrypt, decrypt, getPassphrase } from './crypto.js'
import { handleStoreReadFailure, writePrivateFileAtomicSync } from './persistence.js'

const DEFAULT_PATH = process.env.AGNT_PAYMENTS_PATH || '.agnt/payments.enc'
// ─── Payment History (persistent) ───────────────────────

export interface PaymentRecord {
  tool: string
  tier: 'free' | 'standard' | 'premium'
  amount: string
  payer: string
  txHash: string
  time: string
}

interface PaymentStore {
  totalCalls: number
  totalPaidCalls: number
  totalRevenue: Record<string, number> // tier → cumulative USD
  revenueByTool: Record<string, number>
  history: PaymentRecord[]
}

function resolvePath(): string {
  const p = DEFAULT_PATH
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function loadStore(): PaymentStore {
  const fp = resolvePath()
  if (!existsSync(fp)) return { totalCalls: 0, totalPaidCalls: 0, totalRevenue: {}, revenueByTool: {}, history: [] }
  try {
    const raw = readFileSync(fp, 'utf-8')
    if (raw.trim().startsWith('{')) return JSON.parse(raw) as PaymentStore
    return JSON.parse(decrypt(raw, getPassphrase())) as PaymentStore
  } catch (error) {
    handleStoreReadFailure(`Payment tracker (${fp})`, error)
    return { totalCalls: 0, totalPaidCalls: 0, totalRevenue: {}, revenueByTool: {}, history: [] }
  }
}

function saveStore(store: PaymentStore): void {
  const fp = resolvePath()
  writePrivateFileAtomicSync(fp, encrypt(JSON.stringify(store), getPassphrase()))
}

export function recordCall(): void {
  const store = loadStore()
  store.totalCalls++
  saveStore(store)
}

export function getStats() {
  const store = loadStore()
  return {
    totalCalls: store.totalCalls,
    totalPaidCalls: store.totalPaidCalls,
    totalRevenue: store.totalRevenue,
    topTools: Object.entries(store.revenueByTool).sort((a, b) => b[1] - a[1]).slice(0, 10),
    recentPayments: store.history.slice(-10),
    activeSessions: 0,
  }
}
