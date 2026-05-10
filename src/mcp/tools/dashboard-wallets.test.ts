import test from 'node:test'
import assert from 'node:assert/strict'
import { createWallet } from '../wallet.js'
import {
  canUseLocalWalletExport,
  deleteDashboardWallet,
  getDashboardWallets,
  revealDashboardWalletPrivateKey,
  setDashboardWalletPassword,
} from '../dashboard-wallets.js'

function testPath(name: string): string {
  return `./.agnt/test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.enc`
}

async function withWalletPaths<T>(fn: () => Promise<T>): Promise<T> {
  const previousWalletPath = process.env.AGNT_WALLET_PATH
  const previousVaultPath = process.env.AGNT_WALLET_VAULT_PATH
  const previousAllow = process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT
  process.env.AGNT_WALLET_PATH = testPath('dashboard-wallets-wallets')
  process.env.AGNT_WALLET_VAULT_PATH = testPath('dashboard-wallets-vault')
  delete process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT
  try {
    return await fn()
  } finally {
    if (previousWalletPath === undefined) delete process.env.AGNT_WALLET_PATH
    else process.env.AGNT_WALLET_PATH = previousWalletPath
    if (previousVaultPath === undefined) delete process.env.AGNT_WALLET_VAULT_PATH
    else process.env.AGNT_WALLET_VAULT_PATH = previousVaultPath
    if (previousAllow === undefined) delete process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT
    else process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT = previousAllow
  }
}

test('dashboard wallet summaries never include private keys', async () => {
  await withWalletPaths(async () => {
    const wallet = createWallet('Main')
    process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT = 'true'

    const response = await getDashboardWallets('localhost:3001', { includeBalances: false })
    assert.equal(response.wallets.length, 1)
    assert.equal(response.wallets[0].name, 'Main')
    assert.equal(response.wallets[0].address, wallet.address)
    assert.equal('privateKey' in response.wallets[0], false)
    assert.equal(response.passwordSet, false)
  })
})

test('local private key export requires a configured password', async () => {
  await withWalletPaths(async () => {
    const wallet = createWallet('Main')
    assert.throws(
      () => revealDashboardWalletPrivateKey('localhost:3001', 'Main', 'password123'),
      /Set a wallet export password/,
    )

    setDashboardWalletPassword('localhost:3001', 'password123')
    assert.throws(
      () => revealDashboardWalletPrivateKey('localhost:3001', 'Main', 'wrong-password'),
      /Incorrect wallet export password/,
    )

    const revealed = revealDashboardWalletPrivateKey('localhost:3001', 'Main', 'password123')
    assert.equal(revealed.privateKey, wallet.privateKey)
  })
})

test('hosted dashboard requests cannot reveal wallet private keys', async () => {
  await withWalletPaths(async () => {
    createWallet('Main')
    assert.equal(canUseLocalWalletExport('agnt.example.com'), false)
    assert.throws(
      () => setDashboardWalletPassword('agnt.example.com', 'password123'),
      /only available from the local dashboard/,
    )
    assert.throws(
      () => revealDashboardWalletPrivateKey('agnt.example.com', 'Main', 'password123'),
      /only available from the local dashboard/,
    )
  })
})

test('local wallet deletion requires password and removes the wallet', async () => {
  await withWalletPaths(async () => {
    const wallet = createWallet('Delete Me')
    process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT = 'true'

    assert.throws(
      () => deleteDashboardWallet('localhost:3001', 'Delete Me', 'password123'),
      /Set a wallet export password/,
    )
    setDashboardWalletPassword('localhost:3001', 'password123')
    assert.throws(
      () => deleteDashboardWallet('localhost:3001', 'Delete Me', 'wrong-password'),
      /Incorrect wallet export password/,
    )

    const deleted = deleteDashboardWallet('localhost:3001', wallet.address, 'password123')
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.wallet.address, wallet.address)
    const response = await getDashboardWallets('localhost:3001', { includeBalances: false })
    assert.equal(response.wallets.length, 0)
  })
})

test('hosted dashboard requests cannot delete local wallets', async () => {
  await withWalletPaths(async () => {
    createWallet('Hosted Delete')
    process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT = 'false'
    assert.throws(
      () => deleteDashboardWallet('agnt.example.com', 'Hosted Delete', 'password123'),
      /only available from the local dashboard/,
    )
  })
})
