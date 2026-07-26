// Plan artifact writer tests.
//
// Uses REAL: the filesystem (temp directories via mkdtemp) and a real
// MemoryEventStore. Nothing is mocked — the plan gate is only worth something if
// it is asserted against actual bytes on disk, since the whole point of the
// artifact being a directory is that the engine can ask the filesystem instead of
// trusting an in-memory flag.
//
// Validates: Requirements 6.1, 6.2, 6.3

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PlanWriter, PLAN_DOCUMENTS, InvalidRunIdError, resolveDocument } from '../src/plan/index.js'
import { MemoryEventStore } from '../src/events/index.js'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-plan-'))
  tmpDirs.push(dir)
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A full twelve-document plan, each with identifiable content. */
function fullPlan(): Record<string, string> {
  return Object.fromEntries(PLAN_DOCUMENTS.map((doc) => [doc, `# ${doc}\n\ncontent for ${doc}\n`]))
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('writing the plan artifact', () => {
  it('writes twelve files with the layout names and contents', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    const result = await writer.write('r1', fullPlan())

    expect(result.dir).toBe(join(base, '.sketch', 'plan', 'r1'))
    expect(result.files).toEqual([
      'prd.md',
      'stories.md',
      'architecture.md',
      'folders.md',
      'components.md',
      'api.md',
      'schema.md',
      'security.md',
      'tests.md',
      'milestones.md',
      'risks.md',
      'dependencies.md',
    ])
    expect(result.ignored).toEqual([])

    expect((await readdir(result.dir)).sort()).toEqual([...result.files].sort())
    for (const doc of PLAN_DOCUMENTS) {
      const text = await readFile(join(result.dir, `${doc}.md`), 'utf8')
      expect(text).toBe(`# ${doc}\n\ncontent for ${doc}\n`)
    }
    expect(await writer.missing('r1')).toEqual([])
  })

  it('writes only the four documents the plan action supplies, mapping arch to architecture.md', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    // Exactly the action protocol's shape: four keys, abbreviated names.
    const result = await writer.write('r1', {
      prd: 'product requirements',
      arch: 'the architecture',
      schema: 'the schema',
      tests: 'the test plan',
    })

    // Policy: unsupplied documents are OMITTED, not stubbed.
    expect(result.files).toEqual(['prd.md', 'architecture.md', 'schema.md', 'tests.md'])
    expect((await readdir(result.dir)).sort()).toEqual(
      ['architecture.md', 'prd.md', 'schema.md', 'tests.md'],
    )
    expect(await readFile(join(result.dir, 'architecture.md'), 'utf8')).toBe('the architecture')
    expect(await exists(join(result.dir, 'stories.md'))).toBe(false)

    // "Not yet planned" is readable from the directory shape itself.
    expect(await writer.missing('r1')).toEqual([
      'stories',
      'folders',
      'components',
      'api',
      'security',
      'milestones',
      'risks',
      'dependencies',
    ])
    // The partial plan still opens the gate: something was planned.
    expect(await writer.hasPlan('r1')).toBe(true)
  })

  it('accepts documented aliases and ignores keys that match no document', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    const result = await writer.write('r1', {
      'User_Stories': 'stories body',
      db: 'schema body',
      'api.md': 'api body',
      testPlan: 'tests body',
      // Neither a document nor an alias, and a path-shaped key at that: must not
      // become a file name.
      '../../escape': 'nope',
      whatever: 'nope',
    })

    expect(result.documents).toEqual(['stories', 'api', 'schema', 'tests'])
    expect(result.ignored.sort()).toEqual(['../../escape', 'whatever'])
    expect(await readFile(join(result.dir, 'stories.md'), 'utf8')).toBe('stories body')
    expect(await exists(join(base, '.sketch', 'escape'))).toBe(false)

    expect(resolveDocument('arch')).toBe('architecture')
    expect(resolveDocument('nonsense')).toBeNull()
  })

  it('emits plan_written exactly once, carrying the directory path', async () => {
    const base = await makeTmp()
    const events = new MemoryEventStore({ secrets: [] })
    const writer = new PlanWriter({ baseDir: base, events })

    await writer.write('r1', { prd: 'body', arch: 'body' })

    const written = (await events.forRun('r1')).filter((e) => e.kind === 'plan_written')
    expect(written).toHaveLength(1)
    expect(events.size).toBe(1)
    expect(written[0]!.payload.dir).toBe(join(base, '.sketch', 'plan', 'r1'))
    expect(written[0]!.payload.files).toEqual(['prd.md', 'architecture.md'])
  })

  it('upserts on a repeat write: supplied documents are overwritten, earlier ones survive', async () => {
    const base = await makeTmp()
    const events = new MemoryEventStore({ secrets: [] })
    const writer = new PlanWriter({ baseDir: base, events })

    await writer.write('r1', { prd: 'first draft', stories: 'the stories' })
    const second = await writer.write('r1', { prd: 'second draft', schema: 'the schema' })

    expect(second.files).toEqual(['prd.md', 'schema.md'])
    expect(await readFile(join(second.dir, 'prd.md'), 'utf8')).toBe('second draft')
    // Not re-supplied, so not erased: the gate stays monotonic.
    expect(await readFile(join(second.dir, 'stories.md'), 'utf8')).toBe('the stories')
    expect(await readPlanKeys(writer, 'r1')).toEqual(['prd', 'stories', 'schema'])
    // One event per call, not one per run.
    expect((await events.forRun('r1')).length).toBe(2)
  })
})

async function readPlanKeys(writer: PlanWriter, runId: string): Promise<string[]> {
  return Object.keys(await writer.readPlan(runId))
}

describe('hasPlan — the gate', () => {
  it('is false before any write', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })
    expect(await writer.hasPlan('r1')).toBe(false)
    expect(await exists(writer.planDir('r1'))).toBe(false)
  })

  it('is false for a directory that exists but is empty', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })
    await mkdir(writer.planDir('r1'), { recursive: true })

    expect(await exists(writer.planDir('r1'))).toBe(true)
    expect(await writer.hasPlan('r1')).toBe(false)
  })

  it('is false when every document is empty or whitespace-only', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    const { dir, files } = await writer.write('r1', {
      prd: '',
      arch: '   ',
      schema: '\n\t\n',
      tests: '\r\n  \r\n',
    })

    // The files really are on disk; they just carry no plan.
    expect(files).toHaveLength(4)
    expect((await readdir(dir)).sort()).toEqual(
      ['architecture.md', 'prd.md', 'schema.md', 'tests.md'],
    )
    expect(await writer.hasPlan('r1')).toBe(false)
  })

  it('is true after a real write, and stays true for one non-empty document among blanks', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    await writer.write('r1', fullPlan())
    expect(await writer.hasPlan('r1')).toBe(true)

    await writer.write('r2', { prd: '   ', arch: '', schema: 'x', tests: '' })
    expect(await writer.hasPlan('r2')).toBe(true)
  })

  it('ignores files that are not plan documents', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })
    const dir = writer.planDir('r1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'README.md'), 'not a plan document\n', 'utf8')
    await writeFile(join(dir, 'notes.txt'), 'also not one\n', 'utf8')

    expect(await writer.hasPlan('r1')).toBe(false)
  })

  it('is scoped per runId: writing run A does not open the gate for run B', async () => {
    const base = await makeTmp()
    const events = new MemoryEventStore({ secrets: [] })
    const writer = new PlanWriter({ baseDir: base, events })

    await writer.write('run-a', fullPlan())

    expect(await writer.hasPlan('run-a')).toBe(true)
    expect(await writer.hasPlan('run-b')).toBe(false)
    expect(await writer.readPlan('run-b')).toEqual({})

    // And a fresh writer over the same project agrees: the answer lives on disk,
    // not in the instance.
    const other = new PlanWriter({ baseDir: base })
    expect(await other.hasPlan('run-a')).toBe(true)
    expect(await other.hasPlan('run-b')).toBe(false)

    // Nor does a sibling directory name leak across.
    await writer.write('run-b', { prd: 'b plan' })
    expect(await writer.hasPlan('run-b')).toBe(true)
    expect(Object.keys(await writer.readPlan('run-a'))).toHaveLength(12)
    expect(Object.keys(await writer.readPlan('run-b'))).toEqual(['prd'])
  })
})

describe('readPlan', () => {
  it('round-trips every written document', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })
    const plan = fullPlan()

    await writer.write('r1', plan)

    expect(await writer.readPlan('r1')).toEqual(plan)
  })

  it('round-trips unicode and long content byte for byte', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    const unicode = '# 计划 — plan\n\nemoji: 🚀🧪✅\nrtl: مرحبا\ncombining: e\u0301\nnull-ish: \\u0000 literal\n'
    const long = `${'x'.repeat(200_000)}\nend\n`
    const crlf = 'line one\r\nline two\r\n'

    await writer.write('r1', { prd: unicode, arch: long, schema: crlf })

    const plan = await writer.readPlan('r1')
    expect(plan.prd).toBe(unicode)
    expect(plan.architecture).toBe(long)
    expect(plan.architecture!.length).toBe(long.length)
    expect(plan.schema).toBe(crlf)
    expect(await writer.hasPlan('r1')).toBe(true)
  })

  it('renders non-string artifact values rather than failing the plan', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    await writer.write('r1', { prd: ['bullet a', 'bullet b'], schema: { table: 'users' } })

    const plan = await writer.readPlan('r1')
    expect(plan.prd).toBe('bullet a\nbullet b')
    expect(plan.schema).toBe(JSON.stringify({ table: 'users' }, null, 2))
  })
})

describe('runId sanitization', () => {
  const rejected = [
    '../evil',
    '..',
    'a/../b',
    'nested/run',
    'nested\\run',
    '/absolute',
    'C:\\windows\\temp',
    '',
    '   ',
    ' leading',
    'trailing ',
    'has space',
    'weird*name',
    'quote"name',
    'colon:name',
    'pipe|name',
    'question?name',
    'con',
    'trailingdot.',
    'x'.repeat(129),
  ]

  it('rejects traversal and illegal characters', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })

    for (const runId of rejected) {
      expect(() => writer.planDir(runId), runId).toThrow(InvalidRunIdError)
      await expect(writer.write(runId, { prd: 'pwned' }), runId).rejects.toThrow(InvalidRunIdError)
      // A rejected runId can never satisfy the gate.
      expect(await writer.hasPlan(runId), runId).toBe(false)
    }
  })

  it('creates nothing outside the plan root when traversal is attempted', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })
    const escapeTarget = join(base, '.sketch', 'prd.md')
    const deeperTarget = join(base, 'prd.md')

    await expect(writer.write('../../..', { prd: 'pwned' })).rejects.toThrow(InvalidRunIdError)
    await expect(writer.write('../evil', { prd: 'pwned' })).rejects.toThrow(InvalidRunIdError)
    await expect(writer.write('..', { prd: 'pwned' })).rejects.toThrow(InvalidRunIdError)

    // The escaped locations do not exist, and neither does the plan root itself:
    // nothing was created at all.
    expect(await exists(escapeTarget)).toBe(false)
    expect(await exists(deeperTarget)).toBe(false)
    expect(await exists(join(base, '.sketch', 'evil'))).toBe(false)
    expect(await exists(join(base, '.sketch', 'plan'))).toBe(false)
  })

  it('accepts a real generated runId and keeps it inside the plan root', async () => {
    const base = await makeTmp()
    const writer = new PlanWriter({ baseDir: base })
    const runId = 'r0abcdefgh-0123456789abcdef'

    const dir = writer.planDir(runId)
    expect(dir.startsWith(writer.root)).toBe(true)
    expect(dir).toBe(join(base, '.sketch', 'plan', runId))
    await writer.write(runId, { prd: 'ok' })
    expect(await writer.hasPlan(runId)).toBe(true)
  })
})
