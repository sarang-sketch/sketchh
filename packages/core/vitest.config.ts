// Install the no-egress tripwire for every engine test and bound worker pressure.
// Test discovery, isolation, and the normal per-test timeout remain unchanged.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unbounded workers contend on filesystem fixtures on Windows/high-core hosts.
    maxWorkers: 4,
    setupFiles: ['./test/setup/noEgress.ts'],
    // Offline Mode is saved in the user's home (`~/.sketch/privacy.json`). Pinning it
    // off here keeps a developer's own setting out of the suite; the Offline Mode
    // tests pass an explicit environment and a temporary home instead.
    env: { SKETCH_OFFLINE: '0' },
  },
})
