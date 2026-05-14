/**
 * ./AGNT Protocol — Automation Scheduler
 * Lightweight in-process scheduler for DCA, price alerts, and recurring strategies.
 * Persists automations to encrypted JSON file (same pattern as wallets).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { encrypt, decrypt, getPassphrase } from './crypto.js'
import { randomBytes } from 'crypto'
import type { AutomationPlan } from './automation-types.js'

// ─── Types ───────────────────────────────────────────────

export type AutomationType = 'dca' | 'price_alert' | 'event_trigger' | 'market_monitor'

export interface AutomationEntry {
  id: string
  type: AutomationType
  name: string
  userId?: string
  createdByApiKeyId?: string
  planAtCreation?: AutomationPlan
  params: Record<string, unknown>
  intervalMs: number // 0 for one-shot alerts
  maxRuns: number // 0 = unlimited
  status: 'active' | 'paused' | 'completed' | 'failed'
  createdAt: string
  lastRun: string | null
  nextRun: string | null
  runCount: number
  history: { time: string; result: string; success: boolean }[]
}

interface AutomationStore {
  automations: AutomationEntry[]
}

// ─── Persistence ─────────────────────────────────────────

function resolvePath(custom?: string): string {
  const p = custom || process.env.AGNT_AUTOMATIONS_PATH || '.agnt/automations.enc'
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

export function loadAutomations(custom?: string): AutomationStore {
  const fp = resolvePath(custom)
  if (!existsSync(fp)) return { automations: [] }
  try {
    const raw = readFileSync(fp, 'utf-8')
    if (raw.trim().startsWith('{')) return JSON.parse(raw) as AutomationStore
    const json = decrypt(raw, getPassphrase())
    return JSON.parse(json) as AutomationStore
  } catch {
    return { automations: [] }
  }
}

function saveAutomations(store: AutomationStore, custom?: string) {
  const fp = resolvePath(custom)
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(store, null, 2)
  const encrypted = encrypt(json, getPassphrase())
  writeFileSync(fp, encrypted, 'utf-8')
}

// ─── CRUD Operations ─────────────────────────────────────

function generateId(): string {
  return randomBytes(4).toString('hex')
}

export function createAutomation(
  entry: Omit<AutomationEntry, 'id' | 'createdAt' | 'lastRun' | 'nextRun' | 'runCount' | 'history'>,
  custom?: string,
): AutomationEntry {
  const store = loadAutomations(custom)
  const automation: AutomationEntry = {
    ...entry,
    maxRuns: entry.maxRuns || 0,
    id: generateId(),
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: entry.intervalMs > 0 ? new Date(Date.now() + entry.intervalMs).toISOString() : null,
    runCount: 0,
    history: [],
  }
  store.automations.push(automation)
  saveAutomations(store, custom)
  return automation
}

export function listAutomations(): AutomationEntry[] {
  const store = loadAutomations()
  return store.automations
}

export function listAutomationsForUser(userId: string): AutomationEntry[] {
  const store = loadAutomations()
  return store.automations.filter((automation) => automation.userId === userId)
}

export function updateAutomationStatusForUser(id: string, userId: string, status: AutomationEntry['status']): AutomationEntry | null {
  const store = loadAutomations()
  const auto = store.automations.find((a) => a.id === id && a.userId === userId)
  if (!auto) return null
  auto.status = status
  if (status === 'active') {
    if (auto.maxRuns > 0 && auto.runCount >= auto.maxRuns) {
      auto.status = 'completed'
      auto.nextRun = null
    } else if (auto.intervalMs > 0) {
      auto.nextRun = new Date(Date.now() + auto.intervalMs).toISOString()
    } else {
      auto.nextRun = null
    }
  } else {
    auto.nextRun = null
  }
  saveAutomations(store)
  return auto
}

export function cancelAutomation(id: string): AutomationEntry | null {
  const store = loadAutomations()
  const auto = store.automations.find((a) => a.id === id)
  if (!auto) return null
  auto.status = 'completed'
  auto.nextRun = null
  saveAutomations(store)
  return auto
}

export function getAutomation(id: string): AutomationEntry | null {
  const store = loadAutomations()
  return store.automations.find((a) => a.id === id) || null
}

export function addAutomationHistory(
  id: string,
  result: string,
  success: boolean,
  options?: { countRun?: boolean; status?: AutomationEntry['status']; nextRun?: string | null },
) {
  const store = loadAutomations()
  const auto = store.automations.find((a) => a.id === id)
  if (!auto) return
  auto.history.push({ time: new Date().toISOString(), result, success })
  auto.lastRun = new Date().toISOString()
  const countRun = options?.countRun ?? true
  if (countRun) auto.runCount++
  if (options?.status) {
    auto.status = options.status
    auto.nextRun = options.nextRun ?? null
  } else if (auto.maxRuns > 0 && auto.runCount >= auto.maxRuns) {
    auto.status = 'completed'
    auto.nextRun = null
  } else if (auto.intervalMs > 0) {
    auto.nextRun = new Date(Date.now() + auto.intervalMs).toISOString()
  }
  // Keep last 50 history entries
  if (auto.history.length > 50) auto.history = auto.history.slice(-50)
  saveAutomations(store)
}

// ─── Interval Helpers ────────────────────────────────────

export function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/i)
  if (!match) throw new Error(`Invalid interval "${interval}". Use format like "10s", "30m", "6h", "1d".`)
  const num = parseInt(match[1])
  const unit = match[2].toLowerCase()
  if (unit.startsWith('s')) return num * 1000
  if (unit.startsWith('m')) return num * 60 * 1000
  if (unit.startsWith('h')) return num * 60 * 60 * 1000
  if (unit.startsWith('d')) return num * 24 * 60 * 60 * 1000
  throw new Error(`Unknown time unit: ${unit}`)
}

export function formatInterval(ms: number): string {
  if (ms < 60 * 1000) return `${ms / 1000}s`
  if (ms < 60 * 60 * 1000) return `${ms / 60000}m`
  if (ms < 24 * 60 * 60 * 1000) return `${ms / 3600000}h`
  return `${ms / 86400000}d`
}
