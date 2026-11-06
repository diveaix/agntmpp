import { closeSync, existsSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { dirname } from 'path'

export function writePrivateFileAtomicSync(path: string, data: string): void {
  const directory = dirname(path)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, data, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
}

export function handleStoreReadFailure(storeName: string, error: unknown): void {
  if (process.env.NODE_ENV === 'production') {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${storeName} could not be read or decrypted; refusing to continue in production. ${detail}`)
  }
}
