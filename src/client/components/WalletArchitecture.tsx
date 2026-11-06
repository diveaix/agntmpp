import { motion, useReducedMotion } from 'framer-motion'

const wallets = [
  { kind: 'shielded', label: 'Zcash wallet', title: 'Privacy, built in.', description: 'Receive, hold, and send shielded ZEC. Move across networks from the same conversation.', detail: 'Shielded addresses · Private payments' },
  { kind: 'networks', label: 'EVM wallet', title: 'One wallet. Many chains.', description: 'Your EVM assets, connected. Execute across Ethereum, Base, Arbitrum, and more.', detail: 'One address · Multichain execution' },
  { kind: 'signer', label: 'Signing model', title: 'Your keys stay yours.', description: 'Your agent prepares the action. You authorize with your signer. Your recovery phrase stays with you.', detail: 'Your keys · Your approval' },
] as const

function WalletCard({ wallet, index }: { wallet: typeof wallets[number]; index: number }) {
  const reducedMotion = !!useReducedMotion()
  return <motion.article className={`wallet-card wallet-card-${wallet.kind}`}
    initial={reducedMotion ? false : { opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .15 }} transition={{ duration: .5, delay: index * .06 }}>
    <div className="wallet-card-brand" aria-hidden="true">
      {wallet.kind === 'shielded' ? <img className="wallet-zcash-wordmark" src="/zcash.svg" alt="" />
        : wallet.kind === 'networks' ? <div className="wallet-chain-logos">
          {['ethereum', 'base', 'arbitrum'].map(chain => <img src={`/chains/${chain}.png`} alt="" key={chain} />)}
        </div>
        : <svg className="wallet-key" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13" cy="13" r="8" />
          <circle cx="11" cy="11" r="1.5" />
          <path d="M18.65 18.65 33 33M24 24l4-4M29 29l4-4" />
        </svg>}
    </div>
    <span className="wallet-card-label">{wallet.label}</span>
    <h3>{wallet.title}</h3><p>{wallet.description}</p>
    <span className="wallet-card-detail">{wallet.detail}</span>
  </motion.article>
}

export default function WalletArchitecture() {
  return <section className="wallet-architecture site-section" aria-labelledby="wallet-architecture-title">
    <div className="section-heading">
      <h2 className="section-title" id="wallet-architecture-title">Two wallets.<br /><span>One agent connection.</span></h2>
      <p className="section-description">Shielded Zcash and a multichain EVM wallet. Connected through MCP, with every signature under your control.</p>
    </div>
    <div className="wallet-grid">{wallets.map((wallet, index) => <WalletCard key={wallet.kind} wallet={wallet} index={index} />)}</div>
  </section>
}
