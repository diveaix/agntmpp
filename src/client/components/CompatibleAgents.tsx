import { useState, useEffect } from 'react'

interface Agent {
  num: string
  name: string
  logo: string
  url: string
  inlineSvg?: boolean
}

const AGENTS: Agent[] = [
  { num: '01', name: 'Codex', logo: '/codex-color.svg', url: 'https://openai.com/codex' },
  { num: '02', name: 'Claude Code', logo: '/claudecode-color.svg', url: 'https://claude.com/product/claude-code' },
  { num: '03', name: 'Cursor', logo: '/cursor.svg', url: 'https://www.cursor.com/', inlineSvg: true },
  { num: '04', name: 'OpenCode', logo: '/opencode.svg', url: 'https://opencode.ai/', inlineSvg: true },
  { num: '05', name: 'Gemini CLI', logo: '/geminicli-color.svg', url: 'https://geminicli.com' },
  { num: '06', name: 'AI Studio', logo: '/aistudio.svg', url: 'https://aistudio.google.com/', inlineSvg: true },
  { num: '07', name: 'Windsurf', logo: '/windsurf.svg', url: 'https://windsurf.com/', inlineSvg: true },
  { num: '08', name: 'Amp', logo: '/amp-color.svg', url: 'https://ampcode.com/' },
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
    <section className="compat-section" id="compatible-agents">
      <div className="compat-header">
        <span className="compat-dot">◆</span>
        <span className="compat-label">COMPATIBLE CODING AGENTS</span>
        <span className="compat-dot">◆</span>
      </div>
      <div className="compat-grid">
        {AGENTS.map((agent) => (
          <a
            className="compat-card"
            key={agent.num}
            href={agent.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="compat-num">{agent.num}</span>
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
          </a>
        ))}
      </div>
      <p className="compat-sub">
        Works with any MCP-compatible agent. One URL, instant access.
      </p>
    </section>
  )
}
