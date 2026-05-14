import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, resolve } from 'path'
import { decrypt, encrypt, getPassphrase } from './crypto.js'
import { getCurrentWalletScope } from './tool-context.js'

const KEY_LEN = 32

interface WalletVaultStore {
  passwordSalt?: string
  passwordHash?: string
  updatedAt?: string
}

function resolveGlobalPath(custom?: string): string {
  const p = custom || process.env.AGNT_WALLET_VAULT_PATH || '.agnt/wallet-vault.enc'
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function resolvePath(custom?: string): string {
  if (!custom) {
    const scope = getCurrentWalletScope()
    if (scope) {
      const safeScope = createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 32)
      const baseDir = process.env.AGNT_WALLET_VAULT_DIR
        ? (isAbsolute(process.env.AGNT_WALLET_VAULT_DIR) ? process.env.AGNT_WALLET_VAULT_DIR : resolve(process.cwd(), process.env.AGNT_WALLET_VAULT_DIR))
        : resolve(dirname(resolveGlobalPath(process.env.AGNT_WALLET_VAULT_PATH)), 'wallet-vaults')
      return resolve(baseDir, `${safeScope}.enc`)
    }
  }
  return resolveGlobalPath(custom)
}

function loadVault(custom?: string): WalletVaultStore {
  const fp = resolvePath(custom)
  if (!existsSync(fp)) return {}
  try {
    const raw = readFileSync(fp, 'utf-8')
    const json = raw.trim().startsWith('{') ? raw : decrypt(raw, getPassphrase())
    return JSON.parse(json) as WalletVaultStore
  } catch {
    return {}
  }
}

function saveVault(store: WalletVaultStore, custom?: string) {
  const fp = resolvePath(custom)
  const dir = dirname(fp)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(fp, encrypt(JSON.stringify(store, null, 2), getPassphrase()), 'utf-8')
}

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LEN).toString('hex')
}

export function hasWalletExportPassword(custom?: string): boolean {
  const store = loadVault(custom)
  return Boolean(store.passwordSalt && store.passwordHash)
}

export function setWalletExportPassword(password: string, custom?: string): void {
  if (password.trim().length < 8) throw new Error('Wallet export password must be at least 8 characters.')
  const passwordSalt = randomBytes(32).toString('hex')
  saveVault({
    passwordSalt,
    passwordHash: hashPassword(password, passwordSalt),
    updatedAt: new Date().toISOString(),
  }, custom)
}

export function verifyWalletExportPassword(password: string, custom?: string): boolean {
  const store = loadVault(custom)
  if (!store.passwordSalt || !store.passwordHash) return false
  const expected = Buffer.from(store.passwordHash, 'hex')
  const actual = Buffer.from(hashPassword(password, store.passwordSalt), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
