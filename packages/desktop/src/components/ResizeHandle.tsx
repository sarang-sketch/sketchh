// A drag handle between two panes. Pointer drag, plus arrow keys for keyboard users
// (it is a focusable `separator`, as WAI-ARIA describes a splitter). Double-click resets.

import { useCallback, useRef } from 'react'
import styles from './ResizeHandle.module.css'

export interface ResizeHandleProps {
  /** `vertical` sits between left/right panes and drags sideways; `horizontal` drags up/down. */
  orientation: 'vertical' | 'horizontal'
  /** The current size of the pane being resized, in px. */
  size: number
  min: number
  max: number
  /**
   * +1 when dragging right/down GROWS the pane (a pane to the left/top of the handle),
   * -1 when it shrinks it (a pane to the right/bottom).
   */
  direction: 1 | -1
  onResize(size: number): void
  /** Double-click restores this. */
  defaultSize?: number
  label: string
  className?: string
}

export function ResizeHandle({ orientation, size, min, max, direction, onResize, defaultSize, label, className }: ResizeHandleProps) {
  const start = useRef<{ pointer: number; size: number } | null>(null)
  const clamp = useCallback((value: number) => Math.round(Math.min(max, Math.max(min, value))), [max, min])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    start.current = { pointer: orientation === 'vertical' ? event.clientX : event.clientY, size }
    document.body.classList.add(orientation === 'vertical' ? styles.draggingCol! : styles.draggingRow!)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return
    const now = orientation === 'vertical' ? event.clientX : event.clientY
    onResize(clamp(start.current.size + direction * (now - start.current.pointer)))
  }

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return
    start.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    document.body.classList.remove(styles.draggingCol!, styles.draggingRow!)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 50 : 10
    const grow = orientation === 'vertical' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowDown', 'ArrowUp']
    if (event.key === grow[0]) onResize(clamp(size + direction * step))
    else if (event.key === grow[1]) onResize(clamp(size - direction * step))
    else return
    event.preventDefault()
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`${styles.handle} ${orientation === 'vertical' ? styles.vertical : styles.horizontal} ${className ?? ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => defaultSize !== undefined && onResize(clamp(defaultSize))}
      onKeyDown={onKeyDown}
    />
  )
}
