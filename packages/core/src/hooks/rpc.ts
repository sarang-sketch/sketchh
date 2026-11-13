// RPC method implementations for hooks.
//
// These are plain functions of `(root, params)` — no `MethodContext`, no
// registration here. The coordinator wires them into `rpc/methods.ts` as
// `hooks-list`, `hooks-save`, and `hooks-test` (see HANDOFF.md for the snippet).
// They throw a plain `Error` naming the bad field on invalid params, in the
// same shape `methods.ts` turns into `invalid_params`; success is always a
// `{ ok: true, ... }` result, never a throw.

import { loadHooks, saveHooks, hooksFilePath } from './config.js'
import { HookRunner } from './runner.js'
import { isHookEvent, type HookEvent } from './types.js'

function readRoot(root: unknown): string {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('params.root must be a non-empty string')
  }
  return root
}

function readParams(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params must be an object')
  }
  return params as Record<string, unknown>
}

export interface HooksListResult {
  ok: true
  file: string
  present: boolean
  hooks: Array<{
    name: string
    event: HookEvent
    matcher?: string
    command: string[]
    timeoutMs?: number
    blocking?: boolean
  }>
  problems: string[]
}

/** `hooks-list`: the hooks on disk for a project, plus any config problems. */
export async function hooksList(root: string, params: unknown = {}): Promise<HooksListResult> {
  readParams(params)
  const projectRoot = readRoot(root)
  const loaded = await loadHooks(projectRoot)
  return {
    ok: true,
    file: hooksFilePath(projectRoot),
    present: loaded.present,
    hooks: loaded.config.hooks.map((hook) => ({
      name: hook.name ?? hook.event,
      event: hook.event,
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      command: [...hook.command],
      ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
      ...(hook.blocking !== undefined ? { blocking: hook.blocking } : {}),
    })),
    problems: loaded.problems,
  }
}

export interface HooksSaveResult {
  ok: boolean
  file: string
  hooks: Array<{ name: string; event: HookEvent; command: string[] }>
  problems: string[]
}

/**
 * `hooks-save`: validate and write `.sketch/hooks.json`.
 *
 * `params.config` is the whole file (`{ hooks: [...] }`). An invalid config
 * writes nothing and returns `{ ok: false, problems }`.
 */
export async function hooksSave(root: string, params: unknown): Promise<HooksSaveResult> {
  const source = readParams(params)
  const projectRoot = readRoot(root)
  const config = source['config']
  if (config === undefined) throw new Error('params.config is required')
  const saved = await saveHooks(projectRoot, config)
  return {
    ok: saved.ok,
    file: hooksFilePath(projectRoot),
    hooks: saved.hooks.map((hook) => ({
      name: hook.name ?? hook.event,
      event: hook.event,
      command: [...hook.command],
    })),
    problems: saved.problems,
  }
}

export interface HooksTestResult {
  ok: true
  event: HookEvent
  tool?: string
  /** One outcome per matching hook, in config order. */
  outcomes: Array<{
    hook: string
    ok: boolean
    allowed: boolean
    reason?: string
    stdout: string
    stderr: string
    durationMs: number
    timedOut: boolean
  }>
  /** Hooks that matched, by name. Empty means nothing would run for this event. */
  matched: string[]
  problems: string[]
}

/**
 * `hooks-test`: run the hooks that match one event, for real, and report what
 * each did. This executes the configured commands — it is a dry run of the
 * decision only in the sense that no tool call is gated on it. A PreToolUse
 * hook that denies is reported as `allowed: false`; nothing is blocked here.
 */
export async function hooksTest(root: string, params: unknown): Promise<HooksTestResult> {
  const source = readParams(params)
  const projectRoot = readRoot(root)
  const event = source['event']
  if (!isHookEvent(event)) {
    throw new Error('params.event must be one of SessionStart, PreToolUse, PostToolUse, Stop')
  }
  const tool = source['tool']
  if (tool !== undefined && (typeof tool !== 'string' || tool.trim() === '')) {
    throw new Error('params.tool must be a non-empty string when present')
  }
  if ((event === 'PreToolUse' || event === 'PostToolUse') && tool === undefined) {
    throw new Error('params.tool is required for PreToolUse and PostToolUse')
  }
  const input = source['input']

  const loaded = await loadHooks(projectRoot)
  const runner = new HookRunner(loaded.config, { root: projectRoot })
  const matched = loaded.config.hooks
    .filter((hook) => hook.event === event)
    .map((hook) => hook.name ?? hook.event)

  // One real execution, reported per hook. Nothing here is synthesized: the
  // outcomes below are the ones the runner produced.
  const raw =
    event === 'SessionStart' || event === 'Stop'
      ? await runner.run(event, undefined, {})
      : await runner.run(event, tool as string, { input: asRecord(input) })
  const outcomes: HooksTestResult['outcomes'] = raw.map((outcome) => ({
    hook: outcome.hook,
    ok: outcome.ok,
    allowed: outcome.allowed,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    durationMs: outcome.durationMs,
    timedOut: outcome.timedOut,
  }))

  return { ok: true, event, ...(tool !== undefined ? { tool: tool as string } : {}), outcomes, matched, problems: loaded.problems }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
