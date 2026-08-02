// The host: catalog entries → running servers → `ToolDescriptor`s the dispatcher owns.
//
// ── WHERE AUTHORISATION HAPPENS, AND WHERE IT DOES NOT ─────────────────────
//
// It happens in `ToolDispatcher.call` and nowhere else (`capabilities/guard.ts`). This
// file's whole job is to produce descriptors that declare what they cost; it does not
// check a grant, and a test asserts it contains no grant consultation. That is the
// same discipline as one `hasPlan` in `runTask` and one `resolve_within` in
// `command_policy.rs` — the fourth time this codebase makes the bet, and the reason it
// keeps working is that there is only ever one place to look.
//
// ── ONE DESCRIPTOR PER MCP TOOL, NAMESPACED ────────────────────────────────
//
// A server advertises its own tool names (`read_file`, `create_issue`). Two servers
// can advertise the same one, so descriptors are named `<server>.<tool>` — the model
// sees which server it is addressing, and a denial can name the pair.
//
// ── LAZY START, AND ONLY WHAT WAS GRANTED ──────────────────────────────────
//
// Nothing is spawned until `open()` is called for a specific server id, and `open()` is
// only reached for a server whose capability the caller actually holds. So a run with a
// read-only grant never starts the Docker server at all — which is stronger than
// starting it and refusing its calls, because a server that is never launched cannot
// do anything.
//
// ── UNAVAILABLE IS CHEAP AFTER THE FIRST TIME ──────────────────────────────
//
// `McpServer` latches itself off after a hang. The descriptor keeps calling the same
// instance, so the second call costs nothing and returns the same reason (Requirement
// 22.3). The run continues either way.
//
// Validates: Requirements 22.1, 22.2, 22.3, 22.4, 22.5

import type { EventInput } from '../events/store.js'
import type { ToolDescriptor, ToolOutcome } from '../capabilities/index.js'
import { McpCatalogRegistry, missingEnv, type McpCatalogEntry } from './catalog.js'
import { McpServer, framePayload, type McpServerSpec } from './client.js'

export interface McpHostOptions {
  /** Project root. Passed to servers as their working directory. */
  root: string
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
  /** Diagnostics sink: stderr on the wire. Never the event log. */
  log?: (message: string) => void
  /** Environment checked for `requiresEnv` and handed to servers. */
  env?: NodeJS.ProcessEnv
  /** Per-request deadline override, mainly for tests. */
  requestTimeoutMs?: number
  handshakeTimeoutMs?: number
  /**
   * Launch override, by server id. A test points an entry at a local script; a user
   * could point one at a vendored copy. The CAPABILITY still comes from the catalog —
   * an override cannot make the Docker server cost less than `proc:spawn`.
   */
  launchOverrides?: Record<string, McpServerSpec>
  /** Curated defaults plus validated externally supplied entries. */
  catalog?: McpCatalogRegistry | readonly McpCatalogEntry[]
  /**
   * Host launch allowlist, computed by the caller at its grant boundary. This is not
   * tool authorization: descriptors still declare costs and ToolDispatcher remains the
   * one authorization point. RPC supplies this defensively so a later call cannot bypass
   * its pre-launch grant check.
   */
  allowedLaunches?: ReadonlySet<string>
}

/** What happened when a server was asked to start. */
export interface McpOpenResult {
  ok: boolean
  id: string
  detail: string
  /** Tool names advertised, namespaced as the dispatcher will see them. */
  tools: string[]
  /** Environment the entry needs and did not find. */
  missingEnv: string[]
}

/**
 * Holds the servers opened for one run.
 *
 * One host per run: the unavailability latch is per-run state by definition
 * (Requirement 22.3 says "for the remainder of the run"), and sharing a host across
 * runs would carry a dead server's verdict into a run that might have worked.
 */
export class McpHost {
  readonly #servers = new Map<string, McpServer>()
  readonly #entries = new Map<string, McpCatalogEntry>()
  readonly #catalog: McpCatalogRegistry

  constructor(private readonly options: McpHostOptions) {
    this.#catalog = options.catalog instanceof McpCatalogRegistry
      ? options.catalog
      : new McpCatalogRegistry(options.catalog)
  }

  /** Server ids currently open, sorted. */
  get openIds(): string[] {
    return [...this.#servers.keys()].sort()
  }

  /**
   * Start one catalog server.
   *
   * Every failure is a result, not a throw: an unknown id, a missing token, a server
   * that will not handshake. A run must survive all three.
   */
  async open(id: string): Promise<McpOpenResult> {
    const existing = this.#servers.get(id)
    if (existing !== undefined) {
      return {
        ok: existing.unavailable === null,
        id,
        detail: existing.unavailable?.detail ?? `${id} is already open`,
        tools: existing.tools.map((tool) => `${id}.${tool.name}`),
        missingEnv: [],
      }
    }

    const entry = this.#catalog.find(id)
    if (entry === null) {
      // Curated: an id not in the table is not startable, full stop.
      return {
        ok: false,
        id,
        detail: `no MCP server named "${id}" in the curated catalog`,
        tools: [],
        missingEnv: [],
      }
    }

    if (this.options.allowedLaunches !== undefined && !this.options.allowedLaunches.has(id)) {
      return {
        ok: false,
        id,
        detail: `${entry.title} was not approved for launch by this host`,
        tools: [],
        missingEnv: [],
      }
    }

    const env = this.options.env ?? process.env
    const missing = missingEnv(entry, env)
    if (missing.length > 0) {
      // Named, so a surface can ask for exactly what is absent rather than showing an
      // opaque handshake failure ten seconds later.
      return {
        ok: false,
        id,
        detail: `${entry.title} needs ${missing.join(', ')} in the environment and it is not set`,
        tools: [],
        missingEnv: missing,
      }
    }

    const override = this.options.launchOverrides?.[id]
    // The host's deadlines are HOST-WIDE defaults and apply to an override too.
    //
    // They used to be spread only into the catalog-derived spec, so supplying an
    // override silently dropped them and every request fell back to the 20-second
    // default. The Phase 7 gate found it: a hang that should have been paid for in
    // 500ms took 20s, and the assertion that a hang cannot wedge a run was passing
    // for the wrong reason. An override says WHERE to launch; it does not say how
    // patient to be, unless it sets a deadline of its own — which still wins.
    const deadlines = {
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
      ...(this.options.handshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: this.options.handshakeTimeoutMs }
        : {}),
    }
    const spec: McpServerSpec =
      override !== undefined
        ? { ...deadlines, ...override }
        : {
            id,
            command: entry.launch.command,
            args: entry.launch.args,
            cwd: this.options.root,
            ...deadlines,
          }

    const server = new McpServer(spec, {
      ...(this.options.events !== undefined ? { events: this.options.events } : {}),
      ...(this.options.runId !== undefined ? { runId: this.options.runId } : {}),
      ...(this.options.log !== undefined ? { log: this.options.log } : {}),
    })
    // Recorded even when the start fails, so a later call gets the latched reason
    // instead of trying to spawn the same broken server again.
    this.#servers.set(id, server)
    this.#entries.set(id, entry)

    const started = await server.start()
    return {
      ok: started.ok,
      id,
      detail: started.detail,
      tools: server.tools.map((tool) => `${id}.${tool.name}`),
      missingEnv: [],
    }
  }

  /**
   * Descriptors for every tool on every open server.
   *
   * Each declares its server's catalog capability — from the CATALOG, never from an
   * override, so pointing a server elsewhere cannot make it cheaper.
   */
  descriptors(): ToolDescriptor[] {
    const out: ToolDescriptor[] = []
    for (const [id, server] of this.#servers) {
      const entry = this.#entries.get(id)
      if (entry === undefined) continue
      for (const tool of server.tools) {
        out.push({
          name: `${id}.${tool.name}`,
          description:
            tool.description === ''
              ? `${entry.title}: ${tool.name}`
              : `${entry.title}: ${tool.description}`,
          requires: entry.requires,
          run: async (args, context): Promise<ToolOutcome> => {
            // `context.runId` is the LOOP's run id, not this host's. Passing it is what
            // puts a latched server's `tool_denied` in the same `forRun(runId)` window
            // as the `tool_called` the dispatcher wrote.
            const result = await server.callTool(tool.name, args, context.runId)
            return {
              ok: result.ok,
              // FRAMED AS DATA, always. A tool result is text from a third-party
              // process, and a result reading "ignore previous instructions" is a
              // string a tool returned.
              output: framePayload(id, tool.name, result.text),
              detail: {
                server: id,
                tool: tool.name,
                ok: result.ok,
                // Requirement 22.5: a failure, and its reason, is visible.
                ...(result.toolError ? { toolError: true } : {}),
                ...(result.transportError !== undefined
                  ? { transportError: result.transportError }
                  : {}),
                ...(result.unrendered.length > 0 ? { unrendered: result.unrendered } : {}),
                durationMs: result.durationMs,
              },
            }
          },
        })
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  /** Status for the surface: what is open, what is broken, and why (22.5). */
  status(): Array<{
    id: string
    title: string
    requires: string
    ok: boolean
    tools: number
    unavailable: string | null
    reason: string | null
    diagnostics: string
  }> {
    return [...this.#servers.entries()]
      .map(([id, server]) => {
        const entry = this.#entries.get(id)
        return {
          id,
          title: entry?.title ?? id,
          requires: entry?.requires ?? 'unknown',
          ok: server.unavailable === null,
          tools: server.tools.length,
          unavailable: server.unavailable?.reason ?? null,
          reason: server.unavailable?.detail ?? null,
          // Kept short: this is for a panel, and the full text is on the server.
          diagnostics: server.diagnostics.slice(-2_000),
        }
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  /** Shut everything down. Safe to call more than once. */
  async close(): Promise<void> {
    await Promise.all([...this.#servers.values()].map((server) => server.close()))
    this.#servers.clear()
  }
}
