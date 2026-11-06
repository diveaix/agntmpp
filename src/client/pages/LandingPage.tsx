import WorkstationHero from '../components/WorkstationHero'
import AgentSimulation from '../components/AgentSimulation'
import PrivacyGateway from '../components/PrivacyGateway'
import ExecutionSteps from '../components/ExecutionSteps'
import AgentCapabilities from '../components/AgentCapabilities'
import Accordion, { AccordionItem } from '../components/Accordion'
import CompatibleAgents from '../components/CompatibleAgents'
import Footer from '../components/Footer'
import Nav from '../components/Nav'
import PoweredBy from '../components/PoweredBy'
import SectionDivider from '../components/SectionDivider'
import WalletArchitecture from '../components/WalletArchitecture'
import { Link } from 'react-router-dom'
import '../landing-details.css'
import '../landing-layout.css'

export default function LandingPage() {
  return (
    <>
      <Nav />
      <main className="landing-page">
        <WorkstationHero />
        <PoweredBy />
        <AgentSimulation />
        <SectionDivider />
        <PrivacyGateway />
        <SectionDivider />
        <ExecutionSteps />
        <SectionDivider />
        <AgentCapabilities />
        <SectionDivider />

        <div className="landing-details">
          <WalletArchitecture />
          <SectionDivider />
          <section className="product-details site-section" aria-labelledby="product-details-title">
            <div className="section-heading">
              <h2 className="section-title" id="product-details-title">A closer look<br /><span>at ./AGENT.</span></h2>
              <p className="section-description">Understand the MCP connection, the execution flow, and the principles behind the tools.</p>
            </div>
            <Accordion>
              <AccordionItem num="001" title="The MCP connection" id="s-narrative">
                <div className="narrative-inner">
                  <p>Tell your agent what you want to do. ./AGENT turns the instruction into an onchain action: send ZEC, swap assets, move across networks, or manage a DeFi position.</p>
                  <div className="highlight"><p><strong>Your agent is the interface. MCP is the connection.</strong></p></div>
                  <p>Zcash, EVM, and NEAR share one conversation. Your agent prepares the transaction, you authorize it, and the execution result comes back with its status and transaction hash.</p>
                  <Link className="details-link" to="/toolkit">Connect your agent <span aria-hidden="true">↗</span></Link>
                </div>
              </AccordionItem>

              <AccordionItem num="002" title="The execution flow" id="s-protocol">
                <div className="protocol-flow">
                  <div className="flow-step"><span className="step-num">01</span><div><h4>Connect once</h4><p>Add the ./AGENT MCP URL to your existing agent. Your wallet and execution tools become part of the conversation.</p></div></div>
                  <div className="flow-step"><span className="step-num">02</span><div><h4>Give an instruction</h4><p>Name the asset, amount, and destination. Your agent prepares the action and shows the transaction details and fees.</p></div></div>
                  <div className="flow-step"><span className="step-num">03</span><div><h4>Authorize and execute</h4><p>Approve with your own signer. ./AGENT submits the transaction and carries the action through to settlement.</p></div></div>
                  <div className="flow-step"><span className="step-num">04</span><div><h4>Follow the result</h4><p>Get the transaction hash, status, and updated balances back in the same conversation.</p></div></div>
                </div>
              </AccordionItem>

              <AccordionItem num="003" title="Wallet and execution tools" id="s-stack">
                <div className="tech-grid">
                  <div className="tech-card"><span className="tag">Wallets</span><h4>One connected view</h4><p>Manage Zcash and EVM wallets alongside your NEAR account. Check balances and move assets across networks.</p></div>
                  <div className="tech-card"><span className="tag">Execution</span><h4>Instruction to onchain</h4><p>Execute swaps, transfers, and cross-chain actions. Authorize the transaction and follow its settlement.</p></div>
                  <div className="tech-card"><span className="tag">Zcash</span><h4>Shielded payments</h4><p>Send and receive ZEC with shielded addresses. Keep shielded transaction details private within Zcash.</p></div>
                  <div className="tech-card"><span className="tag">DeFi</span><h4>Put assets to work</h4><p>Supply, stake, and manage lending positions through your agent, with amounts and approvals in your control.</p></div>
                  <div className="tech-card"><span className="tag">Context</span><h4>Know what you sign</h4><p>See the asset, network, recipient, and fee before execution. Set clear instructions for your agent.</p></div>
                  <div className="tech-card"><span className="tag">Results</span><h4>A record of every action</h4><p>Transaction hashes, settlement status, and account updates return as structured results your agent can read.</p></div>
                </div>
              </AccordionItem>

              <AccordionItem num="004" title="Why we built ./AGENT" id="s-manifesto">
                <div className="manifesto-inner">
                  <h4>Your intent.<br /><span>Your execution.</span></h4>
                  <p className="manifesto-line">You already have an agent. Give it the ability to act.</p>
                  <p className="manifesto-line">One connection for your wallets, your networks, and your next move. Clear instructions. Your authorization. An onchain result.</p>
                  <Link className="details-link" to="/toolkit">Make the connection <span aria-hidden="true">↗</span></Link>
                </div>
              </AccordionItem>
            </Accordion>
          </section>
        </div>
        <SectionDivider />
        <CompatibleAgents />
      </main>
      <Footer />
    </>
  )
}
