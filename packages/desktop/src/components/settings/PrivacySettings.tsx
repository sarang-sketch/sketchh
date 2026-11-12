// Settings → Privacy: the Offline Mode switch, what this engine sent where, and the
// data Sketch keeps on this computer.
//
// The engine owns all of it. The switch is saved by `privacy-set` in the user's home,
// so every window and every engine process sees the same answer, and the activity list
// is the engine's own record of its requests (origin and outcome only). Nothing here is
// computed in the window, so nothing here can claim more than the engine enforces.

import { useCallback, useEffect, useState } from 'react'
import { useSketchClient } from '../../lib/ClientProvider'
import { useOptionalAgentSession } from '../../lib/AgentSession'
import type { PrivacyStatus } from '../../lib/client'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { useConfirm } from '../ConfirmDialog'
import { Shield, Trash } from '../Icons'
import styles from './SettingsDialog.module.css'
import own from './PrivacySettings.module.css'

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function PrivacySettings() {
  const client = useSketchClient()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const confirm = useConfirm()
  const session = useOptionalAgentSession()
  const [status, setStatus] = useState<PrivacyStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const supported = client.privacyStatus !== undefined && client.privacySet !== undefined
  const root = state.projectRoot ?? undefined

  const refresh = useCallback(async () => {
    if (client.privacyStatus === undefined) return
    try {
      const next = await client.privacyStatus(root !== undefined ? { root } : {})
      setStatus(next)
      setError(null)
      dispatch({ type: 'SET_OFFLINE', payload: next.offline })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [client, dispatch, root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (offline: boolean) => {
    if (client.privacySet === undefined) return
    setSaving(true)
    try {
      const next = await client.privacySet(offline, root !== undefined ? { root } : {})
      setStatus(next)
      setError(null)
      dispatch({ type: 'SET_OFFLINE', payload: next.offline })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const clearChats = async () => {
    const answer = await confirm({
      title: 'Clear chat history?',
      message: `This deletes all ${state.conversations.length} conversations from this computer. It cannot be undone.`,
      buttons: [
        { id: 'clear', label: 'Clear history', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (answer === 'clear') dispatch({ type: 'CLEAR_CONVERSATIONS' })
  }

  if (!supported) {
    return (
      <p className={styles.lead}>
        This engine connection ({client.transport}) cannot report or change Offline Mode, so this page has nothing to show.
      </p>
    )
  }

  const forced = status?.source === 'environment'
  const busy = session?.activeRunId !== null && session?.activeRunId !== undefined

  return (
    <div>
      <div className={styles.option}>
        <div className={styles.optionText}>
          <div className={styles.optionTitle}>Offline Mode</div>
          <div className={styles.optionDetail}>
            Keeps the engine on this computer. Models served here (Ollama, LM Studio, llama.cpp) keep working. Internet
            providers, ChatGPT and OpenRouter sign-in, connection tests against them, MCP servers that need the network, and
            git push, pull, fetch and clone are refused, with a message that says so.
          </div>
          {forced && (
            <div className={own.note} role="note">
              Set by <code>SKETCH_OFFLINE</code> in the engine's environment, so this switch cannot change it.
            </div>
          )}
          {status?.error !== undefined && (
            <div className={own.note} role="note">
              The settings file could not be read ({status.error}), so Offline Mode is on. Switching it off rewrites the file.
            </div>
          )}
        </div>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={status?.offline ?? false}
            disabled={status === null || saving || forced}
            onChange={(e) => void toggle(e.target.checked)}
            aria-label="Offline Mode"
          />
          <span />
        </label>
      </div>

      <div className={own.facts} role="note">
        <Shield size={13} />
        <span>
          Not covered: programs you run yourself in the terminal, and your project's own scripts. They are separate
          programs, and Offline Mode cannot see their connections.
        </span>
      </div>

      {error !== null && (
        <p className={own.error} role="alert">
          {error}
        </p>
      )}

      <div className={own.head}>
        <h3 className={own.h3}>Network activity</h3>
        <button className={styles.secondary} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <p className={styles.optionDetail}>
        Requests this engine made since it started, newest first. Only the address and the result are kept, never the
        request itself.
        {status !== null && !status.guard && ' The request guard is not installed in this engine process, so this list is empty.'}
      </p>
      {status !== null && status.activity.length === 0 ? (
        <p className={own.empty}>No requests yet.</p>
      ) : (
        <table className={own.table} aria-label="Network activity">
          <thead>
            <tr>
              <th>Time</th>
              <th>Address</th>
              <th>Where</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {(status?.activity ?? []).map((entry, index) => (
              <tr key={`${entry.at}-${index}`}>
                <td>{TIME.format(entry.at)}</td>
                <td>
                  <code>{entry.method} {entry.origin}</code>
                </td>
                <td>{entry.local ? 'This computer' : 'Internet'}</td>
                <td className={entry.outcome === 'blocked' ? own.blocked : undefined}>
                  {entry.outcome === 'sent' ? `Sent${entry.status !== undefined ? ` (${entry.status})` : ''}` : entry.outcome === 'blocked' ? 'Blocked' : 'Failed'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className={own.h3}>Your data</h3>
      <ul className={own.paths}>
        <li>
          Settings, sign-ins and installed skills: <code>{status?.storage.user ?? '…'}</code>
        </li>
        {status?.storage.project !== undefined && (
          <li>
            This project's run log, plans and memory: <code>{status.storage.project}</code>
          </li>
        )}
        <li>Chats, open folders and window layout: this window's local storage</li>
        <li>API keys: your operating system's credential store</li>
      </ul>
      <button className={styles.secondary} onClick={() => void clearChats()} disabled={state.conversations.length === 0 || busy}>
        <Trash size={12} /> Clear chat history
      </button>
      {busy && <span className={own.hint}> Stop the running task first.</span>}
    </div>
  )
}

export default PrivacySettings
