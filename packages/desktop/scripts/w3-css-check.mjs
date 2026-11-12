// W3 light CSS-parse check. The full `vite build` is the canonical CSS-compile gate,
// but on a memory-starved host it OOMs; this is a far lighter proof that the two
// stylesheets W3 authored PARSE cleanly through PostCSS (the same parser vite uses).
// The light-theme derivation over these files is separately proven green by
// src/styles/themeColors.test.ts, which runs the real themeColors step on all CSS.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import postcss from 'postcss'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src', 'styles')
for (const f of ['global.css', 'components.css']) {
  const css = readFileSync(join(src, f), 'utf8')
  const root = postcss.parse(css, { from: join(src, f) })
  let rules = 0
  let decls = 0
  root.walkRules(() => { rules += 1 })
  root.walkDecls(() => { decls += 1 })
  console.log(`${f}: parsed OK — ${rules} rules, ${decls} declarations`)
}
console.log('W3 CSS parse: OK')
