import { useState, useEffect } from 'react'
import '../supporting-sections.css'

interface Agent {
  name: string
  logo: string
  url: string
  inlineSvg?: boolean
}

const AGENTS: Agent[] = [
  { name: 'Codex', logo: '/codex-color.svg', url: 'https://openai.com/codex' },
  { name: 'Claude Code', logo: '/claudecode-color.svg', url: 'https://claude.com/product/claude-code' },
  { name: 'Cursor', logo: '/cursor.svg', url: 'https://www.cursor.com/', inlineSvg: true },
  { name: 'OpenCode', logo: '/opencode.svg', url: 'https://opencode.ai/', inlineSvg: true },
  { name: 'Gemini CLI', logo: '/geminicli-color.svg', url: 'https://geminicli.com' },
  { name: 'AI Studio', logo: '/aistudio.svg', url: 'https://aistudio.google.com/', inlineSvg: true },
  { name: 'Windsurf', logo: '/windsurf.svg', url: 'https://windsurf.com/', inlineSvg: true },
  { name: 'Amp', logo: '/amp-color.svg', url: 'https://ampcode.com/' },
]

function InlineSvg({ src, alt }: { src: string; alt: string }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    fetch(src)
      .then(r => r.text())
      .then(text => {
        const processed = text
          .replace(/fill="currentColor"/g, 'fill="#bbb"')
          .replace(/width="1em"/g, 'width="44"')
          .replace(/height="1em"/g, 'height="44"')
        setSvg(processed)
      })
  }, [src])

  return (
    <div
      className="compat-logo compat-logo-inline"
      role="img"
      aria-label={alt}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export default function CompatibleAgents() {
  return (
    <section className="compat-section site-section" id="compatible-agents" aria-labelledby="compatible-agents-title">
      <div className="section-heading">
        <h2 className="section-title" id="compatible-agents-title">Compatible agents</h2>
      </div>
      <div className="compat-grid">
        {AGENTS.map((agent) => (
          <a
            className="compat-card"
            key={agent.name}
            href={agent.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="compat-logo-wrap">
              {agent.inlineSvg ? (
                <InlineSvg src={agent.logo} alt={agent.name} />
              ) : (
                <img
                  src={agent.logo}
                  alt={agent.name}
                  className="compat-logo"
                  loading="lazy"
                />
              )}
            </div>
            <span className="compat-name">{agent.name}</span>
            <svg className="compat-link-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </a>
        ))}
      </div>
    </section>
  )
}
