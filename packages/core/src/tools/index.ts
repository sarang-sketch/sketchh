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
