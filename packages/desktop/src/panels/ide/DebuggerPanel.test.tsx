// DebuggerPanel: renders without a client, records breakpoints, launches
// with the inspector config, and never claims stepping works.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DebuggerPanel, DEFAULT_INSPECT_PORT, inspectorUrl } from './DebuggerPanel'
import { addBreakpoint, breakpointsForFile, removeBreakpoint, toggleBreakpoint } from './debuggerStore'

afterEach(cleanup)

describe('debuggerStore (pure helpers)', () => {
  it('adds, sorts by file then line, and updates a duplicate line’s condition', () => {
    const list = addBreakpoint(addBreakpoint([], { file: 'b.ts', line: 10 }), { file: 'a.ts', line: 3 })
    expect(list.map((b) => b.id)).toEqual(['a.ts:3', 'b.ts:10'])
    const updated = addBreakpoint(list, { file: 'a.ts', line: 3, condition: 'x > 0' })
    expect(updated).toHaveLength(2)
    expect(updated.find((b) => b.id === 'a.ts:3')?.condition).toBe('x > 0')
  })

  it('rejects an empty file, a line below 1, and a non-integer line', () => {
    expect(addBreakpoint([], { file: '', line: 5 })).toEqual([])
    expect(addBreakpoint([], { file: 'a.ts', line: 0 })).toEqual([])
    expect(addBreakpoint([], { file: 'a.ts', line: 2.5 })).toEqual([])
  })

  it('toggles and removes, and lists breakpoints by file', () => {
    const list = addBreakpoint(addBreakpoint([], { file: 'a.ts', line: 1 }), { file: 'b.ts', line: 2 })
    expect(toggleBreakpoint(list, { file: 'a.ts', line: 1 })).toHaveLength(1)
    expect(toggleBreakpoint(list, { file: 'c.ts', line: 9 })).toHaveLength(3)
    expect(removeBreakpoint(list, 'a.ts:1')).toHaveLength(1)
    expect(breakpointsForFile(list, 'a.ts').map((b) => b.line)).toEqual([1])
  })
})

describe('DebuggerPanel', () => {
  it('renders the honesty copy and the empty state with no client', () => {
    render(<DebuggerPanel />)
    expect(screen.getByText(/Breakpoints are recorded; stepping is not implemented yet/)).toBeTruthy()
    expect(screen.getByText('No breakpoints recorded yet.')).toBeTruthy()
    expect(screen.getByText(`http://127.0.0.1:${DEFAULT_INSPECT_PORT}/json`)).toBeTruthy()
    expect(screen.queryByText(/Call Stack|Variables/)).toBeNull()
  })

  it('adds a breakpoint from the form and removes it', () => {
    const onChange = vi.fn()
    render(<DebuggerPanel onBreakpointsChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Breakpoint file'), { target: { value: 'src/main.ts' } })
    fireEvent.change(screen.getByLabelText('Breakpoint line'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('Breakpoint condition'), { target: { value: 'n > 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add breakpoint' }))
    expect(screen.getByText('Breakpoints (1)')).toBeTruthy()
    expect(screen.getByText('src/main.ts:12')).toBeTruthy()
    expect(screen.getByText(/when n > 1/)).toBeTruthy()
    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ file: 'src/main.ts', line: 12, condition: 'n > 1' })]),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove breakpoint src/main.ts:12' }))
    expect(screen.getByText('No breakpoints recorded yet.')).toBeTruthy()
  })

  it('ignores an invalid breakpoint instead of adding it', () => {
    render(<DebuggerPanel />)
    fireEvent.change(screen.getByLabelText('Breakpoint file'), { target: { value: 'src/main.ts' } })
    fireEvent.change(screen.getByLabelText('Breakpoint line'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add breakpoint' }))
    expect(screen.getByText('No breakpoints recorded yet.')).toBeTruthy()
  })

  it('launch calls onLaunch with node + default port 9229 and shows the inspector URL', () => {
    const onLaunch = vi.fn()
    render(<DebuggerPanel onLaunch={onLaunch} />)
    fireEvent.click(screen.getByRole('button', { name: 'Launch with inspector' }))
    expect(onLaunch).toHaveBeenCalledWith({ runtime: 'node', inspectPort: 9229 })
    expect(screen.getByText(/Inspector URL — open this in a browser after the launch/)).toBeTruthy()
    expect(inspectorUrl(9229)).toBe('http://127.0.0.1:9229/json')
  })

  it('respects a custom inspect port', () => {
    const onLaunch = vi.fn()
    render(<DebuggerPanel onLaunch={onLaunch} inspectPort={9230} />)
    fireEvent.click(screen.getByRole('button', { name: 'Launch with inspector' }))
    expect(onLaunch).toHaveBeenCalledWith({ runtime: 'node', inspectPort: 9230 })
    expect(screen.getByText('http://127.0.0.1:9230/json')).toBeTruthy()
  })
})
