// The self-test for the fixture guards' own mechanism.
//
// Every "this fixture is gone" assertion in this package is built on `stripComments`. A
// stripper that removed too much would make all of them pass for no reason, silently —
// which is a worse outcome than the false positives it was written to fix, because a
// false positive is loud and this would not be.
//
// So: it must delete prose and keep code, a string literal, JSX, and a `//` inside a URL.

import { describe, expect, it } from 'vitest'
import { readCode, readSource, stripComments } from './source'

describe('stripComments', () => {
  it('removes prose and keeps the code beside it', () => {
    const sample = [
      '// mcpToolsStatus: { connected: 5 } — a comment about the deleted field',
      '/* $1.4025 was here, in a block comment */',
      'const keep = { mcpToolsStatus: { connected: 5 } }',
    ].join('\n')
    const stripped = stripComments(sample)

    expect(stripped).not.toContain('a comment about the deleted field')
    expect(stripped).not.toContain('in a block comment')
    // Exactly one occurrence survives: the real property.
    expect(stripped.match(/mcpToolsStatus/g)).toHaveLength(1)
    expect(stripped).toContain('connected: 5')
  })

  it('keeps a string literal, including a // inside a URL', () => {
    const stripped = stripComments('const url = "https://example.com/mcpToolsStatus"')
    // A URL is not a comment. Treating it as one would silently truncate real code.
    expect(stripped).toContain('https://example.com/mcpToolsStatus')
  })

  it('keeps JSX text and attributes', () => {
    const stripped = stripComments('<div title="MCP Tools Active (cloudrun)">$1.4025</div>')
    expect(stripped).toContain('MCP Tools Active (cloudrun)')
    expect(stripped).toContain('$1.4025')
  })

  it('removes a JSX comment, which is a block comment in an expression', () => {
    const stripped = stripComments('<div>{/* $1.4025 used to be rendered here */}</div>')
    expect(stripped).not.toContain('1.4025')
  })

  it('keeps a template literal and its interpolation', () => {
    const stripped = stripComments('const s = `total ${usd} // not a comment`')
    expect(stripped).toContain('// not a comment')
    expect(stripped).toContain('${usd}')
  })

  it('handles an escaped quote without losing the rest of the file', () => {
    const stripped = stripComments("const s = 'it\\'s fine' // gone\nconst after = 1")
    expect(stripped).toContain('const after = 1')
    expect(stripped).not.toContain('gone')
  })

  it('is what the fixture guards actually read', () => {
    // The guards depend on both halves: the raw file still contains the explanatory
    // comment, and the code does not contain the fixture.
    expect(readSource(join('components', 'StatusBar.tsx'))).toContain('1.4025')
    expect(readCode(join('components', 'StatusBar.tsx'))).not.toContain('1.4025')
  })
})

function join(...parts: string[]): string {
  return parts.join('/')
}
