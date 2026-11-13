// SplitEditor, with the real CodeEditor mocked out: CodeEditor projects
// AppState.activeFile onto Monaco, so the real one cannot be mounted
// per-pane in a unit test (and cannot take per-pane content yet — see
// SplitEditor.tsx). The mock stands in for "a CodeEditor instance" so the
// split layout, toggle, and close wiring can be tested honestly.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../editor/CodeEditor', () => ({
  CodeEditor: () => <div data-testid="code-editor">CodeEditor</div>,
}))

import { SplitEditor } from './SplitEditor'

afterEach(cleanup)

const left = { path: 'src/a.ts', content: 'const a = 1' }
const right = { path: 'src/b.ts', content: 'const b = 2' }

describe('SplitEditor', () => {
  it('renders two CodeEditor panes side by side, labelled with their paths', () => {
    render(<SplitEditor left={left} right={right} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('split-pane-left')).toBeTruthy()
    expect(screen.getByTestId('split-pane-right')).toBeTruthy()
    expect(screen.getAllByTestId('code-editor')).toHaveLength(2)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('src/b.ts')).toBeTruthy()
  })

  it('toggles to a single pane and back', () => {
    render(<SplitEditor left={left} right={right} onChange={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Single' }))
    expect(screen.getAllByTestId('code-editor')).toHaveLength(1)
    expect(screen.getByTestId('split-pane-left')).toBeTruthy()
    expect(screen.queryByTestId('split-pane-right')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Split vertical' }))
    expect(screen.getAllByTestId('code-editor')).toHaveLength(2)
  })

  it('does not break with only one pane: shows it, and the toggle is disabled', () => {
    render(<SplitEditor left={left} right={null} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getAllByTestId('code-editor')).toHaveLength(1)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Split vertical' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the right pane alone when only it has content', () => {
    render(<SplitEditor left={null} right={right} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getAllByTestId('code-editor')).toHaveLength(1)
    expect(screen.getByTestId('split-pane-right')).toBeTruthy()
  })

  it('shows an empty state with no panes, and calls onClose with the pane path', () => {
    const onClose = vi.fn()
    render(<SplitEditor left={null} right={null} onChange={vi.fn()} onClose={onClose} />)
    expect(screen.getByText('No file open.')).toBeTruthy()
    expect(screen.queryByTestId('code-editor')).toBeNull()

    const { unmount } = render(<SplitEditor left={left} right={right} onChange={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close src/b.ts' }))
    expect(onClose).toHaveBeenCalledWith('src/b.ts')
    unmount()
  })
})
