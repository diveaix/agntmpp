import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
import ExecutionStack from './ExecutionStack'
import '../execution-steps.css'

const steps = [
  {
    label: 'Connect',
    title: 'Your agent,',
    subtitle: 'connected.',
    description: 'Bring ./AGENT into the MCP client you already use. Your agent discovers wallet, market, and transaction tools through a single connection. Requests and results stay in the same conversation.',
  },
  {
    label: 'Instruct',
    title: 'One request.',
    subtitle: 'The right tools.',
    description: 'Send ZEC, swap across chains, or put assets to work. ./AGENT turns your instruction into a transaction, with the network, amount, and fees ready for your approval.',
  },
  {
    label: 'Execute',
    title: 'From instruction',
    subtitle: 'to onchain.',
    description: 'You authorize the transaction with your own signer. ./AGENT executes it and returns the transaction hash, status, and settlement details to your agent. Your keys stay yours.',
  },
] as const

const PIN_TOP = 88
const stepPositions = [.12, .5, .88] as const

export default function ExecutionSteps() {
  const [activeStep, setActiveStep] = useState<0 | 1 | 2>(0)
  const [panelHeight, setPanelHeight] = useState(560)
  const [fitsViewport, setFitsViewport] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const reducedMotion = !!useReducedMotion()
  const scrollEnabled = fitsViewport && !reducedMotion
  const progress = useMotionValue(.12)
  const visualProgress = useSpring(progress, { stiffness: 140, damping: 30, mass: .6 })

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const measure = () => {
      const height = panel.getBoundingClientRect().height
      setPanelHeight(height)
      setFitsViewport(height + PIN_TOP + 24 <= window.innerHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    const track = trackRef.current
    if (!scrollEnabled || !track) return
    let frame = 0
    const update = () => {
      frame = 0
      const distance = track.offsetHeight - panelHeight
      if (distance <= 0) return
      const position = Math.max(0, Math.min(1, (PIN_TOP - track.getBoundingClientRect().top) / distance))
      progress.set(position)
      setActiveStep(Math.min(2, Math.floor(position * 3)) as 0 | 1 | 2)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [panelHeight, progress, scrollEnabled])

  useEffect(() => {
    if (scrollEnabled) return
    const animation = animate(progress, stepPositions[activeStep], {
      duration: reducedMotion ? 0 : .65,
      ease: [.22, 1, .36, 1],
    })
    return () => animation.stop()
  }, [activeStep, progress, reducedMotion, scrollEnabled])

  function selectStep(index: 0 | 1 | 2) {
    const track = trackRef.current
    if (!scrollEnabled || !track) {
      setActiveStep(index)
      return
    }
    const start = window.scrollY + track.getBoundingClientRect().top - PIN_TOP
    const distance = track.offsetHeight - panelHeight
    window.scrollTo({ top: start + distance * stepPositions[index], behavior: 'smooth' })
  }

  return (
    <section className="execution-section site-section" id="how-it-works" aria-labelledby="execution-title">
      <div className="section-heading">
        <h2 className="section-title" id="execution-title">From instruction<br /><span>to execution.</span></h2>
        <p className="section-description">Connect your agent, give an instruction, and authorize the transaction. The result comes back to the same conversation.</p>
      </div>
      <div className="execution-track" ref={trackRef} data-scroll={scrollEnabled}
        style={{ '--execution-panel-height': `${panelHeight}px`, '--execution-pin-top': `${PIN_TOP}px` } as CSSProperties}>
        <div className="execution-layout" ref={panelRef}>
          <div className="execution-artwork" aria-hidden="true">
            <ExecutionStack progress={visualProgress} reducedMotion={reducedMotion} activeStep={activeStep} />
          </div>
          <div className="execution-copy">
            <div className="execution-caption-slot" id="execution-caption" aria-live={scrollEnabled ? 'off' : 'polite'} aria-atomic="true">
              {steps.map((step, index) => (
                <motion.div className="execution-caption" key={step.label}
                  data-active={activeStep === index} aria-hidden={activeStep !== index}
                  initial={false} animate={{ opacity: activeStep === index ? 1 : 0, y: activeStep === index || reducedMotion ? 0 : 8 }}
                  transition={{ duration: reducedMotion ? 0 : .3 }}>
                  <h3>{step.title}<br /><span>{step.subtitle}</span></h3>
                  <p>{step.description}</p>
                </motion.div>
              ))}
            </div>
            <div className="execution-progress">
              <div className="execution-steps" role="navigation" aria-label="Execution steps">
                {steps.map((step, index) => (
                  <button key={step.label} type="button" aria-label={step.label}
                    aria-current={activeStep === index ? 'step' : undefined} data-complete={index <= activeStep}
                    aria-controls="execution-caption" onClick={() => selectStep(index as 0 | 1 | 2)}>
                    <span>{step.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
