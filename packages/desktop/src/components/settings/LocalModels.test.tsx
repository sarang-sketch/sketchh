// Settings → Models → "On this computer", driven through the REAL engine methods
// (`local-models`, `local-model-pull`, `local-model-delete`...) against a stand-in
// Ollama server on 127.0.0.1 that speaks the documented API.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { METHODS, type MethodContext } from '@sketch/core'

import { engineClient } from '../../test/engineHarness'
import { SketchClientProvider } from '../../lib/ClientProvider'
import type { SketchClient } from '../../lib/client'
import type { ProviderSettingsEntry } from '../../lib/contracts'
import { AppStateProvider, useAppState } from '../../state/AppState'
import { ConfirmProvider } from '../ConfirmDialog'
import { LocalModels } from './LocalModels'

let server: Server
let base: string
let seen: Array<{ method: string; path: string; body: Record<string, unknown> }>
let installed: string[]

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => (text += chunk))
    req.on('end', () => resolve(text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)))
  })
}

beforeEach(async () => {
  seen = []
  installed = ['qwen2.5-coder:7b']
  server = createServer(async (req, res) => {
    const payload = await body(req)
    const path = req.url ?? ''
    seen.push({ method: req.method ?? '', path, body: payload })
    const send = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (path === '/api/version') return send({ version: '0.12.6' })
    if (path === '/api/tags') return send({ models: installed.map((name) => ({ name, size: 4_700_000_000, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } })) })
    if (path === '/api/ps') return send({ models: [] })
    if (path === '/api/show') return send({ capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 } })
    if (path === '/api/delete') {
      installed = installed.filter((name) => name !== payload['model'])
      return send({})
    }
    if (path === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"status":"pulling manifest"}\n')
      res.write('{"status":"pulling aaa","digest":"sha256:aaa","total":100,"completed":100}\n')
      installed = [...installed, String(payload['model'])]
      res.end('{"status":"success"}\n')
      return
    }
    send({})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  cleanup()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const ctx: MethodContext = { emitEvent: () => {}, log: () => {}, rememberSecret: () => {}, secrets: () => [], env: process.env, cwd: () => process.cwd() }
const call = <T,>(method: string, params: object) => METHODS[method]!(params as Record<string, unknown>, ctx) as Promise<T>

function client(saved: ProviderSettingsEntry[][]): SketchClient {
  return engineClient({
    localModels: (o) => call('local-models', o ?? {}),
    localModelPull: (p) => call('local-model-pull', p),
    localModelPullStatus: (id) => call('local-model-pull-status', { id }),
    localModelPullCancel: (id) => call('local-model-pull-cancel', { id }),
    localModelDelete: (p) => call('local-model-delete', p),
    localModelLoad: (p) => call('local-model-load', p),
    saveProviderSettings: async ({ settings }) => {
      saved.push(settings.providers)
      return { settings, path: 'providers.json' } as never
    },
  })
}

function Selected() {
  const state = useAppState()
  return <output aria-label="selected">{`${state.selectedProvider ?? ''}/${state.selectedModel ?? ''}`}</output>
}

function mount(saved: ProviderSettingsEntry[][] = []) {
  const ollama: ProviderSettingsEntry = { id: 'ollama', kind: 'openai-compatible', baseUrl: `${base}/v1`, model: 'none', label: 'Ollama (local)' }
  return render(
    <SketchClientProvider client={client(saved)}>
      <AppStateProvider initial={{ providers: [ollama] as never }}>
        <ConfirmProvider>
          <LocalModels />
          <Selected />
        </ConfirmProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

describe('Models on this computer', () => {
  it('shows the running server and each installed model with what it can do', async () => {
    mount()
    const section = screen.getByRole('region', { name: 'Models on this computer' })
    // The engine also checks this machine (memory, `nvidia-smi`, the `ollama` program),
    // which can take a few seconds on a cold start.
    await waitFor(() => expect(section.textContent).toContain('Ollama 0.12.6 is running'), { timeout: 10_000 })
    await waitFor(() => expect(section.textContent).toContain('qwen2.5-coder:7b'))
    expect(section.textContent).toContain('32K context')
    expect(section.textContent).toContain('completion, tools')
    expect(section.textContent).toContain('Recommended for this computer')
  })

  it('asks before downloading, and downloads only after the user agrees', async () => {
    mount()
    await screen.findByText('Recommended for this computer', undefined, { timeout: 10_000 })
    const row = (await screen.findByText('qwen2.5-coder:3b')).closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: /Download/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
    expect(seen.some((s) => s.path === '/api/pull')).toBe(false)

    fireEvent.click(within(row).getByRole('button', { name: /Download/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('1.9 GB')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(seen.some((s) => s.path === '/api/pull' && s.body['model'] === 'qwen2.5-coder:3b')).toBe(true))
    await waitFor(() => expect(row.textContent).toContain('Installed'), { timeout: 5000 })
  })

  it('asks before removing a model', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove qwen2.5-coder:7b' }, { timeout: 10_000 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(seen.some((s) => s.method === 'DELETE' && s.body['model'] === 'qwen2.5-coder:7b')).toBe(true))
    await waitFor(() => expect(screen.getByText('Installed (0)')).toBeTruthy())
  })

  it('"Use for chat" makes the model the selected one, with no key', async () => {
    const saved: ProviderSettingsEntry[][] = []
    mount(saved)
    fireEvent.click(await screen.findByRole('button', { name: 'Use for chat' }, { timeout: 10_000 }))
    await waitFor(() => expect(screen.getByLabelText('selected').textContent).toBe('ollama/qwen2.5-coder:7b'))
    const entry = saved.at(-1)!.find((p) => p.id === 'ollama')!
    expect(entry).toMatchObject({ model: 'qwen2.5-coder:7b', baseUrl: `${base}/v1` })
    expect(JSON.stringify(entry)).not.toMatch(/apiKey/i)
  })
})
