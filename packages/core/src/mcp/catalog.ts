// The curated MCP catalog: pinned, isolated, and off until asked for.
//
// ── CURATED MEANS THE LIST IS DATA IN THIS REPOSITORY ──────────────────────
//
// Requirement 22.2 asks for a registry that is "curated, pinned, and isolated rather
// than exposing arbitrary servers". So this file is a table, committed and reviewable,
// and there is deliberately NO code path that resolves a server name into a command
// at runtime. A user who wants something not on this list adds it here, in a diff,
// where the argv and the capability it costs are both visible.
//
// ── PINNED MEANS A VERSION, NOT `latest` ───────────────────────────────────
//
// Every entry names an exact version. `npx some-server@latest` means the command that
// ran yesterday is not the command that runs today, and a supply-chain compromise
// arrives silently on the next invocation. `@latest` is not permitted here and
// `mcp.test.ts` asserts that.
//
// ── OFF UNTIL ASKED FOR ────────────────────────────────────────────────────
//
// Nothing in this table starts by itself. An entry is a DESCRIPTION of a server that
// could be started, with the capability it would need; starting it takes an explicit
// grant plus a caller that asks. Most entries also need credentials the user has to
// supply, and `requiresEnv` names them so a surface can say what is missing instead
// of failing with an opaque handshake error.
//
// ── THE CAPABILITY IS THE POINT ────────────────────────────────────────────
//
// Each server declares the ONE capability its tools cost, from the Phase 6 vocabulary.
// `ToolDispatcher` checks it before any call (`capabilities/guard.ts`), so a skill
// granted only `fs:read:project` cannot reach the GitHub server whatever the model
// asks for. Servers that would need two different kinds of access are listed with the
// broader one, because a grant a user cannot reason about is a grant they cannot give.
//
// Validates: Requirements 22.2, 22.4

import { isCapability, type Capability } from '../capabilities/index.js'

/** How a server is launched. Argv only — there is no command string anywhere. */
export interface McpLaunch {
  command: string
  args: string[]
}

export interface McpCatalogEntry {
  /** Stable id. Used in grants, denials, and the surface. */
  id: string
  title: string
  /** One line: what its tools do. */
  summary: string
  /** The capability every tool on this server costs. */
  requires: Capability
  /** Exact launch argv. Pinned; never `latest`. */
  launch: McpLaunch
  /** Environment variables the server needs to work at all. */
  requiresEnv?: string[]
  /**
   * Why this server is riskier than its capability alone suggests, when it is.
   * Shown next to a grant prompt.
   */
  caveat?: string
}

/**
 * The pinned catalog.
 *
 * Requirement 22.2 names fourteen: GitHub, Docker, Figma, Notion, Slack, terminal,
 * browser, filesystem, SSH, Cloudflare, Supabase, databases, an Android emulator, and
 * Playwright. All fourteen are here.
 *
 * HONESTY NOTE, and it matters: these are launch descriptions, not vendored software.
 * The packages are third-party and are fetched by the user's own package manager when
 * a server is first started, which means (a) starting one is a network act the user
 * has to have asked for, and (b) this project has NOT audited their contents. What is
 * pinned is the version, so what runs is at least reproducible and reviewable. The
 * hash verification that `registry/` applies to skills cannot be applied here without
 * vendoring the servers, and that is recorded as an open gap rather than implied to be
 * solved.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = Object.freeze([
  {
    id: 'filesystem',
    title: 'Filesystem',
    summary: 'Read and write files under an explicitly allowed directory.',
    // The server is given one root and cannot see outside it, but write is write.
    requires: 'fs:write:project',
    launch: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@0.6.2'],
    },
    caveat:
      'The allowed directory is passed as an argument at launch. Pass the project root ' +
      'and nothing above it: this server can write anywhere it is pointed.',
  },
  {
    id: 'terminal',
    title: 'Terminal',
    summary: 'Run shell commands in the project.',
    requires: 'proc:spawn',
    launch: { command: 'npx', args: ['-y', 'mcp-server-commands@1.1.0'] },
    caveat:
      'A command runner is not bounded by the capability that opened it: anything it ' +
      'starts runs with your permissions. Prefer the built-in scoped terminal, which ' +
      'has a confirmation gate and a contained working directory.',
  },
  {
    id: 'git',
    title: 'Git',
    summary: 'Read history, diffs, and blame for a local repository.',
    requires: 'git:read',
    launch: { command: 'uvx', args: ['mcp-server-git@0.6.2'] },
  },
  {
    id: 'github',
    title: 'GitHub',
    summary: 'Issues, pull requests, and repository contents over the GitHub API.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@0.6.2'] },
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    caveat:
      'The token\u2019s scopes are the real boundary, not this capability. A token with ' +
      'write access lets this server push.',
  },
  {
    id: 'docker',
    title: 'Docker',
    summary: 'List, inspect, and manage containers and images.',
    requires: 'proc:spawn',
    launch: { command: 'uvx', args: ['docker-mcp@0.2.0'] },
    caveat:
      'Access to the Docker socket is effectively root on the host: a container can ' +
      'mount any path. Grant this only to a skill you would give administrator rights.',
  },
  {
    id: 'playwright',
    title: 'Playwright',
    summary: 'Drive a real browser: navigate, click, read the page, capture console output.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.41'] },
    caveat:
      'Downloads browser binaries on first use, and can reach any site the machine can. ' +
      'For verifying a local app, point it at localhost and nothing else.',
  },
  {
    id: 'browser',
    title: 'Browser (fetch)',
    summary: 'Fetch a URL and read it as text or markdown, without a full browser.',
    requires: 'net:http',
    launch: { command: 'uvx', args: ['mcp-server-fetch@0.6.2'] },
  },
  {
    id: 'ssh',
    title: 'SSH',
    summary: 'Run commands on a remote host over SSH.',
    requires: 'proc:spawn',
    launch: { command: 'npx', args: ['-y', 'mcp-server-ssh@0.1.4'] },
    requiresEnv: ['SSH_HOST', 'SSH_USER'],
    caveat:
      'This reaches machines that are not yours to break. It also reads your SSH agent ' +
      'or key files, so a skill with this can act as you on every host you can reach.',
  },
  {
    id: 'postgres',
    title: 'Databases (Postgres)',
    summary: 'Inspect schemas and run read-only queries against a Postgres database.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres@0.6.2'] },
    requiresEnv: ['POSTGRES_CONNECTION_STRING'],
    caveat:
      'The connection string carries a credential. Point it at a development database: ' +
      '"read-only" is the server\u2019s intent, not a guarantee the database enforces.',
  },
  {
    id: 'supabase',
    title: 'Supabase',
    summary: 'Query and manage a Supabase project.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@0.4.5'] },
    requiresEnv: ['SUPABASE_ACCESS_TOKEN'],
    caveat: 'A management token can create and destroy projects, not only read rows.',
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare',
    summary: 'Workers, KV, R2, and DNS for a Cloudflare account.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', '@cloudflare/mcp-server-cloudflare@1.4.0'] },
    requiresEnv: ['CLOUDFLARE_API_TOKEN'],
    caveat: 'DNS and Workers changes are live the moment they are made.',
  },
  {
    id: 'notion',
    title: 'Notion',
    summary: 'Read and update pages and databases in a Notion workspace.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server@1.8.1'] },
    requiresEnv: ['NOTION_TOKEN'],
  },
  {
    id: 'slack',
    title: 'Slack',
    summary: 'Read channels and post messages in a Slack workspace.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack@0.6.2'] },
    requiresEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    caveat: 'Posting is visible to other people and cannot be undone quietly.',
  },
  {
    id: 'figma',
    title: 'Figma',
    summary: 'Read a Figma file\u2019s layout, styles, and components.',
    requires: 'net:http',
    launch: { command: 'npx', args: ['-y', 'figma-developer-mcp@0.4.2'] },
    requiresEnv: ['FIGMA_API_KEY'],
  },
  {
    id: 'android',
    title: 'Android emulator',
    summary: 'Control an Android emulator: install, launch, tap, screenshot.',
    requires: 'proc:spawn',
    launch: { command: 'npx', args: ['-y', '@mobilenext/mobile-mcp@0.0.25'] },
    caveat: 'Drives adb, which can install and remove applications on any attached device.',
  },
])

/** Look one up. Returns null rather than throwing: an unknown id is a denial. */
export function findCatalogEntry(id: string): McpCatalogEntry | null {
  return MCP_CATALOG.find((entry) => entry.id === id) ?? null
}

/** Catalog ids, sorted. */
export function catalogIds(): string[] {
  return MCP_CATALOG.map((entry) => entry.id).sort()
}

/**
 * Environment variables an entry needs that the given environment does not have.
 *
 * The VALUES are never read here, only the presence of the names — this returns what
 * is missing so a surface can ask for it, and it must not become a place a token is
 * copied through.
 */
export function missingEnv(entry: McpCatalogEntry, env: NodeJS.ProcessEnv): string[] {
  return (entry.requiresEnv ?? []).filter((name) => {
    const value = env[name]
    return typeof value !== 'string' || value.trim() === ''
  })
}


function mcpEntryKey(entry: McpCatalogEntry): string {
  return JSON.stringify(entry)
}

function validateMcpEntry(candidate: McpCatalogEntry): McpCatalogEntry {
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('MCP catalog entry must be an object')
  }
  if (typeof candidate.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(candidate.id)) {
    throw new Error(`invalid MCP id ${JSON.stringify(candidate.id)}`)
  }
  if (
    typeof candidate.title !== 'string' || candidate.title.trim() === '' ||
    typeof candidate.summary !== 'string' || candidate.summary.trim() === ''
  ) {
    throw new Error(`MCP entry ${candidate.id} needs a title and summary`)
  }
  if (!isCapability(candidate.requires)) {
    throw new Error(`MCP entry ${candidate.id} has unrecognized capability ${String(candidate.requires)}`)
  }
  if (candidate.launch === null || typeof candidate.launch !== 'object') {
    throw new Error(`MCP entry ${candidate.id} needs a launch description`)
  }
  const { command, args } = candidate.launch
  if (typeof command !== 'string' || command.trim() === '' || /\s|[;&|<>]/.test(command)) {
    throw new Error(`MCP entry ${candidate.id} launch.command must be one executable, not a shell string`)
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || /(?:^|\s)(?:&&|\|\||;)(?:\s|$)/.test(arg))) {
    throw new Error(`MCP entry ${candidate.id} launch.args must be an argv array without shell operators`)
  }
  if (args.some((arg) => /@latest(?:$|\s)/.test(arg)) || !args.some((arg) => /@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(arg))) {
    throw new Error(`MCP entry ${candidate.id} must pin an exact package version in argv`)
  }
  if (candidate.requiresEnv !== undefined && !Array.isArray(candidate.requiresEnv)) {
    throw new Error(`MCP entry ${candidate.id} requiresEnv must be an array`)
  }
  const requiresEnv = candidate.requiresEnv ?? []
  for (const name of requiresEnv) {
    if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`MCP entry ${candidate.id} has invalid required env name ${String(name)}`)
    }
  }
  if (candidate.caveat !== undefined && (typeof candidate.caveat !== 'string' || candidate.caveat.trim() === '')) {
    throw new Error(`MCP entry ${candidate.id} caveat must be non-empty when present`)
  }
  return Object.freeze({
    ...candidate,
    launch: Object.freeze({ command, args: Object.freeze([...args]) }) as McpLaunch,
    ...(requiresEnv.length > 0 ? { requiresEnv: Object.freeze([...new Set(requiresEnv)]) as string[] } : {}),
  })
}

/** Immutable curated catalog plus validated host-supplied entries. */
export class McpCatalogRegistry {
  readonly #entries = new Map<string, McpCatalogEntry>()

  constructor(entries: readonly McpCatalogEntry[] = []) {
    for (const entry of MCP_CATALOG) this.#entries.set(entry.id, entry)
    for (const candidate of entries) {
      const entry = validateMcpEntry(candidate)
      const existing = this.#entries.get(entry.id)
      if (existing !== undefined) {
        if (mcpEntryKey(existing) === mcpEntryKey(entry)) continue
        throw new Error(`conflicting MCP catalog entry: ${entry.id}`)
      }
      this.#entries.set(entry.id, entry)
    }
  }

  list(): readonly McpCatalogEntry[] { return [...this.#entries.values()] }
  find(id: string): McpCatalogEntry | null { return this.#entries.get(id) ?? null }
  ids(): string[] { return [...this.#entries.keys()].sort() }

  /**
   * A copy that also holds the user's own servers (`mcp/userServers.ts`), for one run.
   *
   * Their launch is the user's own choice, so the pinned-version rule does not apply
   * to them. The rest still does: one program and an argv array, a `user-` id that
   * cannot shadow a curated entry, and the honest capability for a program, `proc:spawn`.
   */
  withUserServers(entries: readonly McpCatalogEntry[]): McpCatalogRegistry {
    const next = new McpCatalogRegistry()
    for (const [id, entry] of this.#entries) next.#entries.set(id, entry)
    for (const entry of entries) {
      if (!/^user-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) throw new Error(`invalid user MCP id ${JSON.stringify(entry.id)}`)
      if (next.#entries.has(entry.id)) throw new Error(`user MCP server ${entry.id} is listed twice`)
      if (entry.requires !== 'proc:spawn') throw new Error(`user MCP server ${entry.id} must cost proc:spawn`)
      const { command, args } = entry.launch
      if (typeof command !== 'string' || command.trim() === '' || /[;&|<>`$]/.test(command)) {
        throw new Error(`user MCP server ${entry.id} launch.command must be one program`)
      }
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new Error(`user MCP server ${entry.id} launch.args must be an array of strings`)
      }
      next.#entries.set(entry.id, Object.freeze({ ...entry, launch: Object.freeze({ command, args: Object.freeze([...args]) as string[] }) }))
    }
    return next
  }
}
