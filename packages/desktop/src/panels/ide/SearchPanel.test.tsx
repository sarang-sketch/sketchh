// SearchPanel integration over the real matcher/search helpers and the file-action
// state owner. Process and filesystem capabilities are injected because jsdom has
// neither; their arguments and outcomes are asserted exactly.
// Validates: Requirements 14.6, 27.1, 27.3, 27.4, 27.5

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import SearchPanel, { SEARCH_DEBOUNCE_MS } from './SearchPanel'
import { FileIoProvider } from '../../editor/FileIoProvider'
import type { FileIo } from '../../editor/fileIo'
import { canonicalPath } from '../../editor/paths'
import { AppStateProvider, useAppState, type AppState } from '../../state/AppState'
import { CommandIoProvider } from '../../terminal/CommandIoProvider'
import type { CommandIo, CommandOutput, RunCommandRequest } from '../../terminal/commandIo'

const ROOT = 'C:/project'
const FILE = 'C:/project/src/App.tsx'

function Probe() {
  const state = useAppState()
  return <div data-testid="active-file">{state.activeFile ?? 'none'}</div>
}

function fileIo(content = 'const needle = true\n'): FileIo {
  return {
    async readDir(_root, path) {
      const key = canonicalPath(path)
      if (key === ROOT) return [{ name: 'src', path: `${ROOT}/src`, isDir: true }]
      if (key === `${ROOT}/src`) return [{ name: 'App.tsx', path: FILE, isDir: false }]
      return []
    },
    async readFile() { return content },
    async writeFile() { throw new Error('search never writes') },
    async pickFolder() { return null },
  }
}

class SearchCommandIo implements CommandIo {
  readonly calls: RunCommandRequest[] = []
  runImpl: (request: RunCommandRequest) => Promise<CommandOutput> = async () => ({
    exitCode: 1,
    stdout: '',
    stderr: '',
  })
  async allowedPrograms() { return ['git'] }
  async run(request: RunCommandRequest) {
    this.calls.push(request)
    return this.runImpl(request)
  }
}

function mount(
  root: string | null,
  command: CommandIo,
  files: FileIo = fileIo(),
  initial: Partial<AppState> = {},
) {
  return render(
    <AppStateProvider initial={{ projectRoot: root, searchQuery: '', ...initial }}>
      <FileIoProvider io={files}>
        <CommandIoProvider io={command}>
          <SearchPanel />
          <Probe />
        </CommandIoProvider>
      </FileIoProvider>
    </AppStateProvider>,
  )
}

async function runDebounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SearchPanel source guards', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SearchPanel.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('has no fixture result and never sets HTML', () => {
    expect(source).not.toMatch(/mockResults|const MOCK_|MOCK_SEARCH/)
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(source).not.toContain('src/components/Button.tsx')
  })
})

describe('SearchPanel honest states', () => {
  it('distinguishes no project from no query', () => {
    const command = new SearchCommandIo()
    mount(null, command)
    expect(screen.getByText('No folder open. Open a project to search its files.')).toBeDefined()
    expect((screen.getByLabelText('Search project files') as HTMLInputElement).value).toBe('')
    cleanup()

    mount(ROOT, command)
    expect(screen.getByText('Type something to search for.')).toBeDefined()
  })

  it('distinguishes no matches from a failed search', async () => {
    vi.useFakeTimers()
    const command = new SearchCommandIo()
    mount(ROOT, command)
    fireEvent.change(screen.getByLabelText('Search project files'), { target: { value: 'missing' } })
    await runDebounce()
    expect(screen.getByText('No matches for “missing”.')).toBeDefined()
    cleanup()

    command.runImpl = async () => { throw new Error('git executable is unavailable') }
    const brokenFiles = fileIo()
    brokenFiles.readDir = async () => { throw new Error('Access is denied') }
    mount(ROOT, command, brokenFiles)
    fireEvent.change(screen.getByLabelText('Search project files'), { target: { value: 'needle' } })
    await runDebounce()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Search failed: Cannot search C:/project: Access is denied')
    expect(screen.queryByText(/No matches/)).toBeNull()
  })
})

describe('SearchPanel results', () => {
  it('debounces, names the channel, and opens the hit through the file-action owner', async () => {
    vi.useFakeTimers()
    const command = new SearchCommandIo()
    command.runImpl = async () => ({
      exitCode: 0,
      stdout: 'src/App.tsx:7:const needle = true\n',
      stderr: '',
    })
    mount(ROOT, command)

    const input = screen.getByLabelText('Search project files')
    // Every keystroke of a word must not be a search.
    fireEvent.change(input, { target: { value: 'nee' } })
    fireEvent.change(input, { target: { value: 'needle' } })
    expect(command.calls).toHaveLength(0)

    await runDebounce()
    expect(command.calls).toHaveLength(1)
    expect(command.calls[0]!.args).toEqual([
      'grep', '--no-color', '-n', '-I', '-F', '--untracked', '-i', '-e', 'needle',
    ])
    expect(screen.getByText(/1 match in 1 file via git grep\./)).toBeDefined()
    expect(screen.getByText('7')).toBeDefined()

    fireEvent.click(screen.getByTitle('Open src/App.tsx at line 7'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('active-file').textContent).toBe(FILE)
  })

  it('never renders a result the query has already moved past', async () => {
    vi.useFakeTimers()
    const stale = deferred<CommandOutput>()
    const command = new SearchCommandIo()
    command.runImpl = async (request) => {
      const args = request.args ?? []
      const query = args[args.length - 1]
      if (query === 'stale') return stale.promise
      return { exitCode: 0, stdout: 'src/App.tsx:2:const fresh = true\n', stderr: '' }
    }
    mount(ROOT, command)

    const input = screen.getByLabelText('Search project files')
    fireEvent.change(input, { target: { value: 'stale' } })
    await runDebounce()
    // The first search is in flight and has rendered nothing.
    expect(command.calls).toHaveLength(1)

    fireEvent.change(input, { target: { value: 'fresh' } })
    await runDebounce()
    expect(command.calls).toHaveLength(2)
    expect(screen.getByText(/1 match in 1 file via git grep\./)).toBeDefined()
    expect(screen.getByTitle('Open src/App.tsx at line 2')).toBeDefined()

    // The abandoned query finishes late, with results for a query nobody is asking.
    await act(async () => {
      stale.resolve({ exitCode: 0, stdout: 'src/App.tsx:9:const stale = true\n', stderr: '' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText(/const stale/)).toBeNull()
    expect(screen.queryByTitle('Open src/App.tsx at line 9')).toBeNull()
    expect(screen.getByText(/1 match in 1 file via git grep\./)).toBeDefined()
    expect(screen.getByTitle('Open src/App.tsx at line 2')).toBeDefined()
  })
})
