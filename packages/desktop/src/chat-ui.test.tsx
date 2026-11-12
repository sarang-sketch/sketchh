import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Markdown, parseBlocks } from './components/Markdown'
import type { SketchEvent } from './lib/contracts'
import { changedFiles, currentActivity, lineDiff, receiptFor, sidesOfPatch, stepFor, stepsFor } from './lib/runSummary'
import {
  appReducer,
  initialAppState,
  loadPersistedState,
  savePersistedState,
  scrubSecrets,
  type AppState,
  type ChatMessage,
} from './state/AppState'

afterEach(() => cleanup())

let seq = 0
function event(kind: SketchEvent['kind'], payload: Record<string, unknown>, runId = 'r1'): SketchEvent {
  return { id: `e${++seq}`, ts: seq, runId, kind, payload }
}

const patch = (before: string, after: string) =>
  [
    '--- a/x',
    '+++ b/x',
    `@@ -1,${before.split('\n').length} +1,${after.split('\n').length} @@`,
    ...before.split('\n').map((l) => `-${l}`),
    ...after.split('\n').map((l) => `+${l}`),
  ].join('\n')

describe('run summaries', () => {
  it('describes a background server with its URL, one that exited, and the process tools', () => {
    const started = stepFor(
      event('tool_called', {
        name: 'run_command',
        phase: 'result',
        ok: true,
        detail: { command: 'npm run dev', background: true, id: 'bg-1', url: 'http://localhost:5173' },
      }),
    )
    expect(started).toMatchObject({ kind: 'command', text: 'Started npm run dev in the background — http://localhost:5173', ok: true })
    const crashed = stepFor(
      event('tool_called', { name: 'run_command', phase: 'result', ok: false, detail: { command: 'npm run dev', background: true, exitCode: 1 } }),
    )
    expect(crashed).toMatchObject({ text: 'Tried to start npm run dev — it exited with 1', ok: false })
    expect(stepFor(event('tool_called', { name: 'stop_process', phase: 'result', ok: true, detail: { id: 'bg-1' } }))?.text).toBe(
      'Stopped the background process',
    )
  })

  it('turns the engine whole-file patch into a minimal line diff', () => {
    const before = 'a\nb\nc\nd'
    const after = 'a\nB\nc\nd\ne'
    const sides = sidesOfPatch(patch(before, after))!
    expect(sides).toEqual({ before, after })
    const lines = lineDiff(before, after)
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['B', 'e'])
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['b'])
  })

  it('reports the net change per file across several edits of one run', () => {
    const events = [
      event('edit_proposed', { edits: [{ path: 'a.ts', diff: patch('one\ntwo', 'one\nTWO'), wholeFile: false }] }),
      event('edit_proposed', { edits: [{ path: 'a.ts', diff: patch('one\nTWO', 'one\nTWO\nthree'), wholeFile: false }] }),
      event('edit_proposed', {
        edits: [{ path: 'new.ts', diff: '--- a/new.ts\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+hello', wholeFile: true }],
      }),
    ]
    const files = changedFiles(events)
    expect(files.map((f) => [f.path, f.added, f.removed, f.created])).toEqual([
      ['a.ts', 2, 1, false],
      ['new.ts', 1, 0, true],
    ])
  })

  it('describes what the run did, in order, without file contents', () => {
    const events = [
      event('repo_indexed', { files: 42 }),
      event('tool_called', { name: 'read_file', phase: 'start' }),
      event('tool_called', { name: 'read_file', phase: 'result', ok: true, detail: { path: 'src/app.ts' } }),
      event('plan_written', { files: ['prd.md'] }),
      event('edit_proposed', { reviewRequired: false, edits: [{ path: 'src/app.ts' }] }),
      event('verify_result', { name: 'unit', ok: false }),
      event('run_failed', { reason: 'loop_detected' }),
    ]
    expect(stepsFor(events).map((s) => s.text)).toEqual([
      'Indexed 42 files',
      'Read src/app.ts',
      'Wrote a plan',
      'Edited src/app.ts',
      'unit failed',
      'Stopped: the model kept repeating itself.',
    ])
    expect(currentActivity(events.slice(0, 2))).toBe('Reading the project…')
  })
})

describe('Markdown rendering is text, never HTML', () => {
  it('renders markup-looking model output as visible text, not elements', () => {
    const { container } = render(<Markdown text={'Look: <img src=x onerror="alert(1)"> and <script>alert(2)</script>'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('renders fenced code with a working copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // Defined, not assigned: an earlier test file in the same process can leave
    // `navigator.clipboard` as a getter-only property, which assignment cannot replace.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Markdown text={'Run this:\n\n```bash\nnpm test\n```'} />)
    expect(screen.getByText('npm test')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Copy code'))
    expect(writeText).toHaveBeenCalledWith('npm test')
  })

  it('only makes http(s) links clickable', () => {
    const { container } = render(<Markdown text={'[good](https://example.com) and [bad](javascript:alert(1))'} />)
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('https://example.com')
    expect(container.textContent).toContain('bad')
  })

  it('parses lists, headings, tables and leaves snake_case alone', () => {
    const blocks = parseBlocks('# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nuse snake_case_name here')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'table', 'para'])
    const { container } = render(<Markdown text="use snake_case_name here" />)
    expect(container.querySelector('em')).toBeNull()
  })
})

describe('conversations are real and remembered', () => {
  const msg = (id: string, role: ChatMessage['role'], content: string, ts: number): ChatMessage => ({
    id,
    role,
    content,
    timestamp: ts,
  })

  it('starts empty: no fabricated conversations or artifacts', () => {
    expect(initialAppState.conversations).toEqual([])
    expect(initialAppState.artifacts).toEqual([])
    expect(initialAppState.activeConversationId).toBeNull()
  })

  it('opens a conversation on the first message, titled by it, and keeps the rest in it', () => {
    let state: AppState = { ...initialAppState, projectRoot: 'C:/work' }
    state = appReducer(state, { type: 'ADD_MESSAGE', payload: msg('m1', 'user', 'Fix the login bug', 1) })
    state = appReducer(state, { type: 'ADD_MESSAGE', payload: msg('m2', 'agent', 'Fixed.', 2) })
    expect(state.conversations).toHaveLength(1)
    expect(state.conversations[0]!.title).toBe('Fix the login bug')
    expect(state.conversations[0]!.root).toBe('C:/work')
    expect(state.chatMessages.map((m) => m.id)).toEqual(['m1', 'm2'])

    // New task: a fresh conversation, the old one stays in Recents and reopens.
    const first = state.conversations[0]!.id
    state = appReducer(state, { type: 'NEW_CONVERSATION' })
    expect(state.chatMessages).toEqual([])
    state = appReducer(state, { type: 'ADD_MESSAGE', payload: msg('m3', 'user', 'Second task', 3) })
    expect(state.conversations).toHaveLength(2)
    state = appReducer(state, { type: 'SET_CONVERSATION', payload: first })
    expect(state.chatMessages.map((m) => m.id)).toEqual(['m1', 'm2'])

    state = appReducer(state, { type: 'UPDATE_MESSAGE', payload: { id: 'm2', patch: { filesState: 'undone' } } })
    expect(state.chatMessages[1]!.filesState).toBe('undone')
    state = appReducer(state, { type: 'DELETE_CONVERSATION', payload: first })
    expect(state.conversations).toHaveLength(1)
    expect(state.chatMessages).toEqual([])
  })

  it('bounds agent preferences so a stored value cannot unbound a run', () => {
    const state = appReducer(initialAppState, { type: 'SET_AGENT_PREFS', payload: { maxIterations: 100000, maxUsd: -5 } })
    expect(state.agentPrefs.maxIterations).toBe(100)
    expect(state.agentPrefs.maxUsd).toBeGreaterThan(0)
  })

  it('persists to local storage with credentials scrubbed, and restores what it can validate', () => {
    window.localStorage.clear()
    let state: AppState = { ...initialAppState, projectRoot: 'C:/work' }
    state = appReducer(state, {
      type: 'ADD_MESSAGE',
      payload: msg('k1', 'user', 'use key sk-live0123456789abcdef for the call', 1),
    })
    savePersistedState(state)
    const raw = window.localStorage.getItem('sketch.ui.v1')!
    expect(raw).not.toContain('sk-live0123456789abcdef')
    expect(raw).toContain('[redacted]')

    const restored = loadPersistedState()
    expect(restored.conversations).toHaveLength(1)
    expect(restored.projectRoot).toBe('C:/work')
    expect(scrubSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123')).not.toContain('ghp_')

    // Corrupt persisted state no longer loads as a silent empty object (W10 invariant 5):
    // it resets cleanly — no conversations, no root — AND surfaces a plain info notice so
    // the window does not start blank with no explanation, while preserving the original
    // bytes under a sidecar key.
    window.localStorage.setItem('sketch.ui.v1', '{not json')
    const afterCorrupt = loadPersistedState()
    expect(afterCorrupt.conversations).toBeUndefined()
    expect(afterCorrupt.projectRoot).toBeUndefined()
    expect(afterCorrupt.editorNotice?.level).toBe('info')
    expect(window.localStorage.getItem('sketch.ui.v1.corrupt')).toBe('{not json')
    window.localStorage.clear()
  })
})

describe('the run summary surfaces the engine completion-honesty verdict (B-003)', () => {
  it('reads the edit outcome from the terminal event into the receipt', () => {
    const failed = receiptFor([
      event('run_started', {}),
      event('run_failed', { reason: 'edits_failed', editsApplied: 0, editsFailed: 2 }),
    ])
    expect(failed.edits).toEqual({ applied: 0, failed: 2 })

    const ok = receiptFor([
      event('run_started', {}),
      event('run_completed', { reason: 'done', editsApplied: 3, editsFailed: 0 }),
    ])
    expect(ok.edits).toEqual({ applied: 3, failed: 0 })
  })

  it('leaves the receipt edits field absent for an old log without the fields', () => {
    const receipt = receiptFor([event('run_started', {}), event('run_completed', { reason: 'done' })])
    expect(receipt.edits).toBeUndefined()
  })

  it('names the edits-failed and edits-partial outcomes in plain words', () => {
    expect(stepFor(event('run_failed', { reason: 'edits_failed' }))).toMatchObject({
      kind: 'error',
      text: 'No changes were applied — every edit failed.',
      ok: false,
    })
    expect(stepFor(event('run_failed', { reason: 'edits_partial' }))).toMatchObject({
      kind: 'error',
      text: 'Some edits did not apply — the change is incomplete.',
      ok: false,
    })
  })
})

// ── the receipt shows which model ANSWERED each message (model identity) ──────

import { RunReceiptLine } from './components/RunCards'

describe('the run summary carries the model that answered (model identity)', () => {
  it('records the answered model from responseModel, falling back to the requested model', () => {
    // A router resolved the alias: responseModel is the model that answered.
    const aliased = receiptFor([
      event('run_started', {}),
      event('llm_response', { model: 'openrouter/auto', responseModel: 'deepseek/deepseek-chat-v3', usage: { in: 1, out: 1 } }),
      event('run_completed', { reason: 'done' }),
    ])
    expect(aliased.models).toEqual(['deepseek/deepseek-chat-v3'])
    expect(aliased.modelsAnswered).toBe(true)

    // No responseModel: only the requested model is known, and modelsAnswered is false.
    const requestedOnly = receiptFor([
      event('run_started', {}),
      event('llm_response', { model: 'gpt-4o', usage: { in: 1, out: 1 } }),
      event('run_completed', { reason: 'done' }),
    ])
    expect(requestedOnly.models).toEqual(['gpt-4o'])
    expect(requestedOnly.modelsAnswered).toBe(false)
  })

  it('dedupes models across a multi-call run, first-seen order', () => {
    const receipt = receiptFor([
      event('llm_response', { model: 'gpt-4o', responseModel: 'gpt-4o', usage: { in: 1, out: 1 } }),
      event('llm_response', { model: 'gpt-4o', responseModel: 'gpt-4o', usage: { in: 1, out: 1 } }),
    ])
    expect(receipt.models).toEqual(['gpt-4o'])
  })

  it('RunReceiptLine shows the answered model plainly, and labels a requested-only model', () => {
    const base = { checks: [], commands: [], modelCalls: 1, tokens: { in: 1, out: 1 }, tokensUnknownCalls: 0, tokensEstimated: false, retries: 0, durationMs: null }
    const { container: answered } = render(
      <RunReceiptLine receipt={{ ...base, models: ['deepseek/deepseek-chat-v3'], modelsAnswered: true }} />,
    )
    expect(answered.textContent).toContain('deepseek/deepseek-chat-v3')
    expect(answered.textContent).not.toContain('(requested)')

    cleanup()
    const { container: reqOnly } = render(
      <RunReceiptLine receipt={{ ...base, models: ['gpt-4o'], modelsAnswered: false }} />,
    )
    expect(reqOnly.textContent).toContain('gpt-4o (requested)')
  })
})

// ── the receipt is honest about unknown/estimated tokens and retries ──────────

describe('the receipt never shows unknown usage as 0 (invariant 3), and counts retries', () => {
  it('receiptFor marks unknown-usage calls, does not sum their zeros, and flags estimates', () => {
    const receipt = receiptFor([
      event('run_started', {}),
      // provider reported no usage → usageKnown:false, zeros are a placeholder.
      event('llm_response', { model: 'gpt-4o', usage: { in: 0, out: 0 }, usageKnown: false }),
      // a real, counted call.
      event('llm_response', { model: 'gpt-4o', usage: { in: 100, out: 50 } }),
      event('run_completed', { reason: 'done' }),
    ])
    expect(receipt.tokensUnknownCalls).toBe(1)
    expect(receipt.tokens).toEqual({ in: 100, out: 50 }) // the unknown call added nothing
    expect(receipt.modelCalls).toBe(2)
  })

  it('receiptFor flags estimated numbers and counts retries from attempts', () => {
    const receipt = receiptFor([
      event('llm_response', { model: 'fake', usage: { in: 4, out: 4 }, usageEstimated: true, attempts: 3 }),
    ])
    expect(receipt.tokensEstimated).toBe(true)
    expect(receipt.retries).toBe(2) // attempts 3 ⇒ 2 retries
  })

  it('RunReceiptLine shows "tokens unknown for N of M", "(estimated)", and "(N retries)"', () => {
    const base = { checks: [], commands: [], models: ['gpt-4o'], modelsAnswered: true, durationMs: null }
    const { container: unknown } = render(
      <RunReceiptLine receipt={{ ...base, modelCalls: 2, tokens: { in: 100, out: 50 }, tokensUnknownCalls: 1, tokensEstimated: false, retries: 0 }} />,
    )
    expect(unknown.textContent).toContain('tokens unknown for 1 of 2')
    expect(unknown.textContent).not.toMatch(/\b0 tokens\b/)

    cleanup()
    const { container: est } = render(
      <RunReceiptLine receipt={{ ...base, modelCalls: 1, tokens: { in: 4, out: 4 }, tokensUnknownCalls: 0, tokensEstimated: true, retries: 2 }} />,
    )
    expect(est.textContent).toContain('(estimated)')
    expect(est.textContent).toContain('(2 retries)')
  })
})
