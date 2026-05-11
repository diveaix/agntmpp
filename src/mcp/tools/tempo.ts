/**
 * ./AGNT Protocol — Tempo Chain Tools
 * 14 tools for wallet management, token swaps, cross-chain bridges, and discovery on Tempo.
 * Extracted from the original monolithic server.ts into a modular venue module.
 */

import { formatUnits, parseUnits, pad, stringToHex, createWalletClient, http, maxUint256 } from 'viem'
import { tempo } from 'viem/chains'
import { TEMPO_CHAIN, TOKENS, CONTRACTS, STARGATE, CHAIN_EIDS, DEFAULT_SLIPPAGE, DEX_FEE_BPS } from '../config.js'
import { tip20Abi, dexAbi, stargateAbi, ammRouterAbi } from '../abis.js'
import { createWallet, getActiveWallet, getOrCreateWallet, listWallets, switchWallet, renameWallet, deleteWallet, getAccount, type WalletEntry } from '../wallet.js'
import { getPublicClient, SUPPORTED_CHAINS } from '../chains.js'
import type { ToolModule } from './index.js'

async function fetchJson(url: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

// LiFi chain ID for Tempo
const TEMPO_CHAIN_ID = 4217
const LIFI_CHAIN_IDS: Record<string, number> = {
  ethereum: 1, arbitrum: 42161, base: 8453, optimism: 10,
  polygon: 137, avalanche: 43114, bsc: 56,
}

// Native ETH / gas token address used by LiFi
const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Well-known token addresses on destination chains
// Key format: "chainKey:symbol" → address on that chain
const DEST_TOKENS: Record<string, string> = {
  // USDC
  'ethereum:USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'base:USDC': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'arbitrum:USDC': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  'optimism:USDC': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  'polygon:USDC': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'avalanche:USDC': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  'bsc:USDC': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  // USDT
  'ethereum:USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  'base:USDT': '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  'arbitrum:USDT': '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  'optimism:USDT': '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  'polygon:USDT': '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  'bsc:USDT': '0x55d398326f99059fF775485246999027B3197955',
  // ETH (native on all EVM chains)
  'ethereum:ETH': NATIVE_TOKEN,
  'base:ETH': NATIVE_TOKEN,
  'arbitrum:ETH': NATIVE_TOKEN,
  'optimism:ETH': NATIVE_TOKEN,
}

/** Resolve the destination token address for a bridge.
 *  Accepts: a raw 0x address, a symbol like 'USDC' or 'ETH', or falls back to same-token bridging. */
function resolveDestToken(toChainKey: string, input?: string, fallbackTempoToken?: string): string {
  if (!input) {
    // Default: try to find same symbol on dest chain
    return fallbackTempoToken || NATIVE_TOKEN
  }
  // If it's already a 0x address, use it directly
  if (input.startsWith('0x')) return input
  // Look up by symbol
  const key = `${toChainKey}:${input.toUpperCase()}`
  const found = DEST_TOKENS[key]
  if (found) return found
  // Check common aliases
  const aliases: Record<string, string> = { 'USDC.E': 'USDC', 'USDC.e': 'USDC', 'WETH': 'ETH' }
  const alias = aliases[input]
  if (alias) {
    const aliasKey = `${toChainKey}:${alias}`
    return DEST_TOKENS[aliasKey] || NATIVE_TOKEN
  }
  return NATIVE_TOKEN
}

const pub = () => getPublicClient('tempo')
const mkClient = (w: WalletEntry) => createWalletClient({ account: getAccount(w), chain: tempo, transport: http(TEMPO_CHAIN.rpc) })
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

function requireActiveWallet(): WalletEntry | { error: ReturnType<typeof err> } {
  const w = getActiveWallet()
  if (!w) {
    return {
      error: err(
        'No active AGNT wallet is selected on this server. Create or switch to a funded wallet with the wallet tool before executing transactions. Quotes can run without a wallet, but sends/swaps/bridges will not auto-create a new execution wallet.'
      ),
    }
  }
  return w
}

const TEMPO_STABLE_SEND_BUFFER = '0.005'

function resolveToken(s: string) {
  const t = TOKENS[s]
  if (t) return t
  const lower = s.toLowerCase()
  const found = Object.values(TOKENS).find((t) => t.symbol.toLowerCase() === lower || t.name.toLowerCase() === lower)
  if (found) return found
  throw new Error(`Unknown token "${s}". Available: ${Object.keys(TOKENS).join(', ')}`)
}

function feeStr(amount: bigint, decimals: number, label: string) {
  return `${label}: ${formatUnits(amount, decimals)}`
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'wallet',
    description: 'Manage Tempo wallets',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'switch', 'rename', 'delete', 'info', 'balance'], description: 'Action to perform' },
        name: { type: 'string', description: 'Wallet name (for create/switch)' },
        oldName: { type: 'string', description: 'Wallet old name (for rename)' },
        newName: { type: 'string', description: 'Wallet new name (for rename)' },
        token: { type: 'string', description: 'Token to check balance for' },
        address: { type: 'string', description: 'Address to check balance for' },
        chain: { type: 'string', description: 'Chain to check balance on (e.g. base, ethereum, arbitrum). Default: tempo' },
      },
      required: ['action'],
    },
  },
  {
    name: 'payment',
    description: 'Send tokens or check tx status on Tempo',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['send', 'status'], description: 'Action to perform' },
        to: { type: 'string', description: 'Recipient address (for send)' },
        amount: { type: 'number', description: 'Amount to send' },
        token: { type: 'string', description: 'Token symbol (Default: USDC.e)' },
        memo: { type: 'string', description: 'Payment memo' },
        hash: { type: 'string', description: 'Tx hash (for status)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'tempo_swap',
    description: 'Swap tokens on Tempo DEX or get quotes',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['execute', 'quote'], description: 'Action to perform' },
        tokenIn: { type: 'string' },
        tokenOut: { type: 'string' },
        amount: { type: 'number' },
        direction: { type: 'string', enum: ['sell', 'buy'], description: 'sell=exact input, buy=exact output. Default: sell' },
        slippage: { type: 'number' },
      },
      required: ['action', 'tokenIn', 'tokenOut', 'amount'],
    },
  },
  {
    name: 'tempo_bridge',
    description: 'Bridge tokens from Tempo via Stargate or get quotes',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['execute', 'quote'], description: 'Action to perform' },
        token: { type: 'string' },
        amount: { type: 'number' },
        toChain: { type: 'string' },
        toAddress: { type: 'string', description: 'Destination address (for execute)' },
        toToken: { type: 'string', description: 'Destination token symbol or address (e.g. USDC, ETH, 0x...). Defaults to same token.' },
      },
      required: ['action', 'token', 'amount', 'toChain'],
    },
  },
  {
    name: 'tempo_tokens',
    description: 'List or discover tokens on Tempo',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'search'], description: 'Action to perform' },
        showBalances: { type: 'boolean', description: 'Show wallet balances (for list)' },
        type: { type: 'string', enum: ['all', 'stablecoin', 'altcoin', 'memecoin'], description: 'Token type filter (for list)' },
        query: { type: 'string', description: 'Search term (for search)' },
      },
      required: ['action'],
    },
  },
]

// ─── Handler ─────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'wallet') {
    switch (args.action) {
      case 'create': {
        const w = createWallet(args.name as string | undefined)
        return text(
          `✅ Wallet "${w.name}" created!\n` +
          `Address: ${w.address}\n` +
          `Chain: Multi-chain EVM (Tempo, Ethereum, Base, Arbitrum, etc.)\n\n` +
          `🔐 Private Key (SAVE THIS — shown only once):\n${w.privateKey}\n\n` +
          `⚠️ This key will NEVER be shown again. Back it up securely.\n` +
          `You can import it into MetaMask, Rabby, or any EVM wallet.\n\n` +
          `💡 Fund via Stargate bridge or Tempo Wallet: https://wallet.tempo.xyz`
        )
      }
      case 'list': {
        const { wallets, activeIndex } = listWallets()
        if (!wallets.length) return text('No wallets yet. Use create to make one.')
        const lines = wallets.map((w, i) => `${i === activeIndex ? '→ ' : '  '}${w.name} — ${w.address}`)
        return text(`Wallets:\n${lines.join('\n')}`)
      }
      case 'switch': {
        if (!args.name) return err('Missing name')
        const w = switchWallet(args.name as string)
        if (!w) return err(`Wallet "${args.name}" not found.`)
        return text(`Switched to "${w.name}" (${w.address})`)
      }
      case 'rename': {
        if (!args.oldName || !args.newName) return err('Missing oldName or newName')
        const w = renameWallet(args.oldName as string, args.newName as string)
        if (!w) return err(`Wallet "${args.oldName}" not found.`)
        return text(`Renamed to "${w.name}" (${w.address})`)
      }
      case 'delete': {
        if (!args.name) return err('Missing wallet name to delete')
        const w = deleteWallet(args.name as string)
        if (!w) return err(`Wallet "${args.name}" not found.`)
        return text(`🗑️ Wallet "${w.name}" deleted.\nAddress: ${w.address}\n\n⚠️ If you didn't back up the private key, the funds in this wallet are unrecoverable.`)
      }
      case 'info': {
        const w = getActiveWallet()
        if (!w) return text('No wallet. Use create to make one.')
        const bals: string[] = []
        for (const [sym, tok] of Object.entries(TOKENS)) {
          try {
            const b = await pub().readContract({ address: tok.address, abi: tip20Abi, functionName: 'balanceOf', args: [w.address] }) as bigint
            const f = formatUnits(b, tok.decimals)
            if (Number(f) > 0) bals.push(`  ${sym.padEnd(10)} ${f}`)
          } catch { /* skip */ }
        }
        const chains = ['Tempo (4217)', 'Ethereum (1)', 'Base (8453)', 'Arbitrum (42161)', 'Optimism (10)', 'Polygon (137)', 'Avalanche (43114)', 'BSC (56)']
        return text(
          `Wallet: ${w.name}\nAddress: ${w.address}\n` +
          `Type: Multi-chain EVM wallet (same address on all chains)\n\n` +
          `Supported Chains:\n${chains.map(c => `  • ${c}`).join('\n')}\n\n` +
          `Tempo Balances:\n${bals.length ? bals.join('\n') : '  (empty — needs funding)'}\n\n` +
          `Explorer: ${TEMPO_CHAIN.explorer}/address/${w.address}\n\n` +
          `💡 Use bridge tools (tempo_bridge, relay, debridge, jumper) for cross-chain transfers.\n` +
          `Use Aave, Lido, Uniswap, etc. to interact on other chains.`
        )
      }
      case 'balance': {
        const w = getActiveWallet()
        const addr = (args.address as string || w?.address) as `0x${string}`
        if (!addr) return err('No wallet. Create one first or provide an address.')
        const chainKey = ((args.chain as string) || 'tempo').toLowerCase()

        // Multi-chain: check native + known token balances
        if (chainKey !== 'tempo') {
          const chainConfig = SUPPORTED_CHAINS[chainKey]
          if (!chainConfig) return err(`Unknown chain "${chainKey}". Available: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`)
          const client = getPublicClient(chainKey)

          // If user provided a specific token CA → check that single token
          const tokenArg = args.token as string | undefined
          if (tokenArg && tokenArg.startsWith('0x') && tokenArg.length === 42) {
            const tokenAddr = tokenArg as `0x${string}`
            try {
              const [symbol, decimals, balance] = await Promise.all([
                client.readContract({ address: tokenAddr, abi: tip20Abi, functionName: 'symbol', args: [] }).catch(() => 'UNKNOWN'),
                client.readContract({ address: tokenAddr, abi: tip20Abi, functionName: 'decimals', args: [] }).catch(() => 18),
                client.readContract({ address: tokenAddr, abi: tip20Abi, functionName: 'balanceOf', args: [addr] }) as Promise<bigint>,
              ])
              const fmt = formatUnits(balance, Number(decimals))
              return text(
                `Token on ${chainConfig.label}:\n` +
                `  ${symbol}: ${fmt}\n` +
                `  Contract: ${tokenAddr}\n` +
                `  Decimals: ${decimals}\n\n` +
                `Explorer: ${chainConfig.explorer}/token/${tokenAddr}`
              )
            } catch (e) {
              return err(`Failed to query token ${tokenArg} on ${chainConfig.label}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }

          // Auto-scan: Comprehensive per-chain token registry
          const CHAIN_TOKENS: Record<string, { address: `0x${string}`; decimals: number; symbol: string }[]> = {
            ethereum: [
              { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' },
              { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT' },
              { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, symbol: 'DAI' },
              { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, symbol: 'WETH' },
              { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, symbol: 'WBTC' },
              { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', decimals: 18, symbol: 'rETH' },
              { address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18, symbol: 'stETH' },
              { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18, symbol: 'wstETH' },
              { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, symbol: 'LINK' },
              { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, symbol: 'UNI' },
              { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18, symbol: 'AAVE' },
              { address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', decimals: 18, symbol: 'MKR' },
              { address: '0x4d224452801ACEd8B2F0aebE155379bb5D594381', decimals: 18, symbol: 'APE' },
              { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18, symbol: 'SHIB' },
              { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18, symbol: 'PEPE' },
            ],
            base: [
              { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
              { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
              { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI' },
              { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, symbol: 'cbETH' },
              { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18, symbol: 'wstETH' },
              { address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', decimals: 18, symbol: 'rETH' },
              { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18, symbol: 'AERO' },
              { address: '0xfA980cEd6895AC314E7dE34Ef1bFAE90a5AdD199', decimals: 18, symbol: 'PRIME' },
              { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', decimals: 18, symbol: 'BRETT' },
              { address: '0xBC45647eA894030a4E9801Ec03479739FA2485F0', decimals: 8, symbol: 'TOSHI' },
            ],
            arbitrum: [
              { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' },
              { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USDT' },
              { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
              { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, symbol: 'WETH' },
              { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, symbol: 'WBTC' },
              { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, symbol: 'ARB' },
              { address: '0x5979D7b546E38E9Ab8049369466BFF6edD3Dbf94', decimals: 18, symbol: 'wstETH' },
              { address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18, symbol: 'LINK' },
              { address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', decimals: 18, symbol: 'GMX' },
              { address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342', decimals: 18, symbol: 'MAGIC' },
            ],
            optimism: [
              { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC' },
              { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, symbol: 'USDT' },
              { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
              { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
              { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8, symbol: 'WBTC' },
              { address: '0x4200000000000000000000000000000000000042', decimals: 18, symbol: 'OP' },
              { address: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', decimals: 18, symbol: 'wstETH' },
              { address: '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', decimals: 18, symbol: 'LINK' },
              { address: '0x9e1028F5F1D5eDE59748FFceE5532509976840E0', decimals: 18, symbol: 'PERP' },
            ],
            polygon: [
              { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, symbol: 'USDC' },
              { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, symbol: 'USDT' },
              { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, symbol: 'DAI' },
              { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, symbol: 'WETH' },
              { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8, symbol: 'WBTC' },
              { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18, symbol: 'WMATIC' },
              { address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', decimals: 18, symbol: 'LINK' },
              { address: '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', decimals: 18, symbol: 'UNI' },
              { address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', decimals: 18, symbol: 'AAVE' },
            ],
            avalanche: [
              { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, symbol: 'USDC' },
              { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6, symbol: 'USDT' },
              { address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', decimals: 18, symbol: 'DAI.e' },
              { address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', decimals: 18, symbol: 'WETH.e' },
              { address: '0x50b7545627a5162F82A992c33b87aDc75187B218', decimals: 8, symbol: 'WBTC.e' },
              { address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18, symbol: 'WAVAX' },
              { address: '0x152b9d0FdC40C096DE1b18a2cDCefA7FC6c0a5B2', decimals: 18, symbol: 'sAVAX' },
            ],
            bsc: [
              { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
              { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT' },
              { address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', decimals: 18, symbol: 'DAI' },
              { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18, symbol: 'ETH' },
              { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18, symbol: 'BTCB' },
              { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, symbol: 'WBNB' },
              { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, symbol: 'CAKE' },
              { address: '0xBf5140A22578168FD562DCcF235E5D43A02ce9B1', decimals: 18, symbol: 'UNI' },
            ],
          }

          try {
            const nativeBal = await client.getBalance({ address: addr })
            const nativeFmt = formatUnits(nativeBal, 18)
            const nativeSymbol = chainKey === 'bsc' ? 'BNB' : chainKey === 'polygon' ? 'MATIC' : chainKey === 'avalanche' ? 'AVAX' : 'ETH'
            const lines: string[] = [
              `Balance on ${chainConfig.label}:`,
              `  ${nativeSymbol} (native): ${nativeFmt}`,
            ]

            // Check all known tokens on this chain
            const tokens = CHAIN_TOKENS[chainKey] || []
            for (const tok of tokens) {
              try {
                const bal = await client.readContract({ address: tok.address, abi: tip20Abi, functionName: 'balanceOf', args: [addr] }) as bigint
                const fmt = formatUnits(bal, tok.decimals)
                if (Number(fmt) > 0) lines.push(`  ${tok.symbol}: ${fmt}`)
              } catch { /* skip */ }
            }

            lines.push(`\nExplorer: ${chainConfig.explorer}/address/${addr}`)
            lines.push(`💡 Check any token: use token=0xContractAddress with chain=${chainKey}`)
            return text(lines.join('\n'))
          } catch (e) {
            return err(`Failed to query ${chainConfig.label}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        // Default: Tempo token balance
        if (!args.token) return err('Missing token. Specify a token symbol or use chain parameter for multi-chain balance.')
        const tok = resolveToken(args.token as string)
        const b = await pub().readContract({ address: tok.address, abi: tip20Abi, functionName: 'balanceOf', args: [addr] }) as bigint
        return text(`${tok.symbol}: ${formatUnits(b, tok.decimals)}`)
      }
      default: return err(`Unknown wallet action: ${args.action}`)
    }
  }

  if (name === 'payment') {
    switch (args.action) {
      case 'send': {
        if (!args.to || args.amount === undefined) return err('Missing to or amount')
        const active = requireActiveWallet()
        if ('error' in active) return active.error
        const w = active
        const client = mkClient(w)
        const to = args.to as `0x${string}`
        const amount = args.amount as number
        const sym = (args.token as string) || 'USDC.e'
        const memo = args.memo as string | undefined
        const tok = resolveToken(sym)
        const requested = parseUnits(String(amount), tok.decimals)
        const balance = await pub().readContract({ address: tok.address, abi: tip20Abi, functionName: 'balanceOf', args: [w.address] }) as bigint
        if (requested > balance) {
          return err(`Insufficient ${tok.symbol}. Requested ${formatUnits(requested, tok.decimals)}, available ${formatUnits(balance, tok.decimals)}.`)
        }

        const buffer = tok.type === 'stablecoin' ? parseUnits(TEMPO_STABLE_SEND_BUFFER, tok.decimals) : 0n
        if (buffer > 0n && balance <= buffer) {
          return err(`Not enough spendable ${tok.symbol}. Balance is ${formatUnits(balance, tok.decimals)}, but Tempo exact-balance sends need a tiny buffer for network/accounting fees.`)
        }

        const maxSpendable = buffer > 0n ? balance - buffer : balance
        const parsed = requested > maxSpendable ? maxSpendable : requested
        const adjusted = parsed !== requested

        try {
          if (memo) {
            await pub().simulateContract({ address: tok.address, abi: tip20Abi, functionName: 'transferWithMemo', args: [to, parsed, pad(stringToHex(memo), { size: 32 })], account: getAccount(w) })
          } else {
            await pub().simulateContract({ address: tok.address, abi: tip20Abi, functionName: 'transfer', args: [to, parsed], account: getAccount(w) })
          }
        } catch (e) {
          return err(`Transfer simulation failed before sending. No transaction was submitted. Reason: ${e instanceof Error ? e.message : String(e)}`)
        }

        const hash = memo
          ? await client.writeContract({ address: tok.address, abi: tip20Abi, functionName: 'transferWithMemo', args: [to, parsed, pad(stringToHex(memo), { size: 32 })] })
          : await client.writeContract({ address: tok.address, abi: tip20Abi, functionName: 'transfer', args: [to, parsed] })

        const receipt = await pub().waitForTransactionReceipt({ hash, timeout: 60_000 })
        if (receipt.status !== 'success') {
          return err(`Transfer reverted on-chain.\nTx: ${TEMPO_CHAIN.explorer}/tx/${hash}`)
        }

        return text(`Payment sent!\nAmount: ${formatUnits(parsed, tok.decimals)} ${sym}${adjusted ? `\nAdjusted from requested ${formatUnits(requested, tok.decimals)} ${sym} to keep a tiny Tempo fee buffer.` : ''}\nTo: ${to}\n${memo ? `Memo: ${memo}\n` : ''}Gas: ~0.001 USD (sponsored)\nTx: ${TEMPO_CHAIN.explorer}/tx/${hash}`)

        return text(`✅ Payment sent!\nAmount: ${amount} ${sym}\nTo: ${to}\n${memo ? `Memo: ${memo}\n` : ''}Gas: ~0.001 USD (sponsored)\nTx: ${TEMPO_CHAIN.explorer}/tx/${hash}`)
      }
      case 'status': {
        if (!args.hash) return err('Missing hash')
        const hash = args.hash as `0x${string}`
        try {
          const r = await pub().getTransactionReceipt({ hash })
          return text(`Tx: ${hash}\nStatus: ${r.status === 'success' ? '✅ Success' : '❌ Reverted'}\nBlock: ${r.blockNumber}\nGas: ${r.gasUsed}\nExplorer: ${TEMPO_CHAIN.explorer}/tx/${hash}`)
        } catch {
          try {
            const tx = await pub().getTransaction({ hash })
            return text(`Tx: ${hash}\nStatus: ⏳ Pending\nFrom: ${tx.from}\nTo: ${tx.to}`)
          } catch { return err(`Transaction not found.`) }
        }
      }
      default: return err(`Unknown payment action: ${args.action}`)
    }
  }

  if (name === 'tempo_swap') {
    switch (args.action) {
      case 'execute': {
        const active = requireActiveWallet()
        if ('error' in active) return active.error
        const w = active
        const client = mkClient(w)
        const tIn = resolveToken(args.tokenIn as string)
        const tOut = resolveToken(args.tokenOut as string)
        const amount = args.amount as number
        const slip = (args.slippage as number) || DEFAULT_SLIPPAGE
        const parsed = parseUnits(String(amount), tIn.decimals)
        const path = [tIn.address, tOut.address] as readonly `0x${string}`[]
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200) // 20 min

        // Get quote from AMM Router
        let amountsOut: readonly bigint[]
        try {
          amountsOut = await pub().readContract({
            address: CONTRACTS.ammRouter,
            abi: ammRouterAbi,
            functionName: 'getAmountsOut',
            args: [parsed, path],
          }) as readonly bigint[]
        } catch (e) {
          return err(`AMM quote failed — the ${tIn.symbol}/${tOut.symbol} pair may not have a pool on the Tempo AMM. Error: ${e instanceof Error ? e.message : String(e)}`)
        }

        const expectedOut = amountsOut[amountsOut.length - 1]
        const minOut = expectedOut * BigInt(Math.floor((1 - slip) * 10000)) / 10000n

        // Approve router to spend input tokens
        const allowance = await pub().readContract({ address: tIn.address, abi: tip20Abi, functionName: 'allowance', args: [w.address, CONTRACTS.ammRouter] }) as bigint
        if (allowance < parsed) {
          const approveTx = await client.writeContract({ address: tIn.address, abi: tip20Abi, functionName: 'approve', args: [CONTRACTS.ammRouter, maxUint256] })
          await pub().waitForTransactionReceipt({ hash: approveTx })
        }

        // Execute swap via AMM Router
        const hash = await client.writeContract({
          address: CONTRACTS.ammRouter,
          abi: ammRouterAbi,
          functionName: 'swapExactTokensForTokens',
          args: [parsed, minOut, path, w.address, deadline],
        })

        const outFmt = formatUnits(expectedOut, tOut.decimals)
        const rate = (Number(outFmt) / amount).toFixed(6)
        return text(
          `✅ Swap executed!\n` +
          `Sold: ${amount} ${tIn.symbol}\nExpected: ~${outFmt} ${tOut.symbol}\n` +
          `Min received: ${formatUnits(minOut, tOut.decimals)} ${tOut.symbol}\n\n` +
          `📊 Details:\n  Rate: 1 ${tIn.symbol} ≈ ${rate} ${tOut.symbol}\n  Slippage: ${slip * 100}%\n  DEX: Enshrined AMM (Tempo)\n  Gas: ~0.001 USD (sponsored)\n\nTx: ${TEMPO_CHAIN.explorer}/tx/${hash}`
        )
      }
      case 'quote': {
        const tIn = resolveToken(args.tokenIn as string)
        const tOut = resolveToken(args.tokenOut as string)
        const amount = args.amount as number
        const parsed = parseUnits(String(amount), tIn.decimals)
        const path = [tIn.address, tOut.address] as readonly `0x${string}`[]

        let amountsOut: readonly bigint[]
        try {
          amountsOut = await pub().readContract({
            address: CONTRACTS.ammRouter,
            abi: ammRouterAbi,
            functionName: 'getAmountsOut',
            args: [parsed, path],
          }) as readonly bigint[]
        } catch (e) {
          return err(`AMM quote failed — the ${tIn.symbol}/${tOut.symbol} pair may not exist. Error: ${e instanceof Error ? e.message : String(e)}`)
        }

        const expectedOut = amountsOut[amountsOut.length - 1]
        const outFmt = formatUnits(expectedOut, tOut.decimals)
        const rate = (Number(outFmt) / amount).toFixed(6)

        return text(
          `📊 Swap Quote:\n` +
          `${amount} ${tIn.symbol} → ~${outFmt} ${tOut.symbol}\n\n` +
          `Rate: 1 ${tIn.symbol} ≈ ${rate} ${tOut.symbol}\n` +
          `DEX: Enshrined AMM (Tempo)\n` +
          `Router: ${CONTRACTS.ammRouter}\n` +
          `Gas: ~0.001 USD (sponsored)`
        )
      }
      default: return err(`Unknown tempo_swap action: ${args.action}`)
    }
  }

  if (name === 'tempo_bridge') {
    const supportedChains = { ...CHAIN_EIDS, ...Object.fromEntries(Object.entries(LIFI_CHAIN_IDS).map(([k, v]) => [k, { eid: v, name: k.charAt(0).toUpperCase() + k.slice(1) }])) }

    switch (args.action) {
      case 'execute': {
        const active = requireActiveWallet()
        if ('error' in active) return active.error
        const w = active
        const client = mkClient(w)
        const sym = args.token as string
        const amount = args.amount as number
        const toChainKey = (args.toChain as string).toLowerCase()
        const tok = resolveToken(sym)
        const toAddr = (args.toAddress as string) || w.address

        // Resolve destination chain ID for LiFi
        const toChainId = LIFI_CHAIN_IDS[toChainKey]
        if (!toChainId) return err(`Unknown destination chain. Available: ${Object.keys(LIFI_CHAIN_IDS).join(', ')}`)

        const parsed = parseUnits(String(amount), tok.decimals)

        // Resolve destination token (e.g. USDC on Base, ETH, etc.)
        const destTokenInput = args.toToken as string | undefined
        const destToken = resolveDestToken(toChainKey, destTokenInput, tok.symbol === 'USDC.e' ? DEST_TOKENS[`${toChainKey}:USDC`] : undefined)

        try {
          // Fetch executable transaction from LiFi
          const quoteUrl = `https://li.quest/v1/quote?fromChain=${TEMPO_CHAIN_ID}&toChain=${toChainId}&fromToken=${tok.address}&toToken=${destToken}&fromAmount=${parsed.toString()}&fromAddress=${w.address}&slippage=0.01`
          const data = await fetchJson(quoteUrl) as {
            transactionRequest?: { to: string; data: string; value: string }
            estimate?: { toAmount: string; executionDuration: number; toAmountMin: string }
            action?: { fromToken: { symbol: string; decimals: number }; toToken: { symbol: string; decimals: number } }
            tool?: string
          }

          if (!data.transactionRequest) return err('LiFi returned no executable transaction for this Tempo bridge route. The route may not be supported yet.')

          const txReq = data.transactionRequest

          // Approve LiFi contract if needed for ERC-20
          const spender = txReq.to as `0x${string}`
          const allowance = await pub().readContract({ address: tok.address, abi: tip20Abi, functionName: 'allowance', args: [w.address, spender] }) as bigint
          if (allowance < parsed) {
            const approveTx = await client.writeContract({ address: tok.address, abi: tip20Abi, functionName: 'approve', args: [spender, maxUint256] })
            await pub().waitForTransactionReceipt({ hash: approveTx })
          }

          // Submit the bridge transaction
          const hash = await client.sendTransaction({
            to: spender,
            data: txReq.data as `0x${string}`,
            value: BigInt(txReq.value || '0'),
          })

          const estOut = data.estimate?.toAmount
          const outDecimals = data.action?.toToken?.decimals || tok.decimals
          const formattedOut = estOut ? formatUnits(BigInt(estOut), outDecimals) : '~'
          const duration = Math.ceil((data.estimate?.executionDuration || 60) / 60)

          return text(
            `✅ Bridge initiated via Jumper/LiFi!\n` +
            `Amount: ${amount} ${sym}\n` +
            `Route: Tempo → ${toChainKey} (${data.tool || 'Auto'})\n` +
            `To: ${toAddr}\n` +
            `Expected: ~${formattedOut} ${data.action?.toToken?.symbol || sym}\n` +
            `Est. Time: ~${duration} min\n\n` +
            `Tx: ${TEMPO_CHAIN.explorer}/tx/${hash}`
          )
        } catch (e) {
          return err(`Bridge failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      case 'quote': {
        const sym = args.token as string
        const amount = args.amount as number
        const toChainKey = (args.toChain as string).toLowerCase()
        const tok = resolveToken(sym)

        const toChainId = LIFI_CHAIN_IDS[toChainKey]
        if (!toChainId) return err(`Unknown chain. Available: ${Object.keys(LIFI_CHAIN_IDS).join(', ')}`)

        const parsed = parseUnits(String(amount), tok.decimals)
        const w = getActiveWallet()
        const fromAddr = w?.address || '0x0000000000000000000000000000000000000001'

        const destTokenInput = args.toToken as string | undefined
        const destToken = resolveDestToken(toChainKey, destTokenInput, tok.symbol === 'USDC.e' ? DEST_TOKENS[`${toChainKey}:USDC`] : undefined)

        try {
          const url = `https://li.quest/v1/quote?fromChain=${TEMPO_CHAIN_ID}&toChain=${toChainId}&fromToken=${tok.address}&toToken=${destToken}&fromAmount=${parsed.toString()}&fromAddress=${fromAddr}&slippage=0.01`
          const data = await fetchJson(url) as {
            estimate?: { toAmount: string; executionDuration: number; gasCosts: { amountUSD: string }[] }
            action?: { toToken: { symbol: string; decimals: number } }
            tool?: string
          }

          if (!data.estimate) return err('No bridge route found for this Tempo → destination pair via LiFi.')

          const outDecimals = data.action?.toToken?.decimals || tok.decimals
          const formattedOut = formatUnits(BigInt(data.estimate.toAmount), outDecimals)
          const duration = Math.ceil(data.estimate.executionDuration / 60)
          const gasCost = data.estimate.gasCosts?.reduce((s, g) => s + parseFloat(g.amountUSD || '0'), 0) || 0

          return text(
            `📊 Bridge Quote (Jumper/LiFi):\n` +
            `${amount} ${sym}: Tempo → ${toChainKey}\n\n` +
            `Route: ${data.tool || 'Auto'}\n` +
            `Expected: ~${formattedOut} ${data.action?.toToken?.symbol || sym}\n` +
            `Est. Time: ~${duration} min\n` +
            `Gas: ~$${gasCost.toFixed(2)}\n\n` +
            `💡 Use action 'execute' to bridge.`
          )
        } catch (e) {
          return err(`Bridge quote failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      default: return err(`Unknown tempo_bridge action: ${args.action}`)
    }
  }

  if (name === 'tempo_tokens') {
    switch (args.action) {
      case 'list': {
        const filter = (args.type as string) || 'all'
        const showBal = args.showBalances as boolean
        const w = showBal ? getActiveWallet() : null
        const entries = Object.entries(TOKENS).filter(([, t]) => filter === 'all' || t.type === filter)

        const lines = [`Tokens on Tempo (${filter}):\n`]
        for (const [sym, tok] of entries) {
          let line = `  ${sym.padEnd(10)} [${tok.type}] ${tok.address}`
          if (showBal && w) {
            try {
              const b = await pub().readContract({ address: tok.address, abi: tip20Abi, functionName: 'balanceOf', args: [w.address] }) as bigint
              line += `  Bal: ${formatUnits(b, tok.decimals)}`
            } catch { line += `  Bal: -` }
          }
          lines.push(line)
        }
        return text(lines.join('\n'))
      }
      case 'search': {
        if (!args.query) return err('Missing search query')
        const q = (args.query as string).toLowerCase()
        const matches = Object.entries(TOKENS).filter(([sym, t]) =>
          sym.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q)
        )
        if (!matches.length) return text(`No tokens matching "${args.query}".`)
        const lines = matches.map(([sym, t]) => `  ${sym.padEnd(10)} ${t.name} [${t.type}] ${t.address}`)
        return text(`Found ${matches.length} token(s):\n${lines.join('\n')}`)
      }
      default: return err(`Unknown tempo_tokens action: ${args.action}`)
    }
  }

  return null
}

// ─── Module Export ────────────────────────────────────────

const tempoModule: ToolModule = { tools: TOOLS, handle }
export default tempoModule
