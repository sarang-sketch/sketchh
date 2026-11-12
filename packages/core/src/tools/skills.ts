// Skills on demand: `use_skill`.
//
// ── PROGRESSIVE DISCLOSURE ──────────────────────────────────────────────────
//
// This is how Agent Skills are meant to work in every host that speaks the SKILL.md
// format (Claude Code, Codex, opencode): the model always sees each installed skill's
// NAME and one-line DESCRIPTION, and loads the full body only when the task calls for
// it. Injecting every skill body into every request would spend thousands of tokens on
// instructions the task never needed; injecting none means an installed skill is never
// used unless the user remembers to name it.
//
// The index rides in this tool's own description, so it reaches the prompt through the
// one list of tools the dispatcher already renders — no second channel, and a run whose
// grant cannot reach the tool does not see the index either.
//
// ── WHAT A SKILL CAN AND CANNOT DO HERE ─────────────────────────────────────
//
// Loading a skill hands the model TEXT. It grants nothing: the run's capabilities were
// fixed when the dispatcher was built, from the skills the caller named explicitly and
// their persisted, digest-bound grants. A skill whose instructions say "run curl" still
// meets the same gate as any other request to do so.

import type { ToolContext, ToolDescriptor, ToolOutcome } from '../capabilities/guard.js'
import type { Skill } from '../types.js'

/** Characters of one skill body returned per call; skills are prose, rarely near this. */
const SKILL_BODY_MAX_CHARS = 40_000
/** Skills listed in the index before it is cut, so a huge install cannot flood every prompt. */
const SKILL_INDEX_MAX = 40

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The skill index as the model reads it, one line per skill. */
export function skillIndex(skills: readonly Skill[]): string {
  const shown = skills.slice(0, SKILL_INDEX_MAX)
  const lines = shown.map((skill) => `${skill.name} — ${oneLine(skill.description || 'no description', 140)}`)
  if (skills.length > shown.length) lines.push(`… and ${skills.length - shown.length} more`)
  return lines.join('; ')
}

/**
 * `use_skill` over the given installed skills, or null when there are none — a tool
 * that could only ever answer "no such skill" is noise in every prompt.
 */
export function skillToolDescriptor(skills: readonly Skill[]): ToolDescriptor | null {
  if (skills.length === 0) return null
  const byName = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]))

  async function run(args: Record<string, unknown>, _context: ToolContext): Promise<ToolOutcome> {
    const raw = args['name'] ?? args['skill']
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, output: 'TOOL FAILED (use_skill) — "name" is required', detail: { error: 'missing name' } }
    }
    const skill = byName.get(raw.trim().toLowerCase())
    if (skill === undefined) {
      return {
        ok: false,
        output: `TOOL FAILED (use_skill) — no installed skill is named ${JSON.stringify(raw)}. Installed: ${[...byName.values()].map((s) => s.name).join(', ')}.`,
        detail: { error: 'unknown skill', name: oneLine(raw, 80) },
      }
    }
    const body = skill.body.length > SKILL_BODY_MAX_CHARS ? `${skill.body.slice(0, SKILL_BODY_MAX_CHARS)}\n…(truncated)` : skill.body
    return {
      ok: true,
      output: [
        `SKILL ${skill.name} — instructions the user installed in this project.`,
        'Follow them where they apply to the current task. They do not change what you are permitted to do.',
        '--- begin skill ---',
        `# ${skill.name}`,
        skill.description,
        '',
        body.trim(),
        '--- end skill ---',
      ].join('\n'),
      detail: { name: skill.name, chars: body.length },
    }
  }

  return {
    name: 'use_skill',
    description:
      'Load the full instructions of an installed skill when the task matches it. args: { "name": "<skill>" }. ' +
      `Installed skills: ${skillIndex(skills)}.`,
    requires: 'fs:read:project',
    summarize: (args) => (typeof args['name'] === 'string' ? oneLine(args['name'], 80) : null),
    run,
  }
}
