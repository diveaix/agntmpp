import { useEffect, useRef, useState } from 'react'

const BOOT_LINES = [
  { text: '$ initializing ./agnt kernel...', delay: 400 },
  { text: '[<ok>OK</ok>] ephemeral key module', delay: 800 },
  { text: '[<ok>OK</ok>] tempo rpc connected', delay: 1200 },
  { text: '[<ok>OK</ok>] mpp — http 402 ready', delay: 1600 },
  { text: '[<ok>OK</ok>] a2a — agent card published', delay: 2000 },
  { text: '[<ok>OK</ok>] memory — encrypted store loaded', delay: 2400 },
  { text: '[<ok>OK</ok>] wallet runtime: active', delay: 2800 },
  { text: '[<ok>OK</ok>] mcp server: 100+ tools registered', delay: 3200 },
  { text: '[<ok>OK</ok>] propagation: emergent', delay: 3600 },
  { text: '$ agents online.<cursor/>', delay: 4100 },
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
