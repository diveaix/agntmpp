/**
 * ./AGNT Protocol — Transaction Executor
 *
 * Shared helpers for signing & sending on-chain transactions via viem.
 * Used by all DeFi tools (Aave, Uniswap, Lido, etc.) for real execution.
 */

import { encodeFunctionData, parseUnits, formatUnits, type Abi, type Address } from 'viem'
import { getOrCreateWallet, getAccount, type WalletEntry } from './wallet.js'
import { getPublicClient, getWalletClient, explorerTxUrl } from './chains.js'
import { checkSpend, recordSpend } from './spending-guard.js'

// ─── ERC-20 ABI (approve + balanceOf + allowance) ────────

export const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const

// ─── Core Send ───────────────────────────────────────────

export interface TxResult {
  hash: string
  explorer: string
  chain: string
  from: string
  to: string
  gasUsed?: string
}

/** Send a raw transaction (ETH transfer, contract call, etc.) */
export async function sendTx(
  chain: string,
  to: Address,
  data: `0x${string}`,
  value?: bigint,
  opts?: { amountUsd?: number; action?: string },
): Promise<TxResult> {
  const w = getOrCreateWallet()

  // ── Spending guard ──
  if (opts?.amountUsd && opts.amountUsd > 0) {
    const check = checkSpend(w.address, opts.amountUsd)
    if (!check.allowed) throw new Error(`🛑 Spending limit exceeded: ${check.reason}`)
  }

  const wallet = getWalletClient(chain, w)
  const pub = getPublicClient(chain)

  const hash = await wallet.sendTransaction({
    to,
    data,
    value: value || 0n,
    chain: wallet.chain,
    account: getAccount(w),
  })

  // Wait for confirmation
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })

  // ── Record spend after success ──
  if (opts?.amountUsd && opts.amountUsd > 0) {
    recordSpend(w.address, opts.amountUsd, opts.action || 'tx')
  }

  return {
    hash,
    explorer: explorerTxUrl(chain, hash),
    chain,
    from: w.address,
    to,
    gasUsed: receipt.gasUsed?.toString(),
  }
}

/** Encode + send a contract call. */
export async function callContract(
  chain: string,
  contract: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: unknown[] = [],
  value?: bigint,
  opts?: { amountUsd?: number; action?: string },
): Promise<TxResult> {
  const data = encodeFunctionData({ abi: abi as Abi, functionName, args })
  return sendTx(chain, contract, data, value, opts)
}

// ─── ERC-20 Helpers ──────────────────────────────────────

/** Check ERC-20 balance. Returns human-readable amount. */
export async function getBalance(chain: string, token: Address, decimals: number): Promise<number> {
  const w = getOrCreateWallet()
  const pub = getPublicClient(chain)
  const raw = await pub.readContract({
    address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [w.address],
  }) as bigint
  return parseFloat(formatUnits(raw, decimals))
}

/** Check ETH/native balance. */
export async function getNativeBalance(chain: string): Promise<number> {
  const w = getOrCreateWallet()
  const pub = getPublicClient(chain)
  const raw = await pub.getBalance({ address: w.address })
  return parseFloat(formatUnits(raw, 18))
}

/** Ensure ERC-20 approval. Auto-approves if needed. */
export async function ensureApproval(
  chain: string,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<string | null> {
  const w = getOrCreateWallet()
  const pub = getPublicClient(chain)

  const allowance = await pub.readContract({
    address: token, abi: ERC20_ABI, functionName: 'allowance', args: [w.address, spender],
  }) as bigint

  if (allowance >= amount) return null // already approved

  const maxApproval = 2n ** 256n - 1n
  const tx = await callContract(chain, token, ERC20_ABI, 'approve', [spender, maxApproval])
  return tx.hash
}

/** Format a TxResult into a human-readable string. */
export function formatTxResult(tx: TxResult, label: string): string {
  return (
    `✅ ${label}\n\n` +
    `Hash: ${tx.hash}\n` +
    `Explorer: ${tx.explorer}\n` +
    `Chain: ${tx.chain} | Gas: ${tx.gasUsed || 'pending'}`
  )
}
