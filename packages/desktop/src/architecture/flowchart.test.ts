// The flowchart reader, driven against REAL generator output.
//
// The Mermaid text under test is not a fixture: it is produced by
// `context.generateArchitecture` from a graph built by `context.buildRepoGraph` over
// a real temp directory. So if the generator's emitted shape ever changes, this file
// fails instead of a panel silently drawing nothing.
//
// Validates: Requirements 19.3, 19.4

import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { context } from '@sketch/core'

import { decodeLabel, layoutFlowchart, parseFlowchart } from './flowchart'

const tmpDirs: string[] = []

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-flowchart-'))
  tmpDirs.push(dir)
  // Two modules, so the system view (which aggregates by module) has something to
  // aggregate, and one call across the import so the call graph does too.
  mkdirSync(join(dir, 'src', 'core'), { recursive: true })
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'core', 'engine.ts'),
    'export function helper(): number {\n  return 1\n}\n',
    'utf8',
  )
  writeFileSync(
    join(dir, 'src', 'ui', 'panel.ts'),
    'import { helper } from "../core/engine"\n\nexport function useHelper(): number {\n  return helper()\n}\n',
    'utf8',
  )
  return dir
}

async function generate(root: string): Promise<context.ArchitectureDiagrams> {
  await context.buildRepoGraph({ root })
  return context.generateArchitecture({ root, baseDir: root })
}

const project = makeProject()
const diagrams = await generate(project)

function viewOf(kind: context.ArchitectureViewKind): context.ArchitectureView {
  const view = diagrams.views.find((candidate) => candidate.kind === kind)
  if (view === undefined) throw new Error(`no ${kind} view`)
  return view
}

describe('parseFlowchart against generated source', () => {
  it('reads every node and edge the dependency view emitted, and nothing it did not', () => {
    const view = viewOf('dependency')
    expect(view.available).toBe(true)

    const chart = parseFlowchart(view.mermaid)
    expect(chart.direction).toBe('LR')
    expect(chart.nodes).toHaveLength(view.nodes)
    expect(chart.edges).toHaveLength(view.edges)
    // Nothing was quietly skipped: an unrecognised line is reported, never dropped.
    expect(chart.unparsed).toEqual([])
    // The labels are the real project paths.
    expect(chart.nodes.map((node) => node.label.join(' ')).sort()).toEqual([
      'src/core/engine.ts',
      'src/ui/panel.ts',
    ])
  })

  it('keeps a multi-line label as lines and an edge label as text', () => {
    const system = parseFlowchart(viewOf('system').mermaid)
    // The system view labels a node with its module and file count on two lines,
    // and an edge with its import count.
    expect(system.nodes.some((node) => node.label.length > 1)).toBe(true)
    expect(system.edges.every((edge) => edge.label !== null)).toBe(true)
    expect(system.edges[0]!.label).toMatch(/import\(s\)/)
  })

  it('carries the generator’s comment lines through as notes', () => {
    const chart = parseFlowchart(viewOf('folder-tree').mermaid)
    expect(chart.notes).toContain('folder tree: every path in the graph')
  })

  it('reads every one of the seven views without an unparsed line', () => {
    for (const view of diagrams.views) {
      if (!view.available) {
        // The generator's contract: no diagram at all when there is no evidence.
        expect(view.mermaid).toBe('')
        continue
      }
      const chart = parseFlowchart(view.mermaid)
      expect(chart.unparsed, `${view.kind} produced unparsed lines`).toEqual([])
      expect(chart.nodes.length, view.kind).toBe(view.nodes)
      expect(chart.edges.length, view.kind).toBe(view.edges)
    }
  })
})

describe('parseFlowchart — text stays text', () => {
  it('decodes the two escapes the generator applies, and interprets nothing else', () => {
    // `#quot;` is Mermaid's quote entity and `<br/>` is its line break; both come
    // back as plain text. Anything else that looks like markup stays literal.
    expect(decodeLabel('a#quot;b')).toEqual(['a"b'])
    expect(decodeLabel('one<br/>two')).toEqual(['one', 'two'])
    expect(decodeLabel('<img src=x onerror=alert(1)>')).toEqual([
      '<img src=x onerror=alert(1)>',
    ])
  })

  it('reports a line it does not understand instead of guessing', () => {
    const chart = parseFlowchart('flowchart LR\n  n0["a"]\n  n0 ==> n1\n  subgraph x\n')
    expect(chart.nodes).toHaveLength(1)
    expect(chart.edges).toHaveLength(0)
    expect(chart.unparsed).toEqual(['n0 ==> n1', 'subgraph x'])
  })

  it('drops no edge silently when it names an undeclared node', () => {
    const chart = parseFlowchart('flowchart LR\n  n0["a"]\n  n0 --> n9\n')
    expect(chart.edges).toEqual([])
    expect(chart.unparsed).toEqual(['n0 --> n9'])
  })
})

describe('layoutFlowchart', () => {
  it('places every node once, inside the reported canvas', () => {
    const chart = parseFlowchart(viewOf('folder-tree').mermaid)
    const layout = layoutFlowchart(chart)

    expect(layout.nodes).toHaveLength(chart.nodes.length)
    expect(new Set(layout.nodes.map((node) => node.id)).size).toBe(chart.nodes.length)
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width)
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height)
    }
  })

  it('puts an importer to the left of what it imports, in an LR chart', () => {
    const chart = parseFlowchart(viewOf('dependency').mermaid)
    const layout = layoutFlowchart(chart)
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    for (const edge of layout.edges) {
      expect(byId.get(edge.from)!.x).toBeLessThan(byId.get(edge.to)!.x)
    }
  })

  it('terminates on a cycle and still draws its edges', () => {
    const chart = parseFlowchart('flowchart LR\n  n0["a"]\n  n1["b"]\n  n0 --> n1\n  n1 --> n0\n')
    const layout = layoutFlowchart(chart)
    expect(layout.nodes).toHaveLength(2)
    expect(layout.edges).toHaveLength(2)
  })

  it('is a pure function of its input', () => {
    const chart = parseFlowchart(viewOf('component').mermaid)
    expect(JSON.stringify(layoutFlowchart(chart))).toBe(
      JSON.stringify(layoutFlowchart(parseFlowchart(viewOf('component').mermaid))),
    )
  })
})

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp directory is not a test failure.
    }
  }
})
