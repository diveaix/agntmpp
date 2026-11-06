/** Generic EVM wallet management and payments. */
import { erc20Abi, formatUnits } from 'viem'
import { createWallet, getActiveWallet, listWallets, switchWallet, renameWallet, deleteWallet, recoverLegacyWallet, exportWalletBackup, importWalletBackup } from '../wallet.js'
import { getPublicClient, SUPPORTED_CHAINS } from '../chains.js'
import type { ToolModule } from './index.js'
import { executeWalletSend } from './wallet-send.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const TOOLS = [
  {
    name: 'wallet',
    description: 'Manage multi-chain EVM wallets',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'switch', 'rename', 'delete', 'recover_legacy', 'backup_export', 'backup_import', 'info', 'balance', 'send'], description: 'Action to perform' },
        name: { type: 'string', description: 'Wallet name (for create/switch)' },
        oldName: { type: 'string', description: 'Wallet old name (for rename)' },
        newName: { type: 'string', description: 'Wallet new name (for rename)' },
        token: { type: 'string', description: 'Token to check balance for' },
        address: { type: 'string', description: 'Address to check balance for' },
        to: { type: 'string', description: 'Recipient address (for send)' },
        amount: { type: 'string', description: 'Amount to send (for send), or all/max for supported tokens' },
        nativeReserveEth: { type: 'string', description: 'Native gas reserve for all/max native sends' },
        backup: { type: 'string', description: 'Encrypted wallet backup string (for backup_import)' },
        password: { type: 'string', description: 'Backup password for backup_export or backup_import' },
        confirm: { type: 'boolean', description: 'Confirm dangerous actions like delete' },
        chain: { type: 'string', description: 'Chain to check balance or send on (e.g. base, ethereum, arbitrum). Default: base' },
      },
      required: ['action'],
    },
  },
  {
    name: 'payment',
    description: 'Send tokens or check transaction status on supported EVM chains.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['send', 'status'], description: 'Action to perform' },
        to: { type: 'string', description: 'Recipient address (for send)' },
        amount: { type: ['number', 'string'], description: 'Amount to send, or all/max' },
        token: { type: 'string', description: 'Token symbol (Default: native)' },
        confirm: { type: 'boolean', description: 'Required for all/max sends or sends above configured thresholds.' },
        chain: { type: 'string', description: 'Chain key. Default: base. Use base/arbitrum/optimism/polygon/etc. for generic transfers.' },
        nativeReserveEth: { type: 'string', description: 'Native gas reserve for all/max native sends' },
        hash: { type: 'string', description: 'Tx hash (for status)' },
      },
      required: ['action'],
    },
  },
]

async function handle(name: string, args: Record<string, unknown>) {
  if (name === 'wallet') {
    switch (args.action) {
      case 'create': {
        const w = createWallet(args.name as string | undefined)
        return text(
          `✅ Wallet "${w.name}" created!\n` +
          `Address: ${w.address}\n` +
          `Chain: Multi-chain EVM (Ethereum, Base, Arbitrum, etc.)\n\n` +
          `🔐 Private Key (SAVE THIS — shown only once):\n${w.privateKey}\n\n` +
          `⚠️ This key will NEVER be shown again. Back it up securely.\n` +
          `You can import it into MetaMask, Rabby, or any EVM wallet.\n\n` +
          `💡 Fund this address on a supported EVM chain.`
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
        if (args.confirm !== true) return err('Wallet deletion is permanent. Re-run with confirm=true after backing up the wallet.')
        const w = deleteWallet(args.name as string)
        if (!w) return err(`Wallet "${args.name}" not found.`)
        return text(`🗑️ Wallet "${w.name}" deleted.\nAddress: ${w.address}\n\n⚠️ If you didn't back up the private key, the funds in this wallet are unrecoverable.`)
      }
      case 'backup_export': {
        if (!args.password || typeof args.password !== 'string') return err('Missing backup password. Use a strong password with at least 8 characters.')
        const backup = exportWalletBackup(args.password)
        return text(
          `Wallet backup created\n` +
          `Wallets: ${backup.walletCount}\n` +
          `Exported: ${backup.exportedAt}\n\n` +
          `Encrypted backup:\n${backup.backup}\n\n` +
          `Keep this backup and password together only in a secure place. AGENT cannot restore it without the password.`
        )
      }
      case 'backup_import': {
        if (!args.backup || typeof args.backup !== 'string') return err('Missing encrypted backup string.')
        if (!args.password || typeof args.password !== 'string') return err('Missing backup password.')
        const result = importWalletBackup(args.backup, args.password)
        return text(
          `Wallet backup imported\n` +
          `Imported: ${result.imported}\n` +
          `Skipped existing: ${result.skipped}\n` +
          `Active wallet: ${result.activeWallet ? `${result.activeWallet.name} (${result.activeWallet.address})` : 'none'}`
        )
      }
      case 'recover_legacy': {
        if (!args.name) return err('Missing legacy wallet name or address to recover')
        const recovered = recoverLegacyWallet(args.name as string)
        if (!recovered) {
          return err(
            `Legacy wallet "${args.name}" was not found in the old unscoped wallet vault.\n` +
            `If this was created on Railway, make sure the current deployment has the same volume mounted and the same AGNT_PASSPHRASE.`
          )
        }
        return text(
          `${recovered.alreadyPresent ? 'Legacy wallet already exists in this private vault.' : 'Legacy wallet recovered into this private vault.'}\n` +
          `Wallet: ${recovered.wallet.name}\n` +
          `Address: ${recovered.wallet.address}\n` +
          `Active: yes\n\n` +
          `Private key was not displayed. You can now check balances or send the funds from this wallet.`
        )
      }
      case 'info': {
        const w = getActiveWallet()
        if (!w) return text('No wallet. Use create to make one.')
        const chains = Object.values(SUPPORTED_CHAINS).map(chain => `  • ${chain.label} (${chain.chain.id})`)
        return text(
          `Wallet: ${w.name}\nAddress: ${w.address}\n` +
          `Type: Multi-chain EVM wallet (same address on all chains)\n\n` +
          `Supported Chains:\n${chains.join('\n')}\n\n` +
          `Use wallet action=balance to check a chain. Default: Base.\n` +
          `Use relay or jumper for cross-chain transfers.`
        )
      }
      case 'balance': {
        const w = getActiveWallet()
        const addr = (args.address as string || w?.address) as `0x${string}`
        if (!addr) return err('No wallet. Create one first or provide an address.')
        const chainKey = ((args.chain as string) || 'base').toLowerCase()

        const chainConfig = SUPPORTED_CHAINS[chainKey]
        if (!chainConfig) return err(`Unknown chain "${chainKey}". Available: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`)
        const client = getPublicClient(chainKey)

        // If user provided a specific token CA → check that single token
        const tokenArg = args.token as string | undefined
        if (tokenArg && tokenArg.startsWith('0x') && tokenArg.length === 42) {
          const tokenAddr = tokenArg as `0x${string}`
          try {
            const [symbol, decimals, balance] = await Promise.all([
              client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol', args: [] }).catch(() => 'UNKNOWN'),
              client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals', args: [] }).catch(() => 18),
              client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }) as Promise<bigint>,
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
          const nativeSymbol = chainConfig.nativeSymbol
          const lines: string[] = [
            `Balance on ${chainConfig.label}:`,
            `  ${nativeSymbol} (native): ${nativeFmt}`,
          ]

          // Check all known tokens on this chain
          const tokens = CHAIN_TOKENS[chainKey] || []
          for (const tok of tokens) {
            try {
              const bal = await client.readContract({ address: tok.address, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }) as bigint
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
      case 'send': {
        const chain = ((args.chain as string | undefined) || 'base').toLowerCase()
        return executeWalletSend({
          ...args,
          action: 'send',
          chain,
          token: args.token || 'native',
        })
      }
      default: return err(`Unknown wallet action: ${args.action}`)
    }
  }

  if (name === 'payment') {
    if (args.action !== 'send' && args.action !== 'status') return err(`Unknown payment action: ${args.action}`)
    return executeWalletSend({ ...args, chain: args.chain || 'base', token: args.token || 'native' })
  }
  return null
}

export default { tools: TOOLS, handle } satisfies ToolModule
