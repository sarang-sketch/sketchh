// Tests for the legacy memory surface and what survives of `orchestrator/`:
// `extractJson`, `isWithin`, and the sandboxed `DiskFileWriter`.
//
// The `topoSort` and `Orchestrator` suites that used to sit at the bottom of this
// file were deleted with the legacy state machine they covered (`orchestrator.ts`,
// `planner.ts`, `agent-runner.ts`) and the legacy `verifier/` it drove. The
// canonical driver is `loop.runTask`, covered by `loop.test.ts`.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryProjectMemory } from '../src/memory/project-memory.js'
import { extractJson } from '../src/orchestrator/json.js'
import { DiskFileWriter, isWithin } from '../src/orchestrator/file-writer.js'

// ── MemoryProjectMemory ──────────────────────────────────────────────────────

describe('MemoryProjectMemory', () => {
  let clock: number
  const mk = () => new MemoryProjectMemory(() => clock)

  it('stores and lists decisions', async () => {
    clock = 100
    const m = mk()
    await m.addDecision({ id: 'd1', summary: 'use Tauri', rationale: 'small binary' })
    const decisions = await m.listDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0].createdAt).toBe(100)
  })

  it('sets and gets standards', async () => {
    const m = mk()
    clock = 1
    await m.setStandard('indent', '2 spaces')
    expect(await m.getStandard('indent')).toBe('2 spaces')
    expect(await m.getStandard('missing')).toBeNull()
  })

  it('finds bugs by file', async () => {
    const m = mk()
    clock = 1
    await m.addBug({ id: 'b1', description: 'null deref', fix: 'guard', files: ['a.ts'] })
    await m.addBug({ id: 'b2', description: 'off by one', fix: 'use <=', files: ['b.ts'] })
    const found = await m.findBugsByFile('a.ts')
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe('b1')
  })

  it('lists test records most-recent-first with limit', async () => {
    const m = mk()
    clock = 1; await m.addTestRecord({ id: 't1', checkName: 'lint', passed: true, output: '' })
    clock = 2; await m.addTestRecord({ id: 't2', checkName: 'test', passed: false, output: 'x' })
    const recent = await m.listTestRecords(1)
    expect(recent).toHaveLength(1)
    expect(recent[0].id).toBe('t2')
  })

  it('stores and lists conversations most-recent-first', async () => {
    // This was previously only exercised indirectly, through the legacy orchestrator's
    // end-to-end test. That test is gone; the behaviour is not, so it is asserted here
    // against the object that owns it.
    const m = mk()
    clock = 1; await m.addConversation({ id: 'c1', task: 'add a button', messages: '[]' })
    clock = 2; await m.addConversation({ id: 'c2', task: 'fix the button', messages: '[]' })
    const all = await m.listConversations()
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe('c2')
    expect(all[0].createdAt).toBe(2)
    expect(await m.listConversations(1)).toHaveLength(1)
  })

  it('digest summarises standards, decisions, and bugs', async () => {
    const m = mk()
    clock = 1
    await m.setStandard('lang', 'TypeScript')
    await m.addDecision({ id: 'd1', summary: 'no consensus engine', rationale: 'too costly' })
    await m.addBug({ id: 'b1', description: 'race condition', fix: 'add lock', files: ['x.ts'] })
    const digest = await m.digest()
    expect(digest).toContain('TypeScript')
    expect(digest).toContain('no consensus engine')
    expect(digest).toContain('race condition')
  })

  it('digest is empty for a fresh project', async () => {
    expect(await mk().digest()).toBe('')
  })
})

// ── extractJson ──────────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('parses raw JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses fenced json block', () => {
    const text = 'Here is the plan:\n```json\n{"a":2}\n```\nDone.'
    expect(extractJson(text)).toEqual({ a: 2 })
  })

  it('parses fenced block without json tag', () => {
    expect(extractJson('```\n{"b":3}\n```')).toEqual({ b: 3 })
  })

  it('recovers JSON embedded in prose', () => {
    expect(extractJson('blah blah {"c":4} trailing')).toEqual({ c: 4 })
  })

  it('handles nested braces and strings with braces', () => {
    const text = 'x {"msg":"a {nested} brace","n":{"deep":1}} y'
    expect(extractJson(text)).toEqual({ msg: 'a {nested} brace', n: { deep: 1 } })
  })

  it('returns null when no JSON present', () => {
    expect(extractJson('just prose, no json')).toBeNull()
  })
})

// ── isWithin ─────────────────────────────────────────────────────────────────

describe('isWithin', () => {
  it('accepts paths inside root', () => {
    expect(isWithin('/project', '/project/src/a.ts')).toBe(true)
  })
  it('accepts root itself', () => {
    expect(isWithin('/project', '/project')).toBe(true)
  })
  it('rejects paths outside root', () => {
    expect(isWithin('/project', '/etc/passwd')).toBe(false)
  })
  it('rejects parent traversal', () => {
    expect(isWithin('/project/sub', '/project/secret.ts')).toBe(false)
  })
})

// ── DiskFileWriter ───────────────────────────────────────────────────────────
//
// Real temp directory, real writes. Both cases came from the deleted `e2e.test.ts`,
// where they were the only assertions in that file about code which still ships.
// The escape refusal in particular had no other coverage anywhere.

describe('DiskFileWriter', () => {
  let tmp: string | null = null

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
    tmp = null
  })

  const root = async (): Promise<string> => {
    tmp = await mkdtemp(join(tmpdir(), 'sketch-file-writer-'))
    return tmp
  }

  it('writes edits to disk and returns the paths written', async () => {
    const dir = await root()
    const written = await new DiskFileWriter().apply(dir, [
      { path: 'greet.js', content: 'export const greet = (n) => `hi ${n}`\n' },
      { path: 'nested/deep/a.txt', content: 'a' },
    ])

    expect(written).toEqual(['greet.js', 'nested/deep/a.txt'])
    expect(await readFile(join(dir, 'greet.js'), 'utf8')).toContain('export const greet')
    expect(await readFile(join(dir, 'nested/deep/a.txt'), 'utf8')).toBe('a')
  })

  it('refuses to write outside the project directory', async () => {
    const dir = await root()
    await expect(
      new DiskFileWriter().apply(dir, [{ path: '../escape.js', content: 'x' }]),
    ).rejects.toThrow(/outside project directory/)
  })
})
