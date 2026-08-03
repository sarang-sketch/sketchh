// The scoped-command seam: one interface over the backend's `run_command`.
//
// SAME SHAPE, SAME REASONS AS `FileIo` (src/editor/fileIo.ts). The bridge is a
// Tauri-native capability with no implementation under jsdom, so an interface is
// what lets a test drive the real panel, the real parser and the real state
// transitions against a process double — while production gets the one contained
// path through Rust.
//
// ONE SPAWN PATH, AND ONE CALLER LEFT. The terminal panel runs what the user typed.
// This is the only place the frontend can start a process, and it is the one the
// backend contains: program from the allowlist, arguments as a vector, cwd inside
// the project root, confirmation required (Requirement 22.6).
//
// THE SEARCH PANEL USED TO BE THE SECOND CALLER, and is not any more. It spawned
// `git grep` here because `rg` is not on the Rust allowlist and widening that list
// for a search box would have traded a security boundary for speed. The panel now
// calls the ENGINE's lexical channel over the client seam instead
// (packages/core/src/context/project-search.ts): the engine spawns ripgrep through
// its own verify runner, so search got the fast path, the allowlist stayed exactly
// as narrow as it was, and one of the two search implementations is gone.
//
// Validates: Requirements 22.6, 27.4

import {
  allowedPrograms,
  runCommand,
  type CommandOutput,
  type RunCommandRequest,
} from '../ipc/bridge'

export type { CommandOutput, RunCommandRequest }

export interface CommandIo {
  /**
   * Run one program. Rejects with the backend's own sentence when the policy
   * refuses, when the program cannot start, or when there is no Tauri backend.
   */
  run(request: RunCommandRequest): Promise<CommandOutput>
  /** The programs the backend will start. The Rust list is the source of truth. */
  allowedPrograms(): Promise<string[]>
}

/** The real one. A rename of the bridge functions onto the interface, nothing more. */
export const bridgeCommandIo: CommandIo = {
  run: (request) => runCommand(request),
  allowedPrograms: () => allowedPrograms(),
}
