/**
 * ./AGNT Protocol — A2A (Agent-to-Agent) Task Engine
 * 
 * Implements the A2A task lifecycle so other agents can discover
 * and invoke ./AGNT's DeFi capabilities via standard HTTP.
 * 
 * Task states: submitted → working → completed | failed | canceled
 * 
 * Spec: https://google.github.io/A2A/
 */

import { handleTool } from './tools/index.js'

// ─── Types ───────────────────────────────────────────────

export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'

export interface TaskMessage {
  role: 'user' | 'agent'
  parts: { type: 'text'; text: string }[]
}

export interface Task {
  id: string
  state: TaskState
  messages: TaskMessage[]
  artifacts: { type: 'text'; text: string }[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

// ─── In-Memory Store ─────────────────────────────────────

const tasks = new Map<string, Task>()
const MAX_TASKS = 200
const TASK_TTL_MS = 60 * 60 * 1000 // 1 hour

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function cleanupExpiredTasks() {
  const now = Date.now()
  for (const [id, task] of tasks) {
    if (now - new Date(task.createdAt).getTime() > TASK_TTL_MS) {
      tasks.delete(id)
    }
  }
  // Also enforce max count
  if (tasks.size > MAX_TASKS) {
    const entries = [...tasks.entries()].sort((a, b) =>
      new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime()
    )
    const toDelete = entries.slice(0, entries.length - MAX_TASKS)
    for (const [id] of toDelete) tasks.delete(id)
  }
}

// ─── Skill → Tool Routing ────────────────────────────────

interface ToolMapping {
  tool: string
  extractArgs: (text: string) => Record<string, unknown>
}

/**
 * Maps natural-language task messages to MCP tool calls.
 * This is intentionally simple — the real intelligence comes
 * from the calling agent, which should structure its requests.
 */
function routeToTool(message: string): ToolMapping | null {
  const lower = message.toLowerCase()

  // Swap intents
  if (lower.includes('swap') || lower.includes('trade') || lower.includes('buy') || lower.includes('sell')) {
    return {
      tool: 'smart_swap',
      extractArgs: (text) => {
        // Try to extract token name from the message
        const query = text.replace(/swap|trade|buy|sell|for|on|the|best|pool/gi, '').trim()
        return { action: 'find_best', query: query || 'ETH' }
      },
    }
  }

  // Bridge intents
  if (lower.includes('bridge') || lower.includes('transfer') && lower.includes('chain')) {
    return {
      tool: 'tempo_bridge',
      extractArgs: () => ({ action: 'quote', token: 'USDC.e', amount: 100, toChain: 'ethereum' }),
    }
  }

  // Price intents
  if (lower.includes('price') || lower.includes('how much') || lower.includes('what is')) {
    return {
      tool: 'market_data',
      extractArgs: (text) => {
        const tokens = text.match(/\b(BTC|ETH|SOL|USDC|USDT|ARB|OP|MATIC|AVAX|PEPE|DOGE|SHIB)\b/i)
        return { action: 'price', token: tokens?.[1] || 'ETH' }
      },
    }
  }

  // Yield / staking intents
  if (lower.includes('yield') || lower.includes('stake') || lower.includes('apy')) {
    return {
      tool: 'yield',
      extractArgs: () => ({ action: 'scan' }),
    }
  }

  // Position / portfolio intents
  if (lower.includes('position') || lower.includes('portfolio') || lower.includes('balance')) {
    return {
      tool: 'analytics',
      extractArgs: () => ({ action: 'portfolio' }),
    }
  }

  // Lending intents
  if (lower.includes('lend') || lower.includes('supply') || lower.includes('borrow') || lower.includes('aave')) {
    return {
      tool: 'aave',
      extractArgs: () => ({ action: 'positions' }),
    }
  }

  // Perps / Hyperliquid intents
  if (lower.includes('perp') || lower.includes('futures') || lower.includes('hyperliquid') || lower.includes('long') || lower.includes('short')) {
    return {
      tool: 'hyperliquid',
      extractArgs: () => ({ action: 'positions' }),
    }
  }

  // Whale activity
  if (lower.includes('whale')) {
    return {
      tool: 'analytics',
      extractArgs: (text) => {
        const tokens = text.match(/\b(BTC|ETH|SOL|USDC|USDT|PEPE|DOGE)\b/i)
        return { action: 'whale_activity', token: tokens?.[1] || 'ETH' }
      },
    }
  }

  return null
}

// ─── Task Lifecycle ──────────────────────────────────────

/**
 * Submit a new A2A task. The task is executed immediately (synchronous model).
 * For long-running tasks, the caller can poll via getTask().
 */
export async function submitTask(
  message: string,
  metadata?: Record<string, unknown>,
): Promise<Task> {
  cleanupExpiredTasks()

  const taskId = generateTaskId()
  const now = new Date().toISOString()

  const task: Task = {
    id: taskId,
    state: 'submitted',
    messages: [{ role: 'user', parts: [{ type: 'text', text: message }] }],
    artifacts: [],
    metadata: metadata || {},
    createdAt: now,
    updatedAt: now,
  }

  tasks.set(taskId, task)

  // Transition to working
  task.state = 'working'
  task.updatedAt = new Date().toISOString()

  try {
    const mapping = routeToTool(message)

    if (!mapping) {
      // No specific tool matched — return a helpful response
      task.state = 'completed'
      task.messages.push({
        role: 'agent',
        parts: [{
          type: 'text',
          text: `I couldn't determine a specific action from your request. Here's what I can do:\n\n` +
            `• **Swap tokens** — "swap 100 USDC for ETH"\n` +
            `• **Bridge cross-chain** — "bridge 500 USDC to Arbitrum"\n` +
            `• **Check prices** — "what's the price of BTC?"\n` +
            `• **Scan yields** — "find best yield opportunities"\n` +
            `• **Check positions** — "show my portfolio"\n` +
            `• **Lending** — "check my Aave positions"\n` +
            `• **Perps** — "show my Hyperliquid positions"\n` +
            `• **Whale tracking** — "show whale activity for ETH"\n\n` +
            `Try rephrasing your request with one of these patterns.`,
        }],
      })
      task.updatedAt = new Date().toISOString()
      return task
    }

    // Execute the mapped tool
    const args = mapping.extractArgs(message)
    const result = await handleTool(mapping.tool, args)

    task.state = result.isError ? 'failed' : 'completed'
    const resultText = result.content.map((c) => c.text).join('\n')

    task.messages.push({
      role: 'agent',
      parts: [{ type: 'text', text: resultText }],
    })
    task.artifacts.push({ type: 'text', text: resultText })
  } catch (e) {
    task.state = 'failed'
    task.messages.push({
      role: 'agent',
      parts: [{ type: 'text', text: `Task failed: ${e instanceof Error ? e.message : String(e)}` }],
    })
  }

  task.updatedAt = new Date().toISOString()
  return task
}

/** Retrieve a task by ID. */
export function getTask(id: string): Task | null {
  return tasks.get(id) || null
}

/** Cancel a task. Only works for submitted/working tasks. */
export function cancelTask(id: string): Task | null {
  const task = tasks.get(id)
  if (!task) return null
  if (task.state === 'submitted' || task.state === 'working') {
    task.state = 'canceled'
    task.updatedAt = new Date().toISOString()
  }
  return task
}

/** List recent tasks. */
export function listTasks(limit = 50): Task[] {
  return [...tasks.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
}

/** Get task stats. */
export function getTaskStats() {
  const allTasks = [...tasks.values()]
  return {
    total: allTasks.length,
    byState: {
      submitted: allTasks.filter((t) => t.state === 'submitted').length,
      working: allTasks.filter((t) => t.state === 'working').length,
      completed: allTasks.filter((t) => t.state === 'completed').length,
      failed: allTasks.filter((t) => t.state === 'failed').length,
      canceled: allTasks.filter((t) => t.state === 'canceled').length,
    },
  }
}
