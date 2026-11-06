import { useId, useState } from 'react'
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
  const itemId = useId()
  const triggerId = `${itemId}-trigger`
  const panelId = `${itemId}-panel`

  function toggle() {
    const next = !isOpen
    setIsOpen(next)
    onOpenChange?.(next)
  }

  return (
    <div className={`accord-item${isOpen ? ' open' : ''}`} id={id}>
      <h3 className="accord-heading">
        <button className="accord-header" type="button" id={triggerId}
          aria-expanded={isOpen} aria-controls={panelId} onClick={toggle}>
          <span className="accord-left">
            <span className="accord-num" aria-hidden="true">{num}</span>
            <span className="accord-title">{title}</span>
          </span>
          <span className="accord-toggle" aria-hidden="true">
            <svg viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="1.5">
              <line x1="7" y1="2" x2="7" y2="12" className="vert" />
              <line x1="2" y1="7" x2="12" y2="7" />
            </svg>
          </span>
        </button>
      </h3>
      <div className="accord-body" id={panelId} role="region" aria-labelledby={triggerId}
        aria-hidden={!isOpen} inert={!isOpen}>
        <div className="accord-collapse">
          <div className="accord-inner">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Accordion({ children }: { children: ReactNode }) {
  return <div className="accordion-wrap">{children}</div>
}
