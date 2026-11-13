// Hooks adapter: the Hooks panel's shape ⇄ the engine's `hooks-*` RPC shape.
//
// The panel stores one hook as `{ id, event, matcher, command, args, timeoutMs,
// enabled }`; the engine stores `{ name, event, matcher?, command: argv[],
// timeoutMs?, blocking? }`. The two agree on events (SessionStart / PreToolUse /
// PostToolUse / Stop) and on argv — the command is never joined into a shell
// string on either side. Disabled panel hooks are omitted from what is saved:
// the engine has no `enabled` field, and saving a disabled hook as an enabled
// one would run a program the user switched off.

import type { HookEventName, HookListItem, HooksTestResult } from '../lib/client'
import type { HookConfig, HookEvent } from './HooksPanel'

/** The panel's event type is the engine's event type, by construction. */
export function toEngineEvent(event: HookEvent): HookEventName {
  return event
}

/** One enabled panel hook → one engine hook. `blocking` only matters for PreToolUse. */
export function panelHookToEngine(hook: HookConfig): HookListItem {
  return {
    name: hook.id,
    event: toEngineEvent(hook.event),
    ...(hook.matcher.trim() !== '' ? { matcher: hook.matcher.trim() } : {}),
    command: [hook.command.trim(), ...hook.args],
    timeoutMs: hook.timeoutMs,
    blocking: hook.event === 'PreToolUse',
  }
}

/** The enabled panel hooks, as the engine's `{ hooks: [...] }` config. */
export function panelHooksToEngineConfig(hooks: readonly HookConfig[]): { hooks: HookListItem[] } {
  return { hooks: hooks.filter((hook) => hook.enabled).map(panelHookToEngine) }
}

/** One engine hook → one panel hook. Everything the engine loads is enabled. */
export function engineHookToPanel(item: HookListItem): HookConfig {
  return {
    id: item.name,
    event: item.event,
    matcher: item.matcher ?? '',
    command: item.command[0] ?? '',
    args: item.command.slice(1),
    timeoutMs: item.timeoutMs ?? 5000,
    enabled: true,
  }
}

export function engineHooksToPanel(items: readonly HookListItem[]): HookConfig[] {
  return items.map(engineHookToPanel)
}

/** One-line summary of a `hooks-test` result, for the panel's status line. */
export function describeTestResult(result: HooksTestResult): string {
  if (result.matched.length === 0) return `No hooks match ${result.event} — nothing ran.`
  const denied = result.outcomes.filter((outcome) => !outcome.allowed)
  const failed = result.outcomes.filter((outcome) => !outcome.ok)
  const parts = [`${result.outcomes.length} hook(s) ran for ${result.event}`]
  if (denied.length > 0) parts.push(`${denied.length} denied the call`)
  if (failed.length > 0) parts.push(`${failed.length} failed`)
  const slow = result.outcomes.filter((outcome) => outcome.timedOut)
  if (slow.length > 0) parts.push(`${slow.length} timed out`)
  return `${parts.join(' · ')}.`
}
