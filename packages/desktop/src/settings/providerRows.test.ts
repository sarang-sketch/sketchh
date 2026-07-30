// The Provider Settings view logic, with no DOM in the way.
//
// These are the decisions that would be invisible in a rendered assertion: which
// row is configured, what a never-run test is allowed to claim, whether a draft is
// savable, and — the one that matters most — that the entry a form produces has
// nowhere to put a key.
//
// Validates: Requirements 17.1, 17.2, 27.3

import { describe, expect, it } from 'vitest'

import {
  describeTest,
  draftBlocker,
  draftFor,
  entryFromDraft,
  previewEndpoint,
  providerRows,
  refusedEntries,
  stateFromResult,
} from './providerRows'
import type { ProviderDescriptor, ProviderSettingsEntry } from '../lib/contracts'

const OLLAMA: ProviderDescriptor = {
  id: 'ollama',
  name: 'Ollama (local)',
  kind: 'openai-compatible',
  defaultBaseUrl: 'http://localhost:11434/v1',
  needsKey: false,
  serverless: false,
}

const GROQ: ProviderDescriptor = {
  id: 'groq',
  name: 'Groq',
  kind: 'openai-compatible',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  needsKey: true,
  serverless: true,
}

const CONFIGURED_OLLAMA: ProviderSettingsEntry = {
  id: 'ollama',
  kind: 'openai-compatible',
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3',
  label: 'Ollama (local)',
}

describe('the matrix', () => {
  it('lists every catalog row, configured ones first', () => {
    const rows = providerRows([GROQ, OLLAMA], [CONFIGURED_OLLAMA])
    expect(rows.map((r) => r.descriptor.id)).toEqual(['ollama', 'groq'])
    expect(rows[0]?.configured).toBe(true)
    expect(rows[1]?.configured).toBe(false)
    expect(rows[1]?.entry).toBeNull()
    // The registry's serverless flag survives to the row.
    expect(rows[1]?.descriptor.serverless).toBe(true)
  })

  it('keeps a configured provider that is not in the catalog', () => {
    const custom: ProviderSettingsEntry = {
      id: 'my-proxy',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local-model',
      label: 'My proxy',
    }
    const rows = providerRows([OLLAMA], [custom])
    // Dropping it would hide a provider the engine will happily resolve.
    expect(rows.map((r) => r.descriptor.id)).toEqual(['my-proxy', 'ollama'])
    expect(rows[0]?.descriptor.name).toBe('My proxy')
  })

  it('renders nothing but honest rows when nothing is configured', () => {
    const rows = providerRows([OLLAMA, GROQ], [])
    expect(rows.every((r) => r.entry === null)).toBe(true)
  })
})

describe('what a connection test is allowed to claim', () => {
  it('treats never-run and cancelled as unknown, never as connected or failed', () => {
    expect(describeTest(undefined).tone).toBe('idle')
    expect(describeTest(undefined).label).toBe('Not tested')
    expect(describeTest({ status: 'never-run' }).tone).toBe('idle')
    expect(describeTest({ status: 'cancelled', at: 1 }).tone).toBe('idle')
    expect(describeTest({ status: 'testing' }).tone).toBe('busy')
  })

  it('gives the three real failures three different labels (Requirement 17.1)', () => {
    const codes = ['unreachable', 'unauthorized', 'model-not-found'] as const
    const labels = codes.map(
      (code) => describeTest({ status: 'failed', code, message: 'why', at: 1 }).label,
    )
    expect(new Set(labels).size).toBe(3)
    expect(labels).not.toContain('Failed')
  })

  it('carries the engine verdict through unchanged', () => {
    expect(stateFromResult({ ok: true, code: 'ok', message: 'served', url: 'u', durationMs: 1 }, 7))
      .toEqual({ status: 'ok', message: 'served', at: 7 })
    expect(
      stateFromResult(
        { ok: false, code: 'unreachable', message: 'nothing there', url: 'u', durationMs: 1 },
        7,
      ),
    ).toEqual({ status: 'failed', code: 'unreachable', message: 'nothing there', at: 7 })
    expect(
      stateFromResult(
        { ok: false, code: 'cancelled', message: 'cancelled', url: 'u', durationMs: 1 },
        7,
      ),
    ).toEqual({ status: 'cancelled', at: 7 })
  })
})

describe('the custom endpoint', () => {
  it('shows the URL that will actually be called', () => {
    expect(previewEndpoint('  http://localhost:11434/v1/  ')).toEqual({
      ok: true,
      resolvedUrl: 'http://localhost:11434/v1',
    })
  })

  it('refuses a scheme that is not http(s), and says why', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'localhost:11434', '']) {
      const preview = previewEndpoint(bad)
      expect(preview.ok, `${bad} must be refused`).toBe(false)
      expect(preview.reason).toBeTruthy()
    }
  })

  it('refuses credentials and query strings in the address', () => {
    expect(previewEndpoint('https://user:pw@example.com/v1').ok).toBe(false)
    expect(previewEndpoint('https://example.com/v1?api_key=abc').ok).toBe(false)
  })

  it('blocks a save that has no model or no usable endpoint', () => {
    const draft = draftFor(OLLAMA, null)
    expect(draft.baseUrl).toBe(OLLAMA.defaultBaseUrl)
    expect(draftBlocker(draft)).toMatch(/model/i)
    expect(draftBlocker({ ...draft, model: 'llama3' })).toBeNull()
    expect(draftBlocker({ ...draft, model: 'llama3', baseUrl: 'nope' })).toBeTruthy()
  })
})

describe('the entry a form produces', () => {
  it('has exactly five fields, none of them a key (Requirement 17.2)', () => {
    const entry = entryFromDraft({
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1/',
      model: '  llama3  ',
      label: '',
    })
    expect(Object.keys(entry).sort()).toEqual(['baseUrl', 'id', 'kind', 'label', 'model'])
    expect(entry.model).toBe('llama3')
    // An empty label falls back to the id rather than being written blank.
    expect(entry.label).toBe('ollama')
  })

  it('names what the engine refused instead of failing silently', () => {
    const sent: ProviderSettingsEntry[] = [
      CONFIGURED_OLLAMA,
      { ...CONFIGURED_OLLAMA, id: 'rejected', baseUrl: 'http://127.0.0.1:9/v1' },
    ]
    expect(refusedEntries(sent, [CONFIGURED_OLLAMA])).toEqual(['rejected'])
    expect(refusedEntries(sent, sent)).toEqual([])
  })
})
