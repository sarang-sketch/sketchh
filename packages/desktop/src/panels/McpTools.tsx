// MCP Tools — the curated catalog, what it costs, and what it is missing.
//
// ── WHAT REPLACED WHAT ──────────────────────────────────────────────────────
//
// The ActivityBar carried a badge reading `mcpToolsStatus.connected`, whose value came
// from `{ connected: 5, total: 8, warning: true }` hardcoded in `AppState`, and the chat
// sidebar carried a tooltip naming four servers ("cloudrun, firebase, notebooks,
// visualization") that do not exist in this product. Both are gone. Every row here comes
// from `mcp-catalog` over the client seam (Requirement 27.5).
//
// ── WHY THERE IS NO "CONNECTED" COUNT ───────────────────────────────────────
//
// This is the honest correction, not a shortcut. MCP servers are started PER RUN, by a
// run that asked for them, and only when that run's grant covers the capability they
// cost. The unavailability latch is per-run by definition — Requirement 22.3 says a
// hung server is unavailable "for the remainder of the run" — so a host that outlived a
// run would carry a dead server's verdict into a run that might have worked.
//
// Which means: between runs, nothing is connected. There is no number to show. What a
// user can usefully know before a run is whether a server COULD start — whether its
// credentials are present — and that is `configured`. A badge reading "5 connected"
// while nothing is running is not a simplification, it is false.
//
// ── THE CAPABILITY AND THE ARGV ARE BOTH ON SCREEN ──────────────────────────
//
// Each row shows the one capability the server's tools cost and the exact pinned
// command that would run. A user cannot reason about "grant GitHub access" but can
// reason about "net:http, and it runs @modelcontextprotocol/server-github@0.6.2". The
// caveats say what the capability alone does not — that a GitHub token's scopes are the
// real boundary, that the Docker socket is effectively root.
//
// Validates: Requirements 22.2, 22.4, 22.5, 27.1, 27.5

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Server, Shield } from '../components/Icons'
import { useSketchClient } from '../lib/ClientProvider'
import type { McpCatalogResult } from '../lib/client'
import styles from './McpTools.module.css'

/**
 * Plain words for the engine's capability vocabulary.
 *
 * Duplicated rather than imported, like `SkillsMarketplace`'s copy, because the desktop
 * bundle takes no runtime dependency on `@sketch/core`. `McpTools.test.tsx` asserts this
 * table covers every capability the catalog actually uses, so the two cannot drift.
 */
const CAPABILITY_TEXT: Record<string, string> = {
  'fs:read:project': 'Read files in this project',
  'fs:write:project': 'Create and change files in this project',
  'fs:read:home': 'Read files anywhere in your home directory',
  'fs:write:home': 'Create and change files anywhere in your home directory',
  'net:http': 'Make network requests to any host',
  'net:localhost': 'Make network requests to this machine only',
  'proc:spawn': 'Start other programs, with your permissions',
  'secrets:read': 'Read stored credentials and API keys',
  'git:read': 'Read this repository\u2019s history and diffs',
  'git:write': 'Commit, stage and change this repository',
}

/** Grants that reach past the project. Marked, never hidden. */
const SENSITIVE = new Set(['fs:read:home', 'fs:write:home', 'proc:spawn', 'secrets:read'])

export function McpTools() {
  const client = useSketchClient()

  const [catalog, setCatalog] = useState<McpCatalogResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const canRead = client.mcpCatalog !== undefined

  const refresh = useCallback(async () => {
    const call = client.mcpCatalog
    if (call === undefined) return
    generation.current += 1
    const ticket = generation.current
    setError(null)
    try {
      const answer = await call.call(client)
      if (generation.current !== ticket) return
      setCatalog(answer)
    } catch (err) {
      if (generation.current !== ticket) return
      setCatalog(null)
      setError(`The MCP catalog could not be read: ${message(err)}`)
    }
  }, [client])

  // Reading a table and checking which environment variables are set is local work
  // with no side effect, so it may happen on mount. Nothing here starts a server.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!canRead) {
    return (
      <Frame>
        <Empty
          title="No engine behind this transport"
          detail={`The ${client.transport} transport does not implement mcp-catalog, so there is nothing to report. An invented list would claim that servers are connected and that credentials are present, which is what the hardcoded badge this panel replaced was doing.`}
        />
      </Frame>
    )
  }

  return (
    <Frame>
      {error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}

      {catalog !== null && (
        <>
          <div className={styles.summary} role="status">
            <strong>
              {catalog.configured} of {catalog.total} servers configured
            </strong>
            <span>{catalog.note}</span>
          </div>

          <ul className={styles.servers} aria-label="Curated MCP servers">
            {catalog.servers.map((server) => (
              <li key={server.id} className={styles.server}>
                <div className={styles.head}>
                  <span
                    className={`${styles.badge} ${server.configured ? styles.ready : styles.needs}`}
                  >
                    {server.configured ? <Check size={11} /> : <AlertCircle size={11} />}
                    <span>{server.configured ? 'configured' : 'needs setup'}</span>
                  </span>
                  <span className={styles.title}>{server.title}</span>
                  <code className={styles.id}>{server.id}</code>
                </div>

                <p className={styles.summaryText}>{server.summary}</p>

                <p className={styles.capability}>
                  <Shield size={12} />
                  <span>
                    Costs <code>{server.requires}</code> —{' '}
                    {CAPABILITY_TEXT[server.requires] ?? 'an unrecognised capability'}
                    {SENSITIVE.has(server.requires) && (
                      <strong className={styles.sensitiveMark}> (reaches past this project)</strong>
                    )}
                  </span>
                </p>

                {/* The exact pinned argv. Every entry names a version; none says
                    `@latest`, because a command that changes under you is a supply
                    chain that arrives silently on the next invocation. */}
                <pre className={styles.command} aria-label={`${server.title} launch command`}>
                  {server.command}
                </pre>

                {server.missingEnv.length > 0 && (
                  <p className={styles.missing}>
                    Not set in this environment: {server.missingEnv.join(', ')}. Export{' '}
                    {server.missingEnv.length === 1 ? 'it' : 'them'} before a run asks for this
                    server, or it will refuse to start and say so.
                  </p>
                )}

                {server.caveat !== undefined && (
                  <p className={styles.caveat}>
                    <AlertCircle size={12} />
                    <span>{server.caveat}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>

          <p className={styles.footNote}>
            These packages are third party and are fetched by your own package manager the
            first time a server starts. What is pinned is the version, so what runs is
            reproducible — this project has not audited their contents, and the content hashing
            it applies to skills cannot be applied here without vendoring the servers.
          </p>
        </>
      )}
    </Frame>
  )
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Server size={16} />
          <span>MCP Tools</span>
        </div>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  )
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyText}>{title}</div>
      {detail !== undefined && <p className={styles.emptySubtext}>{detail}</p>}
    </div>
  )
}
