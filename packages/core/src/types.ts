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

export type EventKind =
  | "run_started" | "plan_written" | "skill_loaded" | "context_loaded" | "context_assembled"
  | "llm_request" | "llm_response" | "think"
  | "verify_started" | "verify_result"
  | "edit_proposed" | "edit_accepted" | "edit_rejected"
  | "tool_called" | "tool_denied"
  | "budget_exceeded" | "cache_hit" | "strategy_selected"
  | "memory_retrieved" | "memory_superseded" | "diagram_updated"
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
