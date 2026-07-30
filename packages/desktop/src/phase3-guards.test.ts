// Static tripwires for the Phase 3 invariants that span packages/languages.
// They complement behavioral tests: each guard names the production source whose
// accidental weakening must make this gate fail.
// Validates: Requirements 15.2, 16.4

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(process.cwd(), '../..')
const read = (path: string) => readFileSync(join(repo, path), 'utf8')
const codeOnly = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
const productionTs = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...productionTs(full))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !['monacoDouble.ts', 'fakeDisk.ts'].includes(name)) out.push(full)
  }
  return out
}

describe('Phase 3 cross-cutting guards', () => {
  it('has one production model.setValue path and AppState as the file-content owner', () => {
    const files = productionTs(join(repo, 'packages/desktop/src'))
    const calls = files.flatMap((file) => [...codeOnly(readFileSync(file, 'utf8')).matchAll(/\.setValue\(/g)].map(() => file))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.replaceAll('\\', '/')).toMatch(/\/packages\/desktop\/src\/editor\/models\.ts$/)
    expect(read('packages/desktop/src/state/AppState.tsx')).toContain('IS THE AUTHORITATIVE TEXT')
    expect(read('packages/desktop/src/editor/CodeEditor.tsx')).not.toMatch(/useState\([^\n]*content/)
  })

  it('keeps both independent plan gates scoped to the selected run', () => {
    const ui = read('packages/desktop/src/panels/DiffReview.tsx')
    expect(ui).toContain("event.kind === 'plan_written' && event.runId === selected.runId")
    expect(ui).toContain('disabled={busy || !planWrittenForSelectedRun}')
    expect(read('packages/core/src/loop/agent.ts')).toContain('await deps.plan.hasPlan(runId)')
  })

  it('keeps reject-all on the zero-read/zero-write path', () => {
    const review = read('packages/desktop/src/panels/DiffReview.tsx')
    const body = review.slice(review.indexOf('const rejectEverything'), review.indexOf('// ── honest nothings'))
    expect(body).not.toContain('baselineFor(')
    expect(body).not.toContain('writeFromEditor(')
  })

  it('pins subset offsets, CRLF preservation, and stale completion cancellation', () => {
    const diffTests = read('packages/core/test/diff.test.ts')
    expect(diffTests).toContain('lands accepted hunk 3 at the right line when hunk 2 is rejected')
    expect(diffTests).toContain('keeps a CRLF file on CRLF, including lines the patch adds')
    const ghost = read('packages/desktop/src/editor/ghostCompletion.ts')
    expect(ghost).toContain('this.#request?.abort()')
    expect(ghost).toContain('requestId !== this.#requestId')
    expect(ghost).toContain('DEFAULT_GHOST_COMPLETIONS_ENABLED = false')
  })

  it('keeps option termination in both git implementations', () => {
    const core = read('packages/core/src/tools/git.ts')
    expect(core).toContain("args.push('--', this.#pathspec('diff', options.path))")
    expect(core).toContain("['add', '--', ...pathspecs]")
    const rust = read('packages/desktop/src-tauri/src/main.rs')
    expect(rust).toContain('args.push("--".to_string())')
    expect(read('packages/desktop/src-tauri/src/command_policy.rs')).toContain('a_git_pathspec_that_looks_like_an_option_is_refused')
  })

  it('has no fixtures or HTML injection sinks in shipped Phase 3 panels', () => {
    const panels = [
      'packages/desktop/src/panels/FileExplorer.tsx',
      'packages/desktop/src/panels/GitPanel.tsx',
      'packages/desktop/src/panels/DiffReview.tsx',
      'packages/desktop/src/panels/ide/Terminal.tsx',
      'packages/desktop/src/panels/ide/SearchPanel.tsx',
    ]
    for (const panel of panels) {
      const source = read(panel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      expect(source, panel).not.toMatch(/\b(?:MOCK|SAMPLE|EXAMPLE|FIXTURE)_[A-Z0-9_]+/)
    }
    for (const panel of panels.slice(1)) {
      const source = codeOnly(read(panel))
      expect(source, panel).not.toContain('dangerouslySetInnerHTML')
      expect(source, panel).not.toMatch(/\.innerHTML\s*=/)
      expect(source, panel).not.toContain('insertAdjacentHTML')
      expect(source, panel).not.toContain('DOMParser')
    }
  })

  it('keeps write-path event sanitation and the core dependency-free', () => {
    const store = read('packages/core/src/events/store.ts')
    expect((store.match(/payload: sanitizePayload\(/g) ?? [])).toHaveLength(2)
    const pkg = JSON.parse(read('packages/core/package.json')) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})
