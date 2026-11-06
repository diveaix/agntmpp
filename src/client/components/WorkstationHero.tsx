import { lazy, Suspense, useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Link } from 'react-router-dom'
import MacScreen from './MacScreen'
import HeroBackdrop from './HeroBackdrop'
import '../workstation-hero.css'

const MacintoshComputer = lazy(() => import('./MacintoshComputer'))
const networks = ['Zcash', 'NEAR', 'EVM'] as const

function Display({ booting, onBootEnd }: { booting: boolean; onBootEnd: () => void }) {
  const [networkIndex, setNetworkIndex] = useState(0)

  useEffect(() => {
    if (booting) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setNetworkIndex(index => (index + 1) % networks.length)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [booting])

  return <div className={`wh-screen${booting ? ' wh-booting' : ''}`}>
    <div className="wh-screen-sheen" aria-hidden="true" />
    {booting && <div className="wh-boot" role="status" aria-label="Starting AGENT" onAnimationEnd={event => {
      if (event.animationName === 'wh-boot-exit') onBootEnd()
    }}>
      <div className="wh-boot-mark" aria-hidden="true">
        <svg viewBox="0 0 72 88" fill="none">
          <rect x="9" y="5" width="54" height="69" rx="4" />
          <rect x="17" y="13" width="38" height="32" rx="3" />
          <path d="M27 23v4m18-4v4m-17 7c4 5 12 5 16 0M37 58h16M14 75v7h44v-7" />
          <path d="M20 58h2" />
        </svg>
        <span>./AGENT</span>
      </div>
      <div className="wh-boot-track" aria-hidden="true"><span /></div>
    </div>}
    <div className="wh-screen-content" inert={booting} aria-hidden={booting || undefined}>
      <h1 aria-label="Agents on Zcash, NEAR, and EVM">
        <span className="wh-screen-title" aria-hidden="true">AGENTS ON</span>
        <span className="wh-network-logos" aria-hidden="true">
          {networks.map((network, index) => <span key={network} className={`wh-network-logo${index === networkIndex ? ' is-active' : ''}`} data-network={network}>
            {network === 'Zcash' ? <img className="wh-network-wordmark" src="/zcash.svg" alt="" />
              : <><img className="wh-network-symbol" src={network === 'NEAR' ? '/chains/near-mark.svg' : '/chains/ethereum-mark.svg'} alt="" /><span>{network}</span></>}
          </span>)}
        </span>
      </h1>
      <Link to="/toolkit" className="wh-connect">Connect your agent <span aria-hidden="true">↗</span></Link>
    </div>
  </div>
}

export default function WorkstationHero() {
  const reducedMotion = useReducedMotion()
  const [booted, setBooted] = useState(false)
  const booting = !booted && !reducedMotion
  const display = <Display booting={booting} onBootEnd={() => setBooted(true)} />
  return (
    <section className="wh-hero" aria-label="AGENT — agents on Zcash, NEAR, and EVM">
      <HeroBackdrop />
      <div className="wh-stage">
        <div className="wh-floor-shadow" aria-hidden="true" />
        <Suspense fallback={<div className="wh-computer"><div className="wh-fallback-case" aria-hidden="true"><MacScreen /></div><div className="wh-fallback-screen">{display}</div></div>}>
          <MacintoshComputer>{display}</MacintoshComputer>
        </Suspense>
      </div>
    </section>
  )
}
