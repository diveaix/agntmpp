/**
 * ./AGNT Protocol — Spending Guard
 *
 * Enforces per-wallet spending limits:
 *   • Daily cap — max USD value the wallet can spend in a rolling 24h window
 *   • Per-trade cap — max USD value per individual transaction
 *
 * Storage: .agnt/spending-limits.json (plaintext — no secrets, just config)
 * Spend ledger: .agnt/spend-ledger.json (rolling 24h transaction log)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'

// ─── Types ───────────────────────────────────────────────

export interface SpendingLimit {
  walletAddress: string
  dailyLimitUsd: number        // 0 = unlimited
  perTradeLimitUsd: number     // 0 = unlimited
  updatedAt: string
}

export interface SpendEntry {
  walletAddress: string
  amountUsd: number
  action: string               // e.g. "swap", "bridge", "order"
  timestamp: number            // epoch ms
}

interface LimitStore {
  limits: SpendingLimit[]
}

interface LedgerStore {
  entries: SpendEntry[]
}

// ─── Paths ───────────────────────────────────────────────

const LIMITS_PATH = process.env.AGNT_LIMITS_PATH || '.agnt/spending-limits.json'
const LEDGER_PATH = process.env.AGNT_LEDGER_PATH || '.agnt/spend-ledger.json'

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function ensureDir(fp: string) {
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ─── Persistence ─────────────────────────────────────────

function loadLimits(): LimitStore {
  const fp = resolvePath(LIMITS_PATH)
  if (!existsSync(fp)) return { limits: [] }
  try { return JSON.parse(readFileSync(fp, 'utf-8')) as LimitStore } catch { return { limits: [] } }
}

function saveLimits(store: LimitStore) {
  const fp = resolvePath(LIMITS_PATH)
  ensureDir(fp)
  writeFileSync(fp, JSON.stringify(store, null, 2), 'utf-8')
}

function loadLedger(): LedgerStore {
  const fp = resolvePath(LEDGER_PATH)
  if (!existsSync(fp)) return { entries: [] }
  try { return JSON.parse(readFileSync(fp, 'utf-8')) as LedgerStore } catch { return { entries: [] } }
}

function saveLedger(store: LedgerStore) {
  const fp = resolvePath(LEDGER_PATH)
  ensureDir(fp)
  writeFileSync(fp, JSON.stringify(store, null, 2), 'utf-8')
}

// ─── Core API ────────────────────────────────────────────

/**
 * Set spending limits for a wallet.
 * Pass 0 for unlimited. Overwrites any previous config for that wallet.
 */
export function setLimits(walletAddress: string, dailyLimitUsd: number, perTradeLimitUsd: number): SpendingLimit {
  const store = loadLimits()
  const addr = walletAddress.toLowerCase()
  const existing = store.limits.find(l => l.walletAddress === addr)

  const limit: SpendingLimit = {
    walletAddress: addr,
    dailyLimitUsd: Math.max(0, dailyLimitUsd),
    perTradeLimitUsd: Math.max(0, perTradeLimitUsd),
    updatedAt: new Date().toISOString(),
  }

  if (existing) {
    Object.assign(existing, limit)
  } else {
    store.limits.push(limit)
  }

  saveLimits(store)
  return limit
}

/** Remove all limits for a wallet. */
export function removeLimits(walletAddress: string): boolean {
  const store = loadLimits()
  const addr = walletAddress.toLowerCase()
  const idx = store.limits.findIndex(l => l.walletAddress === addr)
  if (idx < 0) return false
  store.limits.splice(idx, 1)
  saveLimits(store)
  return true
}

/** Get limits for a specific wallet, or null if none set. */
export function getLimits(walletAddress: string): SpendingLimit | null {
  const store = loadLimits()
  return store.limits.find(l => l.walletAddress === walletAddress.toLowerCase()) || null
}

/** Get all configured limits. */
export function getAllLimits(): SpendingLimit[] {
  return loadLimits().limits
}

/**
 * Get total USD spent by a wallet in the last 24 hours.
 */
export function getSpentToday(walletAddress: string): { total: number; entries: SpendEntry[] } {
  const ledger = loadLedger()
  const addr = walletAddress.toLowerCase()
  const cutoff = Date.now() - 24 * 60 * 60 * 1000

  const recent = ledger.entries.filter(e => e.walletAddress === addr && e.timestamp > cutoff)
  const total = recent.reduce((sum, e) => sum + e.amountUsd, 0)

  return { total, entries: recent }
}

/**
 * Pre-flight check: can this wallet execute a trade of the given USD value?
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkSpend(
  walletAddress: string,
  amountUsd: number,
): { allowed: true } | { allowed: false; reason: string } {
  const limit = getLimits(walletAddress)
  if (!limit) return { allowed: true } // no limits set

  // Per-trade check
  if (limit.perTradeLimitUsd > 0 && amountUsd > limit.perTradeLimitUsd) {
    return {
      allowed: false,
      reason: `Trade value $${amountUsd.toFixed(2)} exceeds per-trade limit of $${limit.perTradeLimitUsd.toFixed(2)}. ` +
        `Use safety set_spending_limit to adjust.`,
    }
  }

  // Daily check
  if (limit.dailyLimitUsd > 0) {
    const { total } = getSpentToday(walletAddress)
    const remaining = limit.dailyLimitUsd - total
    if (amountUsd > remaining) {
      return {
        allowed: false,
        reason: `Trade value $${amountUsd.toFixed(2)} would exceed daily limit. ` +
          `Daily limit: $${limit.dailyLimitUsd.toFixed(2)} | Spent today: $${total.toFixed(2)} | Remaining: $${remaining.toFixed(2)}. ` +
          `Use safety set_spending_limit to adjust, or wait for the 24h window to reset.`,
      }
    }
  }

  return { allowed: true }
}

/**
 * Record a completed spend (call AFTER successful tx execution).
 */
export function recordSpend(walletAddress: string, amountUsd: number, action: string): void {
  const ledger = loadLedger()
  const addr = walletAddress.toLowerCase()

  // Append
  ledger.entries.push({
    walletAddress: addr,
    amountUsd,
    action,
    timestamp: Date.now(),
  })

  // Prune entries older than 48h to keep the ledger small
  const cutoff = Date.now() - 48 * 60 * 60 * 1000
  ledger.entries = ledger.entries.filter(e => e.timestamp > cutoff)

  saveLedger(ledger)
}

/** Clear the spend ledger for a wallet (admin reset). */
export function resetSpendLedger(walletAddress: string): number {
  const ledger = loadLedger()
  const addr = walletAddress.toLowerCase()
  const before = ledger.entries.length
  ledger.entries = ledger.entries.filter(e => e.walletAddress !== addr)
  saveLedger(ledger)
  return before - ledger.entries.length
}
