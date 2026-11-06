import { useEffect, useState, useRef } from 'react'

type RespLine =
  | { k: 'ok'; t: string }
  | { k: 'dim'; t: string }
  | { k: 't'; t: string }
  | { k: 'br' }
  | { k: 'inline'; dim: string; rest: string }

interface DemoGroup {
  user: string
  tools: { badge: string; args: string }[]
  responseLines: RespLine[]
}

const GROUPS: DemoGroup[] = [
  {
    user: 'Create a wallet called "Alpha Fund" for Base',
    tools: [
      { badge: 'wallet', args: 'action="create" name="Alpha Fund" chain="base"' },
    ],
    responseLines: [
      { k: 'ok', t: '[ok] Wallet "Alpha Fund" created' },
      { k: 't', t: '  Address: 0xa1b2...c3d4' },
      { k: 't', t: '  Chain: Base (8453)' },
    ],
  },
  {
    user: 'What is the price of ETH?',
    tools: [{ badge: 'market_data', args: 'action="price" token="ETH"' }],
    responseLines: [
      { k: 'dim', t: 'Illustrative market snapshot:' },
      { k: 't', t: '  ETH: $3,841' },
      { k: 't', t: '  24h change: +1.2%' },
      { k: 't', t: '  Source: CoinGecko' },
    ],
  },
  {
    user: 'Remember that I want to review fees before every transfer',
    tools: [{ badge: 'memory', args: 'action="remember" key="transfer_preferences" value="Review fees before every transfer"' }],
    responseLines: [
      { k: 'inline', dim: '[memory] Saved:', rest: ' Review fees before every transfer' },
      { k: 't', t: '  [source] Agent Memory (encrypted)' },
    ],
  },
]

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function RespRow({ line }: { line: RespLine }) {
  if (line.k === 'br') return <div className="ld-resp-gap" aria-hidden />
  if (line.k === 'ok')
    return <div className="ld-line"><span className="ld-ok">{line.t}</span></div>
  if (line.k === 'dim')
    return <div className="ld-line"><span className="ld-dim">{line.t}</span></div>
  if (line.k === 'inline')
    return <div className="ld-line"><span className="ld-dim">{line.dim}</span>{line.rest}</div>
  return <div className="ld-line">{line.t}</div>
}

type GState = { u: number; t: boolean; r: number }

function emptyStates(): GState[] {
  return GROUPS.map(() => ({ u: 0, t: false, r: 0 }))
}

export default function LiveDemoTerminal({ isOpen }: { isOpen: boolean }) {
  const [boot, setBoot] = useState(false)
  const [states, setStates] = useState<GState[]>(emptyStates)
  const [runDone, setRunDone] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as content arrives
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [states, boot, runDone])

  useEffect(() => {
    if (!isOpen) {
      setBoot(false)
      setStates(emptyStates())
      setRunDone(false)
      return
    }

    let cancelled = false
    const seen = sessionStorage.getItem('live-demo-seen') === '1'
    const charMs = seen ? 10 : 20
    const afterUserPause = seen ? 120 : 260
    const lineMs = seen ? 32 : 58
    const betweenGroups = seen ? 220 : 480

    setBoot(false)
    setStates(emptyStates())
    setRunDone(false)

    ;(async () => {
      await delay(seen ? 160 : 320)
      if (cancelled) return
      setBoot(true)
      await delay(seen ? 120 : 240)
      if (cancelled) return

      for (let gi = 0; gi < GROUPS.length; gi++) {
        const g = GROUPS[gi]
        const fullU = g.user.length
        const fullR = g.responseLines.length

        for (let u = 0; u <= fullU; u++) {
          if (cancelled) return
          const uFinal = u
          setStates((prev) =>
            prev.map((s, i) => {
              if (i < gi) {
                const pg = GROUPS[i]
                return { u: pg.user.length, t: true, r: pg.responseLines.length }
              }
              if (i === gi) return { ...s, u: uFinal }
              return { u: 0, t: false, r: 0 }
            }),
          )
          if (u < fullU) await delay(charMs)
        }

        if (cancelled) return
        await delay(afterUserPause)
        if (cancelled) return

        setStates((prev) =>
          prev.map((s, i) => {
            if (i < gi) {
              const pg = GROUPS[i]
              return { u: pg.user.length, t: true, r: pg.responseLines.length }
            }
            if (i === gi) return { ...s, t: true }
            return s
          }),
        )

        for (let r = 0; r <= fullR; r++) {
          if (cancelled) return
          setStates((prev) =>
            prev.map((s, i) => {
              if (i < gi) {
                const pg = GROUPS[i]
                return { u: pg.user.length, t: true, r: pg.responseLines.length }
              }
              if (i === gi) return { ...s, r }
              return s
            }),
          )
          if (r < fullR) await delay(lineMs)
        }

        if (cancelled) return
        await delay(betweenGroups)
      }

      sessionStorage.setItem('live-demo-seen', '1')
      if (!cancelled) setRunDone(true)
    })()

    return () => {
      cancelled = true
    }
  }, [isOpen])

  return (
    <div className="ld-terminal">
      <div className="ld-terminal-header">
        <div className="ld-terminal-dots"><span /><span /><span /></div>
        <div className="ld-terminal-title">AGENT — illustrative EVM demo</div>
      </div>
      <div className={`ld-terminal-body${boot ? ' ld-boot' : ''}`} ref={bodyRef}>
        {GROUPS.map((g, gi) => {
          const st = states[gi] ?? { u: 0, t: false, r: 0 }
          const userVisible = g.user.slice(0, st.u)
          const typing = isOpen && st.u > 0 && st.u < g.user.length
          const showUser = st.u > 0

          return (
            <div key={gi} className="ld-exchange">
              {showUser && (
                <div className={`ld-line ld-user${typing ? ' ld-typing' : ''}`}>
                  <span className="ld-prompt">$</span> {userVisible}
                  {typing && <span className="ld-caret" aria-hidden />}
                </div>
              )}
              {st.t &&
                g.tools.map((tool, ti) => (
                  <div key={`${gi}-tool-${ti}`} className="ld-line ld-tool">
                    <span className="ld-tool-badge">▸ {tool.badge}</span>{' '}
                    <span className="ld-tool-args">{tool.args}</span>
                  </div>
                ))}
              {st.t && st.r > 0 && (
                <div className="ld-response">
                  {g.responseLines.slice(0, st.r).map((line, ri) => (
                    <RespRow key={`${gi}-${ri}`} line={line} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {runDone && (
          <div className="ld-line ld-cursor-row">
            <span className="ld-blink-cursor" />
          </div>
        )}
      </div>
    </div>
  )
}
