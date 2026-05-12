/**
 * ./AGNT Protocol — Multi-Wallet Management (Encrypted)
 * AES-256-GCM encrypted storage with named wallets.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { encrypt, decrypt, getPassphrase } from './crypto.js'
import { getCurrentWalletScope } from './tool-context.js'

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

function resolveGlobalPath(custom?: string): string {
  const p = custom || process.env.AGNT_WALLET_PATH || '.agnt/wallets.enc'
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function resolvePath(custom?: string): string {
  if (!custom) {
    const scope = getCurrentWalletScope()
    if (scope) {
      const safeScope = createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 32)
      const baseDir = process.env.AGNT_WALLET_DIR
        ? (isAbsolute(process.env.AGNT_WALLET_DIR) ? process.env.AGNT_WALLET_DIR : resolve(process.cwd(), process.env.AGNT_WALLET_DIR))
        : resolve(dirname(resolveGlobalPath(process.env.AGNT_WALLET_PATH)), 'wallets')
      return resolve(baseDir, `${safeScope}.enc`)
    }
  }
  return resolveGlobalPath(custom)
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

/** Get the active wallet.
 * Transaction tools must never create wallets implicitly, because that can
 * route execution/gas through a fresh unfunded server wallet instead of the
 * user's selected wallet. Wallet creation must be an explicit user action.
 */
export function getOrCreateWallet(name?: string, custom?: string): WalletEntry {
  const wallet = getActiveWallet(custom)
  if (!wallet) {
    throw new Error('No active AGNT wallet is selected. Create or switch to a user wallet before executing transactions.')
  }
  return wallet
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

/** Copy a wallet from the old unscoped/global vault into the current scoped vault. */
export function recoverLegacyWallet(nameOrAddress: string, legacyPath?: string): { wallet: WalletEntry; alreadyPresent: boolean } | null {
  const legacy = loadStore(resolveGlobalPath(legacyPath))
  const needle = nameOrAddress.toLowerCase()
  const source = legacy.wallets.find((w) => w.name.toLowerCase() === needle || w.address.toLowerCase() === needle)
  if (!source) return null

  const target = loadStore()
  const existingIndex = target.wallets.findIndex((w) => w.address.toLowerCase() === source.address.toLowerCase())
  if (existingIndex >= 0) {
    target.activeIndex = existingIndex
    saveStore(target)
    return { wallet: target.wallets[existingIndex], alreadyPresent: true }
  }

  const copy = { ...source }
  target.wallets.push(copy)
  target.activeIndex = target.wallets.length - 1
  saveStore(target)
  return { wallet: copy, alreadyPresent: false }
}

/** Get viem Account from a wallet entry. */
export function getAccount(w: WalletEntry) {
  return privateKeyToAccount(w.privateKey)
}
