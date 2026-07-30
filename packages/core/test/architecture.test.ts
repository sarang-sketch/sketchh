// Architecture generator tests.
//
// Uses REAL: temp project directories with real files, the real walker/chunker/
// import extractor behind `buildRepoGraph`, the real signature scanner, real
// file reads, and a real `MemoryEventStore`. Nothing is mocked.
//
// The two claims that matter get their own tests:
//   * DETERMINISM (19.4) — byte equality across repeated generation, and across
//     a fresh graph rebuilt from the same tree in a different directory.
//   * HONESTY — a view with no evidence emits NO diagram and states why. The
//     guard is structural: `available === false` implies `mermaid === ''`, for
//     every view, in every fixture.
//
// Validates: Requirements 19.1, 19.2, 19.3, 19.4, 19.5

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRepoGraph, type RepoGraph } from '../src/context/repo-graph.js'
import {
  generateArchitecture,
  renderArchitectureDocument,
  ARCHITECTURE_VIEWS,
  DIAGRAM_FORMAT,
  moduleOf,
  type ArchitectureDiagrams,
  type ArchitectureViewKind,
} from '../src/context/architecture.js'
import { MemoryEventStore } from '../src/events/index.js'

const tmpDirs: string[] = []

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-arch-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function write(root: string, relative: string, content: string): Promise<void> {
  const full = join(root, relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

/**
 * A real little project: two modules, real import edges, real exported
 * declarations, and real call sites across a module boundary. No routes and no
 * schema — so the API and database views must report themselves unavailable.
 */
async function seedCodeProject(root: string): Promise<void> {
  await write(
    root,
    'src/app/main.ts',
    [
      "import { helper, Widget } from '../lib/helper.js'",
      '',
      'export function start(): number {',
      '  const w = new Widget()',
      '  return helper(1) + w.size()',
      '}',
      '',
      '// helper(999) in a comment must not count as a call site',
      "const note = 'helper(0)'",
      'export const label = note',
      '',
    ].join('\n')
  )
  await write(
    root,
    'src/lib/helper.ts',
    [
      'export function helper(n: number): number {',
      '  return n + 1',
      '}',
      '',
      'export class Widget {',
      '  size(): number {',
      '    return 2',
      '  }',
      '}',
      '',
      'function internal(): void {}',
      '',
    ].join('\n')
  )
  await write(root, 'README.md', '# fixture\n')
}

async function graphFor(root: string): Promise<RepoGraph> {
  const { graph } = await buildRepoGraph({ root, persist: false })
  return graph
}

function view(result: ArchitectureDiagrams, kind: ArchitectureViewKind) {
  const found = result.views.find(v => v.kind === kind)
  expect(found, `view ${kind} must exist`).toBeDefined()
  return found!
}

describe('generateArchitecture — the seven views', () => {
  it('derives exactly the seven required views, in a fixed order', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const result = await generateArchitecture({ graph: await graphFor(root), root })

    expect(result.views.map(v => v.kind)).toEqual([...ARCHITECTURE_VIEWS])
    expect(result.views).toHaveLength(7)
    expect(result.format).toBe(DIAGRAM_FORMAT)
    expect([...result.available, ...result.unavailable].sort()).toEqual(
      [...ARCHITECTURE_VIEWS].sort()
    )
  })

  it('derives the folder tree from graph paths', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const tree = view(await generateArchitecture({ graph: await graphFor(root), root }), 'folder-tree')

    expect(tree.available).toBe(true)
    expect(tree.mermaid.startsWith('flowchart TD')).toBe(true)
    expect(tree.mermaid).toContain('README.md')
    expect(tree.mermaid).toContain('"src/"')
    expect(tree.evidence.source).toBe('graph.files[].path')
    expect(tree.evidence.found).toBe(3)
  })

  it('derives the dependency view from the graph\'s own resolved edges', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const dependency = view(
      await generateArchitecture({ graph: await graphFor(root), root }),
      'dependency'
    )

    expect(dependency.available).toBe(true)
    expect(dependency.edges).toBe(1)
    expect(dependency.mermaid).toContain('src/app/main.ts')
    expect(dependency.mermaid).toContain('src/lib/helper.ts')
    expect(dependency.mermaid).toMatch(/n\d+ --> n\d+/)
  })

  it('aggregates the system view by module with edge weights', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const system = view(await generateArchitecture({ graph: await graphFor(root), root }), 'system')

    expect(moduleOf('src/app/main.ts')).toBe('src/app')
    expect(moduleOf('README.md')).toBe('(root)')
    expect(system.available).toBe(true)
    expect(system.mermaid).toContain('src/app')
    expect(system.mermaid).toContain('src/lib')
    expect(system.mermaid).toContain('1 import(s)')
  })

  it('derives the component view from real extracted declarations', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const component = view(
      await generateArchitecture({ graph: await graphFor(root), root }),
      'component'
    )

    expect(component.available).toBe(true)
    // Exported only: `internal` is not part of the public surface.
    expect(component.mermaid).toContain('function helper')
    expect(component.mermaid).toContain('class Widget')
    expect(component.mermaid).not.toContain('internal')
    expect(component.evidence.caveat).not.toBeNull()
  })

  it('derives call edges from real call sites and ignores comments and strings', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const calls = view(
      await generateArchitecture({ graph: await graphFor(root), root }),
      'call-graph'
    )

    expect(calls.available).toBe(true)
    expect(calls.mermaid).toContain('helper()')
    expect(calls.mermaid).toContain('Widget()')
    // One real `helper(1)` call. The commented and quoted occurrences do not count.
    expect(calls.mermaid).toContain('1 call site(s)')
    expect(calls.mermaid).not.toContain('3 call site(s)')
  })
})

describe('generateArchitecture — honesty about missing evidence', () => {
  it('reports the API view unavailable when no routes exist, with a stated reason', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const api = view(await generateArchitecture({ graph: await graphFor(root), root }), 'api')

    expect(api.available).toBe(false)
    expect(api.mermaid).toBe('')
    expect(api.nodes).toBe(0)
    expect(api.edges).toBe(0)
    expect(api.evidence.found).toBe(0)
    expect(api.reason).toContain('no API surface found')
    expect(api.reason).toContain('import edges alone would')
  })

  it('reports the database view unavailable when the repository has no schema', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const database = view(
      await generateArchitecture({ graph: await graphFor(root), root }),
      'database'
    )

    expect(database.available).toBe(false)
    expect(database.mermaid).toBe('')
    expect(database.reason).toContain('no schema found')
    expect(database.reason).toContain('0 .sql and 0 .prisma')
  })

  it('never emits a diagram for a view it calls unavailable, and never omits a reason', async () => {
    // The structural honesty guard, asserted over three different fixtures so it
    // is not a statement about one lucky tree.
    const empty = await makeProject()
    const codeOnly = await makeProject()
    await seedCodeProject(codeOnly)
    const full = await makeProject()
    await seedCodeProject(full)
    await write(
      full,
      'server/routes.ts',
      ["export function mount(app: any): void {", "  app.get('/health', () => 1)", '}', ''].join('\n')
    )
    await write(
      full,
      'db/schema.sql',
      ['CREATE TABLE users (id INTEGER PRIMARY KEY);', '', 'CREATE TABLE posts (', '  id INTEGER,', '  author INTEGER REFERENCES users(id)', ');', ''].join('\n')
    )

    for (const root of [empty, codeOnly, full]) {
      const result = await generateArchitecture({ graph: await graphFor(root), root })
      for (const v of result.views) {
        if (v.available) {
          expect(v.mermaid, `${root} ${v.kind}`).not.toBe('')
          expect(v.reason, `${root} ${v.kind}`).toBeNull()
          expect(v.evidence.found, `${root} ${v.kind}`).toBeGreaterThan(0)
        } else {
          expect(v.mermaid, `${v.kind} claimed unavailable but emitted a diagram`).toBe('')
          expect(typeof v.reason).toBe('string')
          expect((v.reason ?? '').length).toBeGreaterThan(20)
        }
      }
    }
  })

  it('reports every view unavailable when there is no graph, naming the path it looked for', async () => {
    const root = await makeProject()
    const result = await generateArchitecture({ root })

    expect(result.available).toEqual([])
    expect(result.unavailable).toHaveLength(7)
    for (const v of result.views) {
      expect(v.mermaid).toBe('')
      expect(v.reason).toContain('no repository graph')
      expect(v.reason).toContain('graph.json')
    }
  })

  it('does not read prose or string literals as an API surface or a schema', async () => {
    // The failure this test exists for: the generator once read its own
    // documentation and its own test fixtures as evidence, and reported an API
    // and a table called `statement` for a package that has neither.
    const root = await makeProject()
    await write(
      root,
      'src/docs.ts',
      [
        "// A route is registered with router.get('/ghost'), which is prose, not a route.",
        "export const sample = \"router.get('/ghost', handler)\"",
        'export const ddl = "CREATE TABLE ghosts (id INTEGER)"',
        '/* CREATE TABLE spectres (id INTEGER); */',
        '',
      ].join('\n')
    )
    const result = await generateArchitecture({ graph: await graphFor(root), root })

    const api = view(result, 'api')
    expect(api.available).toBe(false)
    expect(api.evidence.found).toBe(0)
    expect(api.mermaid).toBe('')

    const database = view(result, 'database')
    expect(database.available).toBe(false)
    expect(database.evidence.found).toBe(0)
    expect(database.mermaid).toBe('')
    expect(database.reason).toContain('Source files are not searched')
  })

  it('finds a real API and database view when the evidence is there', async () => {
    const root = await makeProject()
    await write(
      root,
      'server/api.ts',
      [
        'export function mount(router: any): void {',
        "  router.get('/users', () => 1)",
        "  router.post('/users', () => 2)",
        "  // router.delete('/users') is commented out and must not appear",
        '}',
        '',
      ].join('\n')
    )
    await write(
      root,
      'db/schema.sql',
      [
        'CREATE TABLE users (id INTEGER PRIMARY KEY);',
        'CREATE TABLE posts (',
        '  id INTEGER,',
        '  author INTEGER REFERENCES users(id)',
        ');',
        '',
      ].join('\n')
    )
    const result = await generateArchitecture({ graph: await graphFor(root), root })

    const api = view(result, 'api')
    expect(api.available).toBe(true)
    expect(api.mermaid).toContain('GET /users')
    expect(api.mermaid).toContain('POST /users')
    expect(api.mermaid).not.toContain('DELETE')

    const database = view(result, 'database')
    expect(database.available).toBe(true)
    expect(database.mermaid).toContain('users')
    expect(database.mermaid).toContain('posts')
    expect(database.mermaid).toContain('references')
  })
})

describe('generateArchitecture — determinism (19.4)', () => {
  it('is byte-identical across repeated generation from the same graph', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const graph = await graphFor(root)

    const first = await generateArchitecture({ graph, root })
    const second = await generateArchitecture({ graph, root })

    expect(renderArchitectureDocument(second)).toBe(renderArchitectureDocument(first))
    expect(second.digest).toBe(first.digest)
    for (let i = 0; i < first.views.length; i++) {
      expect(second.views[i]!.mermaid).toBe(first.views[i]!.mermaid)
    }
  })

  it('is byte-identical for the same tree indexed into a different directory', async () => {
    // Same content, different absolute paths and a freshly built graph: the
    // output must not carry a trace of either.
    const a = await makeProject()
    const b = await makeProject()
    await seedCodeProject(a)
    await seedCodeProject(b)

    const first = await generateArchitecture({ graph: await graphFor(a), root: a })
    const second = await generateArchitecture({ graph: await graphFor(b), root: b })

    expect(second.digest).toBe(first.digest)
    expect(renderArchitectureDocument(second)).toBe(renderArchitectureDocument(first))
  })

  it('orders nodes and edges by content, not by discovery order', async () => {
    // Files whose insertion order into the graph differs from their sorted order:
    // z is written first and imports a, so a Map-order leak would put z first.
    const root = await makeProject()
    await write(root, 'src/z.ts', "import { a } from './a.js'\nexport const z = a\n")
    await write(root, 'src/a.ts', 'export const a = 1\n')
    await write(root, 'src/m.ts', "import { a } from './a.js'\nexport const m = a\n")

    const dependency = view(
      await generateArchitecture({ graph: await graphFor(root), root }),
      'dependency'
    )
    const nodeLines = dependency.mermaid
      .split('\n')
      .filter(line => /^ {2}n\d+\["/.test(line))
      .map(line => line.replace(/^ {2}n\d+\["|"\]$/g, ''))

    expect(nodeLines).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts'])

    // Edges follow the same content order: m -> a before z -> a, even though z
    // was written (and discovered) first.
    const edgeLines = dependency.mermaid.split('\n').filter(line => line.includes(' --> '))
    expect(edgeLines).toEqual(['  n1 --> n0', '  n2 --> n0'])
  })
})

describe('generateArchitecture — caps', () => {
  it('announces truncation in the diagram and prefers connected nodes', async () => {
    const root = await makeProject()
    await write(root, 'src/z.ts', "import { a } from './a.js'\nexport const z = a\n")
    await write(root, 'src/a.ts', 'export const a = 1\n')
    await write(root, 'src/m.ts', "import { a } from './a.js'\nexport const m = a\n")

    const dependency = view(
      await generateArchitecture({
        graph: await graphFor(root),
        root,
        maxNodes: 2,
        maxEdges: 2,
      }),
      'dependency'
    )

    expect(dependency.truncated).toBe(true)
    expect(dependency.nodes).toBe(2)
    expect(dependency.mermaid).toContain('%% truncated: 2 of 3 nodes shown')
    expect(dependency.mermaid).toContain('%% truncated: 1 of 2 edges shown')
    // A capped diagram still shows a relationship rather than orphan boxes.
    expect(dependency.edges).toBe(1)
  })
})

describe('generateArchitecture — the event (19.2)', () => {
  it('emits diagram_updated carrying per-view availability and reasons', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const events = new MemoryEventStore({ clock: () => 1, ids: () => 'e1' })

    const result = await generateArchitecture({
      graph: await graphFor(root),
      root,
      events,
      runId: 'run-1',
    })

    const all = await events.readAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.kind).toBe('diagram_updated')
    expect(all[0]!.runId).toBe('run-1')

    const payload = all[0]!.payload as Record<string, unknown>
    expect(payload.component).toBe('architecture')
    expect(payload.format).toBe('mermaid')
    expect(payload.digest).toBe(result.digest)
    expect(payload.unavailable).toEqual(result.unavailable)

    const views = payload.views as { kind: string; available: boolean; reason: string | null }[]
    expect(views).toHaveLength(7)
    const api = views.find(v => v.kind === 'api')!
    expect(api.available).toBe(false)
    expect(api.reason).toContain('no API surface found')
  })

  it('does not require an event sink', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    await expect(
      generateArchitecture({ graph: await graphFor(root), root })
    ).resolves.toBeDefined()
  })
})

describe('renderArchitectureDocument', () => {
  it('fences available views and states the reason for unavailable ones instead', async () => {
    const root = await makeProject()
    await seedCodeProject(root)
    const result = await generateArchitecture({ graph: await graphFor(root), root })
    const doc = renderArchitectureDocument(result)

    expect(doc).toContain('# Architecture')
    expect(doc).toContain('```mermaid')
    expect(doc).toContain('**Unavailable.**')
    // Exactly one fence pair per available view.
    const fences = doc.split('```mermaid').length - 1
    expect(fences).toBe(result.available.length)
    expect(doc).toContain('Evidence:')
  })
})
