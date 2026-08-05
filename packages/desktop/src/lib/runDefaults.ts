// What a desktop run costs by default — and why those exact numbers.
//
// The engine deliberately has no default context budget and no default spend ceiling.
// That is correct for a library: a limit invented inside `runTask` would truncate
// somebody's long legitimate task, and a retrieval default would add tokens to every
// request made by every caller, including ones scoring evals. See the notes on
// `RunTaskDeps.budget` and the `run` method's opt-in retrieval.
//
// A desktop app is the opposite situation. It is a surface with one human in front of
// it, spending that human's money, and both engine defaults are wrong here:
//
//   * With no context budget, a desktop run sends the prompt and no repository. The
//     whole retrieval engine sits behind a parameter nobody passes, and the model is
//     asked to change code it was never shown.
//   * With no spend ceiling, one looping run on a frontier model is an unbounded bill
//     that the user finds out about from their invoice.
//
// So the defaults live HERE, in the surface, as one exported authority that the run
// path and its tests both read. Nothing about the engine's contracts changed.

import type { RunOptions } from './client'

/**
 * Retrieval and spend defaults applied to a desktop run.
 *
 * These are DEFAULTS, not policy: an explicit option on a `run` call overrides any of
 * them, and the engine still refuses a malformed one rather than repairing it.
 */
export const DESKTOP_RUN_DEFAULTS = {
  /**
   * Tokens of retrieved repository context per run.
   *
   * Enough for roughly a dozen ranked chunks, which is the difference between "fix the
   * retry bug" reaching the model with the retry code and reaching it with nothing. Kept
   * well under a small model's window, because the context share has to leave room for
   * the conversation, the skills, and `AGENTS.md`. No graph on disk means no retrieval
   * and a logged reason, so this costs nothing on an unindexed project.
   */
  contextBudgetTokens: 6_000,

  /**
   * The spend ceiling for one desktop run.
   *
   * `maxCalls` is the ceiling that actually catches the failure this exists for. A
   * runaway loop is a call count, not a token count: forty model calls is far more than
   * any single chat task needs and far less than an unattended loop will make.
   *
   * `maxTokens` is the dependable backstop because it works for every provider,
   * including local and unpriced ones that contribute nothing a price table can see.
   *
   * `maxUsd` is last on purpose. It cannot constrain a model that is not in the price
   * table, so it is a convenience for priced providers rather than the real guard.
   *
   * `onBreach: 'stop'` because the desktop configures no cheap router. A `downgrade`
   * with nowhere to go falls back to stopping anyway, and claiming otherwise here would
   * be a ceiling that reads as if it keeps working.
   */
  budget: {
    maxCalls: 40,
    maxTokens: 250_000,
    maxUsd: 2,
    onBreach: 'stop',
  },

  /**
   * Write what each finished run established into the project's memory.
   *
   * On for the desktop and off in the engine, for the same reason the other two defaults
   * are: the engine serves the eval harness, which scores thousands of runs whose plans and
   * verify outcomes are fixture noise, and it must not write to anybody's repository as a
   * side effect of being called. A desktop run is a person working on their own project,
   * and "each project gets smarter as you work on it" is not true unless something writes.
   *
   * What gets written is narrow and derived, never summarised or model-generated, and it is
   * keyed so a later run supersedes the earlier one instead of accumulating duplicates. It
   * lands in the project's own memory log, which is append-only and reviewable in the
   * Memory panel.
   */
  rememberRun: true,
} as const satisfies Pick<RunOptions, 'contextBudgetTokens' | 'budget' | 'rememberRun'>

/**
 * Apply the desktop defaults under any explicit choices the caller made.
 *
 * Spread order is the whole point: `overrides` wins, so a surface that wants an
 * unindexed or differently-bounded run says so and is obeyed.
 */
export function withDesktopRunDefaults(overrides: RunOptions = {}): RunOptions {
  return {
    contextBudgetTokens: DESKTOP_RUN_DEFAULTS.contextBudgetTokens,
    budget: { ...DESKTOP_RUN_DEFAULTS.budget },
    rememberRun: DESKTOP_RUN_DEFAULTS.rememberRun,
    ...overrides,
  }
}
