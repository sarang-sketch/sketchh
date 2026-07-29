// The scoped-command seam: one interface over the backend's `run_command`.
//
// SAME SHAPE, SAME REASONS AS `FileIo` (src/editor/fileIo.ts). The bridge is a
// Tauri-native capability with no implementation under jsdom, so an interface is
// what lets a test drive the real panel, the real parser and the real state
// transitions against a process double — while production gets the one contained
// path through Rust.
//
// TWO CALLERS, ONE SPAWN PATH. The terminal panel runs what the user typed; the
// search panel runs `git grep` as its fast path. Both go through here, so there is
// exactly one place in the frontend that can start a process, and it is the one the
// backend contains: program from the allowlist, arguments as a vector, cwd inside
// the project root, confirmation required (Requirement 22.6).
//
// NOTHING HERE WIDENS THE POLICY. `ripgrep` is not on the Rust allowlist and this
// module does not add it; the search fast path uses `git grep`, which is (see
// src/search/runSearch.ts for that decision).
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
