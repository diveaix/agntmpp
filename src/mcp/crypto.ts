/**
 * ./AGENT Protocol — Wallet Encryption
 * AES-256-GCM encryption for wallet private keys at rest.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { hostname, userInfo } from 'os'

const ALGO = 'aes-256-gcm'
const SALT_LEN = 32
const IV_LEN = 16
const TAG_LEN = 16
const KEY_LEN = 32

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN)
}

/** Encrypt a string. Returns a hex-encoded "salt:iv:tag:ciphertext" string. */
export function encrypt(plaintext: string, passphrase: string): string {
  const salt = randomBytes(SALT_LEN)
  const key = deriveKey(passphrase, salt)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [salt.toString('hex'), iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':')
}

/** Decrypt a "salt:iv:tag:ciphertext" hex string. */
export function decrypt(encoded: string, passphrase: string): string {
  const [saltHex, ivHex, tagHex, encHex] = encoded.split(':')
  const salt = Buffer.from(saltHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const enc = Buffer.from(encHex, 'hex')
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8')
}

/** Get the encryption passphrase from env or generate a machine-specific one. */
export function getPassphrase(): string {
  if (process.env.AGNT_PASSPHRASE) {
    if (process.env.NODE_ENV === 'production' && process.env.AGNT_PASSPHRASE.length < 32) {
      throw new Error('AGNT_PASSPHRASE must be at least 32 characters in production.')
    }
    return process.env.AGNT_PASSPHRASE
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AGNT_PASSPHRASE is required in production; machine-derived encryption keys are not allowed.')
  }
  return `agnt:${hostname()}:${userInfo().username}`
}
