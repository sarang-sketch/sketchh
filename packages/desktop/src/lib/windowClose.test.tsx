// Closing the window with unsaved edits asks first, however it is closed. In user terms:
//   * Alt+F4 / the taskbar's Close with an unsaved tab asks Save / Don't Save / Cancel;
//     Cancel keeps the window open, Don't Save lets it close;
//   * nothing unsaved: it closes without a question;
//   * the title bar's ✕ already asked, so the close request it sends is not asked twice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { askToClose, markCloseConfirmed, takeCloseConfirmed } from './windowClose'
import { DesktopShell } from '../App'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { AppStateProvider, type AppState } from '../state/AppState'

type CloseHandler = (event: { preventDefault(): void }) => Promise<void>
const tauri = vi.hoisted(() => ({ handlers: [] as Array<(event: { preventDefault(): void }) => Promise<void>> }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: CloseHandler) => {
      tauri.handlers.push(handler)
      return () => {
        tauri.handlers = tauri.handlers.filter((h) => h !== handler)
      }
    },
    setTitle: async () => {},
  }),
}))

const A = 'C:/app/src/a.ts'
const dirtyTab: Partial<AppState> = {
  mode: 'ide',
  projectRoot: 'C:/app',
  openFiles: [A],
  activeFile: A,
  files: {
    [A]: { path: A, name: 'a.ts', content: 'changed', language: 'typescript', isDirty: true, diskContent: 'saved', diskVersion: 1 },
  },
}

function mount(initial: Partial<AppState>) {
  render(
    <AppStateProvider initial={initial}>
      <ConfirmProvider>
        <DesktopShell />
      </ConfirmProvider>
    </AppStateProvider>,
  )
}

/** What the OS does on Alt+F4: send a close request, and close unless it is prevented. */
async function requestClose(): Promise<{ prevented: boolean }> {
  await waitFor(() => expect(tauri.handlers).toHaveLength(1))
  let prevented = false
  const handled = tauri.handlers[0]!({ preventDefault: () => (prevented = true) })
  return handled.then(() => ({ prevented }))
}

beforeEach(() => {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  tauri.handlers = []
  takeCloseConfirmed()
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('closing the window with unsaved edits', () => {
  it('asks on an OS close, and Cancel keeps the window open', async () => {
    mount(dirtyTab)
    const closing = requestClose()
    expect(await screen.findByText('Save changes to a.ts before closing?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await closing).toEqual({ prevented: true })
  })

  it("lets it close on Don't Save", async () => {
    mount(dirtyTab)
    const closing = requestClose()
    fireEvent.click(await screen.findByRole('button', { name: 'Don’t Save' }))
    expect(await closing).toEqual({ prevented: false })
  })

  it('closes without a question when nothing is unsaved', async () => {
    mount({ mode: 'ide', projectRoot: 'C:/app' })
    expect(await requestClose()).toEqual({ prevented: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not ask twice after the title bar already asked', async () => {
    mount(dirtyTab)
    await waitFor(() => expect(tauri.handlers).toHaveLength(1))
    act(() => markCloseConfirmed())
    expect(await requestClose()).toEqual({ prevented: false })
    expect(screen.queryByText('Save changes to a.ts before closing?')).toBeNull()
    // The mark is spent: the next close asks again.
    const again = requestClose()
    expect(await screen.findByText('Save changes to a.ts before closing?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await again).toEqual({ prevented: true })
  })
})

describe('askToClose', () => {
  const pick = (id: string) => vi.fn(async () => id)

  it('does not ask when nothing is unsaved', async () => {
    const confirm = pick('cancel')
    expect(await askToClose([], confirm, async () => true)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('closes only after a save that worked', async () => {
    expect(await askToClose(['a.ts', 'b.ts'], pick('save'), async () => true)).toBe(true)
    expect(await askToClose(['a.ts'], pick('save'), async () => false)).toBe(false)
    expect(await askToClose(['a.ts'], pick('discard'), async () => false)).toBe(true)
    expect(await askToClose(['a.ts'], pick('cancel'), async () => true)).toBe(false)
  })
})
