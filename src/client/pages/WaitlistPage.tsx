import { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import '../waitlist.css'

const XIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
)

const TelegramIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" /></svg>
)

export default function WaitlistPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [waitlistActive, setWaitlistActive] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(false)

  /* Character Spotlight */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const chars = '$ # @ % ^ & * { } [ ] < > / \\ | ~ ? ! + = - _ : ; . , 0 1 2 3 4 5 6 7 8 9 a b c d e f'.split(' ')
    const cellSize = 22
    let cols = 0, rows = 0, grid: string[][] = []
    let mouseX = -9999, mouseY = -9999
    const radius = 220
    let raf: number

    function buildGrid() {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      cols = Math.ceil(canvas.width / cellSize) + 1
      rows = Math.ceil(canvas.height / cellSize) + 1
      grid = []
      for (let i = 0; i < rows; i++) {
        const row: string[] = []
        for (let j = 0; j < cols; j++) {
          row.push(chars[Math.floor(Math.random() * chars.length)])
        }
        grid.push(row)
      }
    }

    buildGrid()
    window.addEventListener('resize', buildGrid)

    const onMove = (e: MouseEvent) => { mouseX = e.clientX; mouseY = e.clientY }
    document.addEventListener('mousemove', onMove)

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.font = '11px "JetBrains Mono", monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      for (let k = 0; k < 60; k++) {
        const r = Math.floor(Math.random() * rows)
        const c = Math.floor(Math.random() * cols)
        if (grid[r]) grid[r][c] = chars[Math.floor(Math.random() * chars.length)]
      }

      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const x = j * cellSize + cellSize / 2
          const y = i * cellSize + cellSize / 2
          const dx = x - mouseX
          const dy = y - mouseY
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < radius) {
            const alpha = (1 - dist / radius) * 0.18
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
            ctx.fillText(grid[i][j], x, y)
          }
        }
      }
      raf = requestAnimationFrame(draw)
    }
    draw()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', buildGrid)
      document.removeEventListener('mousemove', onMove)
    }
  }, [])

  /* Terminal Tilt */
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const maxTilt = 12

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      const y = (e.clientY - rect.top) / rect.height
      const ry = (x - 0.5) * maxTilt * 2
      const rx = (0.5 - y) * maxTilt * 2
      el.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`
    }

    const onLeave = () => {
      el.style.transition = 'transform .5s cubic-bezier(.4,0,.2,1)'
      el.style.transform = 'rotateX(0) rotateY(0)'
      setTimeout(() => { el.style.transition = 'transform .15s ease, box-shadow .3s ease' }, 500)
    }

    const onEnter = () => {
      el.style.transition = 'transform .15s ease, box-shadow .3s ease'
    }

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    el.addEventListener('mouseenter', onEnter)

    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      el.removeEventListener('mouseenter', onEnter)
    }
  }, [])

  /* Waitlist Activate */
  const activateWaitlist = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (submitted) return
    setWaitlistActive(true)
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => inputRef.current?.focus(), 600)
  }, [submitted])

  /* Waitlist Submit */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || submitted) return
    const email = (e.target as HTMLInputElement).value.trim()
    if (!email || !email.includes('@')) {
      setError(true)
      setTimeout(() => setError(false), 600)
      return
    }
    setSubmitted(true)
  }, [submitted])

  return (
    <div className="wl-page">
      <canvas ref={canvasRef} className="wl-spotlight" />

      {/* Nav */}
      <nav className="wl-nav" aria-label="Primary">
        <Link to="/" className="wl-nav-logo">
          <img src="/AGNT.svg" alt="AGNT" className="wl-nav-mark" />
          <span>AGNT</span>
        </Link>
        <div className="wl-nav-links">
          <a
            className={`wl-nav-link wl-nav-link--primary${submitted ? ' wl-disabled' : ''}`}
            href="#"
            onClick={activateWaitlist}
          >
            {submitted ? 'Joined' : 'Request Access'}
          </a>
        </div>
      </nav>

      {/* Main */}
      <main className="wl-main">
        <section className="wl-shell">

          {/* Left: Hero */}
          <div className="wl-hero">
            <h1>
              <span className="glitch-word" data-text="AGENTS">AGENTS</span><br />
              DON'T<br />
              <span className="glitch-word" data-text="SLEEP">SLEEP</span>
            </h1>

            <p className="wl-lead">
              <mark>./AGNT</mark> is getting ready. The financial layer for autonomous agents -
              wallets, swaps, perps, bridges, automations, and payments - is almost here.
            </p>

            <div className="wl-actions">
              <a
                className={`wl-button${submitted ? ' wl-disabled' : ''}`}
                href="#"
                onClick={activateWaitlist}
              >
                {submitted ? "You're on the list" : 'Request Early Access'}
              </a>
            </div>

            <div className="wl-metrics">
              <div className="wl-metric"><strong>100+</strong><span>Agent Tools</span></div>
              <div className="wl-metric"><strong>24/7</strong><span>Automation</span></div>
              <div className="wl-metric"><strong>MCP</strong><span>One URL</span></div>
              <div className="wl-metric"><strong>20+</strong><span>Protocols</span></div>
            </div>
          </div>

          {/* Right: Terminal */}
          <div className="wl-terminal-wrap">
            <aside className="wl-terminal" ref={cardRef}>
              <div className="wl-terminal-header">
                <div className="wl-terminal-dots"><span /><span /><span /></div>
                <div className="wl-terminal-title">agnt://boot</div>
              </div>
              <div className="wl-terminal-body">
                <div className="wl-line"><span className="wl-prompt">$</span> initialize agnt-protocol</div>
                <div className="wl-line"><span className="wl-ok">OK</span> wallet scope hardening</div>
                <div className="wl-line"><span className="wl-ok">OK</span> exact token approvals</div>
                <div className="wl-line"><span className="wl-ok">OK</span> route loss guards</div>
                <div className="wl-line"><span className="wl-ok">OK</span> fast event verifier</div>
                <div className="wl-line"><span className="wl-dim">WAIT</span> hosted access rollout</div>
                <div className="wl-line"><span className="wl-dim">WAIT</span> production smoke tests</div>
                <div className="wl-line"><span className="wl-w">STATUS</span> coming soon</div>

                {/* Waitlist input */}
                <div className={`wl-input-line${waitlistActive ? ' show' : ''}`}>
                  <span className="wl-prompt">$</span>&nbsp;
                  <input
                    ref={inputRef}
                    className="wl-email-input"
                    type="email"
                    placeholder="enter your email"
                    autoComplete="email"
                    disabled={submitted}
                    onKeyDown={handleKeyDown}
                    style={error ? { color: '#ff5f57' } : submitted ? { color: 'var(--g4)' } : undefined}
                  />
                </div>
                {submitted && (
                  <div className="wl-confirm"><span className="wl-ok">OK</span> added to waitlist - we'll be in touch</div>
                )}
              </div>
            </aside>
          </div>

        </section>
      </main>

      {/* Footer */}
      <footer className="wl-footer">
        <a className="wl-social" href="https://x.com/agntmpp" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)">
          <XIcon />
        </a>
        <a className="wl-social" href="https://t.me/+SzRhx6BZxtI2YWQ1" target="_blank" rel="noopener noreferrer" aria-label="Telegram">
          <TelegramIcon />
        </a>
      </footer>
    </div>
  )
}
