// One modal question, answered with a button: "Save / Don't Save / Cancel", "Move to
// Trash / Cancel". `useConfirm()` returns a function that resolves with the id of the
// button pressed (or the cancel id on Escape / backdrop), so a caller reads like
// `if ((await confirm({...})) !== 'save') return`.
//
// Native `window.confirm` is not used: it has two buttons, cannot say which is the
// destructive one, and blocks the whole window including the engine's event stream.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import styles from './ConfirmDialog.module.css'

export interface ConfirmButton {
  id: string
  label: string
  kind?: 'primary' | 'danger' | 'secondary'
}

export interface ConfirmRequest {
  title: string
  message?: ReactNode
  detail?: string
  buttons: ConfirmButton[]
  /** Returned for Escape and a click outside. Defaults to the last button's id. */
  cancelId?: string
}

export type Confirm = (request: ConfirmRequest) => Promise<string>

const ConfirmContext = createContext<Confirm | null>(null)

/** A confirm that falls back to "cancel" when no provider is mounted (isolated tests). */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext)
  return confirm ?? (async (request) => request.cancelId ?? request.buttons[request.buttons.length - 1]?.id ?? 'cancel')
}

interface Pending {
  request: ConfirmRequest
  resolve(id: string): void
}

/** What Tab may land on inside the dialog. */
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([])
  const current = queue[0] ?? null
  const firstButton = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const confirm = useCallback<Confirm>(
    (request) => new Promise<string>((resolve) => setQueue((q) => [...q, { request, resolve }])),
    [],
  )

  const answer = useCallback(
    (id: string) => {
      setQueue((q) => {
        q[0]?.resolve(id)
        return q.slice(1)
      })
    },
    [],
  )

  const cancelId = current ? current.request.cancelId ?? current.request.buttons[current.request.buttons.length - 1]?.id ?? 'cancel' : 'cancel'

  useEffect(() => {
    if (current === null) return
    firstButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        answer(cancelId)
      } else if (event.key === 'Tab') {
        // A modal question keeps the keyboard: Tab cycles its own controls and never
        // reaches the editor or a panel behind the backdrop.
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
        if (controls.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        const at = controls.indexOf(document.activeElement as HTMLElement)
        const step = event.shiftKey ? -1 : 1
        const next = at === -1 ? (event.shiftKey ? controls.length - 1 : 0) : (at + step + controls.length) % controls.length
        controls[next]!.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [answer, cancelId, current])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current !== null && (
        <div className={styles.backdrop} onMouseDown={() => answer(cancelId)} role="presentation">
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="alertdialog"
            aria-modal="true"
            aria-label={current.request.title}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className={styles.title}>{current.request.title}</div>
            {current.request.message !== undefined && <div className={styles.message}>{current.request.message}</div>}
            {current.request.detail !== undefined && <div className={styles.detail}>{current.request.detail}</div>}
            <div className={styles.buttons}>
              {current.request.buttons.map((button, index) => (
                <button
                  key={button.id}
                  ref={index === 0 ? firstButton : undefined}
                  type="button"
                  className={`${styles.button} ${styles[button.kind ?? 'secondary'] ?? ''}`}
                  onClick={() => answer(button.id)}
                >
                  {button.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
