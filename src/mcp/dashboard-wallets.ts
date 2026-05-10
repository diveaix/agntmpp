import { formatUnits, isAddress } from 'viem'
import { TOKENS } from './config.js'
import { getPublicClient, SUPPORTED_CHAINS } from './chains.js'
import { deleteWallet, listWallets, type WalletEntry } from './wallet.js'
import { tip20Abi } from './abis.js'
import { hasWalletExportPassword, setWalletExportPassword, verifyWalletExportPassword } from './wallet-vault.js'

const DEFAULT_BALANCE_CHAINS = ['base', 'arbitrum', 'optimism', 'polygon', 'ethereum'] as const

export interface DashboardWalletBalance {
  chain: string
  chainLabel: string
  symbol: string
  balance: string
  error?: string
}

export interface DashboardWalletSummary {
  name: string
  address: `0x${string}`
  createdAt: string
  active: boolean
  balances: DashboardWalletBalance[]
}

export interface DashboardWalletsResponse {
  wallets: DashboardWalletSummary[]
  activeIndex: number
  exportAvailable: boolean
  passwordSet: boolean
}

function isLocalHost(hostHeader: string | undefined): boolean {
  const host = (hostHeader || '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function canUseLocalWalletExport(hostHeader: string | undefined): boolean {
  return process.env.AGNT_ALLOW_DASHBOARD_WALLET_EXPORT === 'true' || isLocalHost(hostHeader)
}

function sanitizeWallet(wallet: WalletEntry, active: boolean): Omit<DashboardWalletSummary, 'balances'> {
  return {
    name: wallet.name,
    address: wallet.address,
    createdAt: wallet.createdAt,
    active,
  }
}

async function getNativeBalance(chainKey: string, address: `0x${string}`): Promise<DashboardWalletBalance> {
  const chain = SUPPORTED_CHAINS[chainKey]
  try {
    const balance = await getPublicClient(chainKey).getBalance({ address })
    return {
      chain: chainKey,
      chainLabel: chain.label,
      symbol: chainKey === 'polygon' ? 'POL' : 'ETH',
      balance: formatUnits(balance, 18),
    }
  } catch (error) {
    return {
      chain: chainKey,
      chainLabel: chain.label,
      symbol: chainKey === 'polygon' ? 'POL' : 'ETH',
      balance: '0',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function getTempoTokenBalances(address: `0x${string}`): Promise<DashboardWalletBalance[]> {
  const client = getPublicClient('tempo')
  const balances: DashboardWalletBalance[] = []
  for (const token of Object.values(TOKENS)) {
    try {
      const raw = await client.readContract({ address: token.address, abi: tip20Abi, functionName: 'balanceOf', args: [address] }) as bigint
      if (raw > 0n) {
        balances.push({
          chain: 'tempo',
          chainLabel: 'Tempo',
          symbol: token.symbol,
          balance: formatUnits(raw, token.decimals),
        })
      }
    } catch {
      // Token balance failures should not hide the wallet itself.
    }
  }
  return balances
}

async function getBalances(address: `0x${string}`): Promise<DashboardWalletBalance[]> {
  const native = await Promise.all(DEFAULT_BALANCE_CHAINS.map((chain) => getNativeBalance(chain, address)))
  const tempoTokens = await getTempoTokenBalances(address)
  return [...native, ...tempoTokens].filter((entry) => {
    if (entry.error) return true
    const numeric = Number(entry.balance)
    if (!Number.isFinite(numeric) || numeric <= 0) return false
    return numeric < 1_000_000_000
  })
}

export async function getDashboardWallets(hostHeader?: string, options: { includeBalances?: boolean } = {}): Promise<DashboardWalletsResponse> {
  const { wallets, activeIndex } = listWallets()
  const includeBalances = options.includeBalances !== false
  const summaries = await Promise.all(wallets.map(async (wallet, index) => ({
    ...sanitizeWallet(wallet, index === activeIndex),
    balances: includeBalances ? await getBalances(wallet.address) : [],
  })))
  return {
    wallets: summaries,
    activeIndex,
    exportAvailable: canUseLocalWalletExport(hostHeader),
    passwordSet: hasWalletExportPassword(),
  }
}

export function setDashboardWalletPassword(hostHeader: string | undefined, password: string): { passwordSet: true } {
  if (!canUseLocalWalletExport(hostHeader)) throw new Error('Wallet private key export is only available from the local dashboard.')
  setWalletExportPassword(password)
  return { passwordSet: true }
}

export function revealDashboardWalletPrivateKey(hostHeader: string | undefined, walletName: string, password: string): { privateKey: `0x${string}` } {
  if (!canUseLocalWalletExport(hostHeader)) throw new Error('Wallet private key export is only available from the local dashboard.')
  if (!hasWalletExportPassword()) throw new Error('Set a wallet export password before revealing private keys.')
  if (!verifyWalletExportPassword(password)) throw new Error('Incorrect wallet export password.')

  const { wallets } = listWallets()
  const wallet = wallets.find((candidate) => candidate.name === walletName || candidate.address.toLowerCase() === walletName.toLowerCase())
  if (!wallet || !isAddress(wallet.address)) throw new Error('Wallet not found.')
  return { privateKey: wallet.privateKey }
}

export function deleteDashboardWallet(hostHeader: string | undefined, walletName: string, password: string): { deleted: true; wallet: Omit<DashboardWalletSummary, 'balances'> } {
  if (!canUseLocalWalletExport(hostHeader)) throw new Error('Wallet deletion is only available from the local dashboard.')
  if (!hasWalletExportPassword()) throw new Error('Set a wallet export password before deleting wallets.')
  if (!verifyWalletExportPassword(password)) throw new Error('Incorrect wallet export password.')

  const { wallets, activeIndex } = listWallets()
  const index = wallets.findIndex((candidate) => candidate.name === walletName || candidate.address.toLowerCase() === walletName.toLowerCase())
  if (index < 0) throw new Error('Wallet not found.')
  const deleted = deleteWallet(wallets[index].name)
  if (!deleted || !isAddress(deleted.address)) throw new Error('Wallet not found.')
  return { deleted: true, wallet: sanitizeWallet(deleted, index === activeIndex) }
}
