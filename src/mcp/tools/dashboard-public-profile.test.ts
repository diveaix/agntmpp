import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { publicDashboardUser } from '../dashboard-auth.js'

test('public dashboard profile allowlists fields and never returns stored authentication secrets',()=>{
  const record={id:'alice',email:'alice@example.test',walletAddress:'test-wallet',status:'active' as const,createdAt:'2026-09-20',updatedAt:'2026-09-20',passwordSalt:'private-salt',passwordHash:'private-hash',futureSecret:'private-future'}
  assert.deepEqual(publicDashboardUser(record),{id:'alice',email:'alice@example.test',walletAddress:'test-wallet',status:'active',createdAt:'2026-09-20',updatedAt:'2026-09-20'})
  assert.ok(!JSON.stringify(publicDashboardUser(record)).includes('private-'))
  assert.equal(record.passwordHash,'private-hash','Projection must not alter the authentication store')
})

test('hosted profile response sites use the public projection and safe API-key listing',async()=>{
  // Wiring guard supplements the projection behavior test; it is not a live
  // authentication E2E test. Raw objects at these response sites leaked fields.
  const source=await readFile(new URL('../serve.ts',import.meta.url),'utf8')
  assert.equal((source.match(/user: publicDashboardUser\(result\.user\)/g)??[]).length,4)
  assert.match(source,/user: publicDashboardUser\(dashboard\.user\)/)
  assert.match(source,/user: publicDashboardUser\(user\)/)
  const accessMe=source.slice(source.indexOf("app.get('/access/me'"),source.indexOf("app.post('/access/api-keys'"))
  assert.match(accessMe,/listApiKeysForUser\(auth\.userId\)/)
  assert.ok(!accessMe.includes('store.apiKeys'))
  assert.match(source,/app\.use\(\['\/auth','\/dashboard','\/access'\],[\s\S]*?res\.setHeader\('Cache-Control','no-store'\)/)
})
