/**
 * ./AGNT Protocol — Multi-Wallet Management (Encrypted)
 * AES-256-GCM encrypted storage with named wallets.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { encrypt, decrypt, getPassphrase } from './crypto.js'

export interface WalletEntry {
  name: string
  address: `0x${string}`
  privateKey: `0x${string}`
  createdAt: string
}

export interface WalletStore {
  wallets: WalletEntry[]
  activeIndex: number
}

function resolvePath(custom?: string): string {
  const p = custom || process.env.AGNT_WALLET_PATH || '.agnt/wallets.enc'
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function loadStore(custom?: string): WalletStore {
  const fp = resolvePath(custom)
  if (!existsSync(fp)) return { wallets: [], activeIndex: 0 }
  try {
    const raw = readFileSync(fp, 'utf-8')
    // Check if file is encrypted (contains colons from hex encoding) or plaintext JSON
    if (raw.trim().startsWith('{')) {
      // Legacy unencrypted — migrate on next save
      return JSON.parse(raw) as WalletStore
    }
    const json = decrypt(raw, getPassphrase())
    return JSON.parse(json) as WalletStore
  } catch {
    return { wallets: [], activeIndex: 0 }
  }
}

function saveStore(store: WalletStore, custom?: string) {
  const fp = resolvePath(custom)
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(store, null, 2)
  const encrypted = encrypt(json, getPassphrase())
  writeFileSync(fp, encrypted, 'utf-8')
}

/** Create a new named wallet. */
export function createWallet(name?: string, custom?: string): WalletEntry {
  const store = loadStore(custom)
  const pk = generatePrivateKey()
  const acct = privateKeyToAccount(pk)
  const entry: WalletEntry = {
    name: name || `Wallet ${store.wallets.length + 1}`,
    address: acct.address,
    privateKey: pk,
    createdAt: new Date().toISOString(),
  }
  store.wallets.push(entry)
  store.activeIndex = store.wallets.length - 1
  saveStore(store, custom)
  return entry
}

/** Get active wallet or null. */
export function getActiveWallet(custom?: string): WalletEntry | null {
  const store = loadStore(custom)
  return store.wallets[store.activeIndex] || null
}

/** Get or create active wallet. */
export function getOrCreateWallet(name?: string, custom?: string): WalletEntry {
  return getActiveWallet(custom) || createWallet(name, custom)
}

/** List all wallets. */
export function listWallets(custom?: string): { wallets: WalletEntry[]; activeIndex: number } {
  const store = loadStore(custom)
  return { wallets: store.wallets, activeIndex: store.activeIndex }
}

/** Switch active wallet by name or index. */
export function switchWallet(nameOrIndex: string | number, custom?: string): WalletEntry | null {
  const store = loadStore(custom)
  let idx: number
  if (typeof nameOrIndex === 'number') {
    idx = nameOrIndex
  } else {
    idx = store.wallets.findIndex((w) => w.name.toLowerCase() === nameOrIndex.toLowerCase())
  }
  if (idx < 0 || idx >= store.wallets.length) return null
  store.activeIndex = idx
  saveStore(store, custom)
  return store.wallets[idx]
}

/** Rename a wallet. */
export function renameWallet(oldName: string, newName: string, custom?: string): WalletEntry | null {
  const store = loadStore(custom)
  const w = store.wallets.find((w) => w.name.toLowerCase() === oldName.toLowerCase())
  if (!w) return null
  w.name = newName
  saveStore(store, custom)
  return w
}

/** Delete a wallet by name. Returns the deleted entry or null if not found. */
export function deleteWallet(name: string, custom?: string): WalletEntry | null {
  const store = loadStore(custom)
  const idx = store.wallets.findIndex((w) => w.name.toLowerCase() === name.toLowerCase())
  if (idx < 0) return null
  const [deleted] = store.wallets.splice(idx, 1)
  // Adjust activeIndex if needed
  if (store.wallets.length === 0) {
    store.activeIndex = 0
  } else if (store.activeIndex >= store.wallets.length) {
    store.activeIndex = store.wallets.length - 1
  }
  saveStore(store, custom)
  return deleted
}

/** Get viem Account from a wallet entry. */
export function getAccount(w: WalletEntry) {
  return privateKeyToAccount(w.privateKey)
}
