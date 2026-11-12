// A right-click menu: positioned at the pointer, kept inside the window, closed by
// Escape, a click elsewhere, a scroll or a resize. Arrow keys move, Enter runs.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './ContextMenu.module.css'

export type ContextMenuItem =
  | 'separator'
  | {
      id: string
      label: string
      hint?: string
      disabled?: boolean
      danger?: boolean
      run(): void
    }

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose(): void
  label?: string
}

export function ContextMenu({ x, y, items, onClose, label = 'Context menu' }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const actionable = items.filter((item): item is Exclude<ContextMenuItem, 'separator'> => item !== 'separator' && !item.disabled)
  const [focus, setFocus] = useState(0)

  // Keep the menu on screen: flip left/up when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const left = x + rect.width > window.innerWidth - 4 ? Math.max(4, x - rect.width) : x
    const top = y + rect.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - rect.height - 4) : y
    setPos({ left, top })
    el.focus()
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    const onDown = (event: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])

  const run = (item: Exclude<ContextMenuItem, 'separator'>) => {
    if (item.disabled) return
    onClose()
    item.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setFocus((f) => (actionable.length === 0 ? 0 : (f + 1) % actionable.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setFocus((f) => (actionable.length === 0 ? 0 : (f - 1 + actionable.length) % actionable.length))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const item = actionable[focus]
      if (item !== undefined) run(item)
    }
  }

  const menu = (
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={`sep-${index}`} className={styles.separator} role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`${styles.item} ${item.danger ? styles.danger : ''} ${actionable[focus]?.id === item.id ? styles.focused : ''}`}
            onMouseEnter={() => {
              const at = actionable.findIndex((a) => a.id === item.id)
              if (at !== -1) setFocus(at)
            }}
            onClick={() => run(item)}
          >
            <span>{item.label}</span>
            {item.hint !== undefined && <span className={styles.hint}>{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  )
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}
