// The two redactors share ONE credential table.
//
// `src/providers/redact.ts` scrubs a string on its way into a thrown provider
// error; `src/events/redact.ts` sanitizes a structured payload on its way into
// the event log. Different problems, deliberately separate code — but if they
// disagree about what a credential LOOKS like, a format taught to one leaks
// through the other. These tests assert they cannot drift.
//
// Uses REAL: both redactors and the real shared table. Nothing is mocked.
//
// Validates: Requirements 2.6, 3.7

import { describe, it, expect } from 'vitest'
import {
  SECRET_KEY_SHAPES,
  SENSITIVE_KEY_NAMES,
  isSensitiveKeyName,
  normalizeKeyName,
} from '../src/secrets/patterns.js'
import { redact, REDACTED as PROVIDER_REDACTED } from '../src/providers/redact.js'
import { sanitizePayload, REDACTED as EVENT_REDACTED } from '../src/events/redact.js'

/**
 * One sample per entry in SECRET_KEY_SHAPES, in table order. Adding a shape
 * without adding a sample fails the count assertion below — which is the point:
 * a new key format must be proven to reach BOTH consumers.
 */
const SHAPE_SAMPLES: readonly string[] = [
  'sk-ant-api03-ABCDEFGHIJKLMNOP', // hyphen-delimited vendor prefixes
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', // GitHub PAT
  'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', // GitHub OAuth
  'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', // GitHub fine-grained PAT
  'xoxb-1234567890-ABCDEFGHIJ', // Slack
  'AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', // Google API key
  'Bearer ABCDEFGHIJKLMNOPQRSTUV', // bearer header value
]

describe('shared credential shape table', () => {
  it('has a sample for every shape it declares', () => {
    expect(
      SHAPE_SAMPLES.length,
      'A shape was added to SECRET_KEY_SHAPES without a sample. Add one so this ' +
        'test proves both redactors pick the new format up.',
    ).toBe(SECRET_KEY_SHAPES.length)
  })

  it('every sample matches its own shape', () => {
    SECRET_KEY_SHAPES.forEach((shape, i) => {
      const sample = SHAPE_SAMPLES[i]!
      expect(new RegExp(shape.source, shape.flags).test(sample), `shape ${i}: ${sample}`).toBe(true)
    })
  })

  it('the provider redactor catches every shape in the shared table', () => {
    for (const sample of SHAPE_SAMPLES) {
      const out = redact(`request failed with ${sample} attached`, [])
      expect(out, sample).not.toContain(sample)
      expect(out, sample).toContain(PROVIDER_REDACTED)
    }
  })

  it('the event sanitizer catches every shape in the shared table', () => {
    for (const sample of SHAPE_SAMPLES) {
      const out = sanitizePayload({ text: `model said ${sample} here` }, [])
      expect(out.text as string, sample).not.toContain(sample)
      expect(out.text as string, sample).toContain(EVENT_REDACTED)
    }
  })

  it('a format that only ONE module used to know is now caught by both', () => {
    // `ghp_…` lived only in the event table; `gsk-…` lived only in the provider
    // table. Post-unification both consumers catch both.
    const gitHub = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    const groq = 'gsk-ABCDEFGHIJKLMNOP'

    expect(redact(`saw ${gitHub}`, [])).not.toContain(gitHub)
    expect(redact(`saw ${groq}`, [])).not.toContain(groq)
    expect(sanitizePayload({ t: `saw ${gitHub}` }, []).t as string).not.toContain(gitHub)
    expect(sanitizePayload({ t: `saw ${groq}` }, []).t as string).not.toContain(groq)
  })

  it('leaves non-credential text alone in both modules', () => {
    const benign = 'compiled 12 files in 1.4s — see docs at example.com/guide'
    expect(redact(benign, [])).toBe(benign)
    expect(sanitizePayload({ note: benign }, []).note).toBe(benign)
  })
})

describe('shared credential name table', () => {
  it('normalizes every spelling of a key name onto one entry', () => {
    for (const spelling of ['apiKey', 'api_key', 'API-KEY', 'Api Key']) {
      expect(normalizeKeyName(spelling)).toBe('apikey')
      expect(isSensitiveKeyName(spelling)).toBe(true)
    }
    expect(isSensitiveKeyName('x-api-key')).toBe(true)
    expect(isSensitiveKeyName('Authorization')).toBe(true)
  })

  it('does not catch names that merely contain a sensitive word', () => {
    for (const benign of ['maxTokens', 'totalTokens', 'tokenCount', 'secretsFound']) {
      expect(isSensitiveKeyName(benign), benign).toBe(false)
    }
  })

  it('is a non-empty set the event sanitizer actually consults', () => {
    expect(SENSITIVE_KEY_NAMES.size).toBeGreaterThan(0)
    for (const name of SENSITIVE_KEY_NAMES) {
      const out = sanitizePayload({ [name]: 'whatever-value-here' }, [])
      expect(out[name], name).toBe(EVENT_REDACTED)
    }
  })
})
