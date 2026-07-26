// Engine identity reported by `ping`.
//
// WHY A CONSTANT AND NOT A package.json READ. `cli.ts` is esbuild-bundled to a
// single file and registered as a Tauri `externalBin` (Requirement 12.7, task
// 2.1). That file is copied next to the app binary with NO package.json beside
// it, so `readFile(new URL('../package.json', import.meta.url))` — and equally a
// `resolveJsonModule` import, which esbuild would happily inline but tsc would
// emit as a runtime read — resolves to nothing in the shipped sidecar. `ping` is
// the startup liveness call for both transports (Requirement 13.6), so it is the
// one method that absolutely must not depend on the filesystem layout.
//
// The cost of a constant is drift. `test/cli.test.ts` therefore asserts this
// value equals `packages/core/package.json`'s `version`, so a release bump that
// forgets this file fails the build instead of shipping a lying `ping`.

/** Engine name reported by `ping`. */
export const ENGINE_NAME = '@sketch/core'

/** Engine version. MUST match packages/core/package.json — the test enforces it. */
export const ENGINE_VERSION = '0.1.0'

/**
 * Wire protocol version. Bumped only for a breaking change to the frame shapes
 * in `frames.ts`, so a client can refuse a sidecar it cannot speak to.
 */
export const PROTOCOL_VERSION = 1
