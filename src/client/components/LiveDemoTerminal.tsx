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
    user: 'Create a wallet called "Alpha Fund" and check what tokens are available',
    tools: [
      { badge: 'wallet_create', args: 'name="Alpha Fund"' },
      { badge: 'tempo_tokens', args: 'action="list"' },
    ],
    responseLines: [
      { k: 'ok', t: '[ok] Wallet "Alpha Fund" created' },
      { k: 't', t: '  Address: 0xa1b2...c3d4' },
      { k: 't', t: '  Chain: Tempo (4217)' },
      { k: 'br' },
      { k: 't', t: '  Available tokens:' },
      { k: 't', t: '  USDC.e    $1.00   [stablecoin]' },
      { k: 't', t: '  EURC.e    $1.08   [stablecoin]' },
      { k: 't', t: '  wETH      $3,841  [altcoin]' },
      { k: 't', t: '  AGNT      $0.0012 [memecoin]' },
    ],
  },
  {
    user: 'Swap 500 USDC.e for wETH — show me the fees first',
    tools: [{ badge: 'tempo_swap', args: 'tokenIn="USDC.e" tokenOut="wETH" amount=500' }],
    responseLines: [
      { k: 'dim', t: 'Swap Quote:' },
      { k: 't', t: '  500 USDC.e → 0.13017 wETH' },
      { k: 't', t: '  Rate: 1 USDC.e = 0.00026 wETH' },
      { k: 't', t: '  DEX Fee: 0.25 USDC.e (0.05%)' },
      { k: 't', t: '  Slippage: 0.5% max' },
      { k: 't', t: '  Gas: ~0.001 USD' },
      { k: 'br' },
      { k: 'ok', t: '[ok] Swap complete' },
      { k: 't', t: '  Tx: tempo.build/tx/0xf7a2...' },
    ],
  },
  {
    user: 'Long BTC at market, 10x leverage, 0.5 BTC size',
    tools: [{ badge: 'hl_order', args: 'market="BTC" side="buy" size=0.5 leverage=10' }],
    responseLines: [
      { k: 'ok', t: '[ok] Order Placed — Hyperliquid BTC-PERP' },
      { k: 't', t: '  Side: BUY (Long) | Size: 0.5 BTC' },
      { k: 't', t: '  Type: Market @ ~$104,180' },
      { k: 't', t: '  Leverage: 10x' },
      { k: 't', t: '  Notional: $52,090' },
      { k: 't', t: '  Margin: $5,209 | Est. Liq: $93,762' },
    ],
  },
  {
    user: 'Set up a DCA — buy $100 of wETH every 6 hours',
    tools: [{ badge: 'create_dca', args: 'tokenIn="USDC.e" tokenOut="wETH" amount=100 interval="6h"' }],
    responseLines: [
      { k: 'ok', t: '[ok] DCA Strategy Created' },
      { k: 't', t: '  Buy 100 USDC.e → wETH' },
      { k: 't', t: '  Every 6 hours' },
      { k: 't', t: '  Next run: 2026-04-30 18:00' },
      { k: 'br' },
      { k: 'inline', dim: '[memory] Saved:', rest: ' DCA strategy for wETH' },
    ],
  },
  {
    user: 'What trades did I do last week?',
    tools: [{ badge: 'memory_recall', args: 'query="trades last week"' }],
    responseLines: [
      { k: 'dim', t: 'Trade History (last 7 days):' },
      { k: 't', t: '  1. swap: 500 USDC.e → 0.13 wETH' },
      { k: 't', t: '  2. dca: 100 USDC.e → wETH (x4 runs)' },
      { k: 't', t: '  3. perp: BTC-PERP long 0.5 @ $104,180' },
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
        <div className="ld-terminal-title">AGNT — ~/projects/alpha-fund</div>
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
