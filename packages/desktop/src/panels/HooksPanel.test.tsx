// Hooks panel: props-driven list, toggle, add/edit validation, and test.
// No client calls — onSave/onTest are the caller's.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { HooksPanel, validateHook, type HookConfig } from './HooksPanel'

afterEach(cleanup)

const HOOKS: HookConfig[] = [
  { id: 'h1', event: 'PreToolUse', matcher: 'edit_file', command: 'npm', args: ['run', 'lint'], timeoutMs: 5000, enabled: true },
  { id: 'h2', event: 'SessionStart', matcher: '', command: 'git', args: ['status'], timeoutMs: 30000, enabled: false },
]

describe('validateHook', () => {
  it('accepts a well-formed hook', () => {
    expect(validateHook({ event: 'PreToolUse', command: 'npm', timeoutMs: 5000 })).toEqual({})
  })

  it('rejects an empty command, a bad timeout, and an unknown event', () => {
    expect(validateHook({ event: 'PreToolUse', command: '   ', timeoutMs: 5000 }).command).toContain('required')
    expect(validateHook({ event: 'PreToolUse', command: 'npm', timeoutMs: 0 }).timeoutMs).toContain('positive')
    expect(validateHook({ event: 'PreToolUse', command: 'npm', timeoutMs: -5 }).timeoutMs).toContain('positive')
    expect(validateHook({ event: 'PreToolUse', command: 'npm', timeoutMs: 1.5 }).timeoutMs).toContain('whole number')
    expect(validateHook({ event: 'PreToolUse', command: 'npm', timeoutMs: 999_999 }).timeoutMs).toContain('at most')
    expect(validateHook({ event: 'on-magic', command: 'npm', timeoutMs: 5000 }).event).toContain('Unknown event')
  })
})

describe('HooksPanel', () => {
  it('lists hooks with their event, matcher, timeout and state', () => {
    render(<HooksPanel hooks={HOOKS} onSave={() => {}} onTest={() => {}} />)
    expect(screen.getByText('npm run lint')).toBeTruthy()
    expect(screen.getByText(/Before a tool runs/)).toBeTruthy()
    expect(screen.getByText(/matches edit_file/)).toBeTruthy()
    expect(screen.getByText(/timeout 5000 ms/)).toBeTruthy()
    expect(screen.getByText(/When a run starts/)).toBeTruthy()
    expect(screen.getByText(/disabled/)).toBeTruthy()
  })

  it('says hooks run as argv, never a shell string', () => {
    render(<HooksPanel hooks={HOOKS} onSave={() => {}} onTest={() => {}} />)
    expect(screen.getByText(/never as a shell string/)).toBeTruthy()
  })

  it('toggling enable calls onSave with the flipped hook', () => {
    const onSave = vi.fn()
    render(<HooksPanel hooks={HOOKS} onSave={onSave} onTest={() => {}} />)
    fireEvent.click(screen.getByLabelText('Enable hook git'))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].find((h: HookConfig) => h.id === 'h2').enabled).toBe(true)
  })

  it('Test calls onTest with the hook id', () => {
    const onTest = vi.fn()
    render(<HooksPanel hooks={HOOKS} onSave={() => {}} onTest={onTest} />)
    fireEvent.click(screen.getAllByText('Test')[0])
    expect(onTest).toHaveBeenCalledWith('h1')
  })

  it('refuses to save a hook with an empty command and shows the error', () => {
    const onSave = vi.fn()
    render(<HooksPanel hooks={HOOKS} onSave={onSave} onTest={() => {}} />)
    fireEvent.click(screen.getByText('Add hook'))
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '   ' } })
    fireEvent.click(screen.getByText('Save hook'))
    expect(screen.getByText(/Command is required/)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('refuses a bad timeout and shows the error', () => {
    const onSave = vi.fn()
    render(<HooksPanel hooks={HOOKS} onSave={onSave} onTest={() => {}} />)
    fireEvent.click(screen.getByText('Add hook'))
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npm' } })
    fireEvent.change(screen.getByLabelText('Timeout (ms)'), { target: { value: '0' } })
    fireEvent.click(screen.getByText('Save hook'))
    expect(screen.getByText(/positive/)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves a valid new hook with args split into argv', () => {
    const onSave = vi.fn()
    render(<HooksPanel hooks={HOOKS} onSave={onSave} onTest={() => {}} />)
    fireEvent.click(screen.getByText('Add hook'))
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npm' } })
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: 'run lint' } })
    fireEvent.click(screen.getByText('Save hook'))
    expect(onSave).toHaveBeenCalledOnce()
    const saved: HookConfig[] = onSave.mock.calls[0][0]
    expect(saved).toHaveLength(3)
    expect(saved[2].args).toEqual(['run', 'lint'])
    expect(saved[2].event).toBe('PreToolUse')
  })

  it('deleting a hook calls onSave without it', () => {
    const onSave = vi.fn()
    render(<HooksPanel hooks={HOOKS} onSave={onSave} onTest={() => {}} />)
    fireEvent.click(screen.getAllByText('Delete')[0])
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0]).toHaveLength(1)
    expect(onSave.mock.calls[0][0][0].id).toBe('h2')
  })

  it('shows an empty state when there are no hooks', () => {
    render(<HooksPanel hooks={[]} onSave={() => {}} onTest={() => {}} />)
    expect(screen.getByText('No hooks configured')).toBeTruthy()
  })
})
