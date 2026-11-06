import { lazy, Suspense, useRef } from 'react'
import { motion, useInView, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import '../agent-capabilities.css'

const CapabilityScene = lazy(() => import('./CapabilityScene'))
const capabilities = [
  { kind: 'wallets', title: 'Your wallets. Connected.', description: 'Zcash, EVM networks, and NEAR in one conversation. Manage balances and move assets with your agent.' },
  { kind: 'routes', title: 'Onchain execution', description: 'Execute supported swaps and cross-chain transfers through your agent. From instruction to submitted transaction.' },
  { kind: 'results', title: 'From action to receipt', description: 'Sign, execute, and follow the result. Transaction hashes and settlement status come back to your conversation.' },
  { kind: 'connection', title: 'One MCP connection', description: 'Connect your existing agent to wallet, market, and DeFi tools. Plain-language requests. Structured results.' },
] as const

function CapabilityCard({ capability }: { capability: typeof capabilities[number] }) {
  const ref = useRef<HTMLElement>(null)
  const entered = useInView(ref, { margin: '240px', once: true })
  const visible = useInView(ref, { margin: '50px' })
  const reducedMotion = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const illustrationY = useTransform(scrollYProgress, [0, 1], [24, -18])
  return (
    <article ref={ref} className="capability-card">
      <div className="capability-copy"><h3>{capability.title}</h3><p>{capability.description}</p></div>
      <motion.div className="capability-stage" style={{ y: reducedMotion ? 0 : illustrationY }}>
        {entered && <Suspense fallback={<img className="capability-placeholder" src={`/capabilities/${capability.kind}.webp`} alt="" />}>
          <CapabilityScene kind={capability.kind} active={visible} />
        </Suspense>}
      </motion.div>
    </article>
  )
}

export default function AgentCapabilities() {
  return (
    <section className="agent-capabilities site-section" aria-labelledby="capabilities-title">
      <div className="capabilities-heading section-heading">
        <div>
          <h2 className="section-title" id="capabilities-title">What your agent<br /><span>can do.</span></h2>
          <p className="section-description">Connected wallets, onchain execution, and transaction results. The tools to turn your instructions into actions.</p>
        </div>
        <img className="capabilities-zcash" src="/zcash.svg" alt="Zcash" width="159" height="30" />
      </div>
      <div className="capabilities-grid">{capabilities.map(capability => <CapabilityCard key={capability.kind} capability={capability} />)}</div>
    </section>
  )
}
