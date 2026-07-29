// The Run & Debug navigation target is deliberately honest until a debugger exists.
// Validates: Requirements 14.4, 27.3, 27.4

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import ActivityBar from '../../components/ide/ActivityBar'
import SidePanel from '../../components/ide/SidePanel'
import { AppStateProvider } from '../../state/AppState'

afterEach(cleanup)

describe('Debugger entry point', () => {
  it('is reachable from Run & Debug and renders no fabricated debugger data', () => {
    render(
      <AppStateProvider initial={{ mode: 'ide', ideActivePanel: null }}>
        <ActivityBar />
        <SidePanel />
      </AppStateProvider>,
    )

    fireEvent.click(screen.getByTitle('Run & Debug'))

    expect(screen.getByText('Debugger is not implemented yet')).toBeDefined()
    expect(screen.getByText(/No process is attached/)).toBeDefined()
    expect(screen.queryByText(/Call Stack|Variables|Breakpoint|main\.rs:\d+/)).toBeNull()
  })
})
