import type { DocArticle } from './types'

export const guideArticles: DocArticle[] = [
  {
    id: 'wallets',
    group: 'Guides',
    title: 'Wallets & accounts',
    description: 'Keep Zcash, EVM, and native NEAR accounts in one agent workflow, with the right network and signer for every action.',
    blocks: [
      { type: 'heading', id: 'wallet-model', text: 'Three wallets. One connection.' },
      { type: 'text', text: './AGENT organizes account access around three wallet types. Zcash handles shielded ZEC, the EVM wallet shares an address across supported EVM networks, and the native NEAR wallet uses NEAR account and access-key semantics. The agent carries context between them; each network still has its own balances, transaction format, fees, and settlement rules.' },
      { type: 'table', columns: ['Wallet', 'Account model', 'Use it for'], rows: [
        ['Zcash', 'Zcash addresses and shielded balances', 'Receive ZEC, authorize private payments, and fund supported cross-chain execution.'],
        ['EVM', 'One 0x address across the EVM registry', 'Native transfers, ERC-20 assets, swaps, and DeFi positions.'],
        ['Native NEAR', 'A NEAR account with scoped access keys', 'Native NEAR assets and transactions, separate from EVM balances.'],
      ] },
      { type: 'text', text: 'The examples here use the registered EVM wallet tool. Discover the connected server’s tools for Zcash and native NEAR account operations; do not substitute chain="zcash" or chain="near" into an EVM method. A shared MCP connection does not make account formats interchangeable.' },
      { type: 'heading', id: 'wallet-select', text: 'Select the account before the action' },
      { type: 'text', text: 'Start by listing wallets in the current account scope. The active wallet supplies the sender for subsequent execution calls. Use a descriptive name such as Treasury, then verify wallet info after switching. Switching changes the selected account; it does not transfer assets or merge histories.' },
      { type: 'code', label: 'List available EVM wallets', language: 'json', code: `{
  "name": "wallet",
  "arguments": { "action": "list" }
}` },
      { type: 'code', label: 'Select Treasury', language: 'json', code: `{
  "name": "wallet",
  "arguments": { "action": "switch", "name": "Treasury" }
}` },
      { type: 'code', label: 'Verify the active address', language: 'json', code: `{
  "name": "wallet",
  "arguments": { "action": "info" }
}` },
      { type: 'heading', id: 'wallet-balances', text: 'Read a balance on a specific network' },
      { type: 'text', text: 'Always include the chain when an instruction names a network. The wallet balance action defaults to Base, reads the native balance, and scans its known token list. A missing token in that summary does not prove a zero balance. Supply its contract address to query it directly. The same wallet address on Ethereum and Base has independent assets and gas balances.' },
      { type: 'code', label: 'Read Base balances', language: 'json', code: `{
  "name": "wallet",
  "arguments": { "action": "balance", "chain": "base" }
}` },
      { type: 'code', label: 'Read Base USDC explicitly', language: 'json', code: `{
  "name": "wallet",
  "arguments": {
    "action": "balance",
    "chain": "base",
    "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }
}` },
      { type: 'heading', id: 'wallet-management', text: 'Keep wallet identity clear' },
      { type: 'text', text: 'The wallet tool also exposes create, rename, delete, backup_export, backup_import, and recover_legacy. Deleting requires the wallet name and confirm=true. Recovery imports a matching legacy wallet into the current private scope; it does not reveal the private key. Keep identity changes separate from a pending send so the reviewed sender remains the executing sender.' },
      { type: 'code', label: 'Rename a wallet', language: 'json', code: `{
  "name": "wallet",
  "arguments": {
    "action": "rename",
    "oldName": "Trading Bot",
    "newName": "Treasury"
  }
}` },
      { type: 'note', title: 'Signer boundary', text: 'The built-in EVM wallet manager uses a server-managed vault; its create action returns private-key material. Treat that response as a secret and exclude it from transcripts, memory, analytics, and logs. A user-controlled signer connection is a separate authorization boundary. Do not infer non-custodial signing from a wallet name or an MCP connection alone.' },
      { type: 'links', items: [{ title: 'Execute a transfer', description: 'Quote, review, submit, and inspect the receipt.', href: '/docs#execution' }, { title: 'Network reference', description: 'Choose the right account and chain key.', href: '/docs#networks' }] },
    ],
  },
  {
    id: 'execution',
    group: 'Guides',
    title: 'Execute a transaction',
    description: 'Turn an instruction into a reviewed transfer and follow its onchain result.',
    blocks: [
      { type: 'heading', id: 'execution-lifecycle', text: 'Instruction → review → execution' },
      { type: 'text', text: 'Use wallet_send for a native-token or ERC-20 transfer from the active EVM wallet. It has three actions: quote, send, and status. A quote resolves the asset and amount, checks funds, and estimates gas without submitting the transfer. Sending is a separate write action. Status reads the resulting transaction on the named chain.' },
      { type: 'flow', items: ['Select wallet', 'Quote transfer', 'Review details', 'Authorize send', 'Check receipt'] },
      { type: 'note', title: 'Reading these examples', text: 'JSON examples show the name and arguments passed to MCP tools/call; the documentation does not execute them. Replace angle-bracket placeholders with verified values. Discover the connected server’s schema and authorization requirements before issuing a write. A listed method does not override account access, signer policy, or the deployment’s execution controls.' },
      { type: 'heading', id: 'execution-quote', text: '1. Prepare the transfer' },
      { type: 'code', label: 'Quote a 25 USDC transfer on Base', language: 'json', code: `{
  "name": "wallet_send",
  "arguments": {
    "action": "quote",
    "chain": "base",
    "token": "USDC",
    "to": "<verified-recipient-0x-address>",
    "amount": "25"
  }
}` },
      { type: 'text', text: 'The response identifies the selected wallet, its address, the recipient, the resolved amount and token, and estimated gas. Amount is a decimal string in human-readable token units: "25" means 25 USDC, not 25 base units. Native assets use token="native"; ERC-20 assets can use a known symbol or an explicit contract address.' },
      { type: 'heading', id: 'execution-review', text: '2. Review the exact instruction' },
      { type: 'list', items: ['Confirm the sender wallet and network match the user’s instruction.', 'Check the full destination address, resolved token contract, and amount.', 'Keep enough native currency for gas, even when sending an ERC-20 token.', 'Authorize the particular transfer; a previous quote or stored preference is not fresh approval.'] },
      { type: 'text', text: 'Quotes are not reservations and do not issue a reusable quote identifier. The send handler performs fresh checks. If the active wallet, recipient, amount, or network changes, review the changed transfer again. The confirm field acknowledges configured amount thresholds; it is not a cryptographic signature or a substitute for the signer’s authorization.' },
      { type: 'code', label: 'Submit only after authorization', language: 'json', code: `{
  "name": "wallet_send",
  "arguments": {
    "action": "send",
    "chain": "base",
    "token": "USDC",
    "to": "<verified-recipient-0x-address>",
    "amount": "25",
    "confirm": true
  }
}` },
      { type: 'heading', id: 'execution-receipt', text: '3. Follow the transaction' },
      { type: 'text', text: 'Save the chain and hash together. The send handler waits for a receipt, but network delays can outlast that wait. A timeout is not evidence that nothing happened. Check status before submitting another transfer. A successful source-chain transaction also does not prove a separate cross-chain destination has settled.' },
      { type: 'code', label: 'Read the transaction status', language: 'json', code: `{
  "name": "wallet_send",
  "arguments": {
    "action": "status",
    "chain": "base",
    "hash": "<0x-transaction-hash>"
  }
}` },
      { type: 'table', columns: ['Status', 'Meaning', 'Next step'], rows: [
        ['success', 'A successful receipt was found.', 'Return the hash, network, and result to the user.'],
        ['reverted', 'The transaction failed onchain.', 'Inspect the failure and gas spent before preparing another action.'],
        ['pending', 'The transaction is known but has no receipt.', 'Continue status checks without resubmitting.'],
        ['not found yet', 'This RPC cannot find the hash.', 'Verify hash and chain; allow propagation time and inspect the explorer.'],
      ] },
      { type: 'heading', id: 'execution-max', text: 'Sending all while keeping gas' },
      { type: 'text', text: 'The all and max amount aliases use the available balance. Native-token sends keep a reserve; nativeReserve sets the amount retained in the chain’s native token, with 0.0005 as the default unless the server configures another value. The handler separately checks that the remaining balance covers estimated gas. These sends require confirmation. Changes in balance or gas can change the final send after its quote.' },
      { type: 'code', label: 'Quote a native transfer with a reserve', language: 'json', code: `{
  "name": "wallet_send",
  "arguments": {
    "action": "quote",
    "chain": "base",
    "token": "native",
    "to": "<verified-recipient-0x-address>",
    "amount": "all",
    "nativeReserve": "0.0005"
  }
}` },
    ],
  },
  {
    id: 'swaps',
    group: 'Guides',
    title: 'Swaps & cross-chain execution',
    description: 'Execute through Jumper and Relay with explicit assets, destinations, and transaction boundaries.',
    blocks: [
      { type: 'heading', id: 'swaps-tools', text: 'Choose the execution tool' },
      { type: 'text', text: './AGENT executes the requested asset movement. Quote calls prepare the details needed to authorize that movement. Jumper uses LI.FI routes for same-chain and cross-chain swaps; Relay provides cross-chain transfers. Both accept decimal-string amounts in human-readable units. Do not pre-multiply amounts by token decimals.' },
      { type: 'table', columns: ['Tool', 'Read action', 'Write action', 'Asset arguments'], rows: [
        ['jumper', 'quote or routes', 'swap', 'tokenIn on fromChain; tokenOut on toChain'],
        ['relay', 'quote', 'bridge', 'token on fromChain; toToken on toChain'],
      ] },
      { type: 'heading', id: 'swaps-jumper', text: 'Execute a same-chain swap' },
      { type: 'text', text: 'Use the same fromChain and toChain for a same-chain swap. The example supplies Base USDC and receives Base WETH. Set tokenOut explicitly even though the schema does not mark it required: the handler requires a resolved destination token. Jumper’s routes action returns a route preview through the same quote path; it is not a promise of an exhaustive ranked comparison.' },
      { type: 'code', label: 'Prepare 25 USDC → WETH on Base', language: 'json', code: `{
  "name": "jumper",
  "arguments": {
    "action": "quote",
    "fromChain": "base",
    "toChain": "base",
    "tokenIn": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "tokenOut": "0x4200000000000000000000000000000000000006",
    "amount": "25",
    "slippage": 0.5,
    "maxLossPercent": 3
  }
}` },
      { type: 'text', text: 'Review the quoted receive amount, minimum received, estimated gas, recipient, and route value assessment. Jumper expresses slippage as a percentage, so 0.5 means 0.5%. Its default is 1%. After authorization, use action="swap" with the reviewed parameters. The adapter requests a fresh route; an earlier preview does not lock a price.' },
      { type: 'code', label: 'Execute the reviewed swap', language: 'json', code: `{
  "name": "jumper",
  "arguments": {
    "action": "swap",
    "fromChain": "base",
    "toChain": "base",
    "tokenIn": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "tokenOut": "0x4200000000000000000000000000000000000006",
    "amount": "25",
    "slippage": 0.5,
    "maxLossPercent": 3
  }
}` },
      { type: 'heading', id: 'swaps-relay', text: 'Execute a cross-chain transfer' },
      { type: 'text', text: 'Token addresses are network-specific. For Base USDC to Arbitrum USDC, pass both contracts rather than assuming the source contract exists on the destination. toAddress defaults to the active wallet’s address; provide it explicitly when the destination is a different verified account. For native currency, Relay accepts the zero address.' },
      { type: 'code', label: 'Prepare Base USDC → Arbitrum USDC', language: 'json', code: `{
  "name": "relay",
  "arguments": {
    "action": "quote",
    "fromChain": "base",
    "toChain": "arbitrum",
    "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "toToken": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "amount": "100",
    "decimals": 6,
    "maxLossPercent": 3
  }
}` },
      { type: 'code', label: 'Submit the authorized Relay transfer', language: 'json', code: `{
  "name": "relay",
  "arguments": {
    "action": "bridge",
    "fromChain": "base",
    "toChain": "arbitrum",
    "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "toToken": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "amount": "100",
    "decimals": 6,
    "maxLossPercent": 3
  }
}` },
      { type: 'heading', id: 'swaps-settlement', text: 'Track approvals and settlement separately' },
      { type: 'text', text: 'ERC-20 routes can include an approval reset, an exact-amount approval, and the execution transaction. Keep every returned hash. Both adapters assess estimated value loss and reject routes above their limit; maxLossPercent defaults to 10 and cannot raise the ceiling above 10. Reducing it is allowed. A blocked route needs a different amount or route, not a fabricated success response.' },
      { type: 'text', text: 'Check the source receipt and then the destination balance or provider settlement evidence. The returned time estimate is not settlement proof. The EVM adapters validate supported EVM chain IDs; Zcash and native NEAR execution use their native integration paths. Shielded Zcash does not make an EVM source or destination transaction private.' },
      { type: 'note', title: 'Direct DEX helpers', text: 'The registered uniswap and pancakeswap tools expose helper schemas, but their direct live swap actions are disabled. Use Jumper for routed swaps. An action appearing in tools/list does not imply every branch submits a transaction.' },
      { type: 'links', items: [{ title: 'Transaction lifecycle', description: 'Understand authorization, hashes, and receipt status.', href: '/docs#execution' }] },
    ],
  },
  {
    id: 'defi',
    group: 'Guides',
    title: 'Lending, staking & yield',
    description: 'Use protocol-specific actions and understand the asset, network, and exit path before execution.',
    blocks: [
      { type: 'heading', id: 'defi-workflow', text: 'Read the position, then act' },
      { type: 'text', text: 'DeFi tools share the active EVM wallet, but they do not share a universal action schema. Inspect the protocol, account, market, asset units, and exit mechanism before submitting a write. Amounts in these protocol tools are JSON numbers, unlike decimal strings in wallet_send, Jumper, and Relay. Approval and protocol transactions may produce separate hashes.' },
      { type: 'heading', id: 'defi-aave', text: 'Aave V3' },
      { type: 'text', text: 'aave accepts supply, withdraw, and positions. The market argument selects the network; the pool registry includes Ethereum, Arbitrum, Base, Optimism, Polygon, and Avalanche. positions reads collateral, debt, available borrowing, and health factor. Supplying uses asset and amount, while withdrawals use -1 for the full amount.' },
      { type: 'code', label: 'Inspect an Ethereum Aave position', language: 'json', code: `{
  "name": "aave",
  "arguments": { "action": "positions", "market": "ethereum" }
}` },
      { type: 'code', label: 'Authorized supply of 100 USDC on Ethereum', language: 'json', code: `{
  "name": "aave",
  "arguments": {
    "action": "supply",
    "market": "ethereum",
    "asset": "USDC",
    "amount": 100
  }
}` },
      { type: 'text', text: 'The built-in write token map contains Ethereum USDC, USDT, DAI, WETH, and WBTC addresses. The multi-network pool list does not make that map valid on every network. Keep these write examples on Ethereum; verify a chain-specific asset mapping before using another market. The registered tool does not expose borrow or repay actions.' },
      { type: 'heading', id: 'defi-lido', text: 'Lido' },
      { type: 'text', text: 'lido runs on Ethereum and exposes stake, withdraw, and positions. stake accepts an ETH amount and optionally wrapToWstETH. Wrapping adds approval and wrapping operations after staking, so distinguish their receipts. Read positions to inspect stETH and wstETH balances. The withdraw action explains the withdrawal queue; it does not submit a withdrawal request or claim.' },
      { type: 'code', label: 'Authorized stake with wrapping', language: 'json', code: `{
  "name": "lido",
  "arguments": {
    "action": "stake",
    "amount": 0.1,
    "wrapToWstETH": true
  }
}` },
      { type: 'heading', id: 'defi-morpho', text: 'Morpho vaults' },
      { type: 'text', text: 'morpho accepts supply, withdraw, and positions. Named vaults are steakhouse-usdc, gauntlet-usdc, and gauntlet-weth; their built-in addresses are Ethereum vaults. positions checks those named Ethereum vaults. A supplied custom address does not bring verified metadata with it: the handler falls back to Ethereum USDC and six decimals for unrecognized vaults.' },
      { type: 'code', label: 'Inspect named Morpho vault positions', language: 'json', code: `{
  "name": "morpho",
  "arguments": { "action": "positions" }
}` },
      { type: 'text', text: 'Supply calls an ERC-4626 deposit. Withdrawal calls redeem, whose input is vault shares, although this adapter scales amount using its configured asset decimals. Do not assume a requested underlying-asset amount is a valid redemption amount. Verify share units and conversion in the adapter before issuing a redemption or using its -1 branch.' },
      { type: 'heading', id: 'defi-pendle', text: 'Pendle markets' },
      { type: 'text', text: 'pendle exposes markets, positions, buy_pt, and buy_yt. Market discovery accepts Ethereum, Arbitrum, or Base, and sorts by apy, tvl, or maturity. Read maturity alongside implied APY: principal tokens and yield tokens have different exposure and expiry behavior. positions identifies the wallet and directs balance checks; it does not enumerate a complete PT/YT portfolio.' },
      { type: 'code', label: 'Read Ethereum markets by maturity', language: 'json', code: `{
  "name": "pendle",
  "arguments": {
    "action": "markets",
    "chain": "ethereum",
    "sortBy": "maturity"
  }
}` },
      { type: 'text', text: 'The declared buy actions use native ETH on Ethereum, with market, amount, and slippage parameters. The built-in handler does not forward the provider’s returned transaction calldata, so those branches are not a validated execution path. Use market discovery and balance inspection here; do not report a purchase from a successful market lookup.' },
      { type: 'heading', id: 'defi-ethena', text: 'Ethena' },
      { type: 'text', text: 'ethena uses Ethereum USDe and sUSDe. stake accepts an amount of USDe and deposits it into the sUSDe vault; positions reads both token balances. mint returns information about issuer access requirements rather than submitting a mint. This tool has no unstake or redeem action, so establish the separate exit path before entering a position.' },
      { type: 'code', label: 'Read USDe and sUSDe balances', language: 'json', code: `{
  "name": "ethena",
  "arguments": { "action": "positions" }
}` },
      { type: 'code', label: 'Authorized 100 USDe deposit', language: 'json', code: `{
  "name": "ethena",
  "arguments": { "action": "stake", "amount": 100 }
}` },
      { type: 'heading', id: 'defi-ondo', text: 'Ondo assets' },
      { type: 'text', text: 'ondo positions reads the configured Ethereum USDY and OUSG balances. Its mint and redeem actions return issuer-onboarding information; they do not move funds. Treat access to issuer products separately from holding or transferring a token. Approximate APY or USD annotations in protocol output are context, not a live execution quote or a guaranteed return.' },
      { type: 'code', label: 'Read configured Ondo balances', language: 'json', code: `{
  "name": "ondo",
  "arguments": { "action": "positions" }
}` },
      { type: 'links', items: [{ title: 'Market data', description: 'Read prices and asset context separately from execution.', href: '/docs#market-data' }, { title: 'Execution troubleshooting', description: 'Handle approvals, insufficient gas, and uncertain results.', href: '/docs#troubleshooting' }] },
    ],
  },
  {
    id: 'market-data',
    group: 'Guides',
    title: 'Market data & analytics',
    description: 'Give the agent price, chart, account, and token context without submitting transactions.',
    blocks: [
      { type: 'heading', id: 'market-prices', text: 'Read prices in context' },
      { type: 'text', text: 'market_data has price, prices, chart, and gas actions. Price data comes from CoinGecko. Single-token requests take token; batch requests take tokens as a comma-separated string, not an array. Use a CoinGecko ID when a symbol has no alias. For Zcash, use zcash rather than assuming the ZEC ticker is mapped.' },
      { type: 'code', label: 'Read Zcash pricing', language: 'json', code: `{
  "name": "market_data",
  "arguments": { "action": "price", "token": "zcash", "currency": "usd" }
}` },
      { type: 'code', label: 'Read Zcash, ETH, and NEAR together', language: 'json', code: `{
  "name": "market_data",
  "arguments": {
    "action": "prices",
    "tokens": "zcash,ETH,NEAR",
    "currency": "usd"
  }
}` },
      { type: 'text', text: 'A market price is not the amount an execution route will deliver. Token identity, liquidity, transfer taxes, route fees, and slippage affect that result. Keep source and retrieval time with data displayed to a user, and refresh price-sensitive context before preparing a transaction. A quote-currency argument affects price requests; chart output uses USD.' },
      { type: 'heading', id: 'market-chart', text: 'Read charts and gas context' },
      { type: 'code', label: 'Read a seven-day Zcash chart', language: 'json', code: `{
  "name": "market_data",
  "arguments": { "action": "chart", "token": "zcash", "days": 7 }
}` },
      { type: 'text', text: 'Chart requests accept the provider’s supported day windows: 1, 7, 14, 30, 90, 180, or 365. The response summarizes the latest ten OHLC candles rather than returning an interactive chart or the full historical series. The gas action supplies approximate network guidance; use a transaction quote for the actual gas estimate.' },
      { type: 'heading', id: 'market-analytics', text: 'Inspect assets and accounts' },
      { type: 'text', text: 'analytics exposes portfolio, whale_activity, token_security, sentiment, and resolve_ens. portfolio identifies the active wallet and points to balance and position tools. token_security accepts a contract address and supported chain, combines provider flags with trading context, and does not certify an asset as safe. resolve_ens takes name for a name or address lookup.' },
      { type: 'code', label: 'Inspect Base USDC token context', language: 'json', code: `{
  "name": "analytics",
  "arguments": {
    "action": "token_security",
    "chain": "base",
    "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }
}` },
      { type: 'note', title: 'Interpret the source correctly', text: 'whale_activity summarizes market volume and price context; it is not a verified feed of individual whale transactions. Sentiment is third-party context. Treat unavailable provider fields as unknown, and do not convert a missing result into a zero balance, a safe token, or an execution signal.' },
    ],
  },
  {
    id: 'memory',
    group: 'Guides',
    title: 'Preferences & history',
    description: 'Carry useful context between sessions while keeping secrets and transaction authorization outside memory.',
    blocks: [
      { type: 'heading', id: 'memory-preferences', text: 'Remember preferences explicitly' },
      { type: 'text', text: 'memory stores named facts with optional tags. Use stable keys for preferences that the user actually supplied: a preferred network, an account label, or a requirement to review fees. Memory makes context retrievable; it does not enforce a spending policy, authorize future transactions, or schedule execution.' },
      { type: 'code', label: 'Store a review preference', language: 'json', code: `{
  "name": "memory",
  "arguments": {
    "action": "remember",
    "key": "execution.review",
    "value": "Show the network, recipient, amount, and fees before every transfer.",
    "tags": ["preferences", "execution"]
  }
}` },
      { type: 'code', label: 'Recall execution preferences', language: 'json', code: `{
  "name": "memory",
  "arguments": {
    "action": "recall",
    "query": "transfer",
    "tag": "preferences",
    "limit": 5
  }
}` },
      { type: 'text', text: 'recall accepts a query, a tag, or both. list can filter by tag; stats reports counts and date ranges. Avoid storing an entire conversation when one concise preference is sufficient. If a current instruction contradicts an old preference, resolve that difference explicitly instead of silently applying stale context.' },
      { type: 'heading', id: 'memory-history', text: 'Scope history to the wallet' },
      { type: 'text', text: 'history defaults to active_wallet and uses the selected wallet address. Entries without wallet metadata stay out of that view. scope="all" reads the full configured memory store, including unscoped legacy entries; reserve it for an appropriately isolated runtime. If no active wallet exists, select one before asking for wallet-specific history.' },
      { type: 'code', label: 'Read recent swaps for the active wallet', language: 'json', code: `{
  "name": "memory",
  "arguments": {
    "action": "history",
    "type": "swap",
    "scope": "active_wallet",
    "limit": 10
  }
}` },
      { type: 'text', text: 'History is a record of tool activity and stored context, not an authoritative ledger of all account activity. Confirm an execution result with its chain receipt. Transactions made through a different application, incomplete tool calls, or older unscoped records can differ from the agent’s history.' },
      { type: 'heading', id: 'memory-cleanup', text: 'Update and remove stale context' },
      { type: 'text', text: 'Use forget for one known key and bulk_forget for all entries under a tag. Bulk deletion does not have a confirmation argument, so the application should establish the user’s intent before sending it. Deleting memory does not delete blockchain records or a client’s separately retained chat history.' },
      { type: 'code', label: 'Remove a named preference', language: 'json', code: `{
  "name": "memory",
  "arguments": { "action": "forget", "key": "execution.review" }
}` },
      { type: 'code', label: 'Inspect memory statistics', language: 'json', code: `{
  "name": "memory",
  "arguments": { "action": "stats" }
}` },
      { type: 'note', title: 'Keep secrets out of memory', text: 'Never store recovery phrases, private keys, spending keys, backup passwords, session credentials, or connector tokens. Store a non-secret account label or public transaction reference instead. A remembered preference is also untrusted context, not permission to bypass a signer or change the recipient of an action.' },
    ],
  },
  {
    id: 'networks',
    group: 'Reference',
    title: 'Networks & account types',
    description: 'The EVM chain registry, native assets, and the separate Zcash and NEAR account paths.',
    blocks: [
      { type: 'heading', id: 'networks-registry', text: 'EVM network keys' },
      { type: 'text', text: 'Use these lowercase keys in wallet and wallet_send calls. Network labels are for display; numeric chain IDs identify the execution environment. The same EVM address can exist on every network while holding different assets. Token symbols are not contract identities, and a token contract on one network is not automatically valid on another.' },
      { type: 'table', columns: ['Network', 'Tool key', 'Chain ID', 'Native asset'], rows: [
        ['Ethereum', 'ethereum', '1', 'ETH'],
        ['Arbitrum', 'arbitrum', '42161', 'ETH'],
        ['Base', 'base', '8453', 'ETH'],
        ['Optimism', 'optimism', '10', 'ETH'],
        ['Polygon', 'polygon', '137', 'POL'],
        ['Avalanche C-Chain', 'avalanche', '43114', 'AVAX'],
        ['Abstract', 'abstract', '2741', 'ETH'],
        ['BNB Chain', 'bsc', '56', 'BNB'],
        ['Linea', 'linea', '59144', 'ETH'],
        ['zkSync Era', 'zksync', '324', 'ETH'],
      ] },
      { type: 'code', label: 'Read the active EVM wallet and network list', language: 'json', code: `{
  "name": "wallet",
  "arguments": { "action": "info" }
}` },
      { type: 'heading', id: 'networks-native', text: 'Zcash and native NEAR' },
      { type: 'text', text: 'The three-wallet architecture adds Zcash and native NEAR alongside the EVM account. Zcash uses its native address and shielding model for ZEC. Native NEAR uses NEAR accounts and access keys. Neither is an EVM chain key, and neither should be represented by a fabricated EVM chain ID. Select their native tools from the connected server rather than routing them through a generic 0x transfer.' },
      { type: 'text', text: 'NEAR Intents is a routing integration, distinct from native NEAR account operations. Likewise, funding a cross-chain action with shielded ZEC does not make the public destination private. Preserve the account type, source network, destination network, and asset identity in the request and receipt.' },
      { type: 'heading', id: 'networks-capabilities', text: 'A chain registry is not an adapter matrix' },
      { type: 'text', text: 'Each protocol has a narrower network surface. Jumper and Relay’s built-in chain map covers the EVM registry except Abstract. Aave uses its own pool map; Lido and Ethena are Ethereum integrations. Read the specific guide and runtime schema before choosing a network. Wallet balance support alone does not establish a swap route, a DeFi market, or destination settlement support.' },
      { type: 'links', items: [{ title: 'Wallet accounts', description: 'Select the correct wallet before reading or writing.', href: '/docs#wallets' }, { title: 'Protocol actions', description: 'Check the network and asset conventions for DeFi.', href: '/docs#defi' }] },
    ],
  },
  {
    id: 'troubleshooting',
    group: 'Build & operate',
    title: 'Errors & recovery',
    description: 'Separate transport failures, tool errors, and onchain outcomes before deciding what to retry.',
    blocks: [
      { type: 'heading', id: 'troubleshooting-result', text: 'Inspect the tool result' },
      { type: 'text', text: 'An MCP request can reach the server successfully while the tool returns isError=true. Check that flag and read its content before summarizing the outcome. Conversely, an informational response can be a valid result without submitting a transaction. Require a hash and the relevant receipt when presenting an execution as complete.' },
      { type: 'code', label: 'Example tool-level failure', language: 'json', code: `{
  "content": [
    { "type": "text", "text": "Unknown chain. Use a supported chain key." }
  ],
  "isError": true
}` },
      { type: 'heading', id: 'troubleshooting-diagnosis', text: 'Diagnose before retrying' },
      { type: 'table', columns: ['Symptom', 'Check', 'Recovery'], rows: [
        ['No active wallet', 'Account scope and wallet selection', 'List wallets, switch to the intended sender, and verify info.'],
        ['Unknown chain or token', 'Exact key, contract address, and adapter coverage', 'Use the network registry and the tool’s chain-specific schema.'],
        ['Insufficient funds', 'Asset balance and native gas balance on the source chain', 'Read balances and reduce the amount or fund that network.'],
        ['Approval failure', 'Token balance, spender, and any existing approval transaction', 'Check the receipt and allowance before preparing another approval.'],
        ['Route blocked', 'Value loss, minimum received, supported assets, and provider output', 'Prepare a different valid route; do not bypass the loss ceiling.'],
        ['Access denied', 'Connected identity and required account access', 'Reconnect through the normal account authorization flow.'],
        ['Execution disabled', 'Deployment execution policy', 'Have the operator verify the intended environment and policy.'],
        ['Provider or RPC error', 'Affected chain, provider, and request type', 'Retry reads with backoff; investigate write status first.'],
      ] },
      { type: 'heading', id: 'troubleshooting-timeout', text: 'Treat a timeout as an uncertain result' },
      { type: 'text', text: 'A network interruption can happen before submission, after broadcast, or while waiting for a receipt. Preserve any hash already returned and query it on the source chain. Do not automatically resend because the client disconnected or a request timed out. A second successful send is a second transfer.' },
      { type: 'code', label: 'Recover a known transfer outcome', language: 'json', code: `{
  "name": "wallet_send",
  "arguments": {
    "action": "status",
    "chain": "base",
    "hash": "<hash-from-the-original-attempt>"
  }
}` },
      { type: 'text', text: 'When status is pending, allow confirmation time. When it is not found yet, verify the chain and full hash and inspect the explorer. If no hash was captured, investigate the sender’s recent activity and the operator’s execution record before deciding to resubmit. This tool does not accept an idempotency key that makes repeated sends harmless.' },
      { type: 'heading', id: 'troubleshooting-bridge', text: 'Separate source and destination outcomes' },
      { type: 'text', text: 'For a cross-chain action, check approval, source execution, and destination settlement independently. An approval may succeed while execution fails. A source receipt may succeed while the destination is still processing. Report the exact completed phase and keep the unresolved phase visible rather than calling the whole operation failed or complete.' },
      { type: 'heading', id: 'troubleshooting-report', text: 'Capture a useful diagnostic report' },
      { type: 'text', text: 'Record the tool name, action, timestamp, chain, non-secret account identifier, sanitized arguments, isError flag, and known transaction hashes. Exclude keys, passwords, bearer tokens, and raw secret-bearing wallet responses. Refresh tools/list after a server update or reconnect if a method or argument no longer matches the client’s cached schema.' },
      { type: 'links', items: [{ title: 'Transaction status', description: 'Interpret success, reverted, pending, and not found yet.', href: '/docs#execution' }, { title: 'Network reference', description: 'Validate the exact network key.', href: '/docs#networks' }] },
    ],
  },
]
