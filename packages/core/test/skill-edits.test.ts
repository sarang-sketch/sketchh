import { describe, expect, it } from 'vitest'

import { applyEdits, parseEdits } from '../src/skills/edits.js'

const BODY = '# Review\n\nRead the diff.\n\nReport problems.\n'

describe('bounded skill edits (SkillOpt update rule)', () => {
  it('reads add, delete and replace edits from one fenced JSON block', () => {
    const reply = [
      'Here are my edits.',
      '```edits',
      '[{"op":"add","text":"Run the tests.","after":"Read the diff."},',
      ' {"op":"delete","find":"Report problems."},',
      ' {"op":"replace","find":"# Review","text":"# Code review"},',
      ' {"op":"rename","find":"x"}, {"op":"add"}]',
      '```',
    ].join('\n')
    expect(parseEdits(reply)).toEqual([
      { op: 'add', text: 'Run the tests.', after: 'Read the diff.' },
      { op: 'delete', find: 'Report problems.' },
      { op: 'replace', find: '# Review', text: '# Code review' },
    ])
    expect(parseEdits('no block here')).toEqual([])
    expect(parseEdits('```edits\nnot json\n```')).toEqual([])
  })

  it('applies edits in order, anchored on exact text', () => {
    const result = applyEdits(BODY, [
      { op: 'add', text: 'Run the tests.', after: 'Read the diff.' },
      { op: 'replace', find: 'Report problems.', text: 'Report each problem with its file and line.' },
    ])
    expect(result.body).toBe('# Review\n\nRead the diff.\nRun the tests.\n\nReport each problem with its file and line.\n')
    expect(result.applied).toHaveLength(2)
    expect(result.skipped).toEqual([])
  })

  it('skips an edit whose anchor is missing or ambiguous instead of guessing', () => {
    const result = applyEdits('a\nb\na\n', [
      { op: 'delete', find: 'missing' },
      { op: 'replace', find: 'a', text: 'z' },
    ])
    expect(result.body).toBe('a\nb\na\n')
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'its anchor text is not in the skill',
      'its anchor text appears more than once',
    ])
  })

  it('applies at most maxEdits per step', () => {
    const edits = [1, 2, 3].map((n) => ({ op: 'add' as const, text: `rule ${n}` }))
    const result = applyEdits(BODY, edits, 2)
    expect(result.applied).toHaveLength(2)
    expect(result.body).toContain('rule 2')
    expect(result.body).not.toContain('rule 3')
    expect(result.skipped[0]!.reason).toBe('over the limit of 2 edit(s) per step')
  })

  it('inserts replacement text exactly as written, $ sequences included', () => {
    const result = applyEdits('Print the PID.\n', [
      { op: 'replace', find: 'the PID', text: "the PID with `echo $$`, the match with $& and $'quoted'" },
    ])
    expect(result.body).toBe("Print the PID with `echo $$`, the match with $& and $'quoted'.\n")
  })

  it('keeps the spacing of text the edit did not touch, and tidies only its seams', () => {
    const sample = '```python\nimport os\n\n\ndef main():\n    pass\n```'
    const body = `Use this layout:\n\n${sample}\n\nKeep it short.\n\nName files clearly.\n`
    const replaced = applyEdits(body, [{ op: 'replace', find: 'Keep it short.', text: 'Keep it under 50 lines.' }])
    expect(replaced.body).toContain(sample)
    expect(replaced.body).toContain('Keep it under 50 lines.')

    // Deleting a paragraph leaves one blank line where it was, not three.
    const deleted = applyEdits(body, [{ op: 'delete', find: 'Keep it short.' }])
    expect(deleted.body).toBe(`Use this layout:\n\n${sample}\n\nName files clearly.\n`)
  })
})
