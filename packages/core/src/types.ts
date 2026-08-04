// Canonical contracts for @sketch/core.
//
// This file is THE contract. It is reproduced verbatim from the "Core contracts"
// section of .kiro/specs/sketch-engineering-os/design.md. Every type here is
// serializable — no classes, no functions on data, no non-JSON values.
//
// Changing anything in this file requires a spec update first. Do not extend,
// reorder, or "improve" these declarations locally.
//
// Naming note: `VerifyResult` and `RunResult` below once had to share the module
// namespace with a pre-existing verifier aggregate and orchestrator result, which
// were renamed `VerifySummary` and `OrchestratorRunResult` to get out of the way.
// Both of those types are now deleted along with the legacy `verifier/` and the
// legacy orchestrator state machine, so the canonical names have no rivals.

// ── WHY SOME KINDS EXIST AND SOME DISCRIMINATORS REMAIN ─────────────────────
//
// Six kinds below (`repo_indexed`, `context_retrieved`, `embedder_degraded`,
// `model_selected`, `skill_trained`, `ask`) were added in one spec-approved
// change. Before it, each of those facts was carried by an unrelated kind plus a
// `component` payload discriminator, so a Timeline consumer had to read the
// payload to know what it was looking at. The rule applied, and the rule to keep
// applying: a DISTINCT SUBSYSTEM reporting a DISTINCT FACT gets a kind; a
// variant of the same fact does not.
//
// Deliberately still discriminated by `component`, because they are the same
// fact from different places:
//
//   * `context_assembled` — `assembly` (the budgeted assembly step, `primary:
//     true`) and `agent-loop` (the loop's message-count breadcrumb). Both say
//     "the context for this turn is now fixed"; they differ in fidelity.
//   * `tool_called` / `tool_denied` — `mcp` and `registry`. A tool is a tool;
//     `component` names which provider ran or refused it.
//   * `strategy_selected` — `dispatcher` only, now that the cost router has
//     `model_selected`. The discriminator stays because logs written before this
//     change carry router events under this kind, and consumers that check it
//     keep reading those old lines correctly.
//   * `diagram_updated` — `architecture` is its only emitter; the key is
//     provenance, not a discriminator.
//
// `ask_answered` is a DISTINCT FACT from `ask`, not a variant of it, so it gets a
// kind rather than an `answered: true` payload key on `ask`. `ask` says the run
// stopped needing a human; `ask_answered` says a human supplied an answer and the
// run resumed — different causes, different actors, and a Timeline must be able to
// tell "nobody ever answered" from "somebody did" without reading a payload.
//
// `context_loaded` is retained with no emitter. It is part of the published
// contract and logs on disk contain it.
export type EventKind =
  | "run_started" | "plan_written" | "skill_loaded" | "context_loaded" | "context_assembled"
  | "repo_indexed" | "context_retrieved" | "embedder_degraded"
  | "llm_request" | "llm_response" | "think" | "ask" | "ask_answered"
  | "verify_started" | "verify_result"
  | "edit_proposed" | "edit_accepted" | "edit_rejected"
  | "tool_called" | "tool_denied"
  | "budget_exceeded" | "cache_hit" | "strategy_selected" | "model_selected"
  | "memory_retrieved" | "memory_superseded" | "diagram_updated"
  | "skill_trained"
  | "run_completed" | "run_failed" | "eval_scored";

export interface SketchEvent { id: string; ts: number; runId: string; kind: EventKind; payload: Record<string, unknown>; }
export interface Skill { name: string; description: string; body: string; source: string; capabilities?: string[]; }
export interface ProjectContext { agents: string; claude: string; }
export interface Message { role: "system" | "user" | "assistant" | "tool"; content: string; }
export interface Usage { in: number; out: number; }
export interface ChatAdapter {
  readonly id: string;
  /**
   * The model this adapter will actually call.
   *
   * OPTIONAL, so every existing test double still satisfies the seam. But cost cannot
   * be attributed without it — `id` is the provider, and one provider serves models
   * whose prices differ by a factor of sixteen — so an adapter that omits it produces
   * `llm_response` events the ledger has to report as UNPRICED rather than as free.
   */
  readonly model?: string;
  chat(m: Message[], o?: { signal?: AbortSignal }): Promise<{ text: string; usage?: Usage }>;
}
export type ProviderKind = "openai-compatible" | "anthropic-messages";
export interface ProviderConfig {
  id: string; kind: ProviderKind; baseUrl: string; model: string;
  apiKey?: string; headers?: Record<string, string>;
}
export interface VerifyCommand { name: string; cmd: string; args?: string[]; cwd?: string; timeoutMs?: number; }
export interface VerifyResult { name: string; ok: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number; }
export interface Task { id: string; prompt: string; verify: VerifyCommand[]; skillNames?: string[]; }
export interface RunResult { runId: string; ok: boolean; finalText: string; iterations: number; verify: VerifyResult[]; events: SketchEvent[]; }
export type Check = { kind: "verify-pass" } | { kind: "contains"; text: string } | { kind: "not-contains"; text: string };
export interface EvalCase { id: string; task: Task; checks: Check[]; }
export interface EvalResult { caseId: string; score: number; passed: boolean; passedChecks: number; totalChecks: number; detail: string; }
export interface SecretStore { get(id: string): Promise<string | null>; set(id: string, v: string): Promise<void>; del(id: string): Promise<void>; }
