// Custom slash commands: Markdown prompt templates the user keeps with the project.
//
// The convention every agent host shares (Claude Code's `.claude/commands/`,
// opencode's `.opencode/commands/`): one Markdown file per command, the file name is
// the command, optional frontmatter carries a `description` and an `argument-hint`,
// and the body is the prompt, with `$ARGUMENTS` replaced by what the user typed after
// the command. Sketch reads `.sketch/commands/` in the project (shared through git)
// and `~/.sketch/commands/` (personal). Another tool's directory is never read
// silently.
//
// Reading only. Nothing here runs a command; the surface expands the template and
// sends it as an ordinary prompt, through the same run path as anything typed.

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { parseFrontmatter } from '../skills/frontmatter.js'

export interface SlashCommand {
  /** What the user types after `/`. Lowercase letters, digits, `-`, `_`, `:`. */
  name: string
  description: string
  /** Shown after the name in the menu, e.g. `<file>`. */
  argumentHint?: string
  /** The prompt template. */
  body: string
  /** `project` or `user`: where it came from, for the menu and for precedence. */
  scope: 'project' | 'user'
  /** The file it was read from. */
  path: string
}

export interface SlashCommandSource {
  dir: string
  scope: 'project' | 'user'
}

/** Above this a "command" is not a prompt template anyone meant. */
const MAX_COMMAND_BYTES = 64 * 1024
const MAX_COMMANDS = 200
const NAME = /^[a-z0-9][a-z0-9_:-]{0,63}$/

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (Array.isArray(value) && typeof value[0] === 'string') return value.join(' ').trim()
  return undefined
}

/** The first non-heading sentence of a body, for commands with no description. */
function describe(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text !== '') return text.length > 120 ? `${text.slice(0, 119)}…` : text
  }
  return 'Custom command'
}

/**
 * Every command in the given folders, PROJECT FIRST: a project command shadows a
 * personal one of the same name, so a repository can pin how its own `/review` works.
 * A missing folder is not an error; an unreadable or malformed file is a diagnostic.
 */
export async function loadSlashCommands(
  sources: readonly SlashCommandSource[],
): Promise<{ commands: SlashCommand[]; diagnostics: string[] }> {
  const commands: SlashCommand[] = []
  const seen = new Set<string>()
  const diagnostics: string[] = []

  const ordered = [...sources].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1))
  for (const source of ordered) {
    let names: string[]
    try {
      names = (await readdir(source.dir)).filter((name) => extname(name).toLowerCase() === '.md').sort()
    } catch {
      continue
    }
    for (const file of names) {
      if (commands.length >= MAX_COMMANDS) {
        diagnostics.push(`more than ${MAX_COMMANDS} commands; the rest were not loaded`)
        return { commands, diagnostics }
      }
      const name = basename(file, extname(file)).toLowerCase()
      if (!NAME.test(name)) {
        diagnostics.push(`${file}: a command name may use only letters, digits, "-", "_" and ":"`)
        continue
      }
      if (seen.has(name)) continue
      const path = join(source.dir, file)
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > MAX_COMMAND_BYTES) {
          diagnostics.push(`${file}: skipped (not a file, or larger than ${MAX_COMMAND_BYTES} bytes)`)
          continue
        }
        const parsed = parseFrontmatter(await readFile(path, 'utf8'))
        if (!parsed.ok) {
          diagnostics.push(`${file}: ${parsed.error}`)
          continue
        }
        const body = parsed.body.trim()
        if (body === '') {
          diagnostics.push(`${file}: the command has no prompt text`)
          continue
        }
        const hint = scalar(parsed.data['argument-hint']) ?? scalar(parsed.data['argument_hint'])
        commands.push({
          name,
          description: scalar(parsed.data['description']) ?? describe(body),
          ...(hint !== undefined ? { argumentHint: hint } : {}),
          body,
          scope: source.scope,
          path,
        })
        seen.add(name)
      } catch (err) {
        diagnostics.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return { commands, diagnostics }
}

/**
 * Fill a template: `$ARGUMENTS` is everything typed after the command, `$1`…`$9` are
 * its whitespace-separated words. A template that never mentions `$ARGUMENTS` gets
 * the arguments appended, so `/review src/app.ts` is never silently dropped.
 */
export function expandSlashCommand(body: string, args: string): string {
  const trimmed = args.trim()
  const words = trimmed === '' ? [] : trimmed.split(/\s+/)
  const usesArgs = /\$ARGUMENTS|\$[1-9]/.test(body)
  const filled = body
    .replace(/\$ARGUMENTS/g, trimmed)
    .replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? '')
  return usesArgs || trimmed === '' ? filled : `${filled}\n\n${trimmed}`
}
