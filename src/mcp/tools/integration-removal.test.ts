import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_CHAINS, getPublicClient } from '../chains.js'
import bridgesModule from './bridges.js'
import advancedModule from './advanced.js'
import dexIntelModule from './smart-swap.js'
import walletModule from './wallet.js'
import swapsModule from './swaps.js'
import marketDataModule from './market-data.js'
import { assertSupportedRoute, hasRemovedIntegration } from './integration-policy.js'

const testDirectory = mkdtempSync(join(tmpdir(), 'agnt-integration-removal-'))
const paymentPath = join(testDirectory, 'payments.enc')
const previousPaymentsPath = process.env.AGNT_PAYMENTS_PATH
const previousPassphrase = process.env.AGNT_PASSPHRASE
process.env.AGNT_PASSPHRASE = 'integration-removal-test-only-passphrase'
process.env.AGNT_PAYMENTS_PATH = paymentPath
const { getAllTools, handleTool } = await import('./index.js')
if (previousPaymentsPath === undefined) delete process.env.AGNT_PAYMENTS_PATH
else process.env.AGNT_PAYMENTS_PATH = previousPaymentsPath
after(() => {
  if (existsSync(paymentPath)) unlinkSync(paymentPath)
  rmdirSync(testDirectory)
  if (previousPassphrase === undefined) delete process.env.AGNT_PASSPHRASE
  else process.env.AGNT_PASSPHRASE = previousPassphrase
})

const removedChains = ['tempo', 'arc', 'hyperliquid', 'hyperevm', 'solana']
const removedTools = ['tempo_swap', 'tempo_bridge', 'tempo_tokens', 'arc', 'dune', 'debridge', 'polymarket', 'hyperliquid', 'eigenlayer', 'stargate', 'automations', 'dex_intel', 'defillama', 'billing']

test('removed agent tools cannot be dispatched and DAO/automation actions are unavailable', async () => {
  for (const name of ['automations', 'dex_intel', 'defillama', 'billing']) {
    const result = await handleTool(name, { action: 'list' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /Unknown tool/)
  }
  for (const action of ['dao_vote', 'copy_trade']) {
    const result = await advancedModule.handle('advanced', { action })
    assert.equal(result?.isError, true)
    assert.match(result!.content[0].text, /Unknown advanced action/)
  }
  assert.equal(getAllTools().length, 22)
  assert.doesNotMatch(JSON.stringify(getAllTools()), /dao_vote|copy_trade|create_alert|create_event|crypto_quote|crypto_confirm/)
})

test('removed chains have no client or registry entry', () => {
  for (const chain of removedChains) {
    assert.equal(SUPPORTED_CHAINS[chain], undefined)
    assert.throws(() => getPublicClient(chain), /Unknown chain/)
  }
})

test('removed tools are absent while generic wallet operations remain', () => {
  const tools = getAllTools()
  for (const name of removedTools) assert.equal(tools.some(tool => tool.name === name), false)
  for (const name of ['wallet', 'payment', 'wallet_send', 'relay', 'jumper', 'aave', 'lido']) {
    assert.equal(tools.some(tool => tool.name === name), true)
  }
  assert.equal(hasRemovedIntegration(tools), false)
  const wallet = tools.find(tool => tool.name === 'wallet')!
  assert.match(JSON.stringify(wallet.inputSchema.properties.chain), /Default: base/)
})

test('removed source and destination chains are rejected before bridge wallet access', async () => {
  for (const name of ['relay', 'jumper']) {
    for (const chain of removedChains) {
      for (const args of [{ fromChain: chain, toChain: 'base' }, { fromChain: 'base', toChain: chain }]) {
        const result = await bridgesModule.handle(name, { ...args, action: 'quote' })
        assert.equal(result?.isError, true)
        assert.match(result!.content[0].text, /Unknown chain/)
      }
    }
  }
})

test('removed route providers and nested chain IDs are rejected before execution', () => {
  for (const provider of ['stargateV2', 'deBridge', 'dln']) {
    assert.throws(() => assertSupportedRoute({ tool: 'lifi', includedSteps: [{ tool: provider }] }), /unsupported integration/)
  }
  for (const chainId of [4217, 5042002, 999, 1337, 1151111081099710]) {
    assert.throws(() => assertSupportedRoute({ action: { toToken: { chainId } } }), /unsupported chain/)
  }
  assert.doesNotThrow(() => assertSupportedRoute({ tool: 'relay', action: { fromToken: { chainId: 8453 }, toToken: { chainId: 42161 } } }))
})

test('wallet aliases reject removed chains and payment status defaults to Base', async () => {
  for (const chain of removedChains) {
    await assert.rejects(() => walletModule.handle('wallet', { action: 'send', chain }), /Unknown chain/)
    await assert.rejects(() => walletModule.handle('payment', { action: 'status', chain }), /Unknown chain/)
  }
  await assert.rejects(() => walletModule.handle('payment', { action: 'status', hash: 'invalid' }), /valid transaction hash/)
})

test('smart swap rejects removed preferred chains instead of falling back to another chain', async () => {
  for (const chain of removedChains) {
    const result = await dexIntelModule.handle('smart_swap', { action: 'find_and_swap', query: 'ETH', chain })
    assert.equal(result?.isError, true)
  }
})

test('DEX pool previews reject removed chains', async () => {
  for (const chain of removedChains) {
    const result = await swapsModule.handle('uniswap', { action: 'pools', chain })
    assert.equal(result?.isError, true)
  }
})

test('market data rejects native and wrapped token aliases for the removed non-EVM chain', async () => {
  for (const token of ['SOL', 'WSOL', 'solana', 'wrapped-solana']) {
    const result = await marketDataModule.handle('market_data', { action: 'price', token })
    assert.equal(result?.isError, true)
  }
})

test('generic wallet send and ETH staking remain behind the live execution gate', async () => {
  const keys = ['NODE_ENV', 'AGNT_PASSPHRASE', 'AGNT_LIVE_EXECUTION_ENABLED', 'AGNT_MPP_ENABLED', 'AGNT_ACTIVITY_LOG_PATH'] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const activityPath = join(testDirectory, 'activity.enc')
  process.env.NODE_ENV = 'production'
  process.env.AGNT_PASSPHRASE = 'integration-removal-test-only-passphrase'
  process.env.AGNT_ACTIVITY_LOG_PATH = activityPath
  process.env.AGNT_LIVE_EXECUTION_ENABLED = 'false'
  delete process.env.AGNT_MPP_ENABLED
  try {
    for (const [name, action] of [['wallet', 'send'], ['payment', 'send'], ['wallet_send', 'send'], ['yield', 'stake_eth']]) {
      const result = await handleTool(name, { action })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /Live transaction execution is disabled/)
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    if (existsSync(activityPath)) unlinkSync(activityPath)
  }
})
