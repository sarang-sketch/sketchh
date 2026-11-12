#!/usr/bin/env node
// The engine's executable: newline-delimited JSON over stdin/stdout.
//
// This file is deliberately five lines of logic. It is the entry point declared
// by `package.json#bin` and the file esbuild bundles into the Tauri sidecar
// (Requirement 12.7), so it must have no conditional startup: it always serves,
// whether it was invoked as `node dist/cli.js`, through the `sketch` bin shim, or
// as a sidecar binary next to the app. An `import.meta.url === argv[1]` guard —
// the usual trick for making an entry point importable — would silently fail to
// start under a symlinked bin shim, so the dispatch lives in `src/rpc/` instead
// and tests import that.
//
// Nothing here writes to stdout. The protocol server owns that stream
// (Requirement 12.5).
//
// Validates: Requirements 12.1, 12.5, 12.7

import { main } from './rpc/index.js'

// A stray promise rejection anywhere in a handler must not end the engine
// mid-session. On the Node versions that run the sidecar an unhandled rejection
// terminates the process by default, so one forgotten `await` would take the whole
// engine down with only a stack trace on stderr. These handlers keep the process
// serving and write ONE diagnostic line to stderr — never to stdout, which the
// protocol owns. The fatal-startup path below is unchanged: an error thrown by
// `main()` itself still exits non-zero.
const describe = (err: unknown): string =>
  err instanceof Error ? err.stack ?? err.message : String(err)

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`sketch: unhandled rejection: ${describe(reason)}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`sketch: uncaught exception: ${describe(err)}\n`)
})

// Test-only, inert unless SKETCH_TEST_UNHANDLED=1 is set: schedule exactly one
// rejected promise after start-up so a spawned-process test can prove the handler
// above keeps the engine alive and still answering. Read ONLY here, nowhere else.
if (process.env['SKETCH_TEST_UNHANDLED'] === '1') {
  setTimeout(() => {
    void Promise.reject(new Error('test-only injected unhandled rejection'))
  }, 50)
}

try {
  await main()
  // No process.exit: letting the event loop drain flushes pending stdout writes.
  process.exitCode = 0
} catch (err) {
  process.stderr.write(`sketch: fatal: ${describe(err)}\n`)
  process.exitCode = 1
}
