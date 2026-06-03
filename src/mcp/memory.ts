/**
 * ./AGNT Protocol — Agent Memory Engine v2
 *
 * Fast in-memory cache + lazy disk persistence.
 * Only reads from disk once on startup; writes are debounced.
 * Indexed by key, tags, and reverse-index for fast keyword search.
 *
 * Storage: .agnt/memory.enc (AES-256-GCM encrypted)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import { encrypt, decrypt, getPassphrase } from './crypto.js'

const DEFAULT_PATH = '.agnt/memory.enc'
const MAX_MEMORIES = 5000
const SAVE_DEBOUNCE_MS = 2000 // batch writes within 2s window

// ─── Types ───────────────────────────────────────────────

export interface MemoryEntry {
  key: string
  value: string
  tags: string[]
  source: string
  timestamp: string
}

// ─── In-Memory Cache ─────────────────────────────────────

let _entries: MemoryEntry[] = []
let _byKey: Map<string, number> = new Map()       // key → index
let _byTag: Map<string, Set<number>> = new Map()   // tag → indices
let _wordIndex: Map<string, Set<number>> = new Map() // word → indices
let _loaded = false
let _dirty = false
let _saveTimer: ReturnType<typeof setTimeout> | null = null

// ─── Indexing ────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1)
}

function rebuildIndex() {
  _byKey.clear()
  _byTag.clear()
  _wordIndex.clear()

  for (let i = 0; i < _entries.length; i++) {
    indexEntry(i)
  }
}

function indexEntry(idx: number) {
  const e = _entries[idx]
  _byKey.set(e.key, idx)

  // Tag index
  for (const tag of e.tags) {
    const t = tag.toLowerCase()
    if (!_byTag.has(t)) _byTag.set(t, new Set())
    _byTag.get(t)!.add(idx)
  }

  // Word index (key + value + tags)
  const words = tokenize(`${e.key} ${e.value} ${e.tags.join(' ')}`)
  for (const word of words) {
    if (!_wordIndex.has(word)) _wordIndex.set(word, new Set())
    _wordIndex.get(word)!.add(idx)
  }
}

function removeFromIndex(idx: number) {
  const e = _entries[idx]
  _byKey.delete(e.key)
  for (const tag of e.tags) {
    _byTag.get(tag.toLowerCase())?.delete(idx)
  }
  const words = tokenize(`${e.key} ${e.value} ${e.tags.join(' ')}`)
  for (const w of words) {
    _wordIndex.get(w)?.delete(idx)
  }
}

// ─── Persistence ─────────────────────────────────────────

function resolvePath(): string {
  const p = process.env.AGNT_MEMORY_PATH || DEFAULT_PATH
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function loadFromDisk() {
  if (_loaded) return
  _loaded = true

  const fp = resolvePath()
  if (!existsSync(fp)) return

  try {
    const raw = readFileSync(fp, 'utf-8')
    let store: { entries: MemoryEntry[] }
    if (raw.trim().startsWith('{')) {
      store = JSON.parse(raw)
    } else {
      store = JSON.parse(decrypt(raw, getPassphrase()))
    }
    _entries = store.entries || []
    rebuildIndex()
  } catch {
    _entries = []
  }
}

function scheduleSave() {
  _dirty = true
  if (_saveTimer) return // already scheduled
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    if (!_dirty) return
    _dirty = false
    flushToDisk()
  }, SAVE_DEBOUNCE_MS)
}

function flushToDisk() {
  const fp = resolvePath()
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify({ entries: _entries })
  writeFileSync(fp, encrypt(json, getPassphrase()), 'utf-8')
}

/** Force an immediate save (for shutdown hooks). */
export function flushMemory() {
  if (_dirty) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null }
    _dirty = false
    flushToDisk()
  }
}

// ─── Ensure loaded ──────────────────────────────────────

function ensure() {
  if (!_loaded) loadFromDisk()
}

// ─── Core Operations ─────────────────────────────────────

/**
 * Store a fact. Upserts by key. O(1) for updates, O(words) for indexing.
 */
export function rememberFact(
  key: string,
  value: string,
  tags: string[] = [],
  source = 'manual',
): MemoryEntry {
  ensure()

  const entry: MemoryEntry = {
    key, value, tags, source,
    timestamp: new Date().toISOString(),
  }

  const existingIdx = _byKey.get(key)
  if (existingIdx !== undefined) {
    removeFromIndex(existingIdx)
    _entries[existingIdx] = entry
    indexEntry(existingIdx)
  } else {
    const idx = _entries.length
    _entries.push(entry)
    indexEntry(idx)
  }

  // Enforce cap — evict oldest
  if (_entries.length > MAX_MEMORIES) {
    // Find oldest
    let oldestIdx = 0, oldestTime = Infinity
    for (let i = 0; i < _entries.length; i++) {
      const t = new Date(_entries[i].timestamp).getTime()
      if (t < oldestTime) { oldestTime = t; oldestIdx = i }
    }
    removeFromIndex(oldestIdx)
    _entries.splice(oldestIdx, 1)
    rebuildIndex() // re-index after splice shifts indices
  }

  scheduleSave()
  return entry
}

/**
 * Fast keyword search using inverted index.
 * O(matches) instead of O(all entries).
 */
export function recall(query: string, limit = 10): MemoryEntry[] {
  ensure()
  if (!query.trim()) {
    return _entries.slice(-limit).reverse()
  }

  const keywords = tokenize(query)
  if (!keywords.length) return _entries.slice(-limit).reverse()

  // Gather candidate indices from word index
  const candidates = new Map<number, number>() // idx → score

  for (const kw of keywords) {
    // Exact word match
    const exact = _wordIndex.get(kw)
    if (exact) {
      for (const idx of exact) {
        candidates.set(idx, (candidates.get(idx) || 0) + 3)
      }
    }

    // Prefix match for partial words (e.g. "bit" matches "bitcoin")
    if (kw.length >= 3) {
      for (const [word, indices] of _wordIndex) {
        if (word !== kw && word.startsWith(kw)) {
          for (const idx of indices) {
            candidates.set(idx, (candidates.get(idx) || 0) + 1)
          }
        }
      }
    }
  }

  // Boost scores for exact key/tag matches
  for (const [idx, baseScore] of candidates) {
    const e = _entries[idx]
    let boost = 0
    for (const kw of keywords) {
      if (e.key.toLowerCase() === kw) boost += 10
      else if (e.key.toLowerCase().includes(kw)) boost += 5
      if (e.tags.some(t => t.toLowerCase() === kw)) boost += 4
    }
    if (boost) candidates.set(idx, baseScore + boost)
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([idx]) => _entries[idx])
}

/**
 * Get trade history. Uses tag index for O(1) tag lookup.
 */
export function getTradeHistory(
  limit = 20,
  type?: string,
  options: { walletAddress?: string; includeUnscoped?: boolean } = {},
): MemoryEntry[] {
  ensure()
  const tradeKeywords = type
    ? [type.toLowerCase()]
    : ['swap', 'bridge', 'lending', 'perps', 'yield', 'payment']

  const seen = new Set<number>()
  for (const kw of tradeKeywords) {
    const tagged = _byTag.get(kw)
    if (tagged) for (const idx of tagged) seen.add(idx)
  }

  // Also check source-based entries
  if (!type) {
    for (let i = 0; i < _entries.length; i++) {
      const src = _entries[i].source.toLowerCase()
      if (src.includes('swap') || src.includes('bridge') || src.includes('trade') ||
          src.includes('stake') || src.includes('supply') || src.includes('order')) {
        seen.add(i)
      }
    }
  }

  const walletTag = options.walletAddress ? `wallet:${options.walletAddress.toLowerCase()}` : undefined

  return [...seen]
    .map(idx => _entries[idx])
    .filter(entry => {
      if (!walletTag) return true
      const tags = entry.tags.map(tag => tag.toLowerCase())
      if (tags.includes(walletTag)) return true
      return Boolean(options.includeUnscoped && !tags.some(tag => tag.startsWith('wallet:')))
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)
}

/**
 * Delete by key. O(1) lookup.
 */
export function forgetFact(key: string): boolean {
  ensure()
  const idx = _byKey.get(key)
  if (idx === undefined) return false

  removeFromIndex(idx)
  _entries.splice(idx, 1)
  rebuildIndex() // re-index after splice
  scheduleSave()
  return true
}

/**
 * List memories filtered by tag. Uses tag index.
 */
export function listMemories(tag?: string, limit = 50): MemoryEntry[] {
  ensure()

  if (tag) {
    const indices = _byTag.get(tag.toLowerCase())
    if (!indices || indices.size === 0) return []
    return [...indices]
      .map(idx => _entries[idx])
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit)
  }

  return [..._entries]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)
}

/**
 * Get memory stats. O(1) since data is already indexed.
 */
export function getMemoryStats() {
  ensure()

  const tagCounts: [string, number][] = [..._byTag.entries()]
    .map(([tag, set]) => [tag, set.size] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  let oldest: string | null = null
  let newest: string | null = null
  if (_entries.length > 0) {
    oldest = _entries.reduce((a, b) => a.timestamp < b.timestamp ? a : b).timestamp
    newest = _entries.reduce((a, b) => a.timestamp > b.timestamp ? a : b).timestamp
  }

  return {
    totalMemories: _entries.length,
    maxCapacity: MAX_MEMORIES,
    indexedWords: _wordIndex.size,
    indexedTags: _byTag.size,
    topTags: tagCounts,
    oldestMemory: oldest,
    newestMemory: newest,
  }
}

/**
 * Bulk forget — delete all memories matching a tag.
 */
export function forgetByTag(tag: string): number {
  ensure()
  const indices = _byTag.get(tag.toLowerCase())
  if (!indices || indices.size === 0) return 0

  const count = indices.size
  // Delete in reverse index order to avoid shifting
  const sorted = [...indices].sort((a, b) => b - a)
  for (const idx of sorted) {
    _entries.splice(idx, 1)
  }
  rebuildIndex()
  scheduleSave()
  return count
}

/**
 * Search by tag + keyword combined.
 */
export function recallByTag(tag: string, query: string, limit = 10): MemoryEntry[] {
  ensure()
  const tagIndices = _byTag.get(tag.toLowerCase())
  if (!tagIndices || tagIndices.size === 0) return []

  if (!query.trim()) {
    return [...tagIndices]
      .map(idx => _entries[idx])
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit)
  }

  const keywords = tokenize(query)
  const scored: { entry: MemoryEntry; score: number }[] = []

  for (const idx of tagIndices) {
    const e = _entries[idx]
    const text = `${e.key} ${e.value}`.toLowerCase()
    let score = 0
    for (const kw of keywords) {
      if (text.includes(kw)) score += 2
      if (e.key.toLowerCase().includes(kw)) score += 5
    }
    if (score > 0) scored.push({ entry: e, score })
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.entry)
}

// ─── Auto-Recording ──────────────────────────────────────

export function autoRemember(
  toolName: string,
  args: Record<string, unknown>,
  resultSnippet: string,
  context: { walletName?: string; walletAddress?: string } = {},
) {
  const action = (args.action as string) || 'unknown'
  const timestamp = new Date().toISOString()
  const key = `${toolName}:${action}:${timestamp.slice(0, 19)}:${randomUUID().slice(0, 8)}`

  let value = `${toolName} ${action}`
  const relevantArgs = Object.entries(args)
    .filter(([k]) => k !== 'action')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')

  if (relevantArgs) value += ` (${relevantArgs})`
  if (resultSnippet) value += ` → ${resultSnippet.slice(0, 200)}`

  const tags: string[] = [toolName, action]
  if (['tempo_swap', 'smart_swap', 'uniswap', 'pancakeswap'].includes(toolName)) tags.push('swap')
  if (['tempo_bridge', 'relay', 'debridge', 'jumper'].includes(toolName)) tags.push('bridge')
  if (['aave', 'morpho'].includes(toolName)) tags.push('lending')
  if (['hyperliquid'].includes(toolName)) tags.push('perps')
  if (['lido', 'eigenlayer', 'pendle', 'ethena', 'ondo'].includes(toolName)) tags.push('yield')
  if (['payment'].includes(toolName)) tags.push('payment')
  if (['polymarket'].includes(toolName)) tags.push('prediction')
  if (context.walletAddress) tags.push(`wallet:${context.walletAddress.toLowerCase()}`)
  if (context.walletName) tags.push(`wallet_name:${context.walletName.toLowerCase()}`)

  if (context.walletAddress) {
    value += ` | wallet=${context.walletName || 'active'} (${context.walletAddress})`
  }

  try { rememberFact(key, value, tags, toolName) } catch { /* silent */ }
}

// ─── Shutdown hook ───────────────────────────────────────
process.on('beforeExit', flushMemory)
process.on('SIGINT', () => { flushMemory(); process.exit(0) })
