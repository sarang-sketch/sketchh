// Search helper contract: shell-less vector fast path plus bounded file-walk fallback.
// Validates: Requirements 14.6, 22.6, 27.1, 27.5

import { describe, expect, it } from 'vitest'

import type { FileIo } from '../editor/fileIo'
import type { CommandIo, RunCommandRequest } from '../terminal/commandIo'
import { runSearch } from './runSearch'
import { DEFAULT_SEARCH_OPTIONS } from './searchText'

const ROOT = 'C:/repo'

function files(): FileIo {
  return {
    async readDir(_root, path) {
      if (path === ROOT) return [{ name: 'a.ts', path: `${ROOT}/a.ts`, isDir: false }]
      return []
    },
    async readFile() { return 'alpha needle omega\n' },
    async writeFile() { throw new Error('search does not write') },
    async pickFolder() { return null },
  }
}

function command(run: (request: RunCommandRequest) => Promise<{ exitCode: number; stdout: string; stderr: string }>): CommandIo {
  return { run, async allowedPrograms() { return ['git'] } }
}

describe('runSearch', () => {
  it('passes the query as one argv element, never a shell line', async () => {
    const calls: RunCommandRequest[] = []
    const query = 'needle; echo unsafe'
    const outcome = await runSearch(
      { files: files(), command: command(async (request) => {
        calls.push(request)
        return { exitCode: 1, stdout: '', stderr: '' }
      }) },
      { root: ROOT, query, options: DEFAULT_SEARCH_OPTIONS, token: { cancelled: false } },
    )

    expect('ok' in outcome && outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      projectRoot: ROOT,
      cwd: '',
      program: 'git',
      confirmed: true,
    })
    expect(calls[0]!.args).toContain(query)
    expect(calls[0]!.args).not.toContain(`git grep ${query}`)
  })

  it('falls back to the file walker and states why', async () => {
    const outcome = await runSearch(
      { files: files(), command: command(async () => { throw new Error('git is unavailable') }) },
      {
        root: ROOT,
        query: 'needle',
        options: DEFAULT_SEARCH_OPTIONS,
        token: { cancelled: false },
      },
    )

    expect(outcome).toMatchObject({
      ok: true,
      channel: 'walker',
      hitCount: 1,
      fallbackReason: 'git is unavailable',
      groups: [{ path: `${ROOT}/a.ts`, relativePath: 'a.ts' }],
    })
  })

  it('stops a walk when its cancellation token is set', async () => {
    const token = { cancelled: false }
    const io = files()
    io.readDir = async () => {
      token.cancelled = true
      return [{ name: 'a.ts', path: `${ROOT}/a.ts`, isDir: false }]
    }
    const outcome = await runSearch(
      { files: io, command: command(async () => { throw new Error('no git') }) },
      { root: ROOT, query: 'needle', options: DEFAULT_SEARCH_OPTIONS, token },
    )
    expect(outcome).toEqual({ cancelled: true })
  })

  it('reports a root read failure rather than calling it no matches', async () => {
    const io = files()
    io.readDir = async () => { throw new Error('permission denied') }
    const outcome = await runSearch(
      { files: io, command: command(async () => { throw new Error('no git') }) },
      { root: ROOT, query: 'needle', options: DEFAULT_SEARCH_OPTIONS, token: { cancelled: false } },
    )
    expect(outcome).toEqual({ ok: false, message: 'Cannot search C:/repo: permission denied' })
  })
})
