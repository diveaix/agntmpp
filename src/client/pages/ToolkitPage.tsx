import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Footer from '../components/Footer'
import Nav from '../components/Nav'
import Accordion, { AccordionItem } from '../components/Accordion'
import '../toolkit.css'

const MCP_URL = 'https://mcp.agntmpp.xyz/mcp'
const clients = [
  {
    id: 'claude', name: 'Claude', detail: 'Web & desktop', logo: '/claude-color.svg',
    heading: 'Add ./AGENT to Claude.',
    steps: ['Open Customize → Connectors in Claude.', 'Choose Add custom connector. Name it ./AGENT and paste the server URL below.', 'Add the connector, then enable ./AGENT in your conversation.'],
    action: 'Open Claude', href: 'https://claude.ai/settings/connectors',
    docs: 'https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities',
  },
  {
    id: 'cursor', name: 'Cursor', detail: 'Editor', logo: '/cursor-for-terminal.svg',
    heading: 'Bring execution to Cursor.',
    steps: ['Use Add to Cursor to open the MCP installation prompt.', 'Review the server in Cursor and add ./AGENT.', 'Open an agent conversation and ask ./AGENT to take an action.'],
    action: 'Add to Cursor', href: `cursor://anysphere.cursor-deeplink/mcp/install?name=agent&config=${encodeURIComponent(btoa(JSON.stringify({ url: MCP_URL })))}`,
    code: JSON.stringify({ mcpServers: { agent: { url: MCP_URL } } }, null, 2), codeLabel: 'Or add to .cursor/mcp.json',
    docs: 'https://cursor.com/docs/mcp/install-links',
  },
  {
    id: 'codex', name: 'Codex', detail: 'App & CLI', logo: '/codex-color.svg',
    heading: 'Connect ./AGENT to Codex.',
    steps: ['Run the command below in your terminal.', 'Open Codex and check ./AGENT in your MCP server settings.', 'Start a conversation with the tools available to your agent.'],
    code: `codex mcp add agent --url ${MCP_URL}`, codeLabel: 'Add the MCP server',
    docs: 'https://developers.openai.com/codex/mcp',
  },
  {
    id: 'claude-code', name: 'Claude Code', detail: 'Terminal', logo: '/claudecode-color.svg',
    heading: 'One command. Your tools.',
    steps: ['Run the command below in your terminal.', 'Open Claude Code and use /mcp to review the connection.', 'Ask your agent to create a wallet or execute a transaction.'],
    code: `claude mcp add --transport http agent ${MCP_URL}`, codeLabel: 'Add the MCP server',
    docs: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'vscode', name: 'VS Code', detail: 'Copilot', logo: '/vscode.svg',
    heading: 'Put ./AGENT in your editor.',
    steps: ['Open the Command Palette and run MCP: Add Server.', 'Choose HTTP, paste the server URL and name the server agent.', 'Start the server, review its tools and use them in agent chat.'],
    code: JSON.stringify({ servers: { agent: { type: 'http', url: MCP_URL } } }, null, 2), codeLabel: 'Or add to .vscode/mcp.json',
    docs: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers',
  },
  {
    id: 'other', name: 'Another agent', detail: 'Any MCP client', logo: '',
    heading: 'Your agent. The same connection.',
    steps: ['Open your agent’s MCP or connector settings.', 'Add a remote server with Streamable HTTP and paste the server URL.', 'Name it agent, review the connection and load its tools.'],
    docs: 'https://modelcontextprotocol.io/docs/learn/architecture',
  },
]

const prompts = [
  { label: 'WALLETS', text: 'Create my Zcash and EVM wallets.' },
  { label: 'ZCASH', text: 'Move 100 USDC on Base into my shielded Zcash wallet.' },
  { label: 'EXECUTION', text: 'Swap 0.1 ETH for USDC on Ethereum.' },
  { label: 'NEAR', text: 'Send 2 NEAR to my saved recipient.' },
  { label: 'BALANCES', text: 'Show my ZEC, NEAR and EVM balances.' },
  { label: 'RECEIPTS', text: 'Show the status of my last transaction.' },
]

const faqs = [
  { question: 'What does ./AGENT do?', answer: './AGENT is an execution layer for your agent. It turns your instructions into wallet actions, transfers and swaps across Zcash, EVM networks and NEAR, and brings the transaction result back into your conversation.' },
  { question: 'How do I connect?', answer: 'Choose your agent above and add the hosted MCP server. Your agent discovers ./AGENT’s tools through that connection. Setup and connection management stay in your MCP client.' },
  { question: 'Which wallets do I get?', answer: 'A shielded Zcash wallet and a multichain EVM wallet, with native NEAR account access through the same MCP connection. Ethereum, Base, Arbitrum, Optimism, BNB Chain, Arc and Robinhood Chain sit alongside Zcash and NEAR in one conversation.' },
  { question: 'Who controls my funds?', answer: 'You do. The wallets are non-custodial: you control the keys and authorize transactions. Your agent prepares and executes your instructions through ./AGENT without needing your recovery phrase.' },
  { question: 'What stays private?', answer: 'Shielded Zcash transactions protect the sender, recipient and amount within the shielded pool. Activity on EVM networks and NEAR remains public. Moving between chains does not make the public side of a transaction private.' },
  { question: 'Do I need to run a server?', answer: 'No. Add the hosted URL to a client that supports remote MCP over Streamable HTTP. ./AGENT provides the tools; you keep using the agent you already know.' },
]

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), 2600)
  }
  return <button type="button" className="tk-copy" onClick={copy} aria-label={state === 'copied' ? 'Copied to clipboard' : label}>
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">{state === 'copied'
      ? <path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      : <><rect x="7" y="7" width="9" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" /><path d="M12 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.3" /></>}</svg>
    <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Select & copy manually' : label}</span>
  </button>
}

export default function ToolkitPage() {
  const [selected, setSelected] = useState('claude')
  const client = clients.find(({ id }) => id === selected)!

  return <>
    <Nav />
    <main className="toolkit-page">
      <header className="tk-heading">
        <div><h1>Your agent.<br /><span>Connected.</span></h1></div>
        <div className="tk-intro"><p>Wallets. Transfers. Onchain execution.<br />One MCP connection, inside your agent.</p><div className="tk-networks"><span>Zcash</span><span>EVM</span><span>NEAR</span></div></div>
      </header>

      <section id="connect" className="tk-connect" aria-labelledby="tk-connect-title">
        <div className="tk-connect-top"><h2 id="tk-connect-title">Connect your agent</h2></div>
        <div className="tk-connect-grid">
          <div className="tk-client-picker" role="group" aria-label="Choose your agent">
            {clients.map(item => <button type="button" key={item.id} aria-pressed={selected === item.id} aria-controls="tk-client-guide" onClick={() => setSelected(item.id)}>
              <span className="tk-client-icon">{item.logo ? <img src={item.logo} alt="" /> : <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}</span>
              <span className="tk-client-name">{item.name}<small>{item.detail}</small></span><ArrowIcon />
            </button>)}
          </div>
          <div id="tk-client-guide" className="tk-guide" key={client.id}>
            <h3>{client.heading}</h3>
            <ol className="tk-steps">{client.steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol>
            <div className="tk-endpoint">
              <div className="tk-endpoint-label"><span>Server URL</span><span>Streamable HTTP</span></div>
              <div className="tk-url-row"><input aria-label="MCP server URL" readOnly value={MCP_URL} onFocus={event => event.target.select()} spellCheck={false} /><CopyButton value={MCP_URL} label="Copy URL" /></div>
            </div>
            {'code' in client && <div className="tk-config"><div><span>{client.codeLabel}</span><CopyButton value={client.code!} label="Copy setup" /></div><pre><code>{client.code}</code></pre></div>}
            <div className="tk-guide-actions">
              {'href' in client && <a className="tk-primary-action" href={client.href} target={client.id === 'claude' ? '_blank' : undefined} rel="noopener noreferrer">{client.action}<ArrowIcon /></a>}
              <a className="tk-guide-link" href={client.docs} target="_blank" rel="noopener noreferrer">{client.name === 'Another agent' ? 'About MCP' : `${client.name} setup guide`}<span aria-hidden="true">↗</span></a>
            </div>
          </div>
        </div>
        <div className="tk-connect-bottom"><span>Your agent is the interface.</span><span>Your keys stay yours.</span></div>
      </section>

      <section className="tk-prompts" aria-labelledby="tk-prompts-title">
        <div className="tk-section-heading"><div><h2>Say it. Execute it.</h2></div><p>Take a prompt into your agent.<br />Keep the whole action in one conversation.</p></div>
        <div className="tk-prompt-grid">{prompts.map(prompt => <article key={prompt.label}><span className="tk-prompt-label">{prompt.label}</span><p>{prompt.text}</p><CopyButton value={prompt.text} label="Copy prompt" /></article>)}</div>
      </section>

      <section className="tk-faq" aria-labelledby="tk-faq-title">
        <div className="tk-section-heading"><div><h2 id="tk-faq-title">Before you begin.</h2></div><Link to="/docs" className="tk-guide-link">Read the docs<span aria-hidden="true">↗</span></Link></div>
        <Accordion>{faqs.map((faq, index) => <AccordionItem key={faq.question} num={String(index + 1).padStart(3, '0')} title={faq.question}><p>{faq.answer}</p></AccordionItem>)}</Accordion>
      </section>
    </main>
    <Footer showInvitation={false} />
  </>
}
