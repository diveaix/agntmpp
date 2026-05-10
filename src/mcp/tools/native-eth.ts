export const WETH_BY_CHAIN: Record<string, `0x${string}`> = {
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  optimism: '0x4200000000000000000000000000000000000006',
  polygon: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  bsc: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  avalanche: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
}

const NATIVE_ETH_WRAPPER_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism'])

export interface NativeEthPlan {
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  weth: `0x${string}`
  inputIsNative: boolean
  outputIsNative: boolean
  wrapInput: boolean
  unwrapOutput: boolean
  directWrap: boolean
  directUnwrap: boolean
}

export const wethAbi = [
  { name: 'deposit', type: 'function', inputs: [], outputs: [], stateMutability: 'payable' },
  { name: 'withdraw', type: 'function', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const

const erc20BalanceAbi = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

interface BalanceReader {
  readContract: (params: {
    address: `0x${string}`
    abi: typeof erc20BalanceAbi
    functionName: 'balanceOf'
    args: [`0x${string}`]
  }) => Promise<unknown>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Check if a token string means native ETH, not the ERC-20 WETH token. */
export function isNativeEthRequest(token: string): boolean {
  const lower = token.toLowerCase()
  return lower === '0x0000000000000000000000000000000000000000'
    || lower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    || lower === 'eth'
}

export function isWethRequest(token: string, chain: string): boolean {
  const weth = WETH_BY_CHAIN[chain]
  const lower = token.toLowerCase()
  return lower === 'weth' || (!!weth && lower === weth.toLowerCase())
}

export function supportsNativeEthWrapping(chain: string): boolean {
  return NATIVE_ETH_WRAPPER_CHAINS.has(chain)
}

/** Convert native ETH or WETH aliases to the chain's WETH address for router calls. */
export function resolveToWeth(token: string, chain: string): `0x${string}` {
  const weth = WETH_BY_CHAIN[chain]
  if ((isNativeEthRequest(token) || isWethRequest(token, chain)) && weth) return weth
  return token as `0x${string}`
}

export function getNativeEthPlan(rawTokenIn: string, rawTokenOut: string, chain: string): NativeEthPlan {
  const weth = WETH_BY_CHAIN[chain]
  if (!weth) throw new Error(`No WETH address configured for chain "${chain}".`)

  const inputIsNative = isNativeEthRequest(rawTokenIn)
  const outputIsNative = isNativeEthRequest(rawTokenOut)
  if ((inputIsNative || outputIsNative) && !supportsNativeEthWrapping(chain)) {
    throw new Error(
      `Native ETH wrapping is not supported on "${chain}". Use the ERC-20 WETH address directly, or use a chain where ETH is the native gas token: ethereum, base, arbitrum, optimism.`,
    )
  }

  const tokenIn = resolveToWeth(rawTokenIn, chain)
  const tokenOut = resolveToWeth(rawTokenOut, chain)
  const inputIsWeth = tokenIn.toLowerCase() === weth.toLowerCase()
  const outputIsWeth = tokenOut.toLowerCase() === weth.toLowerCase()
  const directWrap = inputIsNative && outputIsWeth && !outputIsNative
  const directUnwrap = outputIsNative && inputIsWeth && !inputIsNative

  return {
    tokenIn,
    tokenOut,
    weth,
    inputIsNative,
    outputIsNative,
    directWrap,
    directUnwrap,
    wrapInput: inputIsNative && !directWrap,
    unwrapOutput: outputIsNative && !directUnwrap,
  }
}

export async function waitForTokenBalanceIncrease(
  client: BalanceReader,
  token: `0x${string}`,
  owner: `0x${string}`,
  previousBalance: bigint,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<bigint> {
  const attempts = opts.attempts ?? 8
  const delayMs = opts.delayMs ?? 1500

  for (let i = 0; i < attempts; i++) {
    const current = await client.readContract({
      address: token,
      abi: erc20BalanceAbi,
      functionName: 'balanceOf',
      args: [owner],
    }) as bigint

    if (current > previousBalance) return current - previousBalance
    if (i < attempts - 1 && delayMs > 0) await delay(delayMs)
  }

  return 0n
}
