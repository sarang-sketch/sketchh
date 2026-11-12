// Invariant 2: no unhandled error takes the window down.
//   * A child that throws during render shows the recovery screen (never a blank
//     window), with the error message and a working Reload.
//   * A rejected promise / an uncaught error surfaces a visible, dismissible notice
//     AND a console record — it is never swallowed.
//
// Mutation checks that prove these are not vacuous are in the doc (fix-stability.md):
// returning `this.props.children` unconditionally from render, and making the global
// listeners call preventDefault + skip showNotice, each make a case here fail.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ErrorBoundary, installGlobalErrorReporter } from './ErrorBoundary'

function Boom({ when }: { when: boolean }) {
  if (when) throw new Error('kaboom from a child render')
  return <div>all good</div>
}

describe('ErrorBoundary — a throwing child shows the recovery screen', () => {
  // React logs a caught error to console.error; silence it so the test output is clean.
  let spy: MockInstance<typeof console.error>
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    spy.mockRestore()
    cleanup()
  })

  it('renders the child normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('all good')).toBeTruthy()
    expect(screen.queryByText('Sketch hit an unexpected error')).toBeNull()
  })

  it('shows the recovery screen with the error message instead of a blank window', () => {
    render(
      <ErrorBoundary onReload={() => {}}>
        <Boom when={true} />
      </ErrorBoundary>,
    )
    // The recovery screen, not an empty tree.
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Sketch hit an unexpected error')).toBeTruthy()
    // The real error message is shown to the user.
    expect(screen.getByText('kaboom from a child render')).toBeTruthy()
    // And a working Reload control.
    expect(screen.getByRole('button', { name: /reload sketch/i })).toBeTruthy()
  })

  it('Reload calls the injected reload handler', () => {
    const onReload = vi.fn()
    render(
      <ErrorBoundary onReload={onReload}>
        <Boom when={true} />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /reload sketch/i }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('records the caught error to the console (never swallowed)', () => {
    render(
      <ErrorBoundary onReload={() => {}}>
        <Boom when={true} />
      </ErrorBoundary>,
    )
    // componentDidCatch logged a record (one of the console.error calls carries our marker).
    const logged = spy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('caught by the app error boundary')),
    )
    expect(logged).toBe(true)
  })
})

describe('installGlobalErrorReporter — a rejected promise surfaces a notice', () => {
  let dispose: () => void
  let log: Mock<(message: string, detail: unknown) => void>

  beforeEach(() => {
    log = vi.fn<(message: string, detail: unknown) => void>()
    dispose = installGlobalErrorReporter({ target: window, log })
  })
  afterEach(() => {
    dispose()
    // The host node is removed by the disposer; confirm nothing lingers.
    expect(document.getElementById('sketch-global-error-host')).toBeNull()
  })

  it('shows a dismissible alert and records the rejection', () => {
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    // jsdom has no PromiseRejectionEvent constructor; attach the reason by hand.
    Object.defineProperty(event, 'reason', { value: new Error('a stray rejection'), configurable: true })
    window.dispatchEvent(event)

    // A console record was written — the error is reported, not swallowed.
    expect(log).toHaveBeenCalledTimes(1)

    // A visible alert carrying the reason is mounted.
    const host = document.getElementById('sketch-global-error-host')
    expect(host).not.toBeNull()
    const alerts = host!.querySelectorAll('[role="alert"]')
    expect(alerts.length).toBe(1)
    expect(alerts[0]!.textContent).toContain('a stray rejection')

    // It is dismissible.
    const dismiss = alerts[0]!.querySelector('button')!
    fireEvent.click(dismiss)
    expect(host!.querySelectorAll('[role="alert"]').length).toBe(0)
  })

  it('surfaces an uncaught window error the same way', () => {
    const event = new Event('error') as ErrorEvent
    Object.defineProperty(event, 'error', { value: new Error('an uncaught throw'), configurable: true })
    window.dispatchEvent(event)

    expect(log).toHaveBeenCalledTimes(1)
    const host = document.getElementById('sketch-global-error-host')!
    expect(host.textContent).toContain('an uncaught throw')
  })

  it('caps the number of notices so a storm cannot fill the screen', () => {
    for (let i = 0; i < 8; i++) {
      const event = new Event('unhandledrejection') as PromiseRejectionEvent
      Object.defineProperty(event, 'reason', { value: new Error(`rejection ${i}`), configurable: true })
      window.dispatchEvent(event)
    }
    const host = document.getElementById('sketch-global-error-host')!
    // Capped at NOTICE_LIMIT (4), keeping the most recent.
    expect(host.querySelectorAll('[role="alert"]').length).toBe(4)
    expect(host.textContent).toContain('rejection 7')
    expect(host.textContent).not.toContain('rejection 0')
  })

  it('removes both listeners on dispose (no doubled handler under StrictMode double-mount)', () => {
    // Dispose the beforeEach install, then install twice and dispose once: a leaked
    // listener from the first install would double the notice count.
    dispose()
    const d1 = installGlobalErrorReporter({ target: window, log })
    d1()
    const d2 = installGlobalErrorReporter({ target: window, log })
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(event, 'reason', { value: new Error('once only'), configurable: true })
    window.dispatchEvent(event)
    // Only the live install reports: one log, one notice.
    expect(log).toHaveBeenCalledTimes(1)
    const host = document.getElementById('sketch-global-error-host')!
    expect(host.querySelectorAll('[role="alert"]').length).toBe(1)
    d2()
    // re-install for afterEach's disposer + host-cleanup assertion.
    dispose = installGlobalErrorReporter({ target: window, log })
  })
})
