// W9 — the Settings dialog: B-009 grouping, visible labels, reset confirmation,
// keyboard-closeable, and settings export/import. Driven in jsdom against the real
// reducer; the Models tab (ProviderSettings/LocalModels, W4's) is not exercised here.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { engineClient } from '../../test/engineHarness'
import { SketchClientProvider } from '../../lib/ClientProvider'
import type { SketchClient } from '../../lib/client'
import {
  AppStateProvider,
  DEFAULT_EDITOR_SETTINGS,
  type AppState,
  type SettingsTab,
} from '../../state/AppState'
import { ConfirmProvider } from '../ConfirmDialog'
import { SettingsDialog } from './SettingsDialog'

afterEach(() => cleanup())

function mount(tab: SettingsTab, extra: Partial<AppState> = {}) {
  const client: SketchClient = engineClient({})
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ settingsOpen: true, settingsTab: tab, ...extra }}>
        <ConfirmProvider>
          <SettingsDialog />
        </ConfirmProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

describe('B-009 — tabs are grouped clearly, each name matches its content', () => {
  it('has the six distinct tabs, with no tab named for two things', () => {
    mount('editor')
    const nav = screen.getByRole('dialog', { name: 'Settings' })
    for (const label of ['Models', 'Agent', 'Editor', 'Privacy', 'Shortcuts', 'About']) {
      expect(within(nav).getByRole('button', { name: label })).toBeTruthy()
    }
    // The old double-named tab is gone.
    expect(within(nav).queryByRole('button', { name: /Shortcuts & privacy/i })).toBeNull()
  })

  it('Shortcuts tab holds the keyboard reference, not privacy text', () => {
    mount('shortcuts')
    const table = screen.getByRole('table', { name: 'Keyboard shortcuts' })
    // A known shortcut row is present inside the table (scoped so the nav title "Settings"
    // does not match).
    expect(within(table).getByText('Settings')).toBeTruthy()
    expect(within(table).getByText('Go to file')).toBeTruthy()
    expect(screen.queryByText(/No account, no usage reporting/i)).toBeNull()
  })

  it('Privacy tab holds the privacy & safety statements', () => {
    mount('privacy')
    expect(screen.getByText(/No account, no usage reporting/i)).toBeTruthy()
    expect(screen.getByText(/Keys stay in your OS credential store/i)).toBeTruthy()
  })

  it('About tab holds version/data/export-import, not the keyboard table', () => {
    mount('about')
    expect(screen.getByRole('heading', { name: 'About Sketch' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Copy settings/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Import settings/i })).toBeTruthy()
    expect(screen.queryByRole('table', { name: 'Keyboard shortcuts' })).toBeNull()
  })
})

describe('labels and keyboard', () => {
  it('every editor input has an accessible name', () => {
    mount('editor')
    expect(screen.getByLabelText('Color theme')).toBeTruthy()
    expect(screen.getByLabelText('Font size')).toBeTruthy()
    expect(screen.getByLabelText('Tab size')).toBeTruthy()
    expect(screen.getByLabelText('Auto save')).toBeTruthy()
    expect(screen.getByLabelText('Word wrap')).toBeTruthy()
  })

  it('Escape closes the dialog', async () => {
    mount('about')
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
  })
})

describe('Restore defaults asks before discarding non-default values (invariant 3)', () => {
  it('does not ask when the section is already at defaults', async () => {
    mount('editor')
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    // No confirm dialog appears (nothing to discard).
    await waitFor(() => expect(screen.queryByText(/Restore editor defaults\?/i)).toBeNull())
  })

  it('asks for confirmation when the editor settings differ from defaults', async () => {
    mount('editor', { editorSettings: { ...DEFAULT_EDITOR_SETTINGS, fontSize: 22 } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    await waitFor(() => expect(screen.getByText(/Restore editor defaults\?/i)).toBeTruthy())
    // The confirmation says it will not touch keys/providers.
    expect(screen.getByText(/does not touch your API keys/i)).toBeTruthy()
  })
})

describe('settings import flow (invariant 8b)', () => {
  it('rejects a non-settings paste with a specific error, applies nothing', async () => {
    mount('about')
    fireEvent.click(screen.getByRole('button', { name: /Import settings/i }))
    const area = screen.getByLabelText(/Paste exported settings JSON/i)
    fireEvent.change(area, { target: { value: '{"kind":"nope"}' } })
    fireEvent.click(screen.getByRole('button', { name: /Review changes/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/not a Sketch settings export/i)
  })

  it('shows the change preview for a valid export before applying', async () => {
    mount('about', { editorSettings: { ...DEFAULT_EDITOR_SETTINGS, fontSize: 13 } })
    fireEvent.click(screen.getByRole('button', { name: /Import settings/i }))
    const blob = JSON.stringify({
      kind: 'sketch-settings',
      version: 1,
      editor: { ...DEFAULT_EDITOR_SETTINGS, fontSize: 19 },
      agent: { mode: 'agent', autoApply: true, maxIterations: 30, maxUsd: 2, verifyChanges: true },
    })
    fireEvent.change(screen.getByLabelText(/Paste exported settings JSON/i), { target: { value: blob } })
    fireEvent.click(screen.getByRole('button', { name: /Review changes/i }))
    await waitFor(() => expect(screen.getByText(/would change/i)).toBeTruthy())
    expect(screen.getByText(/Font size/)).toBeTruthy()
    // Apply is a separate, explicit click.
    expect(screen.getByRole('button', { name: /Apply 1 change/i })).toBeTruthy()
  })
})
