import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelSelector } from './ModelSelector'
import { popoverPosition } from './popoverPosition'
import { AppStateProvider } from '../state/AppState'
import { SketchClientProvider } from '../lib/ClientProvider'
import type { SketchClient } from '../lib/client'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('model picker placement', () => {
  it('opens above a bottom composer and stays inside narrow or right-edge windows', () => {
    expect(popoverPosition({ left: 1220, top: 800, bottom: 830 }, { width: 1440, height: 900 })).toMatchObject({ placement: 'above', bottom: 106, left: 1072, width: 360, maxHeight: 440 })
    const narrow = popoverPosition({ left: 240, top: 40, bottom: 70 }, { width: 320, height: 600 })
    expect(narrow).toMatchObject({ placement: 'below', left: 8, top: 76, width: 304 })
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(320)
    expect(narrow.maxHeight + narrow.top!).toBeLessThanOrEqual(600)
  })
})

describe('model picker keyboard and search', () => {
  it('searches real configured models, selects by keyboard and restores focus on Escape', async () => {
    const user = userEvent.setup()
    const providers = [
      { id: 'a', kind: 'openai-compatible' as const, baseUrl: 'http://localhost:1', label: 'Local A', model: 'coder-small' },
      { id: 'b', kind: 'openai-compatible' as const, baseUrl: 'http://localhost:2', label: 'Local B', model: 'coder-large' },
    ]
    const save = vi.fn(async ({ settings }) => ({ path: '/providers', settings }))
    const client = { transport: 'mock', ping: async () => ({ ok: true, version: 'test', transport: 'mock' }), subscribe: () => () => {}, saveProviderSettings: save } as unknown as SketchClient
    render(<SketchClientProvider client={client}><AppStateProvider initial={{ providers, providerSettingsPath: '/providers', selectedProvider: 'a', selectedModel: 'coder-small' }}><ModelSelector /></AppStateProvider></SketchClientProvider>)
    const trigger = screen.getByRole('button', { name: /Local A/ })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 950, top: 700, bottom: 730, right: 1000, width: 50, height: 30, x: 950, y: 700, toJSON: () => ({}) })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Choose a model' })
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.getAttribute('data-placement')).toBe('above')
    await user.type(screen.getByLabelText('Search models'), 'large')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(save).toHaveBeenCalledWith({ settings: { version: 1, providers, selected: 'b' } })
    expect(screen.queryByRole('dialog', { name: 'Choose a model' })).toBeNull()
    const chosen = screen.getByRole('button', { name: /Local B/ })
    expect(document.activeElement).toBe(chosen)
    fireEvent.keyDown(chosen, { key: 'ArrowDown' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Choose a model' })).toBeNull()
    expect(document.activeElement).toBe(chosen)
  })
})
