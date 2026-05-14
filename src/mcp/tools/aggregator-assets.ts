import { formatUnits, parseUnits } from 'viem'
import type { PublicClient } from 'viem'

export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'
export const LIFI_NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const TOKEN_ADDRESSES: Record<string, Record<string, `0x${string}`>> = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  arbitrum: {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    'USDC.E': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  base: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    WETH: '0x4200000000000000000000000000000000000006',
  },
  optimism: {
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    WETH: '0x4200000000000000000000000000000000000006',
  },
  polygon: {
    USDC: '0x3c499c542cef5e3811E1192ce70d8cC03d5c3359',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  },
  avalanche: {
    USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    'USDC.E': '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664',
    WETH: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
  },
  bsc: {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    WETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  },
}

const erc20BalanceAbi = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

export function isNativeToken(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase()
  return normalized === 'eth' ||
    normalized === 'native' ||
    normalized === NATIVE_TOKEN ||
    normalized === LIFI_NATIVE_TOKEN.toLowerCase()
}

export function resolveTokenAddress(chain: string, token: string | undefined, opts: { lifiNative?: boolean } = {}): string {
  if (!token || isNativeToken(token)) return opts.lifiNative ? LIFI_NATIVE_TOKEN : NATIVE_TOKEN
  if (token.startsWith('0x')) return token
  const symbol = token.trim().toUpperCase()
  const resolved = TOKEN_ADDRESSES[chain]?.[symbol]
  if (!resolved) throw new Error(`Unknown token "${token}" on ${chain}. Use a contract address or one of: ETH, ${Object.keys(TOKEN_ADDRESSES[chain] || {}).join(', ')}`)
  return resolved
}

export function knownTokenDecimals(chain: string, token: string): number {
  if (isNativeToken(token)) return 18
  const lower = token.toLowerCase()
  const entries = TOKEN_ADDRESSES[chain] || {}
  const symbol = Object.entries(entries).find(([, address]) => address.toLowerCase() === lower)?.[0]
  if (symbol === 'USDC' || symbol === 'USDC.E' || symbol === 'USDT') return 6
  return 18
}

export function parseRouteAmount(amount: unknown, decimals: number): bigint {
  const raw = String(amount ?? '').trim()
  if (!raw) throw new Error('Missing amount.')
  if (raw.toLowerCase() === 'max' || raw.toLowerCase() === 'all') throw new Error('max amount must be resolved from balance before quoting.')
  return parseUnits(raw, decimals)
}

export function isMaxRouteAmount(amount: unknown): boolean {
  const raw = String(amount ?? '').trim().toLowerCase()
  return raw === 'max' || raw === 'all'
}

export async function resolveRouteAmount(input: {
  amount: unknown
  decimals: number
  token: string
  account: `0x${string}`
  client: PublicClient
  nativeReserve?: unknown
}): Promise<bigint> {
  if (!isMaxRouteAmount(input.amount)) return parseRouteAmount(input.amount, input.decimals)
  if (isNativeToken(input.token)) {
    const reserve = parseRouteAmount(input.nativeReserve ?? process.env.AGNT_NATIVE_MAX_RESERVE_ETH ?? '0.0005', 18)
    const balance = await input.client.getBalance({ address: input.account })
    if (balance <= reserve) {
      throw new Error(`Not enough native ETH to keep a gas reserve. Balance ${formatUnits(balance, 18)} ETH, reserve ${formatUnits(reserve, 18)} ETH.`)
    }
    return balance - reserve
  }
  return input.client.readContract({
    address: input.token as `0x${string}`,
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [input.account],
  }) as Promise<bigint>
}

export async function estimateNativeTxCost(
  client: PublicClient,
  tx: { account: `0x${string}`; to: `0x${string}`; data?: `0x${string}`; value?: bigint },
): Promise<bigint> {
  const [gas, gasPrice] = await Promise.all([
    client.estimateGas(tx),
    client.getGasPrice(),
  ])
  return gas * gasPrice
}

export async function assertNativeBalanceCoversTx(input: {
  client: PublicClient
  account: `0x${string}`
  to: `0x${string}`
  data?: `0x${string}`
  value?: bigint
  chain: string
}): Promise<{ balance: bigint; gasCost: bigint; totalCost: bigint }> {
  const value = input.value ?? 0n
  const [balance, gasCost] = await Promise.all([
    input.client.getBalance({ address: input.account }),
    estimateNativeTxCost(input.client, {
      account: input.account,
      to: input.to,
      data: input.data,
      value,
    }),
  ])
  const buffer = gasCost / 5n
  const totalCost = value + gasCost + buffer
  if (balance < totalCost) {
    throw new Error(
      `Not enough ${input.chain} ETH for this route. Balance ${formatUnits(balance, 18)} ETH, route value ${formatUnits(value, 18)} ETH, estimated gas ${formatUnits(gasCost, 18)} ETH, buffer ${formatUnits(buffer, 18)} ETH. Try a smaller amount or fund more gas.`
    )
  }
  return { balance, gasCost, totalCost }
}
