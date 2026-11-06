import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'

/** Monochrome cursor trail, keeping the original black-and-white hero direction. */
export default function HeroBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = useReducedMotion()
  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    const ctx = canvas?.getContext('2d')
    if (!canvas || !host || !ctx) return
    const cells = new Map<string, { x: number; y: number; created: number; strength: number }>()
    let width = 0, height = 0, frame = 0, visible = true
    const still = reducedMotion
    const draw = (now: number) => {
      frame = 0
      ctx.clearRect(0, 0, width, height)
      // Sparse registration points, with no colored wash or continuously moving backdrop.
      ctx.fillStyle = 'rgba(255,255,255,0.09)'
      for (let x = 28; x < width; x += 56) {
        for (let y = 28; y < height; y += 56) ctx.fillRect(x, y, 1, 1)
      }
      for (const [key, cell] of cells) {
        const life = 1 - (now - cell.created) / 950
        if (life <= 0) { cells.delete(key); continue }
        ctx.fillStyle = `rgba(255,255,255,${life * life * cell.strength})`
        ctx.fillRect(cell.x + 2, cell.y + 2, 24, 24)
      }
      if (cells.size && visible && !document.hidden && !still) frame = requestAnimationFrame(draw)
    }
    const resize = () => {
      width = host.clientWidth; height = host.clientHeight
      const ratio = Math.min(devicePixelRatio || 1, 2)
      canvas.width = width * ratio; canvas.height = height * ratio
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      cancelAnimationFrame(frame)
      draw(performance.now())
    }
    const move = (event: PointerEvent) => {
      if (still || !visible || document.hidden || event.pointerType === 'touch') return
      const rect = host.getBoundingClientRect()
      const x = Math.floor((event.clientX - rect.left) / 28) * 28
      const y = Math.floor((event.clientY - rect.top) / 28) * 28
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const px = x + dx * 28, py = y + dy * 28
          cells.set(`${px},${py}`, { x: px, y: py, created: performance.now(), strength: dx === 0 && dy === 0 ? 0.32 : 0.035 })
        }
      }
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const update = () => {
      cancelAnimationFrame(frame)
      frame = 0
      cells.clear()
      if (visible && !document.hidden) draw(performance.now())
    }
    const sizeObserver = new ResizeObserver(resize)
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update() })
    sizeObserver.observe(host); observer.observe(host)
    host.addEventListener('pointermove', move)
    document.addEventListener('visibilitychange', update)
    return () => {
      cancelAnimationFrame(frame)
      sizeObserver.disconnect(); observer.disconnect()
      host.removeEventListener('pointermove', move)
      document.removeEventListener('visibilitychange', update)
    }
  }, [reducedMotion])
  return <canvas className="wh-field" ref={canvasRef} aria-hidden="true" />
}
