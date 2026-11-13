// Hooks — props-driven configuration UI for locally-run hooks.
//
// The events are the engine's (`packages/core/src/hooks/`): SessionStart runs
// when a run starts, PreToolUse runs before a tool call and can deny it,
// PostToolUse runs after a tool call, Stop runs when a run ends. The matcher
// is a tool-name glob (empty matches everything).
//
// No client calls inside: the caller owns the config and passes `onSave` /
// `onTest`. Hooks run locally as an argv array — command plus separate
// arguments — never as a shell string, so a hook cannot smuggle a second
// command in through `;` or `&&`. A run loads hooks only after the user
// enabled them (the caller sets `hooksEnabled` when saving).

import { useState } from 'react'
import { Plus, Settings } from '../components/Icons'
import styles from './ToolsPanels.module.css'

export type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export const HOOK_EVENTS: HookEvent[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']

export const HOOK_EVENT_LABELS: Record<HookEvent, string> = {
  SessionStart: 'When a run starts',
  PreToolUse: 'Before a tool runs (can deny it)',
  PostToolUse: 'After a tool runs',
  Stop: 'When a run ends',
}

/** One hook. `args` is an argv array; the command is never joined into a shell string. */
export interface HookConfig {
  id: string
  event: HookEvent
  /** Glob the hook applies to, e.g. `*.ts`. Empty matches everything. */
  matcher: string
  command: string
  args: string[]
  timeoutMs: number
  enabled: boolean
}

export interface HooksPanelProps {
  hooks: HookConfig[]
  onSave: (hooks: HookConfig[]) => void
  onTest: (hookId: string) => void
  /** The engine's refusal when the last save was rejected (shown, nothing lost). */
  saveError?: string | null
  /** The last test outcome, when the caller has one to show. */
  testResult?: string | null
}

export const MAX_HOOK_TIMEOUT_MS = 600_000

export interface HookValidationErrors {
  event?: string
  command?: string
  timeoutMs?: string
}

export function validateHook(draft: {
  event: string
  command: string
  timeoutMs: number
}): HookValidationErrors {
  const errors: HookValidationErrors = {}
  if (!(HOOK_EVENTS as string[]).includes(draft.event)) {
    errors.event = `Unknown event “${draft.event}”. Choose one of: ${HOOK_EVENTS.join(', ')}.`
  }
  if (draft.command.trim() === '') {
    errors.command = 'Command is required — the program to run, e.g. “npm”.'
  }
  if (!Number.isFinite(draft.timeoutMs) || !Number.isInteger(draft.timeoutMs) || draft.timeoutMs <= 0) {
    errors.timeoutMs = 'Timeout must be a positive whole number of milliseconds.'
  } else if (draft.timeoutMs > MAX_HOOK_TIMEOUT_MS) {
    errors.timeoutMs = `Timeout must be at most ${MAX_HOOK_TIMEOUT_MS} ms (10 minutes).`
  }
  return errors
}

interface Draft {
  id: string | null
  event: string
  matcher: string
  command: string
  argsText: string
  timeoutMs: string
  enabled: boolean
}

function toDraft(hook: HookConfig | null): Draft {
  return {
    id: hook?.id ?? null,
    event: hook?.event ?? 'PreToolUse',
    matcher: hook?.matcher ?? '',
    command: hook?.command ?? '',
    argsText: hook ? hook.args.join(' ') : '',
    timeoutMs: String(hook?.timeoutMs ?? 5000),
    enabled: hook?.enabled ?? true,
  }
}

function newId(): string {
  return `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function HooksPanel({ hooks, onSave, onTest, saveError, testResult }: HooksPanelProps) {
  const [editing, setEditing] = useState<Draft | null>(null)
  const [errors, setErrors] = useState<HookValidationErrors>({})

  const saveDraft = () => {
    if (editing === null) return
    const timeoutMs = Number(editing.timeoutMs)
    const found = validateHook({ event: editing.event, command: editing.command, timeoutMs })
    setErrors(found)
    if (Object.keys(found).length > 0) return
    const hook: HookConfig = {
      id: editing.id ?? newId(),
      event: editing.event as HookEvent,
      matcher: editing.matcher.trim(),
      command: editing.command.trim(),
      args: editing.argsText.split(/\s+/).map((a) => a.trim()).filter((a) => a !== ''),
      timeoutMs,
      enabled: editing.enabled,
    }
    onSave(
      editing.id === null
        ? [...hooks, hook]
        : hooks.map((h) => (h.id === editing.id ? hook : h)),
    )
    setEditing(null)
    setErrors({})
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Settings size={16} />
          <span>Hooks</span>
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            setEditing(toDraft(null))
            setErrors({})
          }}
        >
          <Plus size={12} />
          <span>Add hook</span>
        </button>
      </div>
      <div className={styles.body}>
        <p className={styles.note}>
          Hooks run locally as an argv array — a command plus separate arguments —
          never as a shell string, so a hook cannot chain extra commands with `;` or
          `&&`. Testing a hook runs it once against the current project. Hooks only
          run during a run after you save them here — a hooks file from an
          untrusted project never runs on its own.
        </p>
        {saveError !== undefined && saveError !== null && saveError !== '' && (
          <p className={styles.fieldError} role="alert">{saveError}</p>
        )}
        {testResult !== undefined && testResult !== null && testResult !== '' && (
          <p className={styles.note} role="status">{testResult}</p>
        )}

        {hooks.length === 0 && editing === null ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyText}>No hooks configured</div>
            <p className={styles.emptySubtext}>
              Add a hook to run a local command when a run starts or ends, or
              before or after a tool runs. A PreToolUse hook can deny the tool call.
            </p>
          </div>
        ) : (
          <ul className={styles.list} aria-label="Hooks">
            {hooks.map((hook) => (
              <li key={hook.id} className={styles.row}>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={hook.enabled}
                    aria-label={`Enable hook ${hook.command}`}
                    onChange={(e) =>
                      onSave(hooks.map((h) => (h.id === hook.id ? { ...h, enabled: e.target.checked } : h)))
                    }
                  />
                  <span className={styles.rowTitle}>
                    {hook.command}
                    {hook.args.length > 0 ? ` ${hook.args.join(' ')}` : ''}
                  </span>
                </label>
                <p className={styles.rowDetail}>
                  {HOOK_EVENT_LABELS[hook.event]}
                  {hook.matcher !== '' ? ` · matches ${hook.matcher}` : ' · matches everything'} ·{' '}
                  timeout {hook.timeoutMs} ms · {hook.enabled ? 'enabled' : 'disabled'}
                </p>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => {
                      setEditing(toDraft(hook))
                      setErrors({})
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className={styles.button} onClick={() => onTest(hook.id)}>
                    Test
                  </button>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => onSave(hooks.filter((h) => h.id !== hook.id))}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {editing !== null && (
          <section aria-label="Hook form" style={{ marginTop: 12 }}>
            <h3 className={styles.sectionTitle}>{editing.id === null ? 'Add hook' : 'Edit hook'}</h3>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="hook-event">Event</label>
              <select
                id="hook-event"
                className={styles.select}
                value={editing.event}
                onChange={(e) => setEditing({ ...editing, event: e.target.value })}
              >
                {HOOK_EVENTS.map((event) => (
                  <option key={event} value={event}>{HOOK_EVENT_LABELS[event]}</option>
                ))}
              </select>
              {errors.event !== undefined && <p className={styles.fieldError} role="alert">{errors.event}</p>}
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="hook-matcher">Matcher (tool-name glob, empty matches everything)</label>
              <input
                id="hook-matcher"
                className={styles.input}
                value={editing.matcher}
                placeholder="edit_file"
                onChange={(e) => setEditing({ ...editing, matcher: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="hook-command">Command</label>
              <input
                id="hook-command"
                className={`${styles.input} ${errors.command !== undefined ? styles.inputError : ''}`}
                value={editing.command}
                placeholder="npm"
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
              />
              {errors.command !== undefined && <p className={styles.fieldError} role="alert">{errors.command}</p>}
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="hook-args">Arguments (space-separated, run as argv)</label>
              <input
                id="hook-args"
                className={styles.input}
                value={editing.argsText}
                placeholder="run lint"
                onChange={(e) => setEditing({ ...editing, argsText: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="hook-timeout">Timeout (ms)</label>
              <input
                id="hook-timeout"
                className={`${styles.input} ${errors.timeoutMs !== undefined ? styles.inputError : ''}`}
                value={editing.timeoutMs}
                inputMode="numeric"
                onChange={(e) => setEditing({ ...editing, timeoutMs: e.target.value })}
              />
              {errors.timeoutMs !== undefined && <p className={styles.fieldError} role="alert">{errors.timeoutMs}</p>}
            </div>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              <span>Enabled</span>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className={styles.primaryButton} onClick={saveDraft}>
                Save hook
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  setEditing(null)
                  setErrors({})
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
