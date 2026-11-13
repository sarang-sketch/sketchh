// EGM commands: seven skills, one definition each, shared by the composer's
// `/` menu and the EGM panel.

import { describe, expect, it } from 'vitest'

import { BUILTIN_COMMANDS, parseSlash } from './slashCommands'
import { EGM_COMMANDS, egmCommand } from './egm'

describe('EGM commands', () => {
  it('defines seven skills, in workflow order', () => {
    expect(EGM_COMMANDS.map((c) => c.name)).toEqual([
      'egm-brainstorm',
      'egm-draft',
      'egm-review',
      'egm-resolve',
      'egm-bootstrap',
      'egm-drift-report',
      'egm-review-loop',
    ])
    for (const command of EGM_COMMANDS) {
      expect(command.title.length).toBeGreaterThan(0)
      expect(command.description.length).toBeGreaterThan(0)
    }
  })

  it('appears in the composer menu with its skill attached', () => {
    for (const command of EGM_COMMANDS) {
      const menu = BUILTIN_COMMANDS.find((c) => c.name === command.name)
      expect(menu, `/${command.name} is not in the menu`).toBeDefined()
      expect(menu?.source).toBe('builtin')
      expect(menu?.skillNames).toEqual([command.name])
      expect(menu?.description).toBe(command.description)
    }
    // Typing /egm shows all seven: every EGM name starts with the same prefix.
    expect(BUILTIN_COMMANDS.filter((c) => c.name.startsWith('egm-'))).toHaveLength(7)
  })

  it('runs review and drift-report read-only, in Ask mode', () => {
    expect(egmCommand('egm-review')?.mode).toBe('ask')
    expect(egmCommand('egm-drift-report')?.mode).toBe('ask')
    expect(egmCommand('egm-resolve')?.mode).toBeUndefined()
    expect(egmCommand('egm-draft')?.mode).toBeUndefined()
  })

  it('marks the Goldfish commands as fresh-session', () => {
    expect(EGM_COMMANDS.filter((c) => c.freshSession === true).map((c) => c.name)).toEqual([
      'egm-review',
      'egm-review-loop',
    ])
  })

  it('expands to self-contained prompts with the file conventions', () => {
    const file = { file: null }
    expect(egmCommand('egm-brainstorm')?.expand('Add webhooks', file)).toContain('concepts_brief.md')
    expect(egmCommand('egm-draft')?.expand('', file)).toContain('design_draft.md')
    expect(egmCommand('egm-draft')?.expand('', file)).toContain('docs/designs')
    expect(egmCommand('egm-resolve')?.expand('', file)).toContain('goldfish_review_report.md')
    expect(egmCommand('egm-drift-report')?.expand('', file)).toContain('_DRIFT_REPORT.md')
    expect(egmCommand('egm-bootstrap')?.expand('', file)).toContain('15 subdirectories')
  })

  it('states the Goldfish fresh-context rule in the review prompts', () => {
    const file = { file: null }
    for (const name of ['egm-review', 'egm-review-loop'] as const) {
      const prompt = egmCommand(name)?.expand('docs/designs/webhooks.md', file) ?? ''
      expect(prompt).toMatch(/no prior chat history/i)
      expect(prompt).toMatch(/fresh/i)
    }
    // The review prompt names its target, and falls back to asking for it.
    expect(egmCommand('egm-review')?.expand('', { file: null })).toMatch(/ask me for its path/i)
    expect(egmCommand('egm-review')?.expand('docs/designs/x.md', { file: null })).toContain('docs/designs/x.md')
    // An open file fills in as the target.
    expect(egmCommand('egm-review')?.expand('', { file: 'docs/designs/open.md' })).toContain('docs/designs/open.md')
  })

  it('parses /egm-* in the composer', () => {
    expect(parseSlash('/egm-review docs/designs/x.md')).toEqual({
      name: 'egm-review',
      args: 'docs/designs/x.md',
    })
    expect(parseSlash('/egm-brainstorm Add webhooks')).toEqual({
      name: 'egm-brainstorm',
      args: 'Add webhooks',
    })
  })
})
