// Loading and validating `.sketch/hooks.json`.
//
// The file is the user's own configuration, and it names programs Sketch will
// run as the user — so it is validated the way the MCP catalog is validated:
// structurally, before anything is spawned, with every problem named rather
// than the first one silently winning. A file that fails validation loads as
// zero hooks plus its problems; the run proceeds without hooks rather than
// refusing to start over a config file.
//
// Bounds: the file itself is size-capped, the hook count is capped, and every
// field is checked. `command` must be a non-empty argv array of plain strings;
// a string command is rejected, not split, and the program (argv[0]) must be
// one executable. Arguments are data under `shell: false`, so a `node -e`
// script may contain `;` — only control characters are refused there.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  MAX_HOOKS,
  MAX_HOOKS_FILE_BYTES,
  MAX_HOOK_TIMEOUT_MS,
  isHookEvent,
  type HookConfig,
  type HookEvent,
} from './types.js'

export const HOOKS_FILE_NAME = 'hooks.json'

/** `<root>/.sketch/hooks.json`. */
export function hooksFilePath(root: string): string {
  return join(resolve(root), '.sketch', HOOKS_FILE_NAME)
}

export interface HooksFile {
  hooks: HookConfig[]
}

/** What loading found: the hooks that survived validation, and every problem. */
export interface LoadedHooks {
  config: HooksFile
  /** Empty when the file was absent (zero hooks, not an error) or valid. */
  problems: string[]
  /** True when the file existed on disk, valid or not. */
  present: boolean
}

const SHELL_CHARS = /[\s;&|`$<>\n\r]/
const CONTROL_CHARS = /\0/
const GLOB_CHARS = /^[A-Za-z0-9._\-*?]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate one hook entry. Returns the normalised config, or the problems that
 * disqualify it. A hook with any problem is dropped, never repaired: guessing
 * what the user meant by a malformed argv is how a wrong program gets run.
 */
export function validateHookConfig(candidate: unknown, index: number): { config?: HookConfig; problems: string[] } {
  const problems: string[] = []
  const where = `hooks[${index}]`
  if (!isRecord(candidate)) return { problems: [`${where} must be an object`] }

  const event = candidate['event']
  if (!isHookEvent(event)) {
    problems.push(`${where}.event must be one of ${HOOK_EVENTS.join(', ')}`)
  }

  const name = candidate['name']
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
    problems.push(`${where}.name must be a non-empty string when present`)
  }

  const matcher = candidate['matcher']
  if (matcher !== undefined) {
    if (typeof matcher !== 'string' || matcher.trim() === '' || !GLOB_CHARS.test(matcher)) {
      problems.push(`${where}.matcher must be a tool-name glob using only letters, digits, . _ - * ?`)
    }
  }

  const command = candidate['command']
  if (typeof command === 'string') {
    problems.push(`${where}.command must be an argv array, not a shell string`)
  } else if (!Array.isArray(command) || command.length === 0) {
    problems.push(`${where}.command must be a non-empty array of strings`)
  } else {
    for (const [at, element] of command.entries()) {
      if (typeof element !== 'string' || element.trim() === '') {
        problems.push(`${where}.command[${at}] must be a non-empty string`)
      } else if (at === 0 && SHELL_CHARS.test(element)) {
        // The program is one executable: a name with whitespace or shell syntax
        // in it is not a program, it is a fragment of a command line.
        problems.push(`${where}.command[0] must be one executable, not a string with spaces or shell syntax`)
      } else if (CONTROL_CHARS.test(element)) {
        // Arguments are data under `shell: false` — a `node -e` script may
        // legitimately contain `;` and newlines — but NUL cannot appear in an
        // argv at all (`execve` rejects it), so it is refused here.
        problems.push(`${where}.command[${at}] contains a NUL byte and is refused`)
      }
    }
  }

  const timeoutMs = candidate['timeoutMs']
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      problems.push(`${where}.timeoutMs must be a positive number when present`)
    } else if (timeoutMs > MAX_HOOK_TIMEOUT_MS) {
      problems.push(`${where}.timeoutMs must be at most ${MAX_HOOK_TIMEOUT_MS}ms`)
    }
  }

  const blocking = candidate['blocking']
  if (blocking !== undefined && typeof blocking !== 'boolean') {
    problems.push(`${where}.blocking must be a boolean when present`)
  }

  if (problems.length > 0) return { problems }

  const hook: HookConfig = {
    ...(typeof name === 'string' ? { name: name.trim() } : {}),
    event: event as HookEvent,
    ...(typeof matcher === 'string' ? { matcher: matcher.trim() } : {}),
    command: [...(command as string[])],
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    ...(typeof blocking === 'boolean' ? { blocking } : {}),
  }
  return { config: hook, problems }
}

/**
 * Validate a whole parsed file. Unknown top-level keys are ignored (forward
 * compatibility); a non-object, a missing `hooks` array, or too many hooks are
 * problems and yield zero hooks.
 */
export function parseHooksConfig(value: unknown): LoadedHooks {
  if (!isRecord(value)) {
    return { config: { hooks: [] }, problems: ['hooks.json must be a JSON object with a "hooks" array'], present: true }
  }
  const raw = value['hooks']
  if (!Array.isArray(raw)) {
    return { config: { hooks: [] }, problems: ['hooks.json "hooks" must be an array'], present: true }
  }
  if (raw.length > MAX_HOOKS) {
    return {
      config: { hooks: [] },
      problems: [`hooks.json declares ${raw.length} hooks, at most ${MAX_HOOKS} are allowed`],
      present: true,
    }
  }
  const hooks: HookConfig[] = []
  const problems: string[] = []
  raw.forEach((entry, index) => {
    const validated = validateHookConfig(entry, index)
    if (validated.config !== undefined) {
      const hook = validated.config
      hooks.push({
        ...hook,
        name: hook.name ?? `${hook.event}-${hooks.length}`,
      })
    }
    problems.push(...validated.problems)
  })
  return { config: { hooks }, problems, present: true }
}

/** Read `<root>/.sketch/hooks.json`. Missing file: zero hooks, no problems. */
export async function loadHooks(root: string): Promise<LoadedHooks> {
  const file = hooksFilePath(root)
  let size = 0
  try {
    size = (await stat(file)).size
  } catch {
    return { config: { hooks: [] }, problems: [], present: false }
  }
  if (size > MAX_HOOKS_FILE_BYTES) {
    return {
      config: { hooks: [] },
      problems: [`hooks.json is ${size} bytes, at most ${MAX_HOOKS_FILE_BYTES} are read`],
      present: true,
    }
  }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    return {
      config: { hooks: [] },
      problems: [`hooks.json could not be read: ${err instanceof Error ? err.message : String(err)}`],
      present: true,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (err) {
    return {
      config: { hooks: [] },
      problems: [`hooks.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
      present: true,
    }
  }
  return parseHooksConfig(parsed)
}

/**
 * Validate and save a hooks file. Returns the problems when the config is
 * invalid, and writes nothing in that case. The write goes through a temp file
 * plus rename so a crash mid-write cannot leave a half-written hooks file.
 */
export async function saveHooks(
  root: string,
  value: unknown,
): Promise<{ ok: boolean; hooks: HookConfig[]; problems: string[] }> {
  const parsed = parseHooksConfig(value)
  if (parsed.problems.length > 0) return { ok: false, hooks: [], problems: parsed.problems }
  const file = hooksFilePath(root)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, `${JSON.stringify({ hooks: parsed.config.hooks }, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return { ok: true, hooks: parsed.config.hooks, problems: [] }
}

/** Default timeout for a hook that did not set one. */
export function timeoutFor(hook: HookConfig): number {
  return hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
}

/** Whether a hook's decision is honoured for its event. PreToolUse only. */
export function isBlocking(hook: HookConfig): boolean {
  if (hook.blocking !== undefined) return hook.blocking
  return hook.event === 'PreToolUse'
}
