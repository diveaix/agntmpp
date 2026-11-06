import { existsSync, readFileSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { randomUUID } from 'crypto'
import { decrypt, encrypt, getPassphrase } from './crypto.js'
import type { AuthContext } from './access-types.js'
import type { ToolResult } from './tools/index.js'
import { handleStoreReadFailure, writePrivateFileAtomicSync } from './persistence.js'

const DEFAULT_PATH = '.agnt/activity.enc'
const MAX_ACTIVITY_ENTRIES = 1000

export interface ActivityEntry {
  id: string
  userId?: string
  apiKeyId?: string
  tool: string
  action?: string
  title: string
  result: string
  success: boolean
  time: string
  txHash?: string
  chain?: string
  amount?: number
  tokenIn?: string
  tokenOut?: string
}

interface ActivityStore {
  entries: ActivityEntry[]
}

function resolvePath(customPath?: string): string {
  const p = customPath || process.env.AGNT_ACTIVITY_LOG_PATH || DEFAULT_PATH
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function emptyStore(): ActivityStore {
  return { entries: [] }
}

function loadStore(customPath?: string): ActivityStore {
  const fp = resolvePath(customPath)
  if (!existsSync(fp)) return emptyStore()

  try {
    const raw = readFileSync(fp, 'utf-8')
    if (!raw.trim()) return emptyStore()
    const json = raw.trim().startsWith('{') ? raw : decrypt(raw, getPassphrase())
    const parsed = JSON.parse(json) as Partial<ActivityStore>
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
  } catch (error) {
    handleStoreReadFailure(`Activity log (${fp})`, error)
    return emptyStore()
  }
}

function saveStore(store: ActivityStore, customPath?: string) {
  const fp = resolvePath(customPath)
  const sorted = [...store.entries]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, MAX_ACTIVITY_ENTRIES)
  writePrivateFileAtomicSync(fp, encrypt(JSON.stringify({ entries: sorted }), getPassphrase()))
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function titleFromTool(tool: string, args: Record<string, unknown>): string {
  const action = asString(args.action)
  const amount = asNumber(args.amount)
  const tokenIn = asString(args.tokenIn) || asString(args.asset) || asString(args.token)
  const tokenOut = asString(args.tokenOut) || asString(args.toToken)

  if (['uniswap', 'pancakeswap'].includes(tool)) {
    return `Swap ${amount ?? ''} ${tokenIn ?? 'token'} to ${tokenOut ?? 'token'}`.replace(/\s+/g, ' ').trim()
  }
  if (tool === 'smart_swap') {
    return `Swap ${amount ?? ''} into ${asString(args.query) || tokenOut || 'token'}`.replace(/\s+/g, ' ').trim()
  }
  if (['relay', 'jumper'].includes(tool)) {
    const from = asString(args.fromChain) || asString(args.source) || 'source'
    const to = asString(args.toChain) || 'destination'
    return `Bridge ${amount ?? ''} ${tokenIn ?? asString(args.token) ?? 'token'} from ${from} to ${to}`.replace(/\s+/g, ' ').trim()
  }
  if (tool === 'payment') {
    return `Send ${amount ?? ''} ${asString(args.token) || 'token'}`.replace(/\s+/g, ' ').trim()
  }
  return `${tool}${action ? ` ${action}` : ''}`.replace(/_/g, ' ')
}

function extractTxHash(text: string): string | undefined {
  return text.match(/0x[a-fA-F0-9]{64}/)?.[0]
}

export function recordActivity(
  entry: Omit<ActivityEntry, 'id' | 'time'> & { id?: string; time?: string },
  customPath?: string,
): ActivityEntry {
  const store = loadStore(customPath)
  const saved: ActivityEntry = {
    id: entry.id || `act_${randomUUID()}`,
    time: entry.time || new Date().toISOString(),
    ...entry,
  }
  store.entries.unshift(saved)
  saveStore(store, customPath)
  return saved
}

export function recordToolActivity(
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult,
  auth?: AuthContext,
  customPath?: string,
): ActivityEntry {
  const resultText = result.content.map((content) => content.text).join('\n').trim()
  return recordActivity({
    userId: auth?.userId,
    apiKeyId: auth?.apiKeyId,
    tool,
    action: asString(args.action),
    title: titleFromTool(tool, args),
    result: resultText.slice(0, 1000),
    success: !result.isError,
    txHash: extractTxHash(resultText),
    chain: asString(args.chain) || asString(args.fromChain) || asString(args.source),
    amount: asNumber(args.amount),
    tokenIn: asString(args.tokenIn) || asString(args.asset) || asString(args.token),
    tokenOut: asString(args.tokenOut) || asString(args.toToken),
  }, customPath)
}

export function listActivityForUser(userId: string, options?: { includeLocalUnowned?: boolean; limit?: number; path?: string }): ActivityEntry[] {
  const store = loadStore(options?.path)
  const limit = options?.limit || 100
  return store.entries
    .filter((entry) => entry.userId === userId || (options?.includeLocalUnowned && !entry.userId))
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, limit)
}
