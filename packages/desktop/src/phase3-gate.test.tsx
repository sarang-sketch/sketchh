// Phase 3's focused offline gate. Real temp files, real git processes, real core
// run loop/plan gate/file writer/diff parser, and the production React surfaces.
// Monaco alone is doubled because it cannot run in jsdom.
// Validates: Requirements 15.2, 16.4

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { events, loop, orchestrator, plan, providers, tools } from '@sketch/core'
import type { SketchEvent } from './lib/contracts'
import { createEventBus, type PingResult, type SketchClient } from './lib/client'
import { SketchClientProvider } from './lib/ClientProvider'
import { AppStateProvider, DEFAULT_AGENT_PREFS } from './state/AppState'
import { canonicalPath } from './editor/paths'
import { FileIoProvider } from './editor/FileIoProvider'
import type { FileIo } from './editor/fileIo'
import { createMonacoDouble, type MonacoDouble } from './editor/monacoDouble'
import { FileExplorer } from './panels/FileExplorer'
import EditorArea from './components/EditorArea'
import { AgentChat } from './panels/agent/AgentChat'
import { DiffReview } from './panels/DiffReview'
import { GitProvider } from './git/GitProvider'
import { GitPanel } from './panels/GitPanel'

const holder = vi.hoisted(() => ({ double: null as MonacoDouble | null }))
vi.mock('./editor/monacoSetup', () => ({
  loadMonaco: () => Promise.resolve({ api: holder.double!.api, theme: 'test-theme' }),
}))

class StreamingStore implements events.EventStore {
  readonly memory = new events.MemoryEventStore()
  constructor(private readonly publish: (event: SketchEvent) => void) {}
  async emit(input: events.EventInput): Promise<void> {
    this.memory.emit(input)
    const all = await this.memory.readAll()
    this.publish(all[all.length - 1] as SketchEvent)
  }
  readAll() { return this.memory.readAll() }
  forRun(runId: string) { return this.memory.forRun(runId) }
}

class InProcessGateClient implements SketchClient {
  readonly transport = 'mock' as const
  readonly bus = createEventBus()
  readonly coreEvents: SketchEvent[] = []
  /** Overridable so the engine-gate assertion can script an edit-before-plan run. */
  script: string[] = [
    JSON.stringify({ action: 'plan', artifacts: { prd: '# Plan\nReview the requested edit.' } }),
    JSON.stringify({ action: 'edit', edits: [{ path: 'app.ts', search: 'value = 2', replace: 'value = 3' }] }),
    JSON.stringify({ action: 'done', text: 'Proposal ready for review.' }),
  ]
  runId = 'phase3-run'

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'phase3-gate', transport: 'mock' })
  }
  subscribe(handler: (event: SketchEvent) => void) { return this.bus.subscribe(handler) }
  /** This panel starts no run, so it has none to stop. */
  
/** This surface starts no interactive run, so nothing awaits an answer. */

reply(): Promise<never> {
  return Promise.reject(new Error('this surface never answers a question'))
}

cancel(): Promise<never> {
    return Promise.reject(new Error('this surface never cancels a run'))
  }

  eval(): Promise<never[]> { return Promise.resolve([]) }

  async run(task: Parameters<SketchClient['run']>[0], options?: Parameters<SketchClient['run']>[1]) {
    const root = options?.root
    if (!root) throw new Error('gate client requires the open project root')
    const store = new StreamingStore((event) => {
      this.coreEvents.push(event)
      this.bus.emit(event)
    })
    const adapter = new providers.FakeChatAdapter({ script: this.script })
    const runId = this.runId
    return loop.runTask(task, {
      adapter,
      events: store,
      plan: new plan.PlanWriter({ baseDir: root, events: store }),
      files: new orchestrator.DiskFileWriter(),
      root,
      reviewEdits: options?.reviewEdits,
      ids: () => runId,
    })
  }

  private git(root: string) { return new tools.GitTool({ root }) }
  gitStatus({ root }: { root: string }) { return this.git(root).status() }
  gitDiff({ root, path, staged }: { root: string; path?: string; staged?: boolean }) {
    return this.git(root).diff({ ...(path ? { path } : {}), ...(staged ? { staged } : {}) })
  }
  async gitStage({ root, paths }: { root: string; paths: string[] }) {
    const git = this.git(root); await git.stage(paths); return git.status()
  }
  async gitUnstage({ root, paths }: { root: string; paths: string[] }) {
    const git = this.git(root); await git.unstage(paths); return git.status()
  }
  async gitCommit({ root, message }: { root: string; message: string }) {
    const git = this.git(root); const result = await git.commit(message)
    return { output: result.output, status: await git.status() }
  }

  // Phase 4's surface, not part of the Phase 3 chain. Rejecting keeps this gate
  // from quietly depending on provider configuration.
  providerCatalog(): Promise<never> { return Promise.reject(new Error('not part of the phase 3 gate')) }
  saveProviderSettings(): Promise<never> { return Promise.reject(new Error('not part of the phase 3 gate')) }
  testProvider(): Promise<never> { return Promise.reject(new Error('not part of the phase 3 gate')) }
}

function realFileIo(root: string): FileIo {
  const contained = (path: string) => {
    const target = resolve(path)
    const rel = relative(resolve(root), target)
    if (rel.startsWith('..') || resolve(rel) === rel) throw new Error('outside the folder you have open in Sketch')
    return target
  }
  return {
    readFile: async (_root, path) => readFile(contained(path), 'utf8'),
    writeFile: async (_root, path, content) => writeFile(contained(path), content, 'utf8'),
    readDir: async (_root, path) => {
      const dir = contained(path)
      const names = await readdir(dir)
      const rows = await Promise.all(names.filter((name) => !['.git', '.sketch'].includes(name)).map(async (name) => {
        const target = join(dir, name)
        return { name, path: target, isDir: (await stat(target)).isDirectory() }
      }))
      return rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    },
    pickFolder: async () => root,
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

describe('Phase 3 offline gate — actual open/edit/run/review/git seams', () => {
  let root: string
  let file: string
  let monaco: MonacoDouble

  beforeEach(async () => {
    Element.prototype.scrollIntoView = vi.fn()
    root = await mkdtemp(join(tmpdir(), 'sketch-phase3-gate-'))
    file = join(root, 'app.ts')
    await writeFile(file, 'export const value = 1\n', 'utf8')
    git(root, 'init', '--quiet', '--initial-branch=main')
    git(root, 'config', 'user.email', 'gate@sketch.invalid')
    git(root, 'config', 'user.name', 'Sketch Gate')
    git(root, 'add', '--', 'app.ts')
    git(root, 'commit', '--quiet', '-m', 'baseline')
    monaco = createMonacoDouble()
    holder.double = monaco
  })

  afterEach(async () => {
    cleanup()
    await rm(root, { recursive: true, force: true })
  })

  it('opens, edits, runs, reviews, accepts, shows real git status, and holds the plan gate in the UI and the engine', async () => {
    const client = new InProcessGateClient()
    const canonicalRoot = canonicalPath(root)
    const canonicalFile = canonicalPath(file)
    render(
      <SketchClientProvider client={client}>
        {/* Review mode is a user preference now (auto-apply with undo is the default);
            this gate is about the review seam, so it chooses review explicitly. */}
        <AppStateProvider
          initial={{
            mode: 'ide',
            projectRoot: canonicalRoot,
            agentPrefs: { ...DEFAULT_AGENT_PREFS, autoApply: false },
          }}
        >
          <FileIoProvider io={realFileIo(root)}>
            <GitProvider>
              <FileExplorer />
              <EditorArea />
              <AgentChat />
              <DiffReview />
              <GitPanel />
            </GitProvider>
          </FileIoProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )

    // Explorer -> real disk -> AppState -> Monaco model.
    fireEvent.click(await screen.findByText('app.ts'))
    await waitFor(() => expect(monaco.live.has(canonicalFile)).toBe(true))
    expect(monaco.model(canonicalFile).getValue()).toBe('export const value = 1\n')

    // Monaco's model-to-state callback, then the production Ctrl+S path to disk.
    act(() => monaco.model(canonicalFile).typeText('export const value = 2\n'))
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(async () => expect(await readFile(file, 'utf8')).toBe('export const value = 2\n'))

    // Cowork's real run button -> client seam -> real core loop in review mode.
    const prompt = screen.getByLabelText('Message the agent')
    fireEvent.change(prompt, { target: { value: 'Change value to three' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })

    // The loop emitted a parser-valid real patch, but review mode did not write it.
    const accept = await screen.findByLabelText('Accept hunk 1 of app.ts')
    expect(await readFile(file, 'utf8')).toBe('export const value = 2\n')
    const proposed = client.coreEvents.find((event) => event.kind === 'edit_proposed')!
    const edit = (proposed.payload['edits'] as Array<Record<string, unknown>>)[0]!
    expect(edit['diff']).toContain('@@ -1,1 +1,1 @@')
    expect(edit['diff']).toContain('+export const value = 3')
    expect(client.coreEvents.some((event) => event.kind === 'edit_accepted')).toBe(false)

    // The same run's plan unlocks acceptance; the selected hunk writes real bytes.
    expect(accept.hasAttribute('disabled')).toBe(false)
    fireEvent.click(accept)
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 accepted' }))
    await waitFor(async () => expect(await readFile(file, 'utf8')).toBe('export const value = 3\n'))

    // UI-originated edit_accepted refreshes GitProvider through the real GitTool.
    await screen.findByLabelText('Stage app.ts')
    const status = await new tools.GitTool({ root }).status()
    expect(status.unstaged.map((entry) => entry.path)).toContain('app.ts')

    const kinds = client.coreEvents.map((event) => event.kind)
    expect(kinds.indexOf('plan_written')).toBeLessThan(kinds.indexOf('edit_proposed'))
    expect(kinds.indexOf('edit_proposed')).toBeLessThan(kinds.indexOf('run_completed'))

    // ── PLAN GATE, ASSERTION 1 OF 2: THE UI MIRROR (Requirement 16.4) ────────
    // A proposal whose run has no observed `plan_written` keeps apply disabled,
    // and a plan belonging to a DIFFERENT run does not unlock it. The patch is
    // produced by the engine's own diff builder, not written by hand.
    const unplannedDiff = loop.unifiedDiff('app.ts', 'export const value = 3\n', 'export const value = 4\n')
    act(() =>
      client.bus.emit({
        id: 'gate-unplanned-proposal',
        ts: Date.now(),
        runId: 'unplanned-run',
        kind: 'edit_proposed',
        payload: { iteration: 1, reviewRequired: true, edits: [{ path: 'app.ts', diff: unplannedDiff }] },
      }),
    )

    const gatedAccept = await screen.findByLabelText('Accept hunk 1 of app.ts')
    const gatedApply = screen.getByRole('button', { name: /^Apply \d+ accepted$/ })
    expect(gatedAccept.hasAttribute('disabled')).toBe(true)
    expect(gatedApply.hasAttribute('disabled')).toBe(true)
    // The reason is stated to the user, naming the run it is waiting on.
    expect(gatedApply.getAttribute('title')).toMatch(/no plan_written event has been observed for run unplanned-run/)

    // Someone else's plan is not this run's plan.
    act(() =>
      client.bus.emit({
        id: 'gate-foreign-plan',
        ts: Date.now(),
        runId: 'some-other-run',
        kind: 'plan_written',
        payload: { dir: '.sketch/plan/some-other-run', files: ['prd.md'] },
      }),
    )
    expect(screen.getByLabelText('Accept hunk 1 of app.ts').hasAttribute('disabled')).toBe(true)

    // The right run's plan unlocks it, and only it.
    act(() =>
      client.bus.emit({
        id: 'gate-own-plan',
        ts: Date.now(),
        runId: 'unplanned-run',
        kind: 'plan_written',
        payload: { dir: '.sketch/plan/unplanned-run', files: ['prd.md'] },
      }),
    )
    expect(screen.getByLabelText('Accept hunk 1 of app.ts').hasAttribute('disabled')).toBe(false)

    // ── PLAN GATE, ASSERTION 2 OF 2: THE ENGINE (Requirement 6.5) ───────────
    // The authoritative gate. A real run over a real temp repo whose first action
    // is `edit` is refused by `PlanWriter.hasPlan` reading the filesystem — no
    // `edit_proposed`, no write, and the bytes on disk are identical.
    const engineRoot = await mkdtemp(join(tmpdir(), 'sketch-phase3-engine-'))
    try {
      const engineFile = join(engineRoot, 'app.ts')
      const before = 'export const value = 1\n'
      await writeFile(engineFile, before, 'utf8')
      const store = new events.MemoryEventStore()
      const planWriter = new plan.PlanWriter({ baseDir: engineRoot, events: store })
      const result = await loop.runTask(
        { id: 'engine-gate', prompt: 'edit without planning first', verify: [] },
        {
          adapter: new providers.FakeChatAdapter({
            script: [
              JSON.stringify({ action: 'edit', edits: [{ path: 'app.ts', search: 'value = 1', replace: 'value = 9' }] }),
              JSON.stringify({ action: 'done', text: 'stopping' }),
            ],
          }),
          events: store,
          plan: planWriter,
          files: new orchestrator.DiskFileWriter(),
          root: engineRoot,
          ids: () => 'engine-gate-run',
        },
      )

      expect(await planWriter.hasPlan(result.runId)).toBe(false)
      const engineEvents = await store.forRun(result.runId)
      const refusal = engineEvents.find((event) => event.kind === 'edit_rejected')
      expect(refusal?.payload['reason']).toBe(loop.PLAN_GATE_REASON)
      expect(engineEvents.some((event) => event.kind === 'edit_proposed')).toBe(false)
      expect(await readFile(engineFile, 'utf8')).toBe(before)
    } finally {
      await rm(engineRoot, { recursive: true, force: true })
    }
  })
})
