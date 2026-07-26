// Plan artifact writer — the plan gate's storage primitive.
//
// Planning-first is always on. The plan artifact existing on disk is a HARD
// precondition for any file edit (Requirements 6.1–6.5), and the gate is
// enforced in the engine so a CLI-driven run cannot bypass it. That is why the
// artifact is a real directory under `<baseDir>/.sketch/plan/<runId>/` and not an
// in-memory flag: the loop asks the filesystem, not itself.
//
// ---------------------------------------------------------------------------
// RESOLVING THE 4-KEY ACTION vs THE 12-DOCUMENT LAYOUT
// ---------------------------------------------------------------------------
// The `.sketch/` layout in the design specifies twelve documents:
//
//   prd.md stories.md architecture.md folders.md components.md api.md
//   schema.md security.md tests.md milestones.md risks.md dependencies.md
//
// The model's `plan` action carries only four, under abbreviated names:
//
//   { "action": "plan", "artifacts": { "prd": "...", "arch": "...",
//                                      "schema": "...", "tests": "..." } }
//
// Two decisions reconcile them:
//
// 1. ALIASES. `artifacts` accepts any subset of the twelve documents under either
//    its canonical id or a documented alias (`arch` → architecture.md, `db` →
//    schema.md, and so on — see ALIASES below). Lookup is normalized: case,
//    separators, and a trailing `.md` are all ignored, so `userStories`,
//    `user_stories`, and `stories.md` are the same document. A key that resolves
//    to nothing is IGNORED and reported back in `ignored` (and in the
//    `plan_written` payload) rather than becoming a filename — model-supplied
//    keys must never reach the path layer.
//
// 2. UNSUPPLIED DOCUMENTS ARE OMITTED, NOT STUBBED. Requirement 6.4 states the
//    gate in terms of the directory being "absent or empty", so the definition of
//    empty has to be unambiguous. Writing placeholder stubs for the eight
//    documents a `plan` action never supplies would make an EMPTY plan
//    (`artifacts: {}`) structurally identical to a real one — twelve files
//    either way — which forces `hasPlan` to sniff for stub markers inside file
//    bodies. A content heuristic guarding a security-relevant precondition is
//    exactly the wrong trade: a stub marker that drifts, or a model that echoes
//    it, silently opens the gate. With omission the invariant is flat:
//
//        a document file exists  ⟺  that document was planned
//
//    "Not yet planned" is therefore readable from the directory listing itself,
//    which is what a later phase needs anyway (`missing(runId)` returns it
//    directly). `PLAN_DOCUMENTS` remains the canonical twelve so a caller can
//    render the full checklist without the writer fabricating content.
//
// Validates: Requirements 6.1, 6.2, 6.3
//
// The loop-side enforcement of this gate (refusing `edit`, emitting
// `edit_rejected`) is task 1.10 and deliberately lives elsewhere; this module is
// the primitive that task calls.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { EventStore } from "../events/store.js";

/**
 * The canonical twelve plan documents, in the order the design lists them.
 * Covers product requirements, user stories, architecture, folder structure,
 * component tree, API contracts, database schema, security review, test plan,
 * milestones, risks, and dependencies (Requirement 6.2).
 */
export const PLAN_DOCUMENTS = [
  "prd",
  "stories",
  "architecture",
  "folders",
  "components",
  "api",
  "schema",
  "security",
  "tests",
  "milestones",
  "risks",
  "dependencies",
] as const;

/** A canonical plan document id. `prd` is written as `prd.md`. */
export type PlanDocument = (typeof PLAN_DOCUMENTS)[number];

/**
 * Accepted spellings for each document, over and above its canonical id. The
 * `plan` action's `arch` lives here; the rest cover the obvious synonyms a model
 * reaches for. Matching is normalized (see `normalizeKey`), so only the shape of
 * the word matters, not its casing or separators.
 */
const ALIASES: Readonly<Record<string, PlanDocument>> = {
  // prd.md
  prd: "prd",
  requirements: "prd",
  productrequirements: "prd",
  product: "prd",
  // stories.md
  stories: "stories",
  userstories: "stories",
  story: "stories",
  // architecture.md
  architecture: "architecture",
  arch: "architecture",
  design: "architecture",
  // folders.md
  folders: "folders",
  folder: "folders",
  folderstructure: "folders",
  structure: "folders",
  tree: "folders",
  // components.md
  components: "components",
  component: "components",
  componenttree: "components",
  // api.md
  api: "api",
  apis: "api",
  apicontracts: "api",
  contracts: "api",
  // schema.md
  schema: "schema",
  db: "schema",
  database: "schema",
  databaseschema: "schema",
  data: "schema",
  // security.md
  security: "security",
  securityreview: "security",
  threatmodel: "security",
  // tests.md
  tests: "tests",
  test: "tests",
  testplan: "tests",
  testing: "tests",
  // milestones.md
  milestones: "milestones",
  milestone: "milestones",
  roadmap: "milestones",
  // risks.md
  risks: "risks",
  risk: "risks",
  // dependencies.md
  dependencies: "dependencies",
  deps: "dependencies",
  dependency: "dependencies",
} as const;

/**
 * Case-, separator-, and extension-insensitive key normalization.
 * `"User_Stories.md"` → `"userstories"`.
 */
function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Resolve any accepted spelling to its canonical document, or null. */
export function resolveDocument(key: string): PlanDocument | null {
  return ALIASES[normalizeKey(key)] ?? null;
}

/** The file name a document is stored under. */
export function documentFile(doc: PlanDocument): string {
  return `${doc}.md`;
}

/** What a `plan` action supplies: any subset, canonical ids or aliases. */
export type PlanArtifacts = Readonly<Record<string, unknown>>;

export interface PlanWriteResult {
  /** Absolute path of `<baseDir>/.sketch/plan/<runId>/`. */
  dir: string;
  /** File names written by this call, in canonical document order. */
  files: string[];
  /** Canonical documents written by this call, in canonical order. */
  documents: PlanDocument[];
  /** Supplied keys that matched no document and were therefore not written. */
  ignored: string[];
}

export interface PlanWriterOptions {
  /** Project root. Plans land in `<baseDir>/.sketch/plan/<runId>/`. */
  baseDir: string;
  /** Optional event store. When absent the writer is silent. */
  events?: Pick<EventStore, "emit">;
  /** Override the plan root outright, bypassing the `.sketch/plan` convention. */
  planRoot?: string;
}

/**
 * Thrown when a runId cannot be used as a directory name. A runId is minted
 * internally today, but `planDir` is a path-construction site and the value will
 * eventually arrive over the CLI protocol, so traversal is treated as a live
 * risk rather than a theoretical one.
 */
export class InvalidRunIdError extends Error {
  constructor(readonly runId: string, reason: string) {
    super(`invalid runId ${JSON.stringify(runId)}: ${reason}`);
    this.name = "InvalidRunIdError";
  }
}

/** Longest runId we will turn into a directory name. */
const MAX_RUN_ID_LENGTH = 128;

/** Characters a runId may contain. Everything else is rejected outright. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

/** Windows device names, which are unusable as file names on that platform. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Allow-list validation. Rejecting is deliberately preferred over escaping: a
 * sanitized-by-rewriting runId would no longer match the id in the event log, so
 * two different runs could collapse onto one plan directory and one of them
 * would pass a gate it never earned.
 */
export function assertSafeRunId(runId: string): string {
  if (typeof runId !== "string" || runId === "") {
    throw new InvalidRunIdError(String(runId), "must be a non-empty string");
  }
  if (runId.length > MAX_RUN_ID_LENGTH) {
    throw new InvalidRunIdError(runId, `must be at most ${MAX_RUN_ID_LENGTH} characters`);
  }
  if (runId !== runId.trim()) {
    throw new InvalidRunIdError(runId, "must not have leading or trailing whitespace");
  }
  if (runId.includes("/") || runId.includes("\\")) {
    throw new InvalidRunIdError(runId, "must not contain a path separator");
  }
  if (runId.includes("..")) {
    throw new InvalidRunIdError(runId, "must not contain '..'");
  }
  if (isAbsolute(runId) || /^[A-Za-z]:/.test(runId)) {
    throw new InvalidRunIdError(runId, "must not be an absolute path");
  }
  if (!SAFE_RUN_ID.test(runId)) {
    throw new InvalidRunIdError(
      runId,
      "may contain only letters, digits, '.', '-' and '_'",
    );
  }
  if (runId === "." || runId.endsWith(".")) {
    throw new InvalidRunIdError(runId, "must not be or end with '.'");
  }
  if (WINDOWS_RESERVED.test(runId)) {
    throw new InvalidRunIdError(runId, "is a reserved device name");
  }
  return runId;
}

/** Whitespace-only content is empty content. */
function isBlank(text: string): boolean {
  return text.trim() === "";
}

/**
 * Writes and reads the per-run plan artifact, and answers the gate question.
 *
 * Filesystem access is limited to `node:fs/promises`; path building to
 * `node:path`. No runtime dependency, per the core's zero-dependency rule.
 */
export class PlanWriter {
  readonly #root: string;
  readonly #events: Pick<EventStore, "emit"> | undefined;

  constructor(options: PlanWriterOptions) {
    this.#root = resolve(options.planRoot ?? join(options.baseDir, ".sketch", "plan"));
    this.#events = options.events;
  }

  /** The plan root: `<baseDir>/.sketch/plan`. */
  get root(): string {
    return this.#root;
  }

  /**
   * Resolved plan directory for a run. Exported so a caller can show the path to
   * the user and so the loop can name it in a refusal.
   *
   * Throws `InvalidRunIdError` for anything that could escape the plan root.
   */
  planDir(runId: string): string {
    const safe = assertSafeRunId(runId);
    const dir = resolve(join(this.#root, safe));
    // Defence in depth: even with the allow-list above, never hand back a path
    // that is not strictly inside the plan root.
    if (dir !== this.#root && !dir.startsWith(this.#root + sep)) {
      throw new InvalidRunIdError(runId, "resolves outside the plan directory");
    }
    if (dir === this.#root) {
      throw new InvalidRunIdError(runId, "resolves to the plan root itself");
    }
    return dir;
  }

  /**
   * Write the supplied documents to `<baseDir>/.sketch/plan/<runId>/`, then emit
   * `plan_written` carrying the directory path and the file list (Requirements
   * 6.1, 6.3). One call emits exactly one event.
   *
   * Semantics on a repeat write for the same runId: UPSERT. A supplied document
   * overwrites its previous content; a document written by an earlier call and
   * not supplied again is left in place. That lets a plan be filled in over
   * several turns without a later, narrower `plan` action erasing what the run
   * already committed to — and it keeps the gate monotonic, which matters
   * because the gate is a safety precondition.
   */
  async write(runId: string, artifacts: PlanArtifacts): Promise<PlanWriteResult> {
    const dir = this.planDir(runId);

    const resolved = new Map<PlanDocument, string>();
    const ignored: string[] = [];
    for (const [key, value] of Object.entries(artifacts ?? {})) {
      const doc = resolveDocument(key);
      if (doc === null) {
        ignored.push(key);
        continue;
      }
      // Later spellings of the same document win, matching object key order.
      resolved.set(doc, stringifyContent(value));
    }

    await mkdir(dir, { recursive: true });

    const documents: PlanDocument[] = [];
    const files: string[] = [];
    // Canonical order, so the result and the event payload are deterministic.
    for (const doc of PLAN_DOCUMENTS) {
      if (!resolved.has(doc)) continue;
      const file = documentFile(doc);
      await writeFile(join(dir, file), resolved.get(doc)!, "utf8");
      documents.push(doc);
      files.push(file);
    }

    await this.#events?.emit({
      runId,
      kind: "plan_written",
      payload: {
        dir,
        files,
        documents,
        ...(ignored.length > 0 ? { ignored } : {}),
      },
    });

    return { dir, files, documents, ignored };
  }

  /**
   * THE GATE (Requirements 6.4, 6.5). True only when the plan directory exists
   * AND holds at least one document with non-whitespace content.
   *
   * False for: a missing directory, an existing but empty directory, and a
   * directory whose every document is empty or whitespace-only. Scoped strictly
   * per runId — the answer is derived from that run's own directory, so a written
   * plan for run A tells you nothing about run B.
   */
  async hasPlan(runId: string): Promise<boolean> {
    let dir: string;
    try {
      dir = this.planDir(runId);
    } catch {
      // An unusable runId has no plan. The gate stays shut.
      return false;
    }

    for (const file of await this.#listDocuments(dir)) {
      try {
        if (!isBlank(await readFile(join(dir, file), "utf8"))) return true;
      } catch {
        // Unreadable file: cannot count as a plan.
      }
    }
    return false;
  }

  /**
   * The documents written for a run, keyed by canonical id. Absent documents are
   * simply absent from the record, so the Timeline and a resumed run can show
   * exactly what was planned and `missing` covers the rest.
   */
  async readPlan(runId: string): Promise<Partial<Record<PlanDocument, string>>> {
    let dir: string;
    try {
      dir = this.planDir(runId);
    } catch {
      return {};
    }

    const out: Partial<Record<PlanDocument, string>> = {};
    const present = new Set(await this.#listDocuments(dir));
    for (const doc of PLAN_DOCUMENTS) {
      const file = documentFile(doc);
      if (!present.has(file)) continue;
      try {
        out[doc] = await readFile(join(dir, file), "utf8");
      } catch {
        // Skip a document that disappeared between listing and reading.
      }
    }
    return out;
  }

  /** Canonical documents not yet written for this run. */
  async missing(runId: string): Promise<PlanDocument[]> {
    const written = await this.readPlan(runId);
    return PLAN_DOCUMENTS.filter((doc) => written[doc] === undefined);
  }

  /** Known plan document files present in `dir`. Missing directory reads as empty. */
  async #listDocuments(dir: string): Promise<string[]> {
    const known = new Set<string>(PLAN_DOCUMENTS.map(documentFile));
    try {
      return (await readdir(dir)).filter((f) => known.has(f));
    } catch {
      return [];
    }
  }
}

/**
 * Coerce a supplied artifact value to markdown. A model that hands back an array
 * of bullet lines or a nested object is common enough that failing the whole plan
 * over it would be worse than writing a faithful rendering of what it sent.
 */
function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyContent).join("\n");
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
