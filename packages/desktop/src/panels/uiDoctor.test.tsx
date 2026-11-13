// UI Doctor: real checks against a jsdom document the test builds, plus the
// panel running those checks on a supplied root. No axe, no fake score.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { runUiChecks } from './uiDoctor'
import { UiDoctor } from './UiDoctor'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  document.title = ''
  document.documentElement.removeAttribute('lang')
})

function buildDoc(html: string, title = 'Test page', lang: string | null = 'en'): Document {
  document.title = title
  if (lang !== null) document.documentElement.setAttribute('lang', lang)
  document.body.innerHTML = html
  return document
}

describe('runUiChecks', () => {
  it('flags images without alt, and passes when every image has one', () => {
    const results = runUiChecks(buildDoc('<img src="a.png"><img src="b.png" alt=""><img src="c.png" alt="A cat">'))
    const imgResults = results.filter((r) => r.id === 'img-alt')
    expect(imgResults).toHaveLength(1)
    expect(imgResults[0].severity).toBe('error')
    expect(imgResults[0].selector).toContain('img')

    const clean = runUiChecks(buildDoc('<img src="b.png" alt=""><img src="c.png" alt="A cat">'))
    expect(clean.find((r) => r.id === 'img-alt')?.severity).toBe('pass')
  })

  it('flags buttons with no accessible name', () => {
    const results = runUiChecks(buildDoc('<button></button><button aria-label="Close"></button><button>Save</button>'))
    const bad = results.filter((r) => r.id === 'button-name' && r.severity === 'error')
    expect(bad).toHaveLength(1)
    expect(bad[0].selector).toContain('button')
  })

  it('flags inputs without a label, accepting label elements and aria-label', () => {
    const results = runUiChecks(
      buildDoc(
        '<label for="a">Name</label><input id="a"><input id="b"><input aria-label="Search"><label>Wrapped <input></label>',
      ),
    )
    const bad = results.filter((r) => r.id === 'input-label' && r.severity === 'error')
    expect(bad).toHaveLength(1)
    expect(bad[0].selector).toContain('#b')
  })

  it('flags a missing title and a missing html lang', () => {
    const results = runUiChecks(buildDoc('<p>hi</p>', '', null))
    expect(results.find((r) => r.id === 'doc-title')?.severity).toBe('error')
    expect(results.find((r) => r.id === 'html-lang')?.severity).toBe('warn')
    const clean = runUiChecks(buildDoc('<p>hi</p>', 'Test page', 'en'))
    expect(clean.find((r) => r.id === 'doc-title')?.severity).toBe('pass')
    expect(clean.find((r) => r.id === 'html-lang')?.severity).toBe('pass')
  })

  it('estimates contrast from computed style and labels it an estimate', () => {
    const results = runUiChecks(
      buildDoc('<p style="color: #999999; background-color: #ffffff;">faint</p><p style="color: #000000;">dark</p>'),
    )
    const low = results.filter((r) => r.id === 'contrast' && r.severity === 'warn')
    expect(low).toHaveLength(1)
    expect(low[0].detail).toContain('Estimate')
    expect(low[0].detail).toMatch(/2\.\d+:1/)
  })

  it('passes contrast when text is dark on white', () => {
    const results = runUiChecks(buildDoc('<p style="color: #000000; background-color: #ffffff;">dark</p>'))
    expect(results.find((r) => r.id === 'contrast')?.severity).toBe('pass')
  })
})

describe('UiDoctor panel', () => {
  it('runs checks on demand and shows the findings with selectors', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img src="a.png"><button>OK</button>'
    document.body.appendChild(root)
    document.title = 'Panel page'
    document.documentElement.setAttribute('lang', 'en')
    render(<UiDoctor root={root} />)

    expect(screen.getByText('No checks run yet')).toBeTruthy()
    fireEvent.click(screen.getByText('Run checks'))
    expect(screen.getByText('Image without alt text')).toBeTruthy()
    expect(screen.getByText(/error\(s\)/)).toBeTruthy()
    // Re-check runs again without duplicating the list.
    fireEvent.click(screen.getByText('Re-check'))
    expect(screen.getAllByText('Image without alt text')).toHaveLength(1)
  })
})
