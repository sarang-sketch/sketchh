// Unit + property tests for the hand-rolled YAML-subset frontmatter parser.
//
// The property test uses a seeded pseudo-random generator written by hand —
// @sketch/core is dependency-free, so no fast-check.
//
// Validates: Requirements 10.1, 10.4

import { describe, it, expect } from 'vitest'

import { parseFrontmatter } from '../src/skills/frontmatter.js'
import type { FrontmatterData } from '../src/skills/frontmatter.js'

// Narrow a result to success, failing the test with the error if it is not.
function expectOk(text: string): { data: FrontmatterData; body: string } {
  const result = parseFrontmatter(text)
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`)
  return { data: result.data, body: result.body }
}

function expectErr(text: string): string {
  const result = parseFrontmatter(text)
  if (result.ok) throw new Error('expected an error, got ok')
  return result.error
}

describe('parseFrontmatter — supported grammar', () => {
  it('treats a file with no frontmatter as an empty map and a whole-file body', () => {
    const text = '# Just markdown\n\nno fence here\n'
    const { data, body } = expectOk(text)
    expect(data).toEqual({})
    expect(body).toBe(text)
  })

  it('parses plain scalars and returns the body after the block', () => {
    const { data, body } = expectOk(
      ['---', 'name: reviewer', 'description: reviews code', '---', '', 'Body text.', ''].join('\n'),
    )
    expect(data).toEqual({ name: 'reviewer', description: 'reviews code' })
    expect(body).toBe('Body text.\n')
  })

  it('keeps a colon inside a value', () => {
    const { data } = expectOk(['---', 'description: does a: thing', '---', 'b'].join('\n'))
    expect(data['description']).toBe('does a: thing')
  })

  it('keeps a # inside a quoted value', () => {
    const { data } = expectOk(['---', 'description: "issue #42: fixed"', '---', 'b'].join('\n'))
    expect(data['description']).toBe('issue #42: fixed')
  })

  it('parses single-quoted strings, including the doubled-quote escape', () => {
    const { data } = expectOk(["---", "name: 'it''s here: ok'", '---', 'b'].join('\n'))
    expect(data['name']).toBe("it's here: ok")
  })

  it('parses double-quoted strings, including escapes', () => {
    const { data } = expectOk(['---', 'name: "a \\"quoted\\" tab:\\there"', '---', 'b'].join('\n'))
    expect(data['name']).toBe('a "quoted" tab:\there')
  })

  it('parses an inline sequence', () => {
    const { data } = expectOk(
      ['---', 'capabilities: [read, write, network]', '---', 'b'].join('\n'),
    )
    expect(data['capabilities']).toEqual(['read', 'write', 'network'])
  })

  it('parses an inline sequence with quoted items containing commas', () => {
    const { data } = expectOk(['---', 'capabilities: ["a, b", \'c\']', '---', 'b'].join('\n'))
    expect(data['capabilities']).toEqual(['a, b', 'c'])
  })

  it('parses an empty inline sequence', () => {
    const { data } = expectOk(['---', 'capabilities: []', '---', 'b'].join('\n'))
    expect(data['capabilities']).toEqual([])
  })

  it('parses a block sequence', () => {
    const { data } = expectOk(
      ['---', 'name: s', 'capabilities:', '  - read', '  - write', '---', 'b'].join('\n'),
    )
    expect(data).toEqual({ name: 's', capabilities: ['read', 'write'] })
  })

  it('parses a zero-indent block sequence', () => {
    const { data } = expectOk(['---', 'capabilities:', '- read', '- write', '---', 'b'].join('\n'))
    expect(data['capabilities']).toEqual(['read', 'write'])
  })

  it('parses an empty value as the empty string', () => {
    const { data } = expectOk(['---', 'name: s', 'description:', '---', 'b'].join('\n'))
    expect(data).toEqual({ name: 's', description: '' })
  })

  it('ignores comment lines and blank lines inside the block', () => {
    const { data } = expectOk(
      ['---', '# a leading comment', '', 'name: s', '  # indented comment', '---', 'b'].join('\n'),
    )
    expect(data).toEqual({ name: 's' })
  })

  it('strips a trailing comment after a value', () => {
    const { data } = expectOk(['---', 'name: s # the name', '---', 'b'].join('\n'))
    expect(data['name']).toBe('s')
  })

  it('strips a trailing comment after a quoted value and after a sequence', () => {
    const { data } = expectOk(
      ['---', 'name: "s" # why', 'capabilities: [read] # scope', '---', 'b'].join('\n'),
    )
    expect(data).toEqual({ name: 's', capabilities: ['read'] })
  })

  it('parses CRLF line endings identically to LF', () => {
    const crlf = ['---', 'name: s', 'capabilities:', '  - read', '---', '', 'Body.', ''].join('\r\n')
    const lf = ['---', 'name: s', 'capabilities:', '  - read', '---', '', 'Body.', ''].join('\n')
    const fromCrlf = expectOk(crlf)
    const fromLf = expectOk(lf)
    expect(fromCrlf.data).toEqual(fromLf.data)
    expect(fromCrlf.body).toBe(fromLf.body)
    expect(fromCrlf.body).not.toContain('\r')
  })
})

describe('parseFrontmatter — rejected input', () => {
  it('returns an error for an unterminated frontmatter block without throwing', () => {
    let result: ReturnType<typeof parseFrontmatter> | undefined
    expect(() => {
      result = parseFrontmatter('---\nname: s\nno closing fence\n')
    }).not.toThrow()
    expect(result?.ok).toBe(false)
    expect(expectErr('---\nname: s\nno closing fence\n')).toMatch(/unterminated frontmatter/i)
  })

  it('returns an error naming the nested-map limitation', () => {
    const error = expectErr(['---', 'meta:', '  nested: value', '---', 'b'].join('\n'))
    expect(error).toMatch(/nested maps are not supported/i)
    expect(error).toContain('nested: value')
  })

  it('returns an error naming the block-scalar limitation', () => {
    expect(expectErr(['---', 'body: |', '  text', '---', 'b'].join('\n'))).toMatch(
      /block scalars .* are not supported/i,
    )
    expect(expectErr(['---', 'body: >-', '  text', '---', 'b'].join('\n'))).toMatch(
      /block scalars .* are not supported/i,
    )
  })

  it('returns an error for anchors, aliases, and merge keys', () => {
    expect(expectErr(['---', 'base: &a x', '---', 'b'].join('\n'))).toMatch(/anchors/i)
    expect(expectErr(['---', 'copy: *a', '---', 'b'].join('\n'))).toMatch(/aliases/i)
    expect(expectErr(['---', '<<: x', '---', 'b'].join('\n'))).toMatch(/merge keys/i)
  })

  it('returns an error for a line that is not key: value', () => {
    expect(expectErr(['---', 'just a line', '---', 'b'].join('\n'))).toMatch(/expected "key: value"/)
  })

  it('returns an error for a sequence item with no owning key', () => {
    expect(expectErr(['---', '- orphan', '---', 'b'].join('\n'))).toMatch(
      /does not belong to any key/,
    )
  })

  it('returns an error for an unterminated quoted string', () => {
    expect(expectErr(['---', 'name: "unclosed', '---', 'b'].join('\n'))).toMatch(
      /unterminated double-quoted string/,
    )
  })

  it('returns an error for an unterminated inline sequence', () => {
    expect(expectErr(['---', 'capabilities: [a, b', '---', 'b'].join('\n'))).toMatch(
      /unterminated inline sequence/,
    )
  })
})

// ---------------------------------------------------------------------------
// Property-based test: serialize → parse round-trip.
//
// For generated maps of the supported shapes, writing them out as frontmatter
// and parsing them back yields the original map. Generation is driven by a
// seeded LCG so a failure is reproducible from its seed alone.
// ---------------------------------------------------------------------------

function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    // Numerical Recipes LCG — deterministic and dependency-free.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const VALUE_CHARS = 'abcXYZ019 :#\'"-_.[]|>&*'

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!
}

function randomKey(rand: () => number, index: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  let key = ''
  const length = 1 + Math.floor(rand() * 8)
  for (let i = 0; i < length; i++) key += pick(rand, alphabet.split(''))
  // Suffix keeps keys unique so the round-trip compares like for like.
  return `${key}${index}`
}

function randomScalar(rand: () => number): string {
  const length = Math.floor(rand() * 12)
  let out = ''
  for (let i = 0; i < length; i++) out += pick(rand, VALUE_CHARS.split(''))
  return out
}

/** Quote a scalar so the parser reads back exactly what went in. */
function serializeScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function serialize(data: FrontmatterData, rand: () => number): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`)
      } else if (rand() < 0.5) {
        lines.push(`${key}: [${value.map(serializeScalar).join(', ')}]`)
      } else {
        lines.push(`${key}:`)
        for (const item of value) lines.push(`  - ${serializeScalar(item)}`)
      }
    } else if (value === '') {
      lines.push(`${key}:`)
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`)
    }
    if (rand() < 0.2) lines.push('')
    if (rand() < 0.2) lines.push('# a comment')
  }
  lines.push('---')
  lines.push('')
  lines.push('body')
  return lines.join(rand() < 0.5 ? '\n' : '\r\n')
}

function generate(rand: () => number): FrontmatterData {
  const data: FrontmatterData = {}
  const keyCount = Math.floor(rand() * 6)
  for (let i = 0; i < keyCount; i++) {
    const key = randomKey(rand, i)
    const roll = rand()
    if (roll < 0.3) {
      const itemCount = Math.floor(rand() * 4)
      const items: string[] = []
      // An empty generated item would serialize as `- ""`, which is legal, but
      // keeping items non-empty keeps the sequence case focused.
      for (let j = 0; j < itemCount; j++) items.push(randomScalar(rand) || `item${j}`)
      data[key] = items
    } else if (roll < 0.4) {
      data[key] = ''
    } else {
      data[key] = randomScalar(rand)
    }
  }
  return data
}

describe('parseFrontmatter — property: serialize/parse round-trip', () => {
  it('recovers the original map for 500 generated documents', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = makeRandom(seed * 2654435761)
      const original = generate(rand)
      const text = serialize(original, rand)
      const result = parseFrontmatter(text)
      if (!result.ok) {
        throw new Error(`seed ${seed}: parse failed: ${result.error}\n--- input ---\n${text}`)
      }
      expect(result.data, `seed ${seed} input:\n${text}`).toEqual(original)
      expect(result.body, `seed ${seed}`).toBe('body')
    }
  })
})
