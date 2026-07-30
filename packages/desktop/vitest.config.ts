// Test config, kept separate from vite.config.ts so the production build never
// loads the test runner. Same runner as packages/core (vitest) so `npm test` at
// the root drives both packages.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // jsdom pairs Node's `fetch` with jsdom's `AbortController`, and Node's fetch
    // rejects a signal from another realm before it opens a socket. The setup file
    // bridges the two so a REAL request with a cancellable signal works under the
    // harness; it fakes no request, no response and no status. See the file header.
    setupFiles: ['./src/test/jsdomFetchBridge.ts'],
    // CSS modules resolve to a proxy, so class names are irrelevant in tests —
    // assertions go through roles and text, which is what a user actually sees.
    css: false,
  },
})
