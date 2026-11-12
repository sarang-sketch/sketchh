import { describe, expect, it } from 'vitest'
import { MAX_PERSONAL_WORKFLOWS, WORKFLOWS, normalizeWorkflows } from './catalog'

describe('saved workflow records', () => {
  it('rejects corrupt records, duplicate ids and ids that would collide after truncation', () => {
    const valid = { id: 'personal-1', title: ' Review ', prompt: 'Inspect the changes', category: 'Review', mode: 'ask' }
    expect(normalizeWorkflows([null, {}, [], valid, { ...valid, title: 'duplicate' }, { ...valid, id: 'feature' }, { ...valid, id: 'personal-' + 'x'.repeat(120) }, { ...valid, id: 'personal-empty', prompt: ' ' }])).toEqual([{ ...valid, title: 'Review', description: '', personal: true }])
    expect(normalizeWorkflows({})).toEqual([])
  })

  it('bounds saved data and makes invalid modes read only', () => {
    const data = Array.from({ length: 60 }, (_, index) => ({ id: `personal-${index}`, title: 'x'.repeat(100), description: 'x'.repeat(200), prompt: 'x'.repeat(30_000), category: 'invalid', mode: 'invalid' }))
    const result = normalizeWorkflows(data)
    expect(result).toHaveLength(MAX_PERSONAL_WORKFLOWS)
    expect(result[0]).toMatchObject({ category: 'Build', mode: 'ask' })
    expect(result[0]?.title).toHaveLength(80)
    expect(result[0]?.prompt).toHaveLength(20_000)
  })

  it('keeps reviews and planning read only until the user chooses otherwise', () => {
    for (const id of ['review', 'spec', 'release', 'organize', 'explore']) expect(WORKFLOWS.find((w) => w.id === id)?.mode).toBe('ask')
    expect(new Set(WORKFLOWS.map((w) => w.id)).size).toBe(WORKFLOWS.length)
  })
})
