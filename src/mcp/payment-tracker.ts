/**
 * ./AGNT Protocol — Payment Tracker & Session Cache
 * Tracks payment analytics and caches sessions for low-latency repeat calls.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { encrypt, decrypt, getPassphrase } from './crypto.js'
import type { PricingTier } from './mpp.js'

const DEFAULT_PATH = process.env.AGNT_PAYMENTS_PATH || '.agnt/payments.enc'
const SESSION_TTL = parseInt(process.env.AGNT_SESSION_TTL || '60000', 10) // 60s default

// ─── Session Cache (in-memory, no I/O) ──────────────────

const sessionCache = new Map<string, number>() // key → expiry timestamp

export function isSessionCached(payer: string, tool: string): boolean {
  const key = `${payer}:${tool}`
  const expiry = sessionCache.get(key)
  if (!expiry) return false
  if (Date.now() > expiry) {
    sessionCache.delete(key)
    return false
  }
  return true
}

export function cacheSession(payer: string, tool: string): void {
  sessionCache.set(`${payer}:${tool}`, Date.now() + SESSION_TTL)
}

// ─── Payment History (persistent) ───────────────────────

export interface PaymentRecord {
  tool: string
  tier: PricingTier
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
  } catch {
    return { totalCalls: 0, totalPaidCalls: 0, totalRevenue: {}, revenueByTool: {}, history: [] }
  }
}

function saveStore(store: PaymentStore): void {
  const fp = resolvePath()
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(fp, encrypt(JSON.stringify(store), getPassphrase()), 'utf-8')
}

export function recordCall(): void {
  const store = loadStore()
  store.totalCalls++
  saveStore(store)
}

export function recordPayment(tool: string, tier: PricingTier, amount: string, payer: string, txHash: string): void {
  const store = loadStore()
  store.totalPaidCalls++
  const amtNum = parseFloat(amount)
  store.totalRevenue[tier] = (store.totalRevenue[tier] || 0) + amtNum
  store.revenueByTool[tool] = (store.revenueByTool[tool] || 0) + amtNum
  store.history.push({ tool, tier, amount, payer, txHash, time: new Date().toISOString() })
  if (store.history.length > 100) store.history = store.history.slice(-100)
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
    activeSessions: sessionCache.size,
  }
}
