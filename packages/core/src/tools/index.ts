// Tools the engine drives on the user's machine.
//
// `git` is the first. `browser`, `terminal`, and `mcp` land in later phases (see
// the design's `tools/{git,browser,terminal,mcp}.ts`); nothing is declared here
// before it exists, so this barrel never promises a tool the engine cannot run.

export {
  GitError,
  GitTool,
  DEFAULT_GIT_RUN_ID,
  DEFAULT_GIT_TIMEOUT_MS,
  notARepository,
  parseStatus,
  unquotePath,
} from './git.js'
export type {
  GitExec,
  GitExecResult,
  GitFileChange,
  GitStatusResult,
  GitToolOptions,
} from './git.js'

// The same tool, as descriptors an agent's grant is checked against. `GitTool`'s
// methods stay public for the Source Control panel, which is a human pressing a
// button; these are the agent-facing door, and it has a lock.
export { GIT_TOOL_NAMES, gitToolDescriptors } from './gitDescriptors.js'
export type { GitToolDescriptorOptions, GitToolName } from './gitDescriptors.js'

// Read-only project tools: what lets a run LOOK before it edits. All four cost
// `fs:read:project` and go through the same one gate.
export {
  PROJECT_TOOL_NAMES,
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_LINES,
  globToRegExp,
  projectToolDescriptors,
  resolveProjectPath,
} from './project.js'
export type { ProjectToolName } from './project.js'

// `run_command`: one program per call, no shell, contained to the project, and gated
// by the human's per-run permission mode. Costs `proc:spawn`.
export {
  COMMAND_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_TIMEOUT_MS,
  commandEnvironment,
  commandRisk,
  commandToolDescriptor,
  programName,
  splitCommandLine,
} from './command.js'
export type { CommandApprover, CommandMode, CommandRequest, CommandToolOptions } from './command.js'

// `use_skill`: installed skills by name and description, bodies loaded on demand.
export { skillIndex, skillToolDescriptor } from './skills.js'

// The integrated terminal: the user's shell, one process per line, streamed, stoppable.
export {
  MAX_RUNNING_COMMANDS,
  TerminalHost,
  TerminalRefusal,
  defaultShell,
  parseCd,
  resolveTerminalDir,
} from './terminal.js'
export type { ShellSpec, TerminalChunk, TerminalReadResult, TerminalStartResult } from './terminal.js'

// The project watcher: what changed on disk, so the window shows it as it is now.
export { ProjectWatcher, WatcherRegistry, classifyChange, IGNORED_DIRECTORIES } from './watcher.js'
export type { WatchBatch } from './watcher.js'
