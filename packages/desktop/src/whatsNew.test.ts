// W9 invariant 6 — What's New lists only real, shipped changes.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { WHATS_NEW } from './whatsNew'

// From packages/desktop/src → repo root is four levels up.
const docsDir = join(__dirname, '..', '..', '..', 'docs', 'overhaul')

describe("What's New", () => {
  it('has entries, each short and plain', () => {
    expect(WHATS_NEW.length).toBeGreaterThan(0)
    for (const e of WHATS_NEW) {
      expect(e.text.trim().length).toBeGreaterThan(0)
      expect(e.text.length).toBeLessThanOrEqual(120)
    }
  })

  it('every entry cites a fix doc that exists in docs/overhaul', () => {
    for (const e of WHATS_NEW) {
      expect(e.source).toMatch(/^fix-[a-z-]+\.md$/)
      expect(existsSync(join(docsDir, e.source)), `missing source doc ${e.source}`).toBe(true)
    }
  })

  it('does not claim a split editor (a feature W8 recorded as absent)', () => {
    const joined = WHATS_NEW.map((e) => e.text.toLowerCase()).join(' ')
    expect(joined).not.toMatch(/split editor|split view/)
  })
})
