import { useEffect, useRef } from 'react'

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$#@&*<>{}[]=/+-~^%!?:;'

interface MatrixRainProps {
  opacity?: number
  speed?: number
  fontSize?: number
  color?: string
}

export default function MatrixRain({
  opacity = 0.12,
  speed = 1.4,
  fontSize = 14,
  color = 'rgba(255,255,255,',
}: MatrixRainProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    let columns: number
    let drops: number[]
    let speeds: number[]

    const resize = () => {
      canvas.width = canvas.offsetWidth * devicePixelRatio
      canvas.height = canvas.offsetHeight * devicePixelRatio
      ctx.scale(devicePixelRatio, devicePixelRatio)

      const w = canvas.offsetWidth
      columns = Math.floor(w / fontSize)
      drops = Array.from({ length: columns }, () => Math.random() * -100)
      speeds = Array.from({ length: columns }, () => 0.6 + Math.random() * 0.8)
    }

    resize()
    window.addEventListener('resize', resize)

    const h = () => canvas.offsetHeight

    const draw = () => {
      const width = canvas.offsetWidth
      const height = h()

      // Fade trail — darker = longer trails
      ctx.fillStyle = 'rgba(0,0,0,0.06)'
      ctx.fillRect(0, 0, width, height)

      ctx.font = `${fontSize}px "JetBrains Mono", "Courier New", monospace`

      for (let i = 0; i < columns; i++) {
        const char = CHARS[Math.floor(Math.random() * CHARS.length)]
        const x = i * fontSize
        const y = drops[i] * fontSize

        // Head character — brighter
        const headAlpha = 0.3 + Math.random() * 0.25
        ctx.fillStyle = `${color}${headAlpha})`
        ctx.fillText(char, x, y)

        // Occasional bright flash
        if (Math.random() > 0.96) {
          ctx.fillStyle = `${color}${0.55 + Math.random() * 0.2})`
          ctx.fillText(char, x, y)
        }

        // Move drop down
        drops[i] += speed * speeds[i]

        // Reset when off screen (with randomness to avoid sync)
        if (y > height && Math.random() > 0.975) {
          drops[i] = Math.random() * -20
          speeds[i] = 0.6 + Math.random() * 0.8
        }
      }

      animId = requestAnimationFrame(draw)
    }

    animId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', resize)
    }
  }, [opacity, speed, fontSize, color])

  return (
    <canvas
      ref={canvasRef}
      className="matrix-rain"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        opacity,
        pointerEvents: 'none',
      }}
    />
  )
}
