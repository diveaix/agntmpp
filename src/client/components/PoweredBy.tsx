/**
 * Two continuous logo belts moving in opposite directions.
 */

import { useLayoutEffect, useRef, useState } from 'react'

interface Protocol {
  name: string
  logo: string
  label?: boolean
}

const ROW_1: Protocol[] = [
  { name: 'Uniswap', logo: '/uniswap.svg' },
  { name: 'Zcash', logo: '/zcash.svg' },
  { name: 'Aave', logo: '/Aave.svg' },
  { name: 'Lido', logo: '/Lido.svg' },
  { name: 'Ethena', logo: '/ethena.svg' },
  { name: 'Morpho', logo: '/morpho.svg' },
  { name: 'PancakeSwap', logo: '/pancakeswap.svg' },
  { name: 'Ethereum', logo: '/chains/ethereum.png', label: true },
  { name: 'BNB Chain', logo: '/chains/bnb.png', label: true },
  { name: 'Robinhood', logo: '/chains/robinhood.png', label: true },
  { name: 'Arc', logo: '/chains/arc.png', label: true },
  { name: 'NEAR', logo: '/chains/near.png', label: true },
]

const ROW_2: Protocol[] = [
  { name: 'Ondo', logo: '/ondo.svg' },
  { name: 'LI.FI', logo: '/lifi.svg' },
  { name: 'Jumper', logo: '/jumper.svg' },
  { name: 'Relay', logo: '/relay.svg' },
  { name: 'Optimism', logo: '/chains/optimism.png', label: true },
  { name: 'Arbitrum', logo: '/chains/arbitrum.png', label: true },
  { name: 'Base', logo: '/chains/base.png', label: true },
  { name: 'Polygon', logo: '/chains/polygon.png', label: true },
  { name: 'Avalanche', logo: '/chains/avalanche.png', label: true },
]

function LogoTrack({ items }: { items: Protocol[] }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [repetitions, setRepetitions] = useState(1)

  useLayoutEffect(() => {
    const track = trackRef.current
    const group = track?.firstElementChild
    const viewport = track?.parentElement
    if (!track || !group || !viewport) return

    // Equal pixels per second even when the rows have different widths.
    const updateSpeed = () => {
      const slotWidth = group.firstElementChild?.getBoundingClientRect().width || 200
      setRepetitions(Math.max(1, Math.ceil(viewport.clientWidth / (items.length * slotWidth))))
      track.style.setProperty('--pb-duration', `${group.getBoundingClientRect().width / 44}s`)
    }
    updateSpeed()
    const observer = new ResizeObserver(updateSpeed)
    observer.observe(group)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [items.length])

  return (
    <div className="pb-track">
      <div className="pb-track-inner" ref={trackRef}>
        {[0, 1].map(copy => (
          <div className="pb-track-group" key={copy} aria-hidden={copy === 1 ? true : undefined}>
            {Array.from({ length: repetitions }, (_, repeat) => items.map(p => (
              <div
                key={`${repeat}-${p.name}`}
                className="pb-logo-item"
                aria-hidden={repeat > 0 ? true : undefined}
              >
                <img src={p.logo} alt={p.label ? '' : p.name} className={p.label ? 'pb-logo pb-chain-icon' : 'pb-logo'} draggable={false} />
                {p.label && <span className="pb-chain-name">{p.name}</span>}
              </div>
            )))}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function PoweredBy() {
  return (
    <section className="pb-section" id="powered-by">
      <div className="pb-label">Chains &amp; Protocols</div>
      <div className="pb-treadmill">
        <LogoTrack items={ROW_1} />
        <LogoTrack items={ROW_2} />
      </div>
    </section>
  )
}
