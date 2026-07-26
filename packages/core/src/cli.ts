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

try {
  await main()
  // No process.exit: letting the event loop drain flushes pending stdout writes.
  process.exitCode = 0
} catch (err) {
  process.stderr.write(`sketch: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exitCode = 1
}
