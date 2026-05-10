import { useState, useCallback } from 'react'
import MacScreen from '../components/MacScreen'
import BootSequence from '../components/BootSequence'
import LiveDemoTerminal from '../components/LiveDemoTerminal'
import Accordion, { AccordionItem } from '../components/Accordion'
import CompatibleAgents from '../components/CompatibleAgents'
import Footer from '../components/Footer'
import Nav from '../components/Nav'
import PoweredBy from '../components/PoweredBy'
import { Link } from 'react-router-dom'


import { GooeyFilter } from '@/components/ui/gooey-filter'
import { PixelTrail } from '@/components/ui/pixel-trail'
import { useScreenSize } from '@/hooks/use-screen-size'

export default function LandingPage() {
  const alreadyBooted = sessionStorage.getItem('agnt-booted') === '1'
  const [bootDone, setBootDone] = useState(alreadyBooted)
  const [scrollShow, setScrollShow] = useState(alreadyBooted)
  const [liveDemoOpen, setLiveDemoOpen] = useState(false)
  const onBoot = useCallback(() => { sessionStorage.setItem('agnt-booted', '1'); setBootDone(true); setTimeout(() => setScrollShow(true), 800) }, [])
  const screenSize = useScreenSize()

  return (
    <>
      <GooeyFilter id="hero-goo" strength={5} />
      <Nav />
      <section className="hero">
        <div
          className="absolute inset-0 z-0"
          style={{ filter: "url(#hero-goo)" }}
        >
          <PixelTrail
            pixelSize={screenSize.lessThan('md') ? 24 : 32}
            fadeDuration={0}
            delay={500}
            pixelClassName="bg-white"
          />
        </div>
        <div className="mac-container">
          <MacScreen />
          <div className="screen-wrap">
            <div className="screen-scan"></div>
            {!alreadyBooted && <BootSequence onComplete={onBoot} />}
            <div className={`screen-hero${bootDone ? ' show' : ''}`}>
              <h1>
                <span className="glitch-word" data-text="AGENTS">AGENTS</span>
                <br />DON'T<br />
                <span className="glitch-word" data-text="SLEEP">SLEEP</span>
              </h1>
              <p className="sub">Multi-Chain DeFi Terminal for Autonomous AI Agents</p>
              {bootDone && (
                <Link to="/toolkit" className="hero-cta">Access Toolkit →</Link>
              )}
            </div>
          </div>
        </div>
      </section>


      <PoweredBy />

      <Accordion>
        <AccordionItem num="001" title="The Problem" id="s-narrative">
          <div className="narrative-inner">
            <p>AI agents can write code, analyze data, and plan complex workflows. But the moment they need to move money — they hit a wall.</p>
            <p>There is no native financial layer for agents. No way for an AI to hold assets, execute trades, or settle payments without a human clicking buttons.</p>
            <div className="highlight"><p><mark>Your agent is powerful. But without financial access, it's powerless.</mark></p></div>
            <p><em>./AGNT</em> fixes this. It's a multi-chain DeFi terminal that plugs directly into any MCP-compatible agent — giving it 100+ financial tools with a single URL. Spot trading on Tempo, perpetual futures on Hyperliquid, automated DCA strategies, real-time market data, persistent memory, and agent-to-agent coordination via A2A. Your agent handles everything.</p>
          </div>
        </AccordionItem>

        <AccordionItem num="002" title="How It Works" id="s-protocol">
          <div className="protocol-flow">
            <div className="flow-step"><div className="step-num">01</div><h3><mark>Add One URL</mark></h3><p>Paste our hosted MCP server URL into your agent's config. That's it — 100+ DeFi tools register instantly. No cloning, no npm install.</p></div>
            <div className="flow-step"><div className="step-num">02</div><h3><mark>Create Wallets</mark></h3><p>Your agent creates named wallets that work across all EVM chains. "Trading Bot", "Treasury", "DeFi Fund" — one key, every network.</p></div>
            <div className="flow-step"><div className="step-num">03</div><h3><mark>Trade Everything</mark></h3><p>Spot swaps on Tempo DEX. Perpetual futures on Hyperliquid with up to 50x leverage. Real-time market data and funding rates.</p></div>
            <div className="flow-step"><div className="step-num">04</div><h3><mark>Earn Yield</mark></h3><p>Supply to Aave, stake with Lido, restake on EigenLayer, or buy Pendle yield tokens. Your agent farms yield across DeFi protocols 24/7.</p></div>
            <div className="flow-step"><div className="step-num">05</div><h3><mark>Remember & Learn</mark></h3><p>Your agent remembers past trades, strategies, and your preferences via persistent memory. Encrypted, searchable, always available.</p></div>
            <div className="flow-step"><div className="step-num">06</div><h3><mark>Agent-to-Agent</mark></h3><p>Other agents discover your ./AGNT via the A2A protocol — delegate tasks, coordinate strategies, build an agent network. The full agentic stack: MCP + MPP + A2A.</p></div>
            <div className="flow-step"><div className="step-num">07</div><h3><mark>Automate</mark></h3><p>Set up DCA strategies, price alerts with auto-execution, and copy-trading. Your agent trades while you sleep — no manual intervention needed.</p></div>
            <div className="flow-step"><div className="step-num">08</div><h3><mark>Free During Hackathon</mark></h3><p>Connect the MCP server directly. Login, plans, checkout, and API keys are paused for the hackathon build.</p></div>
          </div>
        </AccordionItem>

        <AccordionItem num="003" title="What Your Agent Gets" id="s-stack">
          <div className="tech-grid">
            <div className="tech-card"><span className="tag">Wallets</span><h3><mark>Multi-Chain Wallets</mark></h3><p>One key, every EVM chain. Create, name, and switch between unlimited wallets — Tempo, Ethereum, Arbitrum, Base, and more.</p></div>
            <div className="tech-card"><span className="tag">Spot</span><h3><mark>Smart Routing</mark></h3><p>Auto-discovers the best liquidity via DexScreener and swaps across Tempo, Uniswap, PancakeSwap, Aerodrome, and Velodrome.</p></div>
            <div className="tech-card"><span className="tag">Perps</span><h3><mark>Hyperliquid</mark></h3><p>Trade perpetual futures on any market — BTC, ETH, SOL, DOGE — with up to 50x leverage. Orderbook, positions, funding rates.</p></div>
            <div className="tech-card"><span className="tag">Data</span><h3><mark>Market Intel</mark></h3><p>Real-time prices, OHLCV charts, funding rate comparisons, and gas estimates across all chains. Your agent's eyes on the market.</p></div>
            <div className="tech-card"><span className="tag">Automation</span><h3><mark>DCA & Alerts</mark></h3><p>Set up dollar-cost averaging, price alerts with auto-execution, and recurring strategies. Your agent trades while you sleep.</p></div>
            <div className="tech-card"><span className="tag">Bridge</span><h3><mark>Cross-Chain</mark></h3><p>Bridge USDC.e and EURC.e to 6 chains via Stargate / LayerZero. Fee quotes before execution.</p></div>
            <div className="tech-card"><span className="tag">Yield</span><h3><mark>Yield Farming</mark></h3><p>Supply to Aave, Morpho, and Pendle. Stake ETH with Lido, restake via EigenLayer. Your agent earns yield across top DeFi protocols.</p></div>
            <div className="tech-card"><span className="tag">Payments</span><h3><mark>Send with Memo</mark></h3><p>Send any token with optional payment memos — built for invoicing, reconciliation, and agent-to-agent payments.</p></div>
            <div className="tech-card"><span className="tag">A2A</span><h3><mark>Agent-to-Agent</mark></h3><p>Publish an Agent Card, receive tasks from other agents, and delegate work. The complete agentic protocol stack: MCP + MPP + A2A.</p></div>
            <div className="tech-card"><span className="tag">Memory</span><h3><mark>Persistent Context</mark></h3><p>Agents remember past trades, strategies, and user preferences across sessions. Encrypted, searchable, always available.</p></div>
            <div className="tech-card"><span className="tag">Governance</span><h3><mark>DAO Voting</mark></h3><p>Browse active proposals on Snapshot, cast gasless votes via EIP-712 signatures. Your agent participates in protocol governance.</p></div>
            <div className="tech-card"><span className="tag">Transparency</span><h3><mark>Fee Breakdown</mark></h3><p>Every trade shows fees, gas, slippage, and exchange rate before executing. No hidden costs.</p></div>
          </div>
        </AccordionItem>

        <AccordionItem num="004" title="Live Demo" id="s-terminal" onOpenChange={setLiveDemoOpen}>
          <LiveDemoTerminal isOpen={liveDemoOpen} />
        </AccordionItem>

        <AccordionItem num="005" title="Manifesto" id="s-manifesto">
          <div className="manifesto-inner">
            <h2>We Gave Agents <span className="glitch-word manifesto-glitch" data-text="Money">Money</span>.</h2>
            <p className="manifesto-line">AI agents can reason, plan, and execute — but they couldn't <mark>move value</mark>. They couldn't hold assets, trade perpetuals, or run strategies. <em>Until now.</em></p>
            <div className="manifesto-sep"><div className="sl"></div><span className="sg">◆</span><div className="sl"></div></div>
            <p className="manifesto-line"><em>./AGNT</em> is the <mark>financial layer for autonomous agents</mark>. One URL, 100+ tools, zero friction. Spot. Perps. Yield. Automations. Memory. Agent-to-Agent. Multi-chain. Free to start, paid when automation needs priority. <em>The protocol is the terminal. The terminal is alive.</em></p>
          </div>
        </AccordionItem>
      </Accordion>

      <CompatibleAgents />

      <Footer />
    </>
  )
}
