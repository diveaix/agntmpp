import test from 'node:test'
import assert from 'node:assert/strict'
import { createWallet, exportWalletBackup, importWalletBackup, listWallets, recoverLegacyWallet } from '../wallet.js'
import { runWithToolContext } from '../tool-context.js'
import { hasWalletExportPassword, setWalletExportPassword, verifyWalletExportPassword } from '../wallet-vault.js'

function testPath(name: string): string {
  return `./.agnt/test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.enc`
}

async function withWalletPath<T>(fn: () => Promise<T>): Promise<T> {
  const previousWalletPath = process.env.AGNT_WALLET_PATH
  const previousWalletDir = process.env.AGNT_WALLET_DIR
  const previousVaultPath = process.env.AGNT_WALLET_VAULT_PATH
  const previousVaultDir = process.env.AGNT_WALLET_VAULT_DIR
  process.env.AGNT_WALLET_PATH = testPath('scoped-wallet-root')
  process.env.AGNT_WALLET_DIR = `./.agnt/test-wallet-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`
  process.env.AGNT_WALLET_VAULT_PATH = testPath('scoped-wallet-vault-root')
  process.env.AGNT_WALLET_VAULT_DIR = `./.agnt/test-wallet-vault-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    return await fn()
  } finally {
    if (previousWalletPath === undefined) delete process.env.AGNT_WALLET_PATH
    else process.env.AGNT_WALLET_PATH = previousWalletPath
    if (previousWalletDir === undefined) delete process.env.AGNT_WALLET_DIR
    else process.env.AGNT_WALLET_DIR = previousWalletDir
    if (previousVaultPath === undefined) delete process.env.AGNT_WALLET_VAULT_PATH
    else process.env.AGNT_WALLET_VAULT_PATH = previousVaultPath
    if (previousVaultDir === undefined) delete process.env.AGNT_WALLET_VAULT_DIR
    else process.env.AGNT_WALLET_VAULT_DIR = previousVaultDir
  }
}

test('wallet storage is isolated by MCP wallet scope', async () => {
  await withWalletPath(async () => {
    const sessionA = await runWithToolContext({ walletScope: 'mcp-session:a' }, async () => {
      const wallet = createWallet('A')
      return { wallet, list: listWallets() }
    })

    const sessionB = await runWithToolContext({ walletScope: 'mcp-session:b' }, async () => {
      const wallet = createWallet('B')
      return { wallet, list: listWallets() }
    })

    assert.equal(sessionA.list.wallets.length, 1)
    assert.equal(sessionB.list.wallets.length, 1)
    assert.equal(sessionA.list.wallets[0].name, 'A')
    assert.equal(sessionB.list.wallets[0].name, 'B')
    assert.notEqual(sessionA.wallet.address, sessionB.wallet.address)

    const sessionAAgain = await runWithToolContext({ walletScope: 'mcp-session:a' }, async () => listWallets())
    assert.equal(sessionAAgain.wallets.length, 1)
    assert.equal(sessionAAgain.wallets[0].address, sessionA.wallet.address)
  })
})

test('wallet export passwords are isolated by wallet scope', async () => {
  await withWalletPath(async () => {
    await runWithToolContext({ walletScope: 'user:one' }, async () => {
      setWalletExportPassword('correct horse battery staple')
      assert.equal(hasWalletExportPassword(), true)
      assert.equal(verifyWalletExportPassword('correct horse battery staple'), true)
    })

    await runWithToolContext({ walletScope: 'user:two' }, async () => {
      assert.equal(hasWalletExportPassword(), false)
      assert.equal(verifyWalletExportPassword('correct horse battery staple'), false)
    })
  })
})

test('authenticated wallet scope is stable across API-key sessions', async () => {
  await withWalletPath(async () => {
    const auth = {
      userId: 'user_123',
      apiKeyId: 'key_a',
      plan: 'free',
      subscriptionStatus: 'active',
      source: 'api_key',
      entitlement: {
        plan: 'free',
        dataAutomationSlots: 0,
        customSourceSlots: 0,
        autoExecuteAllowed: false,
        priorityQueue: false,
        eventEvaluationsMonthly: 0,
        executionsMonthly: 0,
      },
    } as const

    const created = await runWithToolContext({ auth, walletScope: `user:${auth.userId}` }, async () => createWallet('User Wallet'))
    const seenLater = await runWithToolContext({ auth, walletScope: `user:${auth.userId}` }, async () => listWallets())

    assert.equal(seenLater.wallets.length, 1)
    assert.equal(seenLater.wallets[0].address, created.address)
  })
})

test('legacy global wallet can be recovered into scoped wallet storage', async () => {
  await withWalletPath(async () => {
    const legacy = createWallet('claude2')
    const scopedBefore = await runWithToolContext({ walletScope: 'mcp-session:recover' }, async () => listWallets())
    assert.equal(scopedBefore.wallets.length, 0)

    const recovered = await runWithToolContext({ walletScope: 'mcp-session:recover' }, async () => recoverLegacyWallet('claude2'))
    assert.ok(recovered)
    assert.equal(recovered.wallet.address, legacy.address)
    assert.equal(recovered.alreadyPresent, false)

    const scopedAfter = await runWithToolContext({ walletScope: 'mcp-session:recover' }, async () => listWallets())
    assert.equal(scopedAfter.wallets.length, 1)
    assert.equal(scopedAfter.wallets[0].address, legacy.address)
  })
})

test('encrypted wallet backups import only into the current wallet scope', async () => {
  await withWalletPath(async () => {
    const backup = await runWithToolContext({ walletScope: 'user:backup-source' }, async () => {
      const wallet = createWallet('Backup Wallet')
      const exported = exportWalletBackup('correct horse battery staple')
      return { wallet, exported }
    })

    assert.equal(backup.exported.walletCount, 1)
    assert.doesNotMatch(backup.exported.backup, /Backup Wallet/)
    assert.doesNotMatch(backup.exported.backup, /0x[a-fA-F0-9]{64}/)

    await runWithToolContext({ walletScope: 'user:backup-target' }, async () => {
      const imported = importWalletBackup(backup.exported.backup, 'correct horse battery staple')
      assert.equal(imported.imported, 1)
      assert.equal(imported.skipped, 0)
      assert.equal(imported.activeWallet?.address, backup.wallet.address)
      assert.equal(listWallets().wallets.length, 1)
    })

    await runWithToolContext({ walletScope: 'user:backup-source' }, async () => {
      assert.equal(listWallets().wallets.length, 1)
    })
  })
})
