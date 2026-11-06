import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useReducedMotion } from 'framer-motion'
import '../agent-simulation.css'

type Fields = readonly (readonly [string, string])[]
type Scenario = {
  id: string
  label: string
  file: string
  prompt: string
  response: string
  inspect: Fields
  reviewTitle: string
  review: Fields
  reviewNote: string
  question: string
  approval: string
  signer: string
  signed: string
  execute: Fields
  result: string
  receipt: string
}

const scenarios: Scenario[] = [
  {
    id: 'wallets', label: 'Wallets', file: 'wallets.session',
    prompt: 'Connect my Zcash and EVM wallets. Keep the signing under my control.',
    response: 'I’ll connect the wallets you choose. Your keys stay with your signer, and connecting won’t authorize any payments.',
    inspect: [['Looking for your selected wallets', 'Selected wallets found'], ['Checking the Zcash account', 'Zcash shielded account found'], ['Checking EVM network access', 'EVM account and supported networks found']],
    reviewTitle: 'Connection request',
    review: [['Zcash', 'Shielded wallet'], ['EVM', 'One account · multiple networks'], ['Access', 'Read accounts and prepare transactions'], ['Signing', 'A separate signature for every payment']],
    reviewNote: 'Your recovery phrases are never part of this connection.',
    question: 'Ready to connect both wallets. Shall I continue?',
    approval: 'Yes, connect them.',
    signer: 'Waiting for connection approval in your wallet',
    signed: 'Connection approved in your wallet',
    execute: [['Connecting your Zcash wallet', 'Zcash wallet connected'], ['Connecting your EVM account', 'EVM account connected'], ['Loading your wallet tools', 'Wallet tools available in this session']],
    result: 'You’re connected. I can now read your balances and prepare transactions across both wallets. Every payment still needs your signature.',
    receipt: 'Zcash + EVM connected · signing stays with you',
  },
  {
    id: 'swap', label: 'Cross-chain', file: 'execution.session',
    prompt: 'Move 0.1 ETH into shielded ZEC. Let me review the transaction before I sign.',
    response: 'I’ll prepare the transfer from Ethereum to your shielded Zcash receiver, then pause for your review.',
    inspect: [['Checking the Ethereum source balance', 'Source balance checked'], ['Validating your shielded Zcash receiver', 'Shielded receiver validated'], ['Preparing the transfer and wallet review', 'Transfer ready for wallet review']],
    reviewTitle: 'Transfer review',
    review: [['From', '0.1 ETH · Ethereum'], ['To', 'Your shielded Zcash wallet'], ['Wallet review', 'Expected ZEC · fees · minimum received'], ['Signing', 'Your Ethereum wallet']],
    reviewNote: 'The Ethereum transaction remains public. Shielded receipt does not hide the source transaction.',
    question: 'The transfer is ready. Open the wallet review before signing?',
    approval: 'Yes. Let me review and sign in my wallet.',
    signer: 'Waiting for your signature in the Ethereum wallet',
    signed: 'Transaction signed in your Ethereum wallet',
    execute: [['Submitting the Ethereum transaction', 'Ethereum transaction submitted'], ['Waiting for source confirmation', 'Source transaction confirmed'], ['Following settlement to your Zcash wallet', 'Shielded receipt confirmed by your Zcash wallet']],
    result: 'The transfer is complete. ZEC has reached your shielded wallet, and the execution result is back in this conversation.',
    receipt: 'Ethereum → Zcash · destination receipt confirmed',
  },
  {
    id: 'near', label: 'Native NEAR', file: 'near.session',
    prompt: 'Send 5 NEAR to studio.near. Confirm the recipient and network before I sign.',
    response: 'I’ll check studio.near on NEAR mainnet and prepare a transfer from your native NEAR account.',
    inspect: [['Resolving studio.near on mainnet', 'studio.near resolved on mainnet'], ['Checking your native NEAR balance', 'Native NEAR balance checked'], ['Preparing the transfer and network fee review', 'Transfer ready for wallet review']],
    reviewTitle: 'Transfer review',
    review: [['Recipient', 'studio.near'], ['Network', 'NEAR · mainnet'], ['Amount', '5 NEAR'], ['Network fee', 'Review in your wallet before signing']],
    reviewNote: 'This uses your native NEAR account, separate from your EVM wallet.',
    question: 'Recipient confirmed: studio.near on NEAR mainnet. Send the signing request?',
    approval: 'Confirmed. Send the signing request.',
    signer: 'Waiting for your signature in the NEAR wallet',
    signed: 'Transfer signed in your NEAR wallet',
    execute: [['Submitting the native NEAR transfer', 'Native NEAR transfer submitted'], ['Waiting for transaction inclusion', 'Transaction included on NEAR'], ['Following finality on NEAR', 'Transfer finalized · 5 NEAR to studio.near']],
    result: 'Done. Your 5 NEAR transfer to studio.near is finalized. The transaction result is attached to this session.',
    receipt: '5 NEAR → studio.near · finalized',
  },
]

const COMPLETE_AT = 20100
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function Message({ speaker, text, time, start, duration }: { speaker: 'you' | 'agent'; text: string; time: number; start: number; duration: number }) {
  if (time < start) return null
  const progress = Math.min(1, (time - start) / duration)
  return <div className={`asim-message asim-message-${speaker}`}>
    <span className="asim-message-mark" aria-hidden="true">{speaker === 'you' ? '❯' : './'}</span>
    <div><span className="asim-speaker">{speaker}</span><p>{text.slice(0, Math.floor(text.length * progress))}{progress < 1 && <i className="asim-caret" aria-hidden="true" />}</p></div>
  </div>
}

function Activity({ items, time, start, label }: { items: Fields; time: number; start: number; label: string }) {
  if (time < start) return null
  return <div className="asim-activity">
    <span className="asim-activity-label">MCP <span aria-hidden="true">/</span> {label}</span>
    {items.map(([pending, finished], index) => {
      const at = start + index * 750
      if (time < at) return null
      const done = time >= at + 750
      return <div className={done ? 'is-done' : 'is-working'} key={finished}><span aria-hidden="true">{done ? '✓' : spinner[Math.floor(time / 100) % spinner.length]}</span><span>{done ? finished : pending}</span></div>
    })}
  </div>
}

export default function AgentSimulation() {
  const [selected, setSelected] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [inView, setInView] = useState(false)
  const [pageVisible, setPageVisible] = useState(true)
  const [following, setFollowing] = useState(true)
  const reduceMotion = useReducedMotion()
  const frameRef = useRef<HTMLElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const followOutput = useRef(true)
  const scenario = scenarios[selected]
  const time = reduceMotion ? COMPLETE_AT : elapsed
  const complete = time >= COMPLETE_AT
  const playing = inView && pageVisible && !complete && !reduceMotion

  useEffect(() => {
    const target = frameRef.current
    if (!target) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio >= .35), { threshold: .35 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setElapsed(value => Math.min(value + 50, COMPLETE_AT)), 50)
    return () => window.clearInterval(timer)
  }, [playing])

  useLayoutEffect(() => {
    const output = outputRef.current
    if (!output) return
    if (reduceMotion) {
      output.scrollTop = 0
      followOutput.current = output.scrollHeight - output.clientHeight < 28
      setFollowing(followOutput.current)
    } else if (followOutput.current) output.scrollTop = output.scrollHeight
  }, [time, selected, reduceMotion])

  function select(index: number) {
    setSelected(index)
    setElapsed(0)
    followOutput.current = true
    setFollowing(true)
    if (outputRef.current) outputRef.current.scrollTop = 0
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % scenarios.length
    else if (event.key === 'ArrowLeft') next = (index + scenarios.length - 1) % scenarios.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = scenarios.length - 1
    else return
    event.preventDefault()
    select(next)
    tabRefs.current[next]?.focus()
  }

  return <section className="asim-section site-section" id="agent-conversations" aria-labelledby="asim-heading">
    <div className="section-heading">
      <h2 className="section-title" id="asim-heading">See your agent<br /><span>execute onchain.</span></h2>
      <p className="section-description">Ask in plain language. Watch your agent connect, prepare, and execute — with your approval, in one terminal session.</p>
    </div>

    <div className="asim-demo">
      <div className="asim-tabs" role="tablist" aria-label="Terminal example sessions">
        {scenarios.map((item, index) => <button key={item.id} ref={node => { tabRefs.current[index] = node }}
          type="button" role="tab" id={`asim-tab-${item.id}`} aria-controls="asim-panel" aria-selected={index === selected}
          tabIndex={index === selected ? 0 : -1} onKeyDown={event => onTabKey(event, index)} onClick={() => select(index)}>
          <span className="asim-tab-symbol" aria-hidden="true">⌁</span>{item.label}<span className="asim-tab-number" aria-hidden="true">0{index + 1}</span>
        </button>)}
      </div>
      <figure ref={frameRef} className="asim-frame" data-playing={playing} aria-label="AGENT macOS Terminal simulation">
        <div className="asim-toolbar">
          <div className="asim-window-dots" aria-hidden="true"><i /><i /><i /></div>
          <div className="asim-window-title"><svg width="14" height="12" viewBox="0 0 18 15" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><path d="M1 3V1h6l2 2h8v11H1Z" /></svg><span>agent — Terminal</span></div>
        </div>

        <div className="asim-panel" id="asim-panel" role="tabpanel" aria-labelledby={`asim-tab-${scenario.id}`}>
          <div className="asim-session-path"><span>~/agent/<strong>{scenario.file}</strong></span></div>
          <div className="asim-output" ref={outputRef} role="log" aria-live="off" aria-label={`${scenario.label} terminal transcript`} tabIndex={0} onScroll={() => {
            const node = outputRef.current
            if (node) {
              const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 28
              followOutput.current = nearBottom
              setFollowing(nearBottom)
            }
          }}>
            <Message speaker="you" text={scenario.prompt} time={time} start={300} duration={1600} />
            <Message speaker="agent" text={scenario.response} time={time} start={2300} duration={2000} />
            <Activity items={scenario.inspect} label="prepare" time={time} start={4700} />
            {time >= 7300 && <div className="asim-review"><span className="asim-review-title">{scenario.reviewTitle}</span><dl>{scenario.review.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>{scenario.reviewNote}</p></div>}
            <Message speaker="agent" text={scenario.question} time={time} start={9000} duration={1100} />
            <Message speaker="you" text={scenario.approval} time={time} start={11200} duration={900} />
            {time >= 12600 && <div className={`asim-signer${time >= 14500 ? ' is-signed' : ''}`}><span aria-hidden="true">{time >= 14500 ? '✓' : spinner[Math.floor(time / 100) % spinner.length]}</span>{time >= 14500 ? scenario.signed : scenario.signer}{time < 14500 && <span className="asim-signer-hint">external wallet</span>}</div>}
            <Activity items={scenario.execute} label="execute" time={time} start={14700} />
            <Message speaker="agent" text={scenario.result} time={time} start={17400} duration={2100} />
            {time >= 19700 && <div className="asim-receipt"><span aria-hidden="true">✓</span>{scenario.receipt}</div>}
            {complete && <div className="asim-next-line"><span aria-hidden="true">❯</span><span>What would you like to do next?</span><i className="asim-caret" aria-hidden="true" /></div>}
          </div>
          {!following && <button className="asim-follow" type="button" onClick={() => {
            followOutput.current = true; setFollowing(true)
            if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
          }}>Latest output <span aria-hidden="true">↓</span></button>}
        </div>
        <span className="asim-sr-only" role="status">{complete ? `${scenario.label} example complete. Scroll the terminal to read the conversation.` : ''}</span>
      </figure>
    </div>
  </section>
}
