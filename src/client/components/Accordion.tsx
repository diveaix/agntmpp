import { useState, useRef, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'

interface AccordionItemProps {
  num: string
  title: string
  id?: string
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

export function AccordionItem({ num, title, id, onOpenChange, children }: AccordionItemProps) {
  const [isOpen, setIsOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const isOpenRef = useRef(false)
  isOpenRef.current = isOpen

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev
      onOpenChange?.(next)
      requestAnimationFrame(() => {
        if (bodyRef.current) {
          if (next) {
            bodyRef.current.style.maxHeight = bodyRef.current.scrollHeight + 'px'
          } else {
            bodyRef.current.style.maxHeight = '0px'
          }
        }
      })
      return next
    })
  }, [onOpenChange])

  useEffect(() => {
    if (!isOpen || !bodyRef.current) return
    const el = bodyRef.current
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!bodyRef.current || !isOpenRef.current) return
        bodyRef.current.style.maxHeight = bodyRef.current.scrollHeight + 'px'
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isOpen])

  return (
    <div className={`accord-item${isOpen ? ' open' : ''}`} id={id}>
      <div className="accord-header" onClick={toggle}>
        <div className="accord-left">
          <span className="accord-num">{num}</span>
          <span className="accord-title">{title}</span>
        </div>
        <div className="accord-toggle">
          <svg viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="1.5">
            <line x1="7" y1="2" x2="7" y2="12" className="vert" />
            <line x1="2" y1="7" x2="12" y2="7" />
          </svg>
        </div>
      </div>
      <div className="accord-body" ref={bodyRef}>
        <div className="accord-inner">
          {children}
        </div>
      </div>
    </div>
  )
}

export default function Accordion({ children }: { children: ReactNode }) {
  return <div className="accordion-wrap">{children}</div>
}
