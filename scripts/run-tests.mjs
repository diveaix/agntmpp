import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve('src/mcp/tools')
const tests = readdirSync(root, { recursive: true })
  .filter((file) => typeof file === 'string' && file.endsWith('.test.ts'))
  .map((file) => join(root, file))
  .sort()

const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--test', ...tests], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
