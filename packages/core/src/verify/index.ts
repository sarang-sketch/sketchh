// Public surface of the shell-less verify runner.

export {
  runCommand,
  runCommands,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  EXIT_TIMEOUT,
  EXIT_SPAWN_FAILED,
  EXIT_ABORTED,
  EXIT_SIGNALLED,
} from './runner.js'
export type { VerifyEventSink, RunCommandOptions } from './runner.js'
