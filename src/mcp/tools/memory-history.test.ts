import test from 'node:test'
import assert from 'node:assert/strict'

function testPath(name: string): string {
  return `./.agnt/test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.enc`
}

test('memory history is scoped to the active wallet by default', async () => {
  process.env.AGNT_MEMORY_PATH = testPath('memory-history')
  process.env.AGNT_WALLET_PATH = testPath('memory-history-wallets')

  const { createWallet } = await import('../wallet.js')
  const { autoRemember } = await import('../memory.js')
  const memoryTool = (await import('./memory.js')).default

  const walletOne = createWallet('wallet one')
  autoRemember('tempo_swap', {
    action: 'swap',
    amount: 1,
    tokenIn: 'USDC.e',
    tokenOut: 'pathUSD',
  }, 'Swapped from wallet one', {
    walletName: walletOne.name,
    walletAddress: walletOne.address,
  })

  const walletTwo = createWallet('wallet two')
  autoRemember('tempo_swap', {
    action: 'swap',
    amount: 2,
    tokenIn: 'USDC.e',
    tokenOut: 'pathUSD',
  }, 'Swapped from wallet two', {
    walletName: walletTwo.name,
    walletAddress: walletTwo.address,
  })

  const scoped = await memoryTool.handle('memory', { action: 'history' })
  const scopedText = scoped?.content[0]?.text || ''
  assert.match(scopedText, /wallet two/)
  assert.match(scopedText, /Swapped from wallet two/)
  assert.doesNotMatch(scopedText, /Swapped from wallet one/)

  const all = await memoryTool.handle('memory', { action: 'history', scope: 'all' })
  const allText = all?.content[0]?.text || ''
  assert.match(allText, /Swapped from wallet one/)
  assert.match(allText, /Swapped from wallet two/)
})
