/**
 * ./AGNT Protocol — Memory Tools v2
 * Fast: in-memory indexed search, debounced persistence.
 * New: bulk_forget, search_tag, export.
 */

import type { ToolModule } from './index.js'
import {
  rememberFact,
  recall,
  recallByTag,
  getTradeHistory,
  forgetFact,
  forgetByTag,
  listMemories,
  getMemoryStats,
  flushMemory,
  type MemoryEntry,
} from '../memory.js'
import { getActiveWallet } from '../wallet.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const TOOLS = [
  {
    name: 'memory',
    description: 'Fast agent memory. Remember facts, recall by keyword or tag, trade history, bulk operations. Indexed search, persistent across sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['remember', 'recall', 'history', 'forget', 'bulk_forget', 'list', 'stats', 'flush'],
          description: 'Action to perform',
        },
        key: { type: 'string', description: 'Memory key (for remember, forget)' },
        value: { type: 'string', description: 'Content to store (for remember)' },
        tags: {
          type: 'array', items: { type: 'string' },
          description: 'Tags for categorization (for remember)',
        },
        query: { type: 'string', description: 'Search keywords (for recall)' },
        tag: { type: 'string', description: 'Filter by tag (for list, recall, bulk_forget)' },
        limit: { type: 'number', description: 'Max results. Default: 10' },
        type: { type: 'string', description: 'Filter: swap, bridge, lending, perps, yield (for history)' },
        scope: { type: 'string', enum: ['active_wallet', 'all'], description: 'History scope. Default: active_wallet' },
      },
      required: ['action'],
    },
  },
]

function fmtEntry(m: MemoryEntry, i: number): string {
  const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : ''
  const time = m.timestamp.slice(0, 16).replace('T', ' ')
  return `  ${i + 1}. 🔑 ${m.key}${tags}\n     ${m.value.slice(0, 200)}\n     📅 ${time} | ${m.source}`
}

async function handle(name: string, args: Record<string, unknown>) {
  if (name !== 'memory') return null

  try {
    switch (args.action as string) {

      case 'remember': {
        if (!args.key || !args.value) return err('Need key and value')
        const entry = rememberFact(
          args.key as string,
          args.value as string,
          (args.tags as string[]) || [],
          'agent',
        )
        return text(
          `✅ Stored!\n\n` +
          `🔑 ${entry.key}\n` +
          `📝 ${entry.value.slice(0, 200)}\n` +
          (entry.tags.length ? `🏷️ ${entry.tags.join(', ')}\n` : '')
        )
      }

      case 'recall': {
        const limit = (args.limit as number) || 10

        let results: MemoryEntry[]
        if (args.tag && args.query) {
          results = recallByTag(args.tag as string, args.query as string, limit)
        } else if (args.query) {
          results = recall(args.query as string, limit)
        } else if (args.tag) {
          results = recallByTag(args.tag as string, '', limit)
        } else {
          return err('Provide query and/or tag to search')
        }

        if (!results.length) return text(`No memories found.`)

        const lines = [`🧠 Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'}:\n`]
        results.forEach((m, i) => { lines.push(fmtEntry(m, i)); lines.push('') })
        return text(lines.join('\n'))
      }

      case 'history': {
        const limit = (args.limit as number) || 20
        const scope = (args.scope as string | undefined) || 'active_wallet'
        const activeWallet = getActiveWallet()
        if (scope !== 'all' && !activeWallet) {
          return text('No active wallet selected, so I cannot show wallet-specific trade history. Select or create a wallet first, or use scope="all" to inspect unscoped legacy memory.')
        }
        const history = getTradeHistory(limit, args.type as string | undefined, scope === 'all' ? {} : {
          walletAddress: activeWallet?.address,
        })
        if (!history.length) {
          return text(scope === 'all'
            ? 'No trade history yet.'
            : `No trade history found for the active wallet ${activeWallet?.name} (${activeWallet?.address}).`)
        }

        const lines = [`📊 Trade History — ${history.length} entries:\n`]
        if (scope !== 'all') {
          lines.push(`Wallet: ${activeWallet?.name} (${activeWallet?.address})`)
          lines.push('Legacy entries without wallet metadata are hidden here.')
          lines.push('')
        }
        history.forEach((m, i) => { lines.push(fmtEntry(m, i)); lines.push('') })
        return text(lines.join('\n'))
      }

      case 'forget': {
        if (!args.key) return err('Provide key to forget')
        if (!forgetFact(args.key as string)) return err(`"${args.key}" not found`)
        return text(`✅ Deleted "${args.key}"`)
      }

      case 'bulk_forget': {
        if (!args.tag) return err('Provide tag to bulk-delete')
        const count = forgetByTag(args.tag as string)
        if (!count) return err(`No memories with tag "${args.tag}"`)
        return text(`✅ Deleted ${count} memories with tag "${args.tag}"`)
      }

      case 'list': {
        const limit = (args.limit as number) || 50
        const memories = listMemories(args.tag as string | undefined, limit)
        if (!memories.length) return text(`No memories${args.tag ? ` [${args.tag}]` : ''}.`)

        const lines = [`🧠 ${memories.length} memories${args.tag ? ` [${args.tag}]` : ''}:\n`]
        memories.forEach((m, i) => { lines.push(fmtEntry(m, i)); lines.push('') })
        return text(lines.join('\n'))
      }

      case 'stats': {
        const s = getMemoryStats()
        const lines = [
          `🧠 Memory Stats\n`,
          `Entries: ${s.totalMemories} / ${s.maxCapacity}`,
          `Indexed Words: ${s.indexedWords}`,
          `Indexed Tags: ${s.indexedTags}`,
          `Oldest: ${s.oldestMemory?.slice(0, 16).replace('T', ' ') || 'none'}`,
          `Newest: ${s.newestMemory?.slice(0, 16).replace('T', ' ') || 'none'}`,
        ]
        if (s.topTags.length) {
          lines.push(`\nTop Tags:`)
          for (const [tag, count] of s.topTags) lines.push(`  🏷️ ${tag}: ${count}`)
        }
        return text(lines.join('\n'))
      }

      case 'flush': {
        flushMemory()
        return text(`✅ Memory flushed to disk.`)
      }

      default:
        return err(`Unknown action: ${args.action}`)
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

export default { tools: TOOLS, handle } satisfies ToolModule
