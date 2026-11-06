import { useEffect, useRef, useState } from 'react'

const BOOT_LINES = [
  { text: '$ initializing ./agent kernel...', delay: 400 },
  { text: '[<ok>OK</ok>] ephemeral key module', delay: 800 },
  { text: '[<ok>OK</ok>] evm toolkit loaded', delay: 1200 },
  { text: '[<ok>OK</ok>] account access ready', delay: 1600 },
  { text: '[<ok>OK</ok>] a2a — agent card published', delay: 2000 },
  { text: '[<ok>OK</ok>] memory — encrypted store loaded', delay: 2400 },
  { text: '[<ok>OK</ok>] wallet runtime: active', delay: 2800 },
  { text: '[<ok>OK</ok>] mcp server: toolkit loaded', delay: 3200 },
  { text: '[<ok>OK</ok>] propagation: emergent', delay: 3600 },
  { text: '$ tools ready. connect your agent.<cursor/>', delay: 4100 },
]

interface BootSequenceProps {
  onComplete: () => void
}

export default function BootSequence({ onComplete }: BootSequenceProps) {
  const [visibleLines, setVisibleLines] = useState<number[]>([])
  const [hiding, setHiding] = useState(false)
  const timersRef = useRef<NodeJS.Timeout[]>([])

  useEffect(() => {
    BOOT_LINES.forEach((line, idx) => {
      const timer = setTimeout(() => {
        setVisibleLines((prev) => [...prev, idx])
      }, line.delay)
      timersRef.current.push(timer)
    })

    const hideTimer = setTimeout(() => {
      setHiding(true)
      setTimeout(onComplete, 500)
    }, 5500)
    timersRef.current.push(hideTimer)

    return () => {
      timersRef.current.forEach(clearTimeout)
    }
  }, [onComplete])

  return (
    <div className={`boot-text${hiding ? ' hide' : ''}`}>
      {BOOT_LINES.map((line, idx) => (
        <div
          key={idx}
          className={`boot-line${visibleLines.includes(idx) ? ' visible' : ''}`}
          dangerouslySetInnerHTML={{
            __html: line.text
              .replace(/<ok>/g, '<span class="ok">')
              .replace(/<\/ok>/g, '</span>')
              .replace(/<cursor\/>/g, '<span class="boot-cursor"></span>'),
          }}
        />
      ))}
    </div>
  )
}
