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
    // CSS modules resolve to a proxy, so class names are irrelevant in tests —
    // assertions go through roles and text, which is what a user actually sees.
    css: false,
  },
})
