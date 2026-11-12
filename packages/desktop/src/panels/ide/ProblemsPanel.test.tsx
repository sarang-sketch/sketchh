// Problems: what the language services found, listed by file, and one click away from
// the line. The mapping from Monaco markers is pinned too: hints are not problems.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import ProblemsPanel, { countProblems } from './ProblemsPanel'
import { toDiagnostics } from '../../editor/CodeEditor'
import { FileIoProvider } from '../../editor/FileIoProvider'
import { createFakeDisk } from '../../editor/fakeDisk'
import { AppStateProvider, useAppState, type Diagnostic } from '../../state/AppState'

afterEach(cleanup)

const ROOT = 'C:/work/app'
const FILE = `${ROOT}/src/a.ts`

const problems: Diagnostic[] = [
  { severity: 'warning', message: 'Unused variable x', line: 9, column: 3, endLine: 9, endColumn: 4, source: 'ts', code: '6133' },
  { severity: 'error', message: "Type 'string' is not assignable to type 'number'.", line: 4, column: 7, endLine: 4, endColumn: 12, source: 'ts', code: '2322' },
]

function Reveal() {
  const state = useAppState()
  return <div data-testid="reveal">{state.revealRequest ? `${state.revealRequest.path}:${state.revealRequest.line}:${state.revealRequest.column}` : ''}</div>
}

describe('the Problems panel', () => {
  it('lists problems by file, errors first, and jumps to the line', async () => {
    const disk = createFakeDisk({ [FILE]: 'const a: number = "x"\n' })
    render(
      <AppStateProvider initial={{ projectRoot: ROOT, diagnostics: { [FILE]: problems } }}>
        <FileIoProvider io={disk.io}>
          <ProblemsPanel />
          <Reveal />
        </FileIoProvider>
      </AppStateProvider>,
    )
    const rows = screen.getAllByRole('button', { name: /Type 'string'|Unused variable/ })
    expect(rows[0]!.textContent).toContain("Type 'string'")
    expect(screen.getByText('a.ts')).toBeTruthy()

    fireEvent.click(rows[0]!)
    await waitFor(() => expect(screen.getByTestId('reveal').textContent).toBe(`${FILE}:4:7`))
  })

  it('says so when the open files have no problems', () => {
    render(
      <AppStateProvider initial={{ projectRoot: ROOT }}>
        <ProblemsPanel />
      </AppStateProvider>,
    )
    expect(screen.getByText('No problems found in the open files.')).toBeTruthy()
  })
})

describe('problem counting and marker mapping', () => {
  it('counts errors and warnings', () => {
    expect(countProblems({ [FILE]: problems })).toEqual({ errors: 1, warnings: 1 })
  })

  it('maps Monaco severities and drops hints', () => {
    const mapped = toDiagnostics([
      { severity: 8, message: 'boom', startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5, code: { value: '1005' } },
      { severity: 4, message: 'careful', startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2 },
      { severity: 1, message: 'hint', startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 2 },
    ])
    expect(mapped.map((d) => [d.severity, d.line, d.code])).toEqual([
      ['error', 1, '1005'],
      ['warning', 3, undefined],
    ])
  })
})
