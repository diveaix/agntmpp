/**
 * Infinite-scroll logo treadmill — inspired by fun.xyz
 * Two identical tracks stacked, scrolling in opposite directions
 * for a premium "living" feel.
 */

interface Protocol {
  name: string
  logo: string
  url: string
}

const ROW_1: Protocol[] = [
  { name: 'Tempo', logo: '/tempo.svg', url: 'https://tempo.xyz/' },
  { name: 'Hyperliquid', logo: '/hyperliquid.svg', url: 'https://hyperliquid.xyz/' },
  { name: 'Uniswap', logo: '/uniswap.svg', url: 'https://uniswap.org/' },
  { name: 'Aave', logo: '/Aave.svg', url: 'https://aave.com/' },
  { name: 'Lido', logo: '/Lido.svg', url: 'https://lido.fi/' },
  { name: 'EigenLayer', logo: '/eigen.svg', url: 'https://www.eigenlayer.xyz/' },
  { name: 'Ethena', logo: '/ethena.svg', url: 'https://ethena.fi/' },
  { name: 'Morpho', logo: '/morpho.svg', url: 'https://morpho.org/' },
  { name: 'PancakeSwap', logo: '/pancakeswap.svg', url: 'https://pancakeswap.finance/' },
]

const ROW_2: Protocol[] = [
  { name: 'Ondo', logo: '/ondo.svg', url: 'https://ondo.finance/' },
  { name: 'Polymarket', logo: '/polymarket-logo.svg', url: 'https://polymarket.com/' },
  { name: 'Stargate', logo: '/stargate.svg', url: 'https://stargate.finance/' },
  { name: 'LI.FI', logo: '/lifi.svg', url: 'https://li.fi/' },
  { name: 'Jumper', logo: '/jumper.svg', url: 'https://jumper.exchange/' },
  { name: 'deBridge', logo: '/debridge.svg', url: 'https://debridge.finance/' },
  { name: 'Relay', logo: '/relay.svg', url: 'https://relay.link/' },
  { name: 'Dune', logo: '/Dune.svg', url: 'https://dune.com/' },
]

function LogoTrack({ items, direction }: { items: Protocol[]; direction: 'left' | 'right' }) {
  const doubled = [...items, ...items]
  return (
    <div className={`pb-track pb-track--${direction}`}>
      <div className="pb-track-inner">
        {doubled.map((p, i) => (
          <a
            key={`${p.name}-${i}`}
            className="pb-logo-item"
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            title={p.name}
          >
            <img src={p.logo} alt={p.name} className="pb-logo" loading="lazy" />
          </a>
        ))}
      </div>
    </div>
  )
}

export default function PoweredBy() {
  return (
    <section className="pb-section" id="powered-by">
      <div className="pb-label">Powered By</div>
      <div className="pb-treadmill">
        <LogoTrack items={ROW_1} direction="left" />
        <LogoTrack items={ROW_2} direction="right" />
      </div>
    </section>
  )
}
