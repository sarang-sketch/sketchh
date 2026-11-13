// Slash commands in the composer — the same idea as Claude Code's and Codex's `/`.
//
// Three sources, one menu:
//   * BUILT-INS below: prompt templates for the everyday jobs (/init, /fix, /test,
//     /review…) and a few app actions (/clear, /undo, /model, /auto…).
//   * CUSTOM commands: Markdown files in `.sketch/commands/` (shared with the repo) and
//     `~/.sketch/commands/` (personal), listed by the engine's `commands-list`.
//   * SKILLS installed in the project: `/<skill> <task>` runs the task with that skill
//     loaded in full.
//
// A prompt command is expanded HERE and sent as an ordinary message, so it takes the
// same run path, the same permissions and the same Stop as anything typed by hand.

import type { AgentMode } from '../state/AppState'
import { EGM_COMMANDS } from './egm'

export type AppAction =
  | 'clear'
  | 'undo'
  | 'model'
  | 'connect'
  | 'settings'
  | 'skills'
  | 'help'
  | 'mode:ask'
  | 'mode:agent'
  | 'mode:auto'

export interface MenuCommand {
  name: string
  description: string
  argumentHint?: string
  source: 'builtin' | 'project' | 'user' | 'skill'
  /** For an app action, what to do instead of sending a prompt. */
  action?: AppAction
  /** Expand to the prompt that is sent. `context.file` is the open file, if any. */
  expand?: (args: string, context: { file: string | null }) => string
  /** Run this one command in a different mode than the composer's (e.g. /review is read-only). */
  mode?: AgentMode
  /** Skills to load in full for the run. */
  skillNames?: string[]
}

const target = (args: string, file: string | null, fallback: string) =>
  args.trim() !== '' ? args.trim() : file !== null ? `\`${file}\`` : fallback

export const BUILTIN_COMMANDS: readonly MenuCommand[] = [
  {
    name: 'init',
    description: 'Write an AGENTS.md that explains this project to AI agents',
    source: 'builtin',
    expand: () =>
      'Create or update AGENTS.md at the project root so an AI coding agent can work here well. ' +
      'Read the project first. Cover: what it is, the folder structure and entry points, how to install, ' +
      'build, run and test it (exact commands), and the coding conventions you can see. Keep it short and accurate — ' +
      'only facts you verified in the code.',
  },
  {
    name: 'explain',
    description: 'Explain how a file, feature or the whole project works',
    argumentHint: '[file or topic]',
    source: 'builtin',
    mode: 'ask',
    expand: (args, { file }) =>
      `Explain how ${target(args, file, 'this project')} works: its purpose, the main pieces and how they connect, ` +
      'and anything surprising. Read the code first and cite file paths.',
  },
  {
    name: 'fix',
    description: 'Find and fix a bug, with the smallest correct change',
    argumentHint: '[what is wrong]',
    source: 'builtin',
    expand: (args, { file }) =>
      args.trim() !== ''
        ? `Fix this: ${args.trim()}. Find the root cause in the code first, make the smallest correct change, then run the project's checks.`
        : `Find the most likely bug in ${file !== null ? `\`${file}\`` : 'this project'} and fix it. Explain the root cause, make the smallest correct change, then run the project's checks.`,
  },
  {
    name: 'test',
    description: 'Write tests in the project\'s own framework and make them pass',
    argumentHint: '[file]',
    source: 'builtin',
    expand: (args, { file }) =>
      `Write unit tests for ${target(args, file, 'the most important untested module')}. Use the test framework and ` +
      'style this project already uses, cover the edge cases, run them, and make them pass without weakening them.',
  },
  {
    name: 'review',
    description: 'Review the uncommitted changes for bugs and risks (read-only)',
    source: 'builtin',
    mode: 'ask',
    expand: (args) =>
      'Review the current uncommitted changes (use git-diff / git-status to see them). Point out bugs, risky or ' +
      'incomplete changes, missing tests and unclear code, most important first, with file and line. Do not edit files.' +
      (args.trim() !== '' ? ` Focus: ${args.trim()}` : ''),
  },
  {
    name: 'refactor',
    description: 'Improve structure and readability without changing behaviour',
    argumentHint: '[file or area]',
    source: 'builtin',
    expand: (args, { file }) =>
      `Refactor ${target(args, file, 'the most tangled module')} for clarity and maintainability without changing ` +
      'its behaviour. Keep the public interface, keep the tests passing, and run them to prove it.',
  },
  {
    name: 'docs',
    description: 'Add or improve documentation comments and README sections',
    argumentHint: '[file]',
    source: 'builtin',
    expand: (args, { file }) =>
      `Document ${target(args, file, 'the public API of this project')}: clear doc comments on exported functions and ` +
      'types, in the style the project already uses. Do not change behaviour.',
  },
  {
    name: 'plan',
    description: 'Make a step-by-step plan for a task without changing anything',
    argumentHint: '<task>',
    source: 'builtin',
    mode: 'ask',
    expand: (args) =>
      `Make a concrete, step-by-step implementation plan for: ${args.trim() || 'the next most valuable improvement to this project'}. ` +
      'Read the relevant code first; list the files to change and how, the risks, and how to test it. Do not edit files.',
  },
  {
    name: 'commit',
    description: 'Write a commit message for the current changes (does not commit)',
    source: 'builtin',
    mode: 'ask',
    expand: () =>
      'Look at the uncommitted changes (git-status and git-diff) and write one clear commit message for them: a ' +
      'short imperative subject line, a blank line, then the why. Do not commit and do not edit files.',
  },
  { name: 'clear', description: 'Start a new conversation', source: 'builtin', action: 'clear' },
  { name: 'undo', description: 'Undo the last changes the agent made', source: 'builtin', action: 'undo' },
  { name: 'model', description: 'Choose the model', source: 'builtin', action: 'model' },
  { name: 'connect', description: 'Connect a model (free options available)', source: 'builtin', action: 'connect' },
  { name: 'ask', description: 'Ask mode: read-only answers, no changes', source: 'builtin', action: 'mode:ask' },
  { name: 'agent', description: 'Agent mode: edits, and asks before running commands', source: 'builtin', action: 'mode:agent' },
  { name: 'auto', description: 'Auto mode: works to completion without asking', source: 'builtin', action: 'mode:auto' },
  { name: 'skills', description: 'Browse and install skills', source: 'builtin', action: 'skills' },
  { name: 'settings', description: 'Open settings', source: 'builtin', action: 'settings' },
  { name: 'help', description: 'Show what you can type here', source: 'builtin', action: 'help' },
  // EGM (Elephant-Goldfish Model): design and review with fresh eyes. Each
  // loads its skill in full when installed, and its expanded prompt carries
  // the file conventions and the Goldfish fresh-context rule, so the command
  // still works from the prompt alone. See `lib/egm.ts` for the definitions.
  ...EGM_COMMANDS.map((command): MenuCommand => ({
    name: command.name,
    description: command.description,
    ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
    source: 'builtin',
    ...(command.mode !== undefined ? { mode: command.mode } : {}),
    skillNames: [command.name],
    expand: command.expand,
  })),
]

/** A custom Markdown command, as the engine listed it. */
export function customCommand(entry: { name: string; description: string; argumentHint?: string; body: string; scope: 'project' | 'user' }): MenuCommand {
  return {
    name: entry.name,
    description: entry.description,
    ...(entry.argumentHint !== undefined ? { argumentHint: entry.argumentHint } : {}),
    source: entry.scope,
    expand: (args) => expandTemplate(entry.body, args),
  }
}

/** An installed skill, as a command that runs a task with it loaded. */
export function skillCommand(skill: { name: string; description: string }): MenuCommand {
  return {
    name: skill.name,
    description: skill.description || 'Installed skill',
    argumentHint: '<task>',
    source: 'skill',
    skillNames: [skill.name],
    expand: (args) => (args.trim() !== '' ? args.trim() : `Use the ${skill.name} skill on this project and report what you find.`),
  }
}

/**
 * `$ARGUMENTS` / `$1`…`$9`, the convention every agent host uses for command files.
 * Arguments a template never mentions are appended rather than dropped.
 */
export function expandTemplate(body: string, args: string): string {
  const trimmed = args.trim()
  const words = trimmed === '' ? [] : trimmed.split(/\s+/)
  const usesArgs = /\$ARGUMENTS|\$[1-9]/.test(body)
  const filled = body.replace(/\$ARGUMENTS/g, trimmed).replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? '')
  return usesArgs || trimmed === '' ? filled : `${filled}\n\n${trimmed}`
}

/** Merge the three sources: built-ins first, then project/user commands, then skills. Names are unique. */
export function commandMenu(custom: readonly MenuCommand[], skills: readonly MenuCommand[]): MenuCommand[] {
  const seen = new Set<string>()
  const out: MenuCommand[] = []
  for (const command of [...BUILTIN_COMMANDS, ...custom, ...skills]) {
    if (seen.has(command.name)) continue
    seen.add(command.name)
    out.push(command)
  }
  return out
}

/** `/name rest of line` → its parts, or null when the text is not a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (match === null) return null
  return { name: match[1]!.toLowerCase(), args: match[2] ?? '' }
}
