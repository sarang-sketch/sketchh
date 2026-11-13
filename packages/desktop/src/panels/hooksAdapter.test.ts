import { describe, expect, it } from 'vitest'
import {
  describeTestResult,
  engineHookToPanel,
  engineHooksToPanel,
  panelHookToEngine,
  panelHooksToEngineConfig,
} from './hooksAdapter'
import type { HookConfig } from './HooksPanel'
import type { HooksTestResult } from '../lib/client'

const PANEL_HOOK: HookConfig = {
  id: 'h1',
  event: 'PreToolUse',
  matcher: 'edit_file',
  command: 'npm',
  args: ['run', 'lint'],
  timeoutMs: 5000,
  enabled: true,
}

describe('hooksAdapter', () => {
  it('maps a panel hook to engine argv without joining a shell string', () => {
    expect(panelHookToEngine(PANEL_HOOK)).toEqual({
      name: 'h1',
      event: 'PreToolUse',
      matcher: 'edit_file',
      command: ['npm', 'run', 'lint'],
      timeoutMs: 5000,
      blocking: true,
    })
  })

  it('only PreToolUse hooks are blocking, and an empty matcher is omitted', () => {
    const item = panelHookToEngine({ ...PANEL_HOOK, event: 'Stop', matcher: '  ' })
    expect(item.blocking).toBe(false)
    expect(item.matcher).toBeUndefined()
  })

  it('omits disabled hooks from the saved config', () => {
    expect(
      panelHooksToEngineConfig([PANEL_HOOK, { ...PANEL_HOOK, id: 'h2', enabled: false }]),
    ).toEqual({ hooks: [panelHookToEngine(PANEL_HOOK)] })
  })

  it('round-trips an engine hook back to the panel', () => {
    expect(engineHookToPanel(panelHookToEngine(PANEL_HOOK))).toEqual(PANEL_HOOK)
    expect(engineHooksToPanel([])).toEqual([])
  })

  it('summarises a test result, including denials and timeouts', () => {
    const result: HooksTestResult = {
      ok: true,
      event: 'PreToolUse',
      tool: 'edit_file',
      matched: ['h1', 'h2'],
      problems: [],
      outcomes: [
        { hook: 'h1', ok: true, allowed: false, reason: 'no', stdout: '', stderr: '', durationMs: 12, timedOut: false },
        { hook: 'h2', ok: true, allowed: true, stdout: '', stderr: '', durationMs: 9000, timedOut: true },
      ],
    }
    expect(describeTestResult(result)).toContain('2 hook(s) ran for PreToolUse')
    expect(describeTestResult(result)).toContain('1 denied the call')
    expect(describeTestResult(result)).toContain('1 timed out')
    expect(describeTestResult({ ...result, matched: [], outcomes: [] })).toContain('No hooks match PreToolUse')
  })
})
