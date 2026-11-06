import { Link } from 'react-router-dom'
import '../supporting-sections.css'

const XIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
)

const TelegramIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" /></svg>
)

export default function Footer({ showInvitation = true }: { showInvitation?: boolean }) {
  return (
    <footer className="site-footer">
      <div className="sf-shell">
        {showInvitation && <div className="sf-invitation">
          <h2>Put your agent to work.</h2>
          <Link className="sf-connect" to="/toolkit">Connect your agent<span aria-hidden="true">↗</span></Link>
        </div>}
        <div className="sf-grid">
          <div className="sf-brand">
            <Link to="/" className="sf-wordmark" aria-label="./AGENT home"><img src="/dotslashagent.svg?v=2" alt="" /><span>AGENT</span></Link>
            <p>From your instruction to onchain execution.<br />One connection. Your agent.</p>
          </div>
          <div className="sf-link-group" role="navigation" aria-label="Explore AGENT">
            <h3>Explore</h3>
            <Link to="/">Home</Link>
            <Link to="/toolkit">Toolkit</Link>
            <Link to="/docs">Documentation</Link>
            <Link to="/presale">Access Pass</Link>
          </div>
          <div className="sf-link-group" role="navigation" aria-label="AGENT community">
            <h3>Stay connected</h3>
            <a href="https://github.com/agntmpp" target="_blank" rel="noopener noreferrer">GitHub<span aria-hidden="true">↗</span></a>
            <a href="https://x.com/dotslashagent" target="_blank" rel="noopener noreferrer"><XIcon />X / Twitter<span aria-hidden="true">↗</span></a>
            <a href="https://t.me/+SzRhx6BZxtI2YWQ1" target="_blank" rel="noopener noreferrer"><TelegramIcon />Telegram<span aria-hidden="true">↗</span></a>
            <Link to="/waitlist">Join the waitlist<span aria-hidden="true">↗</span></Link>
          </div>
        </div>
        <div className="sf-baseline"><span>© {new Date().getFullYear()} ./AGENT</span><span>Built by agents, for agents.</span></div>
      </div>
    </footer>
  )
}
