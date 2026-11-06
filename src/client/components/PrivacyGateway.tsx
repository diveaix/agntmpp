import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useInView, useReducedMotion } from 'framer-motion'
import GatewayGlass from './GatewayGlass'
import { GatewayCoin, GatewayTile, projectToken } from './GatewayTokens'
import '../privacy-gateway.css'

const chains = ['ethereum', 'base', 'arbitrum', 'bnb', 'optimism', 'polygon']
const packets = Array.from({ length: 7 }, (_, index) => index)

const tilePositions = [[-36, -36], [36, -36], [-36, 36], [36, 36]]
const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t) }

export default function PrivacyGateway() {
  const sectionRef = useRef<HTMLElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const packetRefs = useRef<(HTMLDivElement | null)[]>([])
  const glassRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<HTMLDivElement>(null)
  const elapsed = useRef(0)
  const isVisible = useInView(sectionRef, { amount: 0.15 })
  const reducedMotion = useReducedMotion()
  const [pageVisible, setPageVisible] = useState(true)
  const [scale, setScale] = useState(1)
  const running = isVisible && !reducedMotion && pageVisible

  useEffect(() => {
    let frame = 0, lastTime: number | null = null
    const draw = (time: number) => {
      const cycle = Math.floor(time / 6600)
      const beat = time % 6600
      const travel = ease(beat / 3300)
      const press = beat < 5050 ? ease((beat - 3350) / 700) : 1 - ease((beat - 5050) / 850)
      const conversion = ease((beat - 3950) / 1100)
      const phase = beat < 3300 ? 'moving' : beat < 4050 ? 'pressing' : beat < 5050 ? 'shielding' : 'lifting'
      if (stageRef.current) {
        stageRef.current.dataset.phase = phase
        stageRef.current.style.setProperty('--gateway-press', String(press))
      }
      packetRefs.current.forEach((packet, index) => {
        if (!packet) return
        const slot = (index + cycle) % packets.length - 3
        const position = projectToken((slot + travel - 1) * 244)
        packet.style.transform = `translate(${position.x}px, ${position.y}px)`
        packet.style.zIndex = String(slot + 5)
        // Keep the same packet throughout: tiles coalesce as the coin emerges.
        // Both ends match between cycles, so lifting the press never exposes a swap.
        const transformed = slot > 0 ? 1 : slot === 0 ? conversion : 0
        packet.style.setProperty('--conversion', String(transformed))
        packet.style.setProperty('--input-opacity', String(1 - ease(transformed / .8)))
        packet.style.setProperty('--output-opacity', String(ease((transformed - .18) / .82)))
      })
      if (glassRef.current) glassRef.current.style.transform = `translateY(${-40 + press * 30}px)`
      if (shadowRef.current) {
        shadowRef.current.style.opacity = String(.45 + press * .4)
        shadowRef.current.style.transform = `translate(-50%, -50%) scale(${1.08 - press * .16})`
      }
    }
    draw(reducedMotion ? 6100 : elapsed.current)
    if (!running) return
    const tick = (now: number) => {
      if (lastTime !== null) elapsed.current += Math.min(now - lastTime, 80)
      lastTime = now
      draw(elapsed.current)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [running, reducedMotion])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / 1100))
    observer.observe(viewport)
    const updateVisibility = () => setPageVisible(!document.hidden)
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [])

  return (
    <section className="privacy-gateway site-section" ref={sectionRef} aria-labelledby="gateway-title">
      <div className="section-heading">
        <h2 className="section-title" id="gateway-title">Across chains.<br /><span>Into shielded Zcash.</span></h2>
        <p className="section-description">Move assets from supported networks into your shielded Zcash wallet through the same agent connection.</p>
      </div>

      <div className="gateway-stage" ref={stageRef} data-running={running}>
        <div
          className="gateway-viewport"
          ref={viewportRef}
          role="img"
          aria-label="A conceptual cross-chain route: network tiles travel into the AGENT module, gather beneath its glass surface, and smoothly resolve into a silver Zcash coin before continuing to a shielded destination."
        >
          <div className="gateway-scene" style={{ '--gateway-scale': scale } as CSSProperties} aria-hidden="true">
            <div className="gateway-belt-plane">
              <div className="gateway-belt-surface" />
              <div className="gateway-belt-guide gateway-belt-guide-top" />
              <div className="gateway-belt-guide gateway-belt-guide-bottom" />
              <div className="gateway-belt-station" />
            </div>
            <div className="gateway-module-shadow" ref={shadowRef} />
            {packets.map(index => (
              <div className="gateway-packet" key={index} ref={node => { packetRefs.current[index] = node }}>
                <div className="gateway-chain-cluster">
                  {tilePositions.map(([x, y], offset) => {
                    const position = projectToken(x, y)
                    return <div className="gateway-chain-tile" key={offset} style={{ '--tile-x': `${position.x}px`, '--tile-y': `${position.y}px` } as CSSProperties}><GatewayTile chain={chains[(index + offset) % chains.length]} /></div>
                  })}
                </div>
                <div className="gateway-zcash-coin"><GatewayCoin /></div>
              </div>
            ))}
            <div className="gateway-glass-module" ref={glassRef}><GatewayGlass /></div>
            <span className="gateway-diagram-label gateway-diagram-label-in">YOUR ASSETS<span>Across supported chains</span></span>
            <span className="gateway-diagram-label gateway-diagram-label-out">ZCASH<span>A shielded destination</span></span>
          </div>
        </div>

        <div className="gateway-stations">
          <div><span className="gateway-station-number">01</span><span>START ANYWHERE<small>Your assets. Your chain.</small></span></div>
          <div><span className="gateway-station-number">02</span><span>LET YOUR AGENT EXECUTE<small>Instruct. Authorize. Execute.</small></span></div>
          <div><span className="gateway-station-number">03</span><span>ARRIVE SHIELDED<small>Your Zcash destination.</small></span></div>
        </div>
      </div>
    </section>
  )
}
