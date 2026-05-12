import { AsyncLocalStorage } from 'async_hooks'
import type { AuthContext } from './access-types.js'

export interface ToolExecutionContext {
  auth?: AuthContext
  walletScope?: string
}

const toolContext = new AsyncLocalStorage<ToolExecutionContext>()

export async function runWithToolContext<T>(context: ToolExecutionContext, fn: () => Promise<T>): Promise<T> {
  return toolContext.run(context, fn)
}

export function getCurrentToolContext(): ToolExecutionContext | undefined {
  return toolContext.getStore()
}

export function getCurrentWalletScope(): string | undefined {
  return toolContext.getStore()?.walletScope
}
