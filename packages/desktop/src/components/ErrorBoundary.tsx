// The last line of defence: nothing a render throws, and nothing a stray promise
// rejects, is allowed to leave the user staring at a blank window.
//
// TWO MECHANISMS, ONE MODULE, because they are the same promise to the user — "an
// error will never silently take the app down" — reached two different ways:
//
//   1. <ErrorBoundary> is a React error boundary (a class, because only a class can
//      implement getDerivedStateFromError/componentDidCatch). It wraps the whole app
//      in main.tsx, OUTSIDE every provider, so a throw ANYWHERE below it — including
//      in a provider's own render — still lands here and shows a plain recovery
//      screen instead of React unmounting the tree to nothing. The screen states the
//      error, offers Reload, and warns that unsaved edits in open editor tabs may be
//      lost (the tabs themselves are restored on reload; their unsaved CONTENT is not
//      persisted byte-for-byte, so the honest thing is to say so rather than promise
//      a recovery the app cannot make).
//
//   2. installGlobalErrorReporter() adds window 'unhandledrejection' and 'error'
//      listeners. A rejected promise or an error thrown outside React's render path
//      (an event handler, a timer, an async callback) never reaches an error
//      boundary, so without this it would only hit the console and the user would
//      see nothing. These listeners DO NOT swallow the error — they
//      `console.error` a record AND surface a dismissible, screen-reader-announced
//      notice — and they never call preventDefault(), so the default console
//      reporting still happens too. The notice is a single `role="alert"` region
//      mounted into its own host node, following W9's convention (errors are
//      `role="alert"`, there is no central toast system) without depending on any
//      React context, since these fire from anywhere at any time.
//
// Neither mechanism hides an error: one shows a recovery screen, the other shows a
// visible notice, and both also write to the console.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import styles from './ErrorBoundary.module.css'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Reload the window. Injected in tests; production reloads the real location. */
  onReload?: () => void
}

interface ErrorBoundaryState {
  error: Error | null
}

/** True when any open editor tab holds unsaved changes, read defensively off localStorage. */
function hasUnsavedHint(): boolean {
  // The reducer does not persist unsaved buffer CONTENT, so there is nothing to read
  // that proves a dirty tab after a crash. This is deliberately conservative: if the
  // window had open tabs at all, warn that unsaved edits in them may be lost. A false
  // positive (warning when nothing was dirty) is far better than a false negative
  // (staying silent while the user loses work).
  try {
    const raw = window.localStorage?.getItem('sketch.ui.v1')
    if (raw === null || raw === undefined) return false
    const parsed = JSON.parse(raw) as { openTabs?: { paths?: unknown } } | null
    const paths = parsed?.openTabs?.paths
    return Array.isArray(paths) && paths.length > 0
  } catch {
    return false
  }
}

/**
 * The app-wide React error boundary. Shows a plain recovery screen — never a blank
 * window — with the error message and a Reload button.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // A record, always — the recovery screen is for the user, the console is for
    // whoever is debugging. The error is reported, never swallowed.
    console.error('[sketch] a render error was caught by the app error boundary:', error, info.componentStack)
  }

  private reload = (): void => {
    if (this.props.onReload) {
      this.props.onReload()
      return
    }
    try {
      window.location.reload()
    } catch {
      // No location (an unusual host): clear the caught error so React tries to
      // re-render the tree, which is the best in-process recovery available.
      this.setState({ error: null })
    }
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    const unsaved = hasUnsavedHint()
    return (
      <div className={styles.screen} role="alert" aria-live="assertive">
        <div className={styles.card}>
          <h1 className={styles.heading}>Sketch hit an unexpected error</h1>
          <p className={styles.lede}>
            The window stayed open so you don’t lose your place. Reloading usually clears it.
          </p>
          <pre className={styles.message}>{error.message || 'Unknown error'}</pre>
          {unsaved && (
            <p className={styles.warning}>
              You had files open. Unsaved edits in them may not survive the reload — if you can,
              note any changes before reloading.
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" className={styles.reload} onClick={this.reload}>
              Reload Sketch
            </button>
          </div>
        </div>
      </div>
    )
  }
}

// ── global (non-render) error reporting ──────────────────────────────────────

const HOST_ID = 'sketch-global-error-host'
const NOTICE_LIMIT = 4

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

/** The host node every global notice is mounted into. Created once, on demand. */
function ensureHost(doc: Document): HTMLElement {
  let host = doc.getElementById(HOST_ID)
  if (host === null) {
    host = doc.createElement('div')
    host.id = HOST_ID
    host.className = styles.noticeHost ?? HOST_ID
    // A live region so a screen reader announces a notice the moment it appears,
    // even though it is outside the React tree.
    host.setAttribute('role', 'region')
    host.setAttribute('aria-label', 'Background errors')
    doc.body.appendChild(host)
  }
  return host
}

/** Render one dismissible error notice into the host. */
function showNotice(doc: Document, text: string): void {
  const host = ensureHost(doc)
  // Keep only the most recent few so a storm of rejections cannot fill the screen.
  while (host.childElementCount >= NOTICE_LIMIT && host.firstElementChild) {
    host.firstElementChild.remove()
  }

  const notice = doc.createElement('div')
  notice.className = styles.notice ?? 'sketch-global-error-notice'
  notice.setAttribute('role', 'alert')

  const body = doc.createElement('span')
  body.className = styles.noticeText ?? ''
  body.textContent = `Something failed in the background: ${text}`
  notice.appendChild(body)

  const dismiss = doc.createElement('button')
  dismiss.type = 'button'
  dismiss.className = styles.noticeDismiss ?? ''
  dismiss.setAttribute('aria-label', 'Dismiss')
  dismiss.textContent = '×'
  dismiss.addEventListener('click', () => notice.remove())
  notice.appendChild(dismiss)

  host.appendChild(notice)
}

export interface GlobalErrorReporterOptions {
  /** The window to listen on. Defaults to the real one; injected in tests. */
  target?: Window
  /** Where the record goes. Defaults to console.error; injected in tests. */
  log?: (message: string, detail: unknown) => void
}

/**
 * Install the window-level 'unhandledrejection' and 'error' listeners.
 *
 * Returns a disposer that removes BOTH listeners and the notice host, so the app
 * can install this exactly once and React StrictMode's double-invoke (or a test)
 * cannot leave a doubled handler behind. The listeners report — a console record
 * and a visible, dismissible notice — and deliberately never call preventDefault,
 * so the platform's own default reporting still runs. Nothing is swallowed.
 */
export function installGlobalErrorReporter(options: GlobalErrorReporterOptions = {}): () => void {
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined)
  if (target === undefined) return () => {}
  const doc = target.document
  const log = options.log ?? ((message, detail) => console.error(message, detail))

  const onRejection = (event: PromiseRejectionEvent): void => {
    const text = messageOf(event.reason)
    log('[sketch] unhandled promise rejection:', event.reason)
    showNotice(doc, text)
  }

  const onError = (event: ErrorEvent): void => {
    const reason = event.error ?? event.message
    const text = messageOf(reason)
    log('[sketch] uncaught error:', reason)
    showNotice(doc, text)
  }

  target.addEventListener('unhandledrejection', onRejection as EventListener)
  target.addEventListener('error', onError as EventListener)

  return () => {
    target.removeEventListener('unhandledrejection', onRejection as EventListener)
    target.removeEventListener('error', onError as EventListener)
    doc.getElementById(HOST_ID)?.remove()
  }
}
