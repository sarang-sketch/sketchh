// Test config for the engine. It exists for ONE reason: to install the no-egress
// tripwire (`test/setup/noEgress.ts`) for every core test file, so that "nothing
// has ever run against a real provider" is enforced by the runner rather than by
// convention. Everything else is vitest's default on purpose — file discovery,
// pool and isolation are unchanged from the configuration-free setup this replaced,
// so the suite that ran before this file runs identically after it.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./test/setup/noEgress.ts'],
  },
})
