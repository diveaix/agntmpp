import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useReducedMotion } from 'framer-motion'
import Nav from '../components/Nav'
import '../waitlist.css'

export default function WaitlistPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const terminalRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reducedMotion = useReducedMotion()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || reducedMotion) return
    const chars = './AGENT01{}[]<>/+#%$:=;'
    const cell = 24, radius = 200
    let width = 0, height = 0, frame = 0
    let x = -1000, y = -1000
    const clear = () => {
      cancelAnimationFrame(frame)
      frame = 0
      ctx.clearRect(0, 0, width, height)
    }
    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = width * ratio
      canvas.height = height * ratio
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      clear()
    }
    const draw = () => {
      frame = 0
      ctx.clearRect(0, 0, width, height)
      ctx.font = '11px Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const left = Math.max(0, Math.floor((x - radius) / cell))
      const right = Math.min(Math.ceil(width / cell), Math.ceil((x + radius) / cell))
      const top = Math.max(0, Math.floor((y - radius) / cell))
      const bottom = Math.min(Math.ceil(height / cell), Math.ceil((y + radius) / cell))
      for (let row = top; row <= bottom; row++) {
        for (let col = left; col <= right; col++) {
          const px = col * cell + cell / 2, py = row * cell + cell / 2
          const distance = Math.hypot(px - x, py - y)
          if (distance >= radius) continue
          ctx.fillStyle = `rgba(190,190,187,${(1 - distance / radius) ** 2 * .19})`
          ctx.fillText(chars[(row * 31 + col * 17) % chars.length], px, py)
        }
      }
    }
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch' || document.hidden) return
      x = event.clientX
      y = event.clientY
      if (!frame) frame = requestAnimationFrame(draw)
    }
    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', move)
    window.addEventListener('blur', clear)
    document.documentElement.addEventListener('pointerleave', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      clear()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('blur', clear)
      document.documentElement.removeEventListener('pointerleave', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [reducedMotion])

  function activate() {
    inputRef.current?.focus({ preventScroll: true })
    terminalRef.current?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'center' })
  }

  async function subscribe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'sending' || status === 'success') return
    setStatus('sending')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), source: 'agnt-updates' }),
        signal: controller.signal,
      })
      const result: { ok?: boolean } = await response.json()
      if (!response.ok || result.ok !== true) throw new Error('Subscription failed')
      setStatus('success')
    } catch {
      setStatus('error')
    } finally {
      window.clearTimeout(timeout)
    }
  }

  return (
    <div className="wl-page">
      <canvas ref={canvasRef} className="wl-spotlight" aria-hidden="true" />
      <Nav />
      <main className="wl-main">
        <section className="wl-shell" aria-labelledby="waitlist-title">
          <div className="wl-hero">
            <h1 id="waitlist-title">AGENTS<br /><span>DON'T</span><br />SLEEP</h1>
            <p className="wl-lead">The execution layer for your agent. Wallets, transfers, and onchain actions through one MCP connection.</p>
            <div className="wl-actions"><button className="wl-button" type="button" onClick={activate} disabled={status === 'success'} aria-controls="waitlist-signup">{status === 'success' ? "You're on the list" : 'Join the waitlist'}<span aria-hidden="true">↗</span></button></div>
            <div className="wl-metrics">
              <div><strong>Zcash</strong><span>Shielded wallet</span></div>
              <div><strong>EVM</strong><span>Multichain</span></div>
              <div><strong>NEAR</strong><span>Native account</span></div>
              <div><strong>MCP</strong><span>One connection</span></div>
            </div>
          </div>

          <div className="wl-terminal-wrap">
            <aside className="wl-terminal" ref={terminalRef} aria-label="AGENT waitlist terminal">
              <div className="wl-terminal-header">
                <div className="wl-terminal-dots" aria-hidden="true"><span /><span /><span /></div>
                <span className="wl-terminal-title">agent://boot</span>
              </div>
              <div className="wl-terminal-body">
                <p className="wl-command"><span className="wl-prompt" aria-hidden="true">$</span> initialize ./agent</p>
                <div className="wl-terminal-lines" aria-label="AGENT capabilities">
                  <p><span>ZEC</span> shielded Zcash wallet</p>
                  <p><span>EVM</span> one wallet, multiple chains</p>
                  <p><span>NEAR</span> native account connection</p>
                  <p><span>KEYS</span> user-controlled signing</p>
                  <p><span>MCP</span> instruction to execution</p>
                </div>
                <div className="wl-terminal-invite"><p>Stay close to what's next.</p><span>Product releases. New connections.</span></div>
                <div id="waitlist-signup" className="wl-signup">
                  {status === 'success' ? <div className="wl-confirm" role="status"><span>✓</span><div><strong>You're on the list.</strong><p>We'll be in touch at {email.trim()}.</p></div></div> : <form onSubmit={subscribe}>
                    <label htmlFor="waitlist-email"><span className="wl-prompt" aria-hidden="true">$</span> join --email</label>
                    <div className="wl-input-line"><span className="wl-prompt" aria-hidden="true">›</span><input ref={inputRef} id="waitlist-email" className="wl-email-input" type="email" name="email" autoComplete="email" aria-label="Your email address" placeholder="you@example.com" required maxLength={320} value={email} onChange={event => { setEmail(event.target.value); if (status === 'error') setStatus('idle') }} disabled={status === 'sending'} aria-describedby={status === 'error' ? 'waitlist-error' : 'waitlist-note'} /><button type="submit" aria-label="Join the waitlist with this email" disabled={status === 'sending'}><span>{status === 'sending' ? 'Joining…' : 'Join'}</span><span aria-hidden="true">↵</span></button></div>
                    {status === 'error' && <p id="waitlist-error" className="wl-error" role="alert">Couldn't save your email. Please try again.</p>}
                    <p id="waitlist-note" className="wl-input-note">By joining, you agree to receive ./AGENT product emails.</p>
                  </form>}
                </div>
              </div>
            </aside>
          </div>
        </section>
        <div className="wl-footer"><span>Built by agents, for agents.</span><div><a href="https://x.com/dotslashagent" target="_blank" rel="noopener noreferrer">X ↗</a><a href="https://t.me/+SzRhx6BZxtI2YWQ1" target="_blank" rel="noopener noreferrer">Telegram ↗</a></div></div>
      </main>
    </div>
  )
}
