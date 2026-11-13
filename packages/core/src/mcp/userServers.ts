// MCP servers the user configured, in the format Claude Desktop, Cursor and Claude Code
// share: `{ "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }`.
//
//   * `~/.sketch/mcp.json`          — every project ("global")
//   * `<project>/.sketch/mcp.json`  — this project; wins over a global server of the same name
//
// ── TRUST ────────────────────────────────────────────────────────────────────
//
// A server is a program Sketch starts as the user. A file in the user's home is the
// user's own. A file inside a project can come from anyone who can push to that
// repository, so a project server starts only after the user approved THAT exact
// launch: its name, command, arguments and environment (values included, since an
// environment variable such as NODE_OPTIONS can run code). The approval is a hash kept
// in `~/.sketch/mcp-trust.json`, outside every repository; changing anything voids it.
//
// ── CAPABILITY ───────────────────────────────────────────────────────────────
//
// A user server is an arbitrary program, so its tools cost `proc:spawn`, the honest
// capability for "runs a program as you". Offline Mode does not start user servers at
// all: Sketch cannot tell whether a program uses the network.
//
// Remote servers (`"url": ...`) run over Streamable HTTP (`mcp/httpTransport.ts`):
// no process is spawned, the tools cost `net:http`, and Offline Mode does not
// start them. A remote server needs no OAuth support in Sketch — a server that
// demands it answers 401 and the call fails cleanly (see `httpTransport.ts`).

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { McpCatalogEntry } from './catalog.js'
import type { McpServerSpec } from './client.js'
import type { RemoteMcpServerSpec } from './httpTransport.js'
import { backupCorruptConfig } from '../settings/providerSettings.js'

export const USER_SERVER_PREFIX = 'user-'
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface UserMcpServer {
  /** The key under `mcpServers`. */
  name: string
  /** `user-<slug>`: the id the host, grants and tool names use. */
  id: string
  scope: 'global' | 'project'
  file: string
  command: string | null
  args: string[]
  env: Record<string, string>
  /** A remote (Streamable HTTP) server's address. Null for stdio servers. */
  url: string | null
  /**
   * Extra HTTP headers sent to a remote server, e.g. an `Authorization` value
   * the user put in their own config. Stored like `env` and never logged.
   */
  headers: Record<string, string>
  /** Why it cannot start. Empty when it can. */
  problems: string[]
  /** Global servers always; project servers once the user approved this exact launch. */
  trusted: boolean
  fingerprint: string
}

export interface UserServersOptions {
  home?: string
  root?: string
}

export interface UserServerFiles {
  global: string
  project?: string
  trust: string
}

export function userServerFiles(options: UserServersOptions = {}): UserServerFiles {
  const home = resolve(options.home ?? homedir())
  return {
    global: join(home, '.sketch', 'mcp.json'),
    ...(options.root !== undefined ? { project: join(resolve(options.root), '.sketch', 'mcp.json') } : {}),
    trust: join(home, '.sketch', 'mcp-trust.json'),
  }
}

export function idForName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${USER_SERVER_PREFIX}${slug === '' ? 'server' : slug}`
}

async function readJson(file: string): Promise<{ value: Record<string, unknown> | null; error?: string }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { value: null }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null, error: `${file} is not a JSON object` }
    return { value: parsed as Record<string, unknown> }
  } catch (err) {
    return { value: null, error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

export function fingerprintOf(input: { scope: string; root?: string; name: string; command: string | null; args: string[]; env: Record<string, string>; url: string | null; headers?: Record<string, string> }): string {
  const env = Object.keys(input.env).sort().map((key) => [key, input.env[key]])
  const headers = Object.keys(input.headers ?? {}).sort().map((key) => [key, input.headers?.[key]])
  const canonical = JSON.stringify([input.scope, input.root ?? '', input.name, input.command, input.args, env, input.url, headers])
  return createHash('sha256').update(canonical).digest('hex')
}

/** One `mcpServers` entry, checked. Exported for tests. */
export function parseServer(
  name: string,
  raw: unknown,
  where: { scope: 'global' | 'project'; file: string; root?: string },
): UserMcpServer {
  const problems: string[] = []
  const entry = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  if (!NAME.test(name)) problems.push('the name may use letters, digits, ., _ and - only')
  const command = typeof entry['command'] === 'string' && entry['command'].trim() !== '' ? entry['command'].trim() : null
  const url = typeof entry['url'] === 'string' && entry['url'].trim() !== '' ? entry['url'].trim() : null
  const args = Array.isArray(entry['args']) ? entry['args'].filter((a): a is string => typeof a === 'string') : []
  if (Array.isArray(entry['args']) && args.length !== entry['args'].length) problems.push('every argument must be a string')
  const env: Record<string, string> = {}
  const rawEnv = entry['env']
  if (rawEnv !== undefined && (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv))) problems.push('"env" must be an object of strings')
  else if (rawEnv !== undefined) {
    for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (!ENV_NAME.test(key) || typeof value !== 'string') problems.push(`environment entry ${key} must be NAME: "text"`)
      else env[key] = value
    }
  }
  if (command === null && url === null) problems.push('it needs a "command" to run or a "url" for a remote server')
  if (command !== null && /[;&|<>`$]/.test(command)) problems.push('"command" must be one program, not a shell command line; put its arguments in "args"')
  if (command !== null && url !== null) problems.push('give either a "command" or a "url", not both')
  if (url !== null && !/^https?:\/\/[^\s/]+/.test(url)) problems.push('"url" must be an http:// or https:// address')
  const headers: Record<string, string> = {}
  const rawHeaders = entry['headers']
  const HEADER_NAME = /^[A-Za-z0-9-]+$/
  if (rawHeaders !== undefined && (rawHeaders === null || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders))) problems.push('"headers" must be an object of strings')
  else if (rawHeaders !== undefined) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (!HEADER_NAME.test(key) || typeof value !== 'string') problems.push(`header entry ${key} must be NAME: "text"`)
      else headers[key] = value
    }
  }
  if (url === null && Object.keys(headers).length > 0) problems.push('"headers" only apply to a remote ("url") server')
  return {
    name,
    id: idForName(name),
    scope: where.scope,
    file: where.file,
    command,
    args,
    env,
    url,
    headers,
    problems,
    trusted: where.scope === 'global',
    fingerprint: fingerprintOf({ scope: where.scope, ...(where.root !== undefined ? { root: where.root } : {}), name, command, args, env, url, headers }),
  }
}

async function readTrust(file: string): Promise<Record<string, unknown>> {
  const { value } = await readJson(file)
  const approved = value?.['approved']
  return approved !== null && typeof approved === 'object' && !Array.isArray(approved) ? (approved as Record<string, unknown>) : {}
}

export interface UserServersResult {
  servers: UserMcpServer[]
  files: UserServerFiles
  diagnostics: string[]
}

/** Every configured server, project entries first, each with its trust state. */
export async function readUserServers(options: UserServersOptions = {}): Promise<UserServersResult> {
  const files = userServerFiles(options)
  const diagnostics: string[] = []
  const root = options.root !== undefined ? resolve(options.root) : undefined
  const read = async (scope: 'global' | 'project', file: string | undefined): Promise<UserMcpServer[]> => {
    if (file === undefined) return []
    const { value, error } = await readJson(file)
    if (error !== undefined) {
      // A corrupt mcp.json must not brick MCP: set it aside (never deleted) so the
      // next save starts clean, and say plainly where the old bytes went.
      const moved = await backupCorruptConfig(file)
      diagnostics.push(
        moved.backedUpTo !== null
          ? `${error}. It was moved to ${moved.backedUpTo}; add your servers again or restore it by hand.`
          : `${error}. It could not be moved aside (${moved.reason}); fix or remove it by hand.`,
      )
    }
    const block = value?.['mcpServers']
    if (block === undefined || block === null) return []
    if (typeof block !== 'object' || Array.isArray(block)) {
      diagnostics.push(`${file}: "mcpServers" must be an object`)
      return []
    }
    return Object.entries(block as Record<string, unknown>).map(([name, raw]) =>
      parseServer(name, raw, { scope, file, ...(scope === 'project' && root !== undefined ? { root } : {}) }),
    )
  }
  const project = await read('project', files.project)
  const global = await read('global', files.global)
  // Trust is security state: a corrupt trust file must FAIL CLOSED (no project server
  // is treated as approved) and be set aside, not silently ignored, so the user is told
  // their approvals were lost and re-approves deliberately.
  const trustRead = await readJson(files.trust)
  if (trustRead.error !== undefined) {
    const moved = await backupCorruptConfig(files.trust)
    diagnostics.push(
      moved.backedUpTo !== null
        ? `${trustRead.error}. Your MCP approvals could not be read and were moved to ${moved.backedUpTo}; approve project servers again.`
        : `${trustRead.error}. Your MCP approvals could not be read (${moved.reason}); approve project servers again.`,
    )
  }
  const approvedRaw = trustRead.value?.['approved']
  const approved: Record<string, unknown> =
    approvedRaw !== null && typeof approvedRaw === 'object' && !Array.isArray(approvedRaw)
      ? (approvedRaw as Record<string, unknown>)
      : {}
  for (const server of project) server.trusted = approved[server.fingerprint] !== undefined
  const taken = new Set(project.map((s) => s.id))
  const servers = [...project]
  for (const server of global) {
    if (taken.has(server.id)) {
      diagnostics.push(`the project's "${server.name}" is used instead of the global one with the same name`)
      continue
    }
    taken.add(server.id)
    servers.push(server)
  }
  return { servers, files, diagnostics }
}

export interface ServerInput {
  scope: 'global' | 'project'
  name: string
  /** Required for a stdio server; omit for a remote (`url`) server. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Remote (Streamable HTTP) server address. Omit for a stdio server. */
  url?: string
  /** Extra HTTP headers for a remote server. Never logged. */
  headers?: Record<string, string>
}

/** Add or replace one server, keeping every other entry and key in the file. */
export async function saveUserServer(options: UserServersOptions, input: ServerInput): Promise<UserMcpServer> {
  const files = userServerFiles(options)
  const file = input.scope === 'project' ? files.project : files.global
  if (file === undefined) throw new Error('a project server needs an open project')
  const parsed = parseServer(input.name, { command: input.command, args: input.args ?? [], env: input.env ?? {}, url: input.url, headers: input.headers }, {
    scope: input.scope,
    file,
    ...(input.scope === 'project' && options.root !== undefined ? { root: resolve(options.root) } : {}),
  })
  if (parsed.problems.length > 0) throw new Error(parsed.problems.join('; '))
  const { value, error } = await readJson(file)
  if (error !== undefined) throw new Error(`${error}. Fix or remove the file first; Sketch will not overwrite it.`)
  const doc = value ?? {}
  const block = doc['mcpServers'] !== null && typeof doc['mcpServers'] === 'object' && !Array.isArray(doc['mcpServers']) ? { ...(doc['mcpServers'] as Record<string, unknown>) } : {}
  block[input.name] = {
    ...(parsed.command !== null ? { command: parsed.command } : {}),
    ...(parsed.url !== null ? { url: parsed.url } : {}),
    args: parsed.args,
    ...(Object.keys(parsed.env).length > 0 ? { env: parsed.env } : {}),
    ...(Object.keys(parsed.headers).length > 0 ? { headers: parsed.headers } : {}),
  }
  await writeJson(file, { ...doc, mcpServers: block })
  return parsed
}

export async function removeUserServer(options: UserServersOptions, scope: 'global' | 'project', name: string): Promise<boolean> {
  const files = userServerFiles(options)
  const file = scope === 'project' ? files.project : files.global
  if (file === undefined) return false
  const { value, error } = await readJson(file)
  if (error !== undefined) throw new Error(error)
  const block = value?.['mcpServers']
  if (block === null || typeof block !== 'object' || Array.isArray(block) || !(name in (block as object))) return false
  const next = { ...(block as Record<string, unknown>) }
  delete next[name]
  await writeJson(file, { ...value, mcpServers: next })
  return true
}

/** Approve (or withdraw approval for) a project server's exact launch. */
export async function setServerTrust(options: UserServersOptions, server: UserMcpServer, trusted: boolean): Promise<void> {
  const files = userServerFiles(options)
  const { value } = await readJson(files.trust)
  const approved = { ...(await readTrust(files.trust)) }
  if (trusted) approved[server.fingerprint] = { name: server.name, root: options.root !== undefined ? resolve(options.root) : null, at: new Date().toISOString() }
  else delete approved[server.fingerprint]
  await writeJson(files.trust, { ...(value ?? {}), approved })
}

/** The catalog-shaped entry the host and dispatcher see for a user server. */
export function catalogEntryFor(server: UserMcpServer): McpCatalogEntry {
  return {
    id: server.id,
    title: server.name,
    summary: `Your MCP server "${server.name}" (${server.scope === 'project' ? 'this project' : 'all projects'})`,
    requires: 'proc:spawn',
    launch: { command: server.command ?? '', args: server.args },
    caveat: 'A program you configured. It runs with your permissions.',
  }
}

export function specFor(server: UserMcpServer, root: string, deadlines: { requestTimeoutMs?: number; handshakeTimeoutMs?: number } = {}): McpServerSpec {
  return { id: server.id, command: server.command ?? '', args: server.args, cwd: root, env: server.env, ...deadlines }
}

/**
 * The HTTP spec for a remote user server. Only call for a server with a `url`;
 * stdio servers go through `specFor`. Header values come from the user's own
 * config and are never logged (see `httpTransport.ts`).
 */
export function remoteSpecFor(server: UserMcpServer, deadlines: { requestTimeoutMs?: number; handshakeTimeoutMs?: number } = {}): RemoteMcpServerSpec {
  return {
    id: server.id,
    url: server.url ?? '',
    ...(Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
    ...deadlines,
  }
}
