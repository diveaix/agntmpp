import { useState, useEffect, useRef } from 'react'
import Nav from '../components/Nav'

/* ── Data ── */
const SECTIONS = [
  { id: 'getting-started', label: 'Getting Started', group: 'Start' },
  { id: 'connection', label: 'Connection', group: 'Start' },
  { id: 'wallets', label: 'Wallets', group: 'Tools' },
  { id: 'trading', label: 'Trading', group: 'Tools' },
  { id: 'perps', label: 'Perpetuals', group: 'Tools' },
  { id: 'defi', label: 'DeFi & Yield', group: 'Tools' },
  { id: 'bridges', label: 'Bridges', group: 'Tools' },
  { id: 'data', label: 'Market Data', group: 'Tools' },
  { id: 'automation', label: 'Automation', group: 'Advanced' },
  { id: 'intelligence', label: 'Agent Intelligence', group: 'Advanced' },
  { id: 'safety', label: 'Safety', group: 'Advanced' },
  { id: 'chains', label: 'Chains', group: 'Reference' },
  { id: 'protocols', label: 'Protocols', group: 'Reference' },
]

interface Tool { name: string; desc: string; protocol: string }

const TOOLS: Record<string, Tool[]> = {
  wallets: [
    { name: 'create_wallet', desc: 'Create a named wallet. Works across all EVM chains.', protocol: 'Tempo' },
    { name: 'list_wallets', desc: 'List all wallets with names and addresses.', protocol: 'Tempo' },
    { name: 'switch_wallet', desc: 'Switch active wallet by name.', protocol: 'Tempo' },
    { name: 'rename_wallet', desc: 'Rename a wallet without changing its address.', protocol: 'Tempo' },
    { name: 'wallet_info', desc: 'Full wallet details and token balances.', protocol: 'Tempo' },
    { name: 'get_balance', desc: 'Check balance of a specific token.', protocol: 'Tempo' },
  ],
  trading: [
    { name: 'smart_swap', desc: 'Auto-routes to the best pool across Uniswap, PancakeSwap, Aerodrome, Velodrome.', protocol: 'Smart Router' },
    { name: 'swap_tokens', desc: 'Swap any token pair on Tempo DEX.', protocol: 'Tempo DEX' },
    { name: 'get_swap_quote', desc: 'Preview swap with full fee breakdown.', protocol: 'Tempo DEX' },
    { name: 'uniswap_swap', desc: 'Swap on Uniswap V3 (ETH, ARB, BASE, OP, POLY).', protocol: 'Uniswap V3' },
    { name: 'pancake_swap', desc: 'Swap on PancakeSwap V3 (BSC, ETH, ARB, BASE).', protocol: 'PancakeSwap' },
    { name: 'jumper_swap', desc: 'Cross-chain swap via LiFi aggregator.', protocol: 'Jumper' },
    { name: 'dex_intel', desc: 'Discover pairs and liquidity via DexScreener.', protocol: 'DexScreener' },
    { name: 'swap_any_chain', desc: 'DEX aggregator swap on any EVM chain.', protocol: '1inch' },
  ],
  perps: [
    { name: 'hl_place_order', desc: 'Place limit/market orders on perpetual futures (1-50x leverage).', protocol: 'Hyperliquid' },
    { name: 'hl_cancel_order', desc: 'Cancel open orders by ID or market.', protocol: 'Hyperliquid' },
    { name: 'hl_positions', desc: 'View open positions with PnL and liquidation price.', protocol: 'Hyperliquid' },
    { name: 'hl_orderbook', desc: 'Live L2 orderbook depth for any perp market.', protocol: 'Hyperliquid' },
    { name: 'hl_account', desc: 'Account summary: value, margin, leverage.', protocol: 'Hyperliquid' },
    { name: 'hl_markets', desc: 'List markets with funding, volume, OI.', protocol: 'Hyperliquid' },
    { name: 'hl_set_leverage', desc: 'Set leverage (1-50x), cross or isolated.', protocol: 'Hyperliquid' },
    { name: 'hl_funding_history', desc: 'View recent funding payments.', protocol: 'Hyperliquid' },
  ],
  defi: [
    { name: 'aave_supply', desc: 'Supply tokens into Aave V3 to earn yield (6 chains).', protocol: 'Aave V3' },
    { name: 'aave_withdraw', desc: 'Withdraw + earned interest from Aave V3.', protocol: 'Aave V3' },
    { name: 'lido_stake', desc: 'Stake ETH for stETH/wstETH (~3-4% APY).', protocol: 'Lido' },
    { name: 'eigen_deposit', desc: 'Restake LSTs into EigenLayer.', protocol: 'EigenLayer' },
    { name: 'morpho_supply', desc: 'Supply to Morpho optimized vaults.', protocol: 'Morpho' },
    { name: 'pendle_buy_pt', desc: 'Buy Principal Tokens for fixed yield.', protocol: 'Pendle' },
    { name: 'pendle_buy_yt', desc: 'Buy Yield Tokens for leveraged yield.', protocol: 'Pendle' },
    { name: 'ethena_mint', desc: 'Mint USDe via delta-neutral hedging.', protocol: 'Ethena' },
    { name: 'ondo_mint', desc: 'Mint USDY — tokenized US Treasury yield.', protocol: 'Ondo' },
    { name: 'get_yield_opportunities', desc: 'Scan best yields across all DeFi.', protocol: 'DefiLlama' },
  ],
  bridges: [
    { name: 'bridge_tokens', desc: 'Bridge USDC.e/EURC.e via Stargate/LayerZero.', protocol: 'Stargate' },
    { name: 'relay_bridge', desc: 'Ultra-fast bridge via relayers (~10-30s).', protocol: 'Relay' },
    { name: 'debridge_bridge', desc: 'Decentralized cross-chain bridge.', protocol: 'deBridge' },
    { name: 'jumper_routes', desc: 'Compare all available cross-chain routes.', protocol: 'Jumper' },
  ],
  data: [
    { name: 'get_price', desc: 'Current price with 24h change and volume.', protocol: 'CoinGecko' },
    { name: 'get_chart', desc: 'OHLCV candle data (1d-1y timeframes).', protocol: 'CoinGecko' },
    { name: 'get_funding_rates', desc: 'Cross-venue funding rate comparison.', protocol: 'Hyperliquid' },
    { name: 'get_gas', desc: 'Gas estimates across all chains.', protocol: 'Multi-chain' },
    { name: 'defillama_tvl', desc: 'TVL for any protocol or chain.', protocol: 'DefiLlama' },
    { name: 'dune_query', desc: 'Execute Dune Analytics queries.', protocol: 'Dune' },
    { name: 'polymarket_markets', desc: 'Browse prediction markets.', protocol: 'Polymarket' },
  ],
  automation: [
    { name: 'create_dca', desc: 'Dollar-cost average: buy X every N hours.', protocol: 'Tempo' },
    { name: 'create_alert', desc: 'Price alert with auto-trade execution.', protocol: 'Multi-chain' },
    { name: 'list_automations', desc: 'Show all active DCAs and alerts.', protocol: 'Internal' },
    { name: 'cancel_automation', desc: 'Stop an automation by ID.', protocol: 'Internal' },
    { name: 'create_strategy', desc: 'Multi-step composable strategies.', protocol: 'Internal' },
    { name: 'copy_trade', desc: 'Mirror trades from a whale wallet.', protocol: 'Multi-chain' },
    { name: 'backtest_strategy', desc: 'Backtest DCA / momentum strategies.', protocol: 'CoinGecko' },
  ],
  intelligence: [
    { name: 'memory_remember', desc: 'Store encrypted key-value facts with tags.', protocol: 'Memory' },
    { name: 'memory_recall', desc: 'Search memories by keyword.', protocol: 'Memory' },
    { name: 'memory_history', desc: 'View auto-recorded trade history.', protocol: 'Memory' },
    { name: 'telegram_send', desc: 'Send messages to Telegram.', protocol: 'Telegram' },
    { name: 'telegram_alert', desc: 'Formatted alerts with severity levels.', protocol: 'Telegram' },
    { name: 'get_portfolio', desc: 'Aggregate portfolio across all chains.', protocol: 'Multi-chain' },
    { name: 'get_pnl', desc: 'Track realized/unrealized PnL.', protocol: 'Multi-chain' },
    { name: 'resolve_ens', desc: 'Resolve ENS names ↔ addresses.', protocol: 'ENS' },
  ],
  safety: [
    { name: 'revoke_approvals', desc: 'List and revoke token approvals.', protocol: 'Multi-chain' },
    { name: 'set_spending_limit', desc: 'Set daily USD spending cap.', protocol: 'Internal' },
    { name: 'emergency_stop', desc: 'Kill switch — pause all automations.', protocol: 'Internal' },
    { name: 'simulate_tx', desc: 'Dry-run transactions before execution.', protocol: 'Multi-chain' },
    { name: 'token_security_check', desc: 'Check for honeypot / rug indicators.', protocol: 'GoPlus' },
    { name: 'export_history', desc: 'Export full trade history report.', protocol: 'Internal' },
  ],
}

const CHAINS = [
  { name: 'Tempo', id: '4217', note: 'Sub-cent gas, ~500ms finality' },
  { name: 'Ethereum', id: '1', note: 'Mainnet' },
  { name: 'Base', id: '8453', note: 'Coinbase L2' },
  { name: 'Arbitrum', id: '42161', note: 'Arbitrum One' },
  { name: 'Optimism', id: '10', note: 'OP Mainnet' },
  { name: 'Polygon', id: '137', note: 'Polygon PoS' },
  { name: 'Avalanche', id: '43114', note: 'C-Chain' },
  { name: 'BSC', id: '56', note: 'BNB Chain' },
]

const PROTOCOLS = [
  { name: 'Tempo DEX', cat: 'Spot', chains: 'Tempo' },
  { name: 'Hyperliquid', cat: 'Perps', chains: 'Hyperliquid L1' },
  { name: 'Aave V3', cat: 'Lending', chains: '6 chains' },
  { name: 'Lido', cat: 'Staking', chains: 'Ethereum' },
  { name: 'EigenLayer', cat: 'Restaking', chains: 'Ethereum' },
  { name: 'Ethena', cat: 'Synthetic', chains: 'Ethereum' },
  { name: 'Morpho', cat: 'Lending', chains: 'ETH, Base' },
  { name: 'Pendle', cat: 'Yield', chains: 'ETH, ARB' },
  { name: 'Ondo', cat: 'RWA', chains: 'Ethereum' },
  { name: 'Uniswap V3', cat: 'DEX', chains: '5 chains' },
  { name: 'PancakeSwap', cat: 'DEX', chains: '4 chains' },
  { name: 'Jumper/LiFi', cat: 'Aggregator', chains: '8+ chains' },
  { name: 'Stargate', cat: 'Bridge', chains: '7+ chains' },
  { name: 'Relay', cat: 'Bridge', chains: '8+ chains' },
  { name: 'deBridge', cat: 'Bridge', chains: '12+ chains' },
  { name: 'DefiLlama', cat: 'Data', chains: 'All' },
  { name: 'DexScreener', cat: 'Data', chains: 'All' },
  { name: 'Dune', cat: 'Data', chains: 'All' },
  { name: 'Polymarket', cat: 'Predictions', chains: 'Polygon' },
  { name: 'Snapshot', cat: 'Governance', chains: 'Off-chain' },
]

/* ── Components ── */

function ToolTable({ tools }: { tools: Tool[] }) {
  return (
    <div className="d-table">
      <div className="d-table-head">
        <span>Tool</span><span>Protocol</span><span>Description</span>
      </div>
      {tools.map(t => (
        <div className="d-table-row" key={t.name}>
          <code>{t.name}</code>
          <span className="d-badge">{t.protocol}</span>
          <span>{t.desc}</span>
        </div>
      ))}
    </div>
  )
}

function CodeBlock({ label, children }: { label: string; children: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(children)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="d-code">
      <div className="d-code-head">
        <span>{label}</span>
        <button onClick={copy} className={`d-code-copy${copied ? ' copied' : ''}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{children}</code></pre>
    </div>
  )
}

/* ── Page ── */

export default function DocsPage() {
  const [active, setActive] = useState('getting-started')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')   // committed search
  const contentRef = useRef<HTMLDivElement>(null)

  // Intersection observer for active section tracking
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setActive(e.target.id); break }
      }
    }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 })
    SECTIONS.forEach(s => {
      const el = document.getElementById(s.id)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [])

  // Scroll-reveal
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('d-in') })
    }, { threshold: 0.08 })
    document.querySelectorAll('.d-reveal').forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  // Search logic
  const q = query.toLowerCase().trim()

  const matchTool = (t: Tool) =>
    !q || t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q) || t.protocol.toLowerCase().includes(q)

  const filteredTools: Record<string, Tool[]> = {}
  for (const [cat, tools] of Object.entries(TOOLS)) {
    filteredTools[cat] = tools.filter(matchTool)
  }

  const filteredChains = CHAINS.filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.note.toLowerCase().includes(q)
  )
  const filteredProtocols = PROTOCOLS.filter(p =>
    !q || p.name.toLowerCase().includes(q) || p.cat.toLowerCase().includes(q) || p.chains.toLowerCase().includes(q)
  )

  // Which sections have results?
  const sectionHasResults = (id: string): boolean => {
    if (!q) return true
    if (id === 'getting-started' || id === 'connection') return !q // hide when searching
    if (id === 'chains') return filteredChains.length > 0
    if (id === 'protocols') return filteredProtocols.length > 0
    const cat = SECTIONS.find(s => s.id === id)
    if (!cat) return false
    const toolCatMap: Record<string, string> = {
      wallets: 'wallets', trading: 'trading', perps: 'perps',
      defi: 'defi', bridges: 'bridges', data: 'data',
      automation: 'automation', intelligence: 'intelligence', safety: 'safety',
    }
    const toolKey = toolCatMap[id]
    return toolKey ? (filteredTools[toolKey]?.length ?? 0) > 0 : false
  }

  const doSearch = () => {
    setQuery(search)
    // scroll to first matching section
    if (search.trim()) {
      setTimeout(() => {
        const first = SECTIONS.find(s => sectionHasResults(s.id) && s.id !== 'getting-started' && s.id !== 'connection')
        if (first) scrollTo(first.id)
      }, 50)
    }
  }

  // Group sections for sidebar
  const groups = SECTIONS.reduce<Record<string, typeof SECTIONS>>((acc, s) => {
    ;(acc[s.group] ??= []).push(s)
    return acc
  }, {})

  return (
    <>
      <Nav />
      <main className="d-layout">
        {/* ─── Sidebar Rail ─── */}
        <aside className="d-rail" aria-label="Documentation navigation">
          <div className="d-rail-inner">
            <a className="d-brand" href="/">
              <img src="/AGNT.svg" alt="AGNT" className="d-brand-logo" />
              <span>AGNT DOCS</span>
            </a>
            {Object.entries(groups).map(([group, items]) => (
              <div className="d-nav-group" key={group}>
                <div className="d-nav-title">{group}</div>
                {items.map(s => (
                  <button
                    key={s.id}
                    className={`d-nav-link${active === s.id ? ' active' : ''}${q && !sectionHasResults(s.id) ? ' dimmed' : ''}`}
                    onClick={() => scrollTo(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        {/* ─── Content ─── */}
        <article className="d-content" ref={contentRef}>
          <div className="d-paper">

            {/* Hero */}
            <header className="d-hero d-reveal" id="getting-started">
              <div className="d-eyebrow">Documentation</div>
              <h1>The operator manual for autonomous&nbsp;agents.</h1>
              <p className="d-lead">102+ tools. 20+ protocols. One URL. Find a command, understand the risk, copy a working setup.</p>
              <div className="d-search">
                <span className="d-search-slash">/</span>
                <input
                  aria-label="Search docs"
                  placeholder="Search wallets, swaps, safety, memory…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') doSearch() }}
                />
                <button type="button" onClick={doSearch}>Search</button>
              </div>
              {q && (
                <div className="d-search-status">
                  Showing results for "<strong>{q}</strong>"
                  <button className="d-search-clear" onClick={() => { setQuery(''); setSearch('') }}>Clear</button>
                </div>
              )}
            </header>

            {/* Quick Start Callout */}
            {!q && (
              <div className="d-callout d-reveal">
                <div className="d-callout-inner">
                  <strong>Quick Start</strong>
                  <p>Create an AGNT account, generate an API key or connector URL from the dashboard, then add the MCP endpoint to your agent.</p>
                </div>
              </div>
            )}

            {/* Connection */}
            {!q && (
              <section className="d-section d-reveal" id="connection">
                <h2>Connection</h2>
                <p>Add one of these to your agent's MCP config after creating an API key or connector URL.</p>

                <div className="d-callout">
                  <div className="d-callout-inner">
                    <strong>Hosted endpoint</strong>
                    <p>Use SSE for most agent clients. Use streamable HTTP where the host asks for it. Self-hosting is available as a secondary trust path.</p>
                  </div>
                </div>

                <CodeBlock label="Claude Code">
                  {`claude mcp add agnt --transport sse "https://mcp.agntmpp.xyz/sse?agnt_connector_token=<your connector token>"`}
                </CodeBlock>
                <CodeBlock label="Cursor / Windsurf / Amp">
{`{
  "mcpServers": {
    "agnt": {
      "url": "https://mcp.agntmpp.xyz/sse?agnt_connector_token=<your connector token>"
    }
  }
}`}
                </CodeBlock>
                <CodeBlock label="Self-hosted">
                  {`npx @anthropic-ai/sdk mcp agnt --url http://localhost:3001/sse`}
                </CodeBlock>
              </section>
            )}

            {/* Wallets */}
            {sectionHasResults('wallets') && (
              <section className="d-section d-reveal" id="wallets">
                <h2>Wallets</h2>
                <p>Named wallets that work across every EVM chain. One key, every network.</p>
                <ToolTable tools={q ? filteredTools.wallets : TOOLS.wallets} />
              </section>
            )}

            {/* Trading */}
            {sectionHasResults('trading') && (
              <section className="d-section d-reveal" id="trading">
                <h2>Trading</h2>
                <p>Spot swaps across Tempo, Uniswap, PancakeSwap, Aerodrome, Velodrome — with Smart Routing for best execution.</p>
                <ToolTable tools={q ? filteredTools.trading : TOOLS.trading} />
              </section>
            )}

            {/* Perpetuals */}
            {sectionHasResults('perps') && (
              <section className="d-section d-reveal" id="perps">
                <h2>Perpetuals</h2>
                <p>Trade perpetual futures on Hyperliquid with up to 50x leverage.</p>
                <ToolTable tools={q ? filteredTools.perps : TOOLS.perps} />
              </section>
            )}

            {/* DeFi & Yield */}
            {sectionHasResults('defi') && (
              <section className="d-section d-reveal" id="defi">
                <h2>DeFi &amp; Yield</h2>
                <p>Lending, staking, restaking, and yield tokenization across top protocols.</p>
                <ToolTable tools={q ? filteredTools.defi : TOOLS.defi} />
              </section>
            )}

            {/* Bridges */}
            {sectionHasResults('bridges') && (
              <section className="d-section d-reveal" id="bridges">
                <h2>Bridges</h2>
                <p>Cross-chain transfers via Stargate, Relay, deBridge, and Jumper/LiFi.</p>
                <ToolTable tools={q ? filteredTools.bridges : TOOLS.bridges} />
              </section>
            )}

            {/* Market Data */}
            {sectionHasResults('data') && (
              <section className="d-section d-reveal" id="data">
                <h2>Market Data</h2>
                <p>Real-time prices, charts, gas, on-chain analytics, and prediction markets.</p>
                <ToolTable tools={q ? filteredTools.data : TOOLS.data} />
              </section>
            )}

            {/* Automation */}
            {sectionHasResults('automation') && (
              <section className="d-section d-reveal" id="automation">
                <h2>Automation</h2>
                <p>DCA strategies, price alerts, copy trading, and composable multi-step strategies.</p>
                <ToolTable tools={q ? filteredTools.automation : TOOLS.automation} />
              </section>
            )}

            {/* Agent Intelligence */}
            {sectionHasResults('intelligence') && (
              <section className="d-section d-reveal" id="intelligence">
                <h2>Agent Intelligence</h2>
                <p>Persistent memory, Telegram notifications, portfolio tracking, and ENS resolution.</p>
                <ToolTable tools={q ? filteredTools.intelligence : TOOLS.intelligence} />
              </section>
            )}

            {/* Safety */}
            {sectionHasResults('safety') && (
              <section className="d-section d-reveal" id="safety">
                <h2>Safety</h2>
                <p>Spending limits, approval revocation, transaction simulation, and kill switches.</p>
                {!q && (
                  <div className="d-callout">
                    <div className="d-callout-inner">
                      <strong>Recommended default</strong>
                      <p>Show spending limits and simulation status near every executable action. Make disabled states explicit when a wallet or route is missing.</p>
                    </div>
                  </div>
                )}
                <ToolTable tools={q ? filteredTools.safety : TOOLS.safety} />
              </section>
            )}

            {/* Chains */}
            {sectionHasResults('chains') && (
              <section className="d-section d-reveal" id="chains">
                <h2>Supported Chains</h2>
                <div className="d-chain-grid">
                  {(q ? filteredChains : CHAINS).map(c => (
                    <div className="d-chain-card" key={c.name}>
                      <span className="d-chain-name">{c.name}</span>
                      <span className="d-chain-id">Chain {c.id}</span>
                      <span className="d-chain-note">{c.note}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Protocols */}
            {sectionHasResults('protocols') && (
              <section className="d-section d-reveal" id="protocols">
                <h2>Integrated Protocols</h2>
                <div className="d-table">
                  <div className="d-table-head">
                    <span>Protocol</span><span>Category</span><span>Chains</span>
                  </div>
                  {(q ? filteredProtocols : PROTOCOLS).map(p => (
                    <div className="d-table-row" key={p.name}>
                      <strong>{p.name}</strong>
                      <span className="d-badge">{p.cat}</span>
                      <span>{p.chains}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* No results */}
            {q && !SECTIONS.some(s => sectionHasResults(s.id)) && (
              <div className="d-no-results">
                <p>No tools, chains, or protocols match "<strong>{q}</strong>"</p>
                <button onClick={() => { setQuery(''); setSearch('') }}>Clear search</button>
              </div>
            )}
          </div>
        </article>
      </main>
    </>
  )
}
