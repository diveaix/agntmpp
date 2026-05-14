export interface TxErrorContext {
  tool?: string
  action?: string
  chain?: string
  wallet?: string
}

function redactSecrets(message: string): string {
  return message
    .replace(/0x[a-fA-F0-9]{64}/g, '0x[redacted-private-key-or-hash]')
    .replace(/agnt_live_[A-Za-z0-9_-]+/g, 'agnt_live_[redacted]')
}

export function classifyTxError(error: unknown): string {
  const raw = redactSecrets(error instanceof Error ? error.message : String(error))
  const lower = raw.toLowerCase()

  if (lower.includes('no active agnt wallet') || lower.includes('no wallet')) {
    return 'No active wallet is selected for this user. Create or switch to a user wallet before executing transactions.'
  }
  if (lower.includes('insufficient funds') || lower.includes('exceeds the balance') || lower.includes('not enough') || lower.includes('insufficient')) {
    return raw
  }
  if (lower.includes('allowance') || lower.includes('approval') || lower.includes('transfer_from_failed') || lower.includes('transferfrom')) {
    return `Token approval or allowance failed. AGNT uses exact-amount approvals, so try again with the same amount or check that the token balance is available. Details: ${raw}`
  }
  if (lower.includes('execution reverted') || lower.includes('reverted')) {
    return `Transaction reverted before completion. No successful transfer was confirmed. Details: ${raw}`
  }
  if (lower.includes('price impact') || lower.includes('route blocked') || lower.includes('value loss')) {
    return raw
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return `The transaction was submitted or simulated but confirmation timed out. Check the transaction status before retrying. Details: ${raw}`
  }
  if (lower.includes('network') || lower.includes('fetch failed') || lower.includes('rpc')) {
    return `RPC or route API failed. Try again or switch RPC provider for this chain. Details: ${raw}`
  }
  return raw
}

export function formatTxError(error: unknown, context: TxErrorContext = {}): string {
  const parts = [
    classifyTxError(error),
    context.chain ? `Chain: ${context.chain}` : undefined,
    context.wallet ? `Wallet: ${context.wallet}` : undefined,
    context.tool ? `Tool: ${context.tool}${context.action ? `/${context.action}` : ''}` : undefined,
  ].filter(Boolean)
  return parts.join('\n')
}
