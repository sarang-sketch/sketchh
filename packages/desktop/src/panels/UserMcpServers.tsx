// MCP panel → "Your servers": the MCP servers the user configured, in the same
// `mcpServers` JSON format Claude Desktop, Cursor and Claude Code use.
//
// The engine owns the files and the rules (`core/mcp/userServers.ts`): a project's
// servers start only after the user approved that exact launch, every user server's
// tools cost `proc:spawn`, and Offline Mode starts none of them. This panel adds,
// imports, tests, approves and removes them, and chooses which ones chats may start.

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useSketchClient } from '../lib/ClientProvider'
import type { UserMcpServerInfo, UserMcpServersResult, UserMcpTestResult } from '../lib/client'
import { useAppDispatch, useAppState } from '../state/AppState'
import { useConfirm } from '../components/ConfirmDialog'
import { AlertCircle, Check, Plus, Shield, Trash } from '../components/Icons'
import styles from './UserMcpServers.module.css'

/** `KEY=value` lines to an object. Exported for tests. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) throw new Error(`"${trimmed}" is not NAME=value`)
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1)
  }
  return env
}

/** The `mcpServers` block of a pasted Claude Desktop / Cursor / Claude Code config. */
export function parseImport(text: string): Array<{ name: string; command: string; args: string[]; env: Record<string, string> }> {
  const parsed: unknown = JSON.parse(text)
  const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  const block = (record['mcpServers'] ?? record) as Record<string, unknown>
  return Object.entries(block).map(([name, raw]) => {
    const entry = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof entry['command'] !== 'string') throw new Error(`"${name}" has no "command" (remote servers are not supported yet)`)
    return {
      name,
      command: entry['command'],
      args: Array.isArray(entry['args']) ? entry['args'].map(String) : [],
      env: entry['env'] !== null && typeof entry['env'] === 'object' ? Object.fromEntries(Object.entries(entry['env'] as object).map(([k, v]) => [k, String(v)])) : {},
    }
  })
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function UserMcpServers() {
  const client = useSketchClient()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const confirm = useConfirm()
  const root = state.projectRoot ?? undefined
  const enabled = state.agentPrefs.mcpServers ?? []
  const [result, setResult] = useState<UserMcpServersResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, UserMcpTestResult | 'running'>>({})
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ name: '', command: '', args: '', env: '', scope: 'global' as 'global' | 'project' })
  const [pasted, setPasted] = useState('')
  const supported = client.mcpServers !== undefined && client.mcpServerSave !== undefined
  const at = root !== undefined ? { root } : {}

  const refresh = useCallback(async () => {
    if (client.mcpServers === undefined) return
    try {
      setResult(await client.mcpServers(root !== undefined ? { root } : {}))
      setProblem(null)
    } catch (err) {
      setProblem(message(err))
    }
  }, [client, root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!supported) return null

  const setEnabled = (name: string, on: boolean) => {
    const next = on ? [...new Set([...enabled, name])] : enabled.filter((n) => n !== name)
    dispatch({ type: 'SET_AGENT_PREFS', payload: { mcpServers: next } })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const env = parseEnvLines(form.env)
      const args = form.args.split(/\r?\n/).map((a) => a.trim()).filter((a) => a !== '')
      setResult(await client.mcpServerSave!({ scope: form.scope, name: form.name.trim(), command: form.command.trim(), args, env, ...at }))
      setForm({ name: '', command: '', args: '', env: '', scope: form.scope })
      setAdding(false)
      setProblem(null)
    } catch (err) {
      setProblem(message(err))
    }
  }

  const importServers = async () => {
    try {
      const entries = parseImport(pasted)
      for (const entry of entries) {
        await client.mcpServerSave!({ scope: form.scope, ...entry, ...at })
      }
      setPasted('')
      setImporting(false)
      setProblem(null)
      await refresh()
    } catch (err) {
      setProblem(`Import failed: ${message(err)}`)
    }
  }

  const test = async (server: UserMcpServerInfo) => {
    if (client.mcpServerTest === undefined) return
    setTests((all) => ({ ...all, [server.name]: 'running' }))
    try {
      const outcome = await client.mcpServerTest({ name: server.name, ...at })
      setTests((all) => ({ ...all, [server.name]: outcome }))
    } catch (err) {
      setTests((all) => ({ ...all, [server.name]: { ok: false, name: server.name, detail: message(err), tools: [] } }))
    }
  }

  const approve = async (server: UserMcpServerInfo, trusted: boolean) => {
    if (client.mcpServerTrust === undefined) return
    if (trusted) {
      const answer = await confirm({
        title: `Allow "${server.name}" to run?`,
        message: `This project's settings ask Sketch to start a program as you: ${[server.command, ...server.args].join(' ')}`,
        detail: 'Only approve a command you recognise. If the project changes it, Sketch asks again.',
        buttons: [
          { id: 'allow', label: 'Allow', kind: 'primary' },
          { id: 'cancel', label: 'Cancel', kind: 'secondary' },
        ],
        cancelId: 'cancel',
      })
      if (answer !== 'allow') return
    }
    try {
      setResult(await client.mcpServerTrust({ name: server.name, trusted, ...at }))
    } catch (err) {
      setProblem(message(err))
    }
  }

  const remove = async (server: UserMcpServerInfo) => {
    if (client.mcpServerRemove === undefined) return
    const answer = await confirm({
      title: `Remove "${server.name}"?`,
      message: `It is deleted from ${server.file}.`,
      buttons: [
        { id: 'remove', label: 'Remove', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (answer !== 'remove') return
    try {
      setResult(await client.mcpServerRemove({ scope: server.scope, name: server.name, ...at }))
      setEnabled(server.name, false)
    } catch (err) {
      setProblem(message(err))
    }
  }

  return (
    <section className={styles.wrap} aria-label="Your MCP servers">
      <div className={styles.head}>
        <strong>Your servers</strong>
        <div className={styles.headActions}>
          <button className={styles.button} onClick={() => setAdding((v) => !v)}>
            <Plus size={12} /> Add server
          </button>
          <button className={styles.button} onClick={() => setImporting((v) => !v)}>
            Import JSON
          </button>
        </div>
      </div>
      <p className={styles.note}>
        Programs you add here can be used by chats when "Use in chats" is on. Their tools run with your permissions. Offline
        Mode starts none of them.
      </p>

      {(adding || importing) && (
        <label className={styles.field}>
          Save to
          <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as 'global' | 'project' })} aria-label="Save to">
            <option value="global">All projects (~/.sketch/mcp.json)</option>
            <option value="project" disabled={root === undefined}>
              This project (.sketch/mcp.json)
            </option>
          </select>
        </label>
      )}

      {adding && (
        <form className={styles.form} onSubmit={(e) => void save(e)} aria-label="Add an MCP server">
          <input className={styles.input} placeholder="Name, e.g. filesystem" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
          <input className={styles.input} placeholder="Command, e.g. npx" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} aria-label="Command" />
          <textarea className={styles.input} rows={3} placeholder={'Arguments, one per line\n-y\n@modelcontextprotocol/server-filesystem'} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} aria-label="Arguments" />
          <textarea className={styles.input} rows={2} placeholder="Environment, NAME=value per line (optional)" value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} aria-label="Environment" />
          <button className={styles.button} type="submit" disabled={form.name.trim() === '' || form.command.trim() === ''}>
            Save server
          </button>
        </form>
      )}

      {importing && (
        <div className={styles.form}>
          <textarea
            className={styles.input}
            rows={6}
            placeholder={'Paste a config from Claude Desktop, Cursor or Claude Code:\n{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "..."] } } }'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            aria-label="MCP configuration JSON"
          />
          <button className={styles.button} onClick={() => void importServers()} disabled={pasted.trim() === ''}>
            Import
          </button>
        </div>
      )}

      {problem !== null && (
        <p className={styles.error} role="alert">
          <AlertCircle size={12} /> {problem}
        </p>
      )}
      {result?.diagnostics.map((line) => (
        <p key={line} className={styles.note}>
          {line}
        </p>
      ))}

      {result !== null && result.servers.length === 0 && <p className={styles.note}>No servers yet.</p>}
      <ul className={styles.list}>
        {result?.servers.map((server) => {
          const outcome = tests[server.name]
          const usable = server.problems.length === 0 && server.trusted
          return (
            <li key={`${server.scope}:${server.name}`} className={styles.row}>
              <div className={styles.rowHead}>
                <span className={styles.name}>{server.name}</span>
                <span className={styles.scope}>{server.scope === 'project' ? 'This project' : 'All projects'}</span>
                {server.scope === 'project' && (
                  <span className={server.trusted ? styles.ok : styles.warn}>
                    {server.trusted ? <Check size={11} /> : <Shield size={11} />} {server.trusted ? 'Approved' : 'Needs your approval'}
                  </span>
                )}
              </div>
              <code className={styles.command}>{server.command !== null ? [server.command, ...server.args].join(' ') : server.url}</code>
              {server.problems.map((p) => (
                <p key={p} className={styles.error}>
                  {p}
                </p>
              ))}
              <div className={styles.actions}>
                <label className={styles.toggle}>
                  <input type="checkbox" checked={enabled.includes(server.name)} disabled={!usable} onChange={(e) => setEnabled(server.name, e.target.checked)} aria-label={`Use ${server.name} in chats`} />
                  Use in chats
                </label>
                {server.scope === 'project' && server.problems.length === 0 && (
                  <button className={styles.button} onClick={() => void approve(server, !server.trusted)}>
                    {server.trusted ? 'Revoke' : 'Approve'}
                  </button>
                )}
                <button className={styles.button} disabled={!usable || outcome === 'running'} onClick={() => void test(server)}>
                  {outcome === 'running' ? 'Testing…' : 'Test'}
                </button>
                <button className={styles.button} aria-label={`Remove ${server.name}`} onClick={() => void remove(server)}>
                  <Trash size={12} />
                </button>
              </div>
              {outcome !== undefined && outcome !== 'running' && (
                <div className={outcome.ok ? styles.testOk : styles.error} role="status" aria-label={`Test of ${server.name}`}>
                  {outcome.ok ? `Connected: ${outcome.tools.length} tool${outcome.tools.length === 1 ? '' : 's'} — ${outcome.tools.map((t) => t.name).join(', ')}` : outcome.detail}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default UserMcpServers
