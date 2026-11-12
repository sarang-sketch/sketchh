// The title bar's menus, in user terms:
//   * File → Open Recent lists the other folders this user opened and switches to one,
//     asking first about unsaved tabs, like Open Folder;
//   * the menus name the new shortcuts: Ctrl+O, Ctrl+K (Edit with AI), Alt+F5, F5.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// B-008: the title bar's window controls (minimize/maximize/close) reach a Tauri-only
// API (getCurrentWindow), which throws a TypeError outside the packaged app. The guard
// reads `isTauri()`. The mocked window API records whether the control ever reached it:
// in the dev preview (isTauri false) the guard short-circuits so it is NEVER called;
// in the packaged app (isTauri true) it IS. Removing the guard makes the dev case call
// it — which is what the mutation check confirms this test catches.
const win = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }
const getCurrentWindow = vi.fn(() => win)
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }))
const isTauri = vi.fn(() => false)
vi.mock('../ipc/bridge', () => ({ isTauri: () => isTauri() }))

import { TitleBar } from './TitleBar'
import { ConfirmProvider } from './ConfirmDialog'
import { AppStateProvider, useAppState, type AppState } from '../state/AppState'

// jsdom's window is 1024 wide; below 1080 the seven menus fold into one.
const realWidth = window.innerWidth
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1400 })
  isTauri.mockReturnValue(false)
  getCurrentWindow.mockClear()
  win.minimize.mockClear()
  win.toggleMaximize.mockClear()
  win.close.mockClear()
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: realWidth })
})

function Root() {
  const state = useAppState()
  return <div data-testid="root">{state.projectRoot ?? ''}</div>
}

function mount(initial: Partial<AppState>) {
  render(
    <AppStateProvider initial={{ mode: 'ide', ...initial }}>
      <ConfirmProvider>
        <TitleBar />
        <Root />
      </ConfirmProvider>
    </AppStateProvider>,
  )
}

const openMenu = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

describe('the title bar', () => {
  it('File → Open Recent lists the other folders and switches to one', async () => {
    mount({
      projectRoot: 'C:/work/app',
      workspaces: [
        { name: 'app', path: 'C:/work/app' },
        { name: 'api', path: 'C:/work/api' },
        { name: 'site', path: 'D:/sites/site' },
      ],
    })
    openMenu('File')
    expect(screen.getByRole('menuitem', { name: 'Open Recent' }).hasAttribute('disabled')).toBe(true)
    // The folder that is already open is not offered again.
    expect(screen.queryByRole('menuitem', { name: 'app' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'site' }).getAttribute('title')).toBe('D:/sites/site')

    fireEvent.click(screen.getByRole('menuitem', { name: 'api' }))
    await waitFor(() => expect(screen.getByTestId('root').textContent).toBe('C:/work/api'))
  })

  it('offers no Open Recent section before any folder was opened', () => {
    mount({ projectRoot: null, workspaces: [] })
    openMenu('File')
    expect(screen.queryByRole('menuitem', { name: 'Open Recent' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Open Folder…\s*Ctrl\+O/ })).toBeTruthy()
  })

  it('names Edit with AI, the change navigation and Run in the menus', () => {
    mount({ projectRoot: 'C:/work/app' })
    openMenu('Edit')
    expect(screen.getByRole('menuitem', { name: /Edit with AI…\s*Ctrl\+K/ })).toBeTruthy()
    openMenu('Go')
    expect(screen.getByRole('menuitem', { name: /Next Change\s*Alt\+F5/ })).toBeTruthy()
    openMenu('Run')
    expect(screen.getByRole('menuitem', { name: /Run a Script…\s*F5/ })).toBeTruthy()
  })
})

describe('the window controls guard the Tauri-only API (B-008)', () => {
  it('calls the window API in the packaged app (running under Tauri)', async () => {
    isTauri.mockReturnValue(true)
    mount({ projectRoot: 'C:/work/app' })
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    await waitFor(() => expect(win.minimize).toHaveBeenCalled())
  })

  it('does not reach the window API outside Tauri (dev preview)', async () => {
    isTauri.mockReturnValue(false)
    mount({ projectRoot: 'C:/work/app' })
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
    // The packaged-app case proves the mock is wired; here the guard short-circuits,
    // so after the same settle window the window API was never reached.
    await new Promise((r) => setTimeout(r, 20))
    expect(getCurrentWindow).not.toHaveBeenCalled()
    expect(win.minimize).not.toHaveBeenCalled()
    expect(win.toggleMaximize).not.toHaveBeenCalled()
  })
})
