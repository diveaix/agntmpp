import Terminal from '../components/Terminal'
import Accordion, { AccordionItem } from '../components/Accordion'
import Footer from '../components/Footer'
import Nav from '../components/Nav'
import { Link } from 'react-router-dom'

export default function ToolkitPage() {
  return (
    <>
      <Nav />


      {/* Connection Guide */}
      <Terminal />

      {/* Example Usage */}
      <div className="mcp-setup">
        <h3>Talk to Your Agent — Examples</h3>
        <p style={{ fontSize: '11px', color: '#555', lineHeight: '1.8', marginBottom: '20px' }}>
          After connecting, your agent discovers all 102 tools automatically. Just speak naturally:
        </p>
        <div className="usage-examples">
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Create a wallet called Trading Bot"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Swap 500 USDC.e for wETH — show me the fees first"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Open a 5x long on ETH-PERP with 0.5 ETH"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Stake 10 ETH via Lido and wrap to wstETH"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Find the best yield opportunities for USDC above 5% APY"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"What's the TVL of Aave on DefiLlama?"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Set up a DCA — buy $50 of wETH every 6 hours"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Bridge 100 USDC to Arbitrum via Relay"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Show me trending Polymarket predictions"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Find the best pool for PEPE/USDC on Base"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Remember that I prefer low-risk strategies with max 5x leverage"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"What trades did I do last week?"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Send me a Telegram alert when ETH drops below $2000"</span>
          </div>
          <div className="usage-example">
            <span className="usage-prompt">→</span>
            <span className="usage-text">"Supply 1000 USDC to Aave on Arbitrum and enable as collateral"</span>
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div className="faq">
        <h3>FAQ</h3>
        <Accordion>
          <AccordionItem num="01" title="What is ./AGNT?">
            <div className="narrative-inner"><p>The most comprehensive <mark>DeFi terminal for AI agents</mark>. 102+ MCP tools covering wallets, spot trading, Smart Routing on multiple DEXes, perpetual futures, lending, yield farming, liquid staking, restaking, cross-chain swaps, bridges, market intelligence, prediction markets, analytics platforms, automated strategies, safety controls, DAO governance, persistent agent memory, Telegram notifications, and agent-to-agent coordination via A2A — all from <mark>a single URL</mark>.</p></div>
          </AccordionItem>
          <AccordionItem num="02" title="How do I connect my agent?">
            <div className="narrative-inner"><p>Create an API key or Claude connector URL from your AGNT dashboard, then add the hosted MCP endpoint to your agent config. Claude-style clients can use the connector URL directly; clients with header support should send <em>x-agnt-api-key</em>.</p></div>
          </AccordionItem>
          <AccordionItem num="03" title="Do I need to install anything?">
            <div className="narrative-inner"><p><mark>No</mark>. We host the MCP server. Just add the URL and your agent connects instantly. If you prefer self-hosting, you can clone the repo and run <mark>npx @agnt/mcp</mark> locally.</p></div>
          </AccordionItem>
          <AccordionItem num="04" title="What agents are supported?">
            <div className="narrative-inner"><p><em>Claude Desktop</em>, <em>Cursor</em>, <em>Windsurf</em>, <em>Amp</em>, <em>Antigravity</em>, and <mark>any MCP-compatible agent</mark>. If your agent supports the Model Context Protocol, it works with ./AGNT — all 100+ tools register automatically.</p></div>
          </AccordionItem>
          <AccordionItem num="05" title="What protocols are supported?">
            <div className="narrative-inner"><p>Tempo DEX, Hyperliquid, Aave V3, Lido, EigenLayer, Ethena, Morpho, Pendle, Ondo Finance, Uniswap V3, PancakeSwap, Jumper/LiFi, Relay, deBridge, Stargate/LayerZero, DefiLlama, Dune Analytics, Polymarket, and more. Check our <Link to="/docs">documentation</Link> for the full list.</p></div>
          </AccordionItem>
          <AccordionItem num="06" title="Are my keys safe?">
            <div className="narrative-inner"><p>Wallet keys are generated and encrypted with <mark>AES-256-GCM</mark> on the machine running your MCP server — whether that's your laptop or your own VPS. Keys <mark>never leave that machine</mark> and are never transmitted over the network. Every transaction is signed server-side by your agent's wallet.</p></div>
          </AccordionItem>
          <AccordionItem num="07" title="How does payment work?">
            <div className="narrative-inner"><p>Create an account, then use the Plans page to choose the access level you need. API keys and Claude connector URLs are generated from your dashboard and stay tied to your account.</p></div>
          </AccordionItem>
          <AccordionItem num="08" title="What is A2A?">
            <div className="narrative-inner"><p>A2A (Agent-to-Agent) is Google's open standard for <mark>agent coordination</mark>. ./AGNT publishes an Agent Card at <em>/.well-known/agent.json</em> so other agents can discover its DeFi capabilities and submit tasks. Combined with MCP (agent↔tools) and MPP (agent↔payments), ./AGNT is the first DeFi toolkit with the <mark>complete agentic protocol stack</mark>.</p></div>
          </AccordionItem>
          <AccordionItem num="09" title="Does my agent remember things?">
            <div className="narrative-inner"><p>Yes. The built-in <mark>Agent Memory</mark> tool stores facts, trade history, and preferences in an encrypted file (<mark>AES-256-GCM</mark>). Your agent can recall past trades, remember risk preferences, and learn from previous performance — all persisted across sessions.</p></div>
          </AccordionItem>
        </Accordion>
      </div>

      <Footer />
    </>
  )
}
