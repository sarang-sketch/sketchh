// Links in terminal output. In user terms: the dev server's URL, a compiler error's
// file and line, a test failure's location and a Python traceback are each one click
// from the right place; version numbers and ordinary words are not links.

import { describe, expect, it } from 'vitest'

import { MAX_FILE_LINK_SCAN, findTerminalLinks, splitByLinks } from './links'

const targets = (text: string) => findTerminalLinks(text).map((link) => link.target)
const texts = (text: string) => findTerminalLinks(text).map((link) => text.slice(link.start, link.end))

describe('findTerminalLinks', () => {
  it('finds a dev server URL and leaves sentence punctuation out of it', () => {
    expect(targets('  ➜  Local:   http://localhost:5173/')).toEqual([{ kind: 'url', url: 'http://localhost:5173/' }])
    expect(texts('Docs at https://vitejs.dev/guide.')).toEqual(['https://vitejs.dev/guide'])
    expect(texts('(see https://example.com/a)')).toEqual(['https://example.com/a'])
    expect(texts('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
  })

  it('finds path:line:column in the forms compilers and test runners print', () => {
    expect(targets('src/app.ts:12:5 - error TS2322')).toEqual([{ kind: 'file', path: 'src/app.ts', line: 12, column: 5 }])
    expect(targets(' ❯ src/math.test.ts:8:20')).toEqual([{ kind: 'file', path: 'src/math.test.ts', line: 8, column: 20 }])
    expect(targets('  --> src/main.rs:4:5')).toEqual([{ kind: 'file', path: 'src/main.rs', line: 4, column: 5 }])
    expect(targets('main.go:17: undefined: foo')).toEqual([{ kind: 'file', path: 'main.go', line: 17 }])
  })

  it("finds tsc's path(line,col) and a Windows path inside a stack trace", () => {
    expect(targets("src/a.ts(3,7): error TS2304: Cannot find name 'x'.")).toEqual([
      { kind: 'file', path: 'src/a.ts', line: 3, column: 7 },
    ])
    expect(targets('    at run (C:\\work\\app\\src\\index.js:10:15)')).toEqual([
      { kind: 'file', path: 'C:\\work\\app\\src\\index.js', line: 10, column: 15 },
    ])
  })

  it('finds a Python traceback location', () => {
    expect(targets('  File "/home/me/app/main.py", line 42, in <module>')).toEqual([
      { kind: 'file', path: '/home/me/app/main.py', line: 42 },
    ])
  })

  it('links a path with a folder even without a line', () => {
    expect(targets("Error: Cannot find module './lib/util.js'")).toEqual([{ kind: 'file', path: './lib/util.js' }])
  })

  it('is not fooled by versions, bare names or the inside of a URL', () => {
    expect(targets('node v20.11.1 and npm 10.2.4')).toEqual([])
    expect(targets('Built with Node.js and package.json is fine')).toEqual([])
    expect(targets('see http://localhost:3000/src/app.ts:4 now')).toEqual([{ kind: 'url', url: 'http://localhost:3000/src/app.ts:4' }])
  })

  it('looks only for URLs in an enormous line, so minified output cannot stall the window', () => {
    const minified = `${'a.b/'.repeat(MAX_FILE_LINK_SCAN)}src/x.ts:1 https://example.com/docs/errors`
    expect(targets(minified)).toEqual([{ kind: 'url', url: 'https://example.com/docs/errors' }])
  })
})

describe('splitByLinks', () => {
  it('splits a line into plain text and whole links', () => {
    const text = 'at src/a.ts:3 and http://x.dev'
    expect(splitByLinks(text, findTerminalLinks(text))).toEqual([
      { text: 'at ' },
      { text: 'src/a.ts:3', link: { kind: 'file', path: 'src/a.ts', line: 3 } },
      { text: ' and ' },
      { text: 'http://x.dev', link: { kind: 'url', url: 'http://x.dev' } },
    ])
  })
})
