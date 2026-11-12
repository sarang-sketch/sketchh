// Settings → Privacy, driven against the REAL engine methods (`privacy-status`,
// `privacy-set`) with a temporary home, so the switch a user flips is the file the
// engine reads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS, clearActivity, recordActivity, type MethodContext } from '@sketch/core'

import { engineClient } from '../../test/engineHarness'
import { SketchClientProvider } from '../../lib/ClientProvider'
import type { PrivacyStatus, SketchClient } from '../../lib/client'
import { AppStateProvider, useAppState, type Conversation } from '../../state/AppState'
import { ConfirmProvider } from '../ConfirmDialog'
import { PrivacySettings } from './PrivacySettings'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sketch-privacy-ui-'))
  clearActivity()
})

afterEach(async () => {
  cleanup()
  await rm(home, { recursive: true, force: true })
})

function ctx(env: NodeJS.ProcessEnv): MethodContext {
  return { emitEvent: () => {}, log: () => {}, rememberSecret: () => {}, secrets: () => [], env, cwd: () => process.cwd() }
}

/** The engine's privacy methods, against the temporary home. `env` decides whether SKETCH_OFFLINE forces it. */
function client(env: NodeJS.ProcessEnv = { SKETCH_OFFLINE: '' }): SketchClient {
  return engineClient({
    privacyStatus: (o) => METHODS['privacy-status']!({ home, ...o }, ctx(env)) as Promise<PrivacyStatus>,
    privacySet: (offline, o) => METHODS['privacy-set']!({ offline, home, ...o }, ctx(env)) as Promise<PrivacyStatus>,
  })
}

function Count() {
  return <output aria-label="conversation count">{useAppState().conversations.length}</output>
}

function mount(sketch: SketchClient, conversations: Conversation[] = []) {
  return render(
    <SketchClientProvider client={sketch}>
      <AppStateProvider initial={{ conversations }}>
        <ConfirmProvider>
          <PrivacySettings />
          <Count />
        </ConfirmProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

const chat = (id: string): Conversation => ({ id, title: id, messages: [], createdAt: 1 })

async function savedOffline(): Promise<boolean> {
  return (JSON.parse(await readFile(join(home, '.sketch', 'privacy.json'), 'utf8')) as { offline: boolean }).offline
}

function toggle(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: 'Offline Mode' }) as HTMLInputElement
}

describe('Settings → Privacy', () => {
  it('turns Offline Mode on through the engine, which saves it for every window', async () => {
    mount(client())
    await waitFor(() => expect(toggle().disabled).toBe(false))
    expect(toggle().checked).toBe(false)

    fireEvent.click(toggle())
    await waitFor(() => expect(toggle().checked).toBe(true))
    expect(await savedOffline()).toBe(true)

    await waitFor(() => expect(toggle().disabled).toBe(false))
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle().checked).toBe(false))
    expect(await savedOffline()).toBe(false)
  })

  it('lists what the engine sent where, marking what Offline Mode blocked', async () => {
    recordActivity({ at: Date.now(), method: 'POST', origin: 'https://api.openai.com', local: false, outcome: 'blocked' })
    recordActivity({ at: Date.now(), method: 'GET', origin: 'http://localhost:11434', local: true, outcome: 'sent', status: 200 })
    mount(client())
    const table = await screen.findByRole('table', { name: 'Network activity' })
    await waitFor(() => expect(table.textContent).toContain('GET http://localhost:11434'))
    const text = table.textContent ?? ''
    expect(text).toContain('This computer')
    expect(text).toContain('Sent (200)')
    expect(text).toContain('POST https://api.openai.com')
    expect(text).toContain('Blocked')
  })

  it('cannot be switched when the engine environment forces it, and says why', async () => {
    mount(client({ SKETCH_OFFLINE: '1' }))
    await waitFor(() => expect(toggle().checked).toBe(true))
    expect(toggle().disabled).toBe(true)
    expect(screen.getByText(/cannot change it/)).toBeTruthy()
  })

  it('clears chat history only after the user confirms', async () => {
    mount(client(), [chat('a'), chat('b')])
    const count = () => screen.getByLabelText('conversation count').textContent
    expect(count()).toBe('2')

    fireEvent.click(await screen.findByRole('button', { name: /Clear chat history/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
    expect(count()).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: /Clear chat history/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }))
    await waitFor(() => expect(count()).toBe('0'))
  })
})
