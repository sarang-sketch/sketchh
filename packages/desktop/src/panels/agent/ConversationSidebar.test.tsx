// Selecting a conversation must NEVER move the workspace root.
//
// The workspace root is the editor / explorer / command_policy boundary; it changes
// only by an explicit Open Folder / recent / confirmed prompt (Req 15.6, BUG_AUDIT
// B-001; W2 invariants 1-2). The old code silently dispatched SET_PROJECT_ROOT to the
// conversation's (often NESTED) root on select, narrowing the boundary and making files
// above it unreachable — the "different workspace boundary" symptom.
//
// New behaviour (the lead's round-2 product decision):
//   (a) conversation root INSIDE / equal to the open workspace -> select only; root,
//       open buffers and terminal cwd are untouched (its runs use the conversation's own
//       root — tested in AgentSession.runRoot.test.tsx).
//   (b) conversation root OUTSIDE the workspace -> select only; root untouched (the read-
//       only notice + send guard live in AgentChat/Composer).
//   (c) no folder open -> adopt the conversation's root as the workspace (nothing to lose).
//
// The precise, non-vacuous probe is "did projectRoot / openFiles / terminal cwd change?":
// the SET_PROJECT_ROOT reducer clears buffers and resets terminal cwds on a real change,
// so an unwanted switch is observable.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfirmProvider } from '../../components/ConfirmDialog'
import {
  AppStateProvider,
  makeFileEntry,
  useAppState,
  type AppState,
} from '../../state/AppState'
import { ConversationSidebar } from './ConversationSidebar'

function conversation(id: string, title: string, root: string | null): AppState['conversations'][number] {
  return { id, title, messages: [], createdAt: 1, updatedAt: 1, root }
}

function openBuffer(path: string): AppState['files'][string] {
  return makeFileEntry(path, 'const a = 1\n')
}

/** Surfaces the live reducer state so a test can assert on the root and buffers. */
let seen: AppState
function Probe() {
  seen = useAppState()
  return null
}

function mount(initial: Parameters<typeof AppStateProvider>[0]['initial']) {
  render(
    <AppStateProvider initial={initial}>
      <ConfirmProvider>
        <ConversationSidebar />
        <Probe />
      </ConfirmProvider>
    </AppStateProvider>,
  )
}

afterEach(() => cleanup())

describe('ConversationSidebar — selecting a conversation never moves the workspace root', () => {
  it('(a) a conversation INSIDE the workspace is selected without touching root, buffers, or terminal cwd', async () => {
    const workspace = 'C:/Users/me/project'
    const nested = 'C:/Users/me/project/web-app' // the owner's trigger: a nested project
    const file = openBuffer('C:/Users/me/project/index.mjs')

    mount({
      projectRoot: workspace,
      openFiles: [file.path],
      activeFile: file.path,
      files: { [file.path]: file },
      terminals: [{ id: 't1', title: 'bash', cwd: 'C:/Users/me/project' }],
      conversations: [conversation('c-nested', 'Nested project', nested)],
    })

    fireEvent.click(screen.getByText('Nested project'))

    // Selected, but the workspace boundary is unchanged and nothing was torn down —
    // index.mjs (the parent entry file) stays open and reachable.
    await waitFor(() => expect(seen.activeConversationId).toBe('c-nested'))
    expect(seen.projectRoot).toBe(workspace)
    expect(seen.openFiles).toEqual([file.path])
    expect(seen.files[file.path]).toBeDefined()
    expect(seen.terminals[0]?.cwd).toBe('C:/Users/me/project')
  })

  it('(a, equal) the SAME folder spelled differently selects with no switch and keeps the buffer', async () => {
    const workspace = 'C:/Users/me/project'
    const file = openBuffer('C:/Users/me/project/src/app.ts')

    mount({
      projectRoot: workspace,
      openFiles: [file.path],
      activeFile: file.path,
      files: { [file.path]: file },
      conversations: [conversation('c-same', 'Same folder', 'c:\\Users\\me\\project')],
    })

    fireEvent.click(screen.getByText('Same folder'))

    await waitFor(() => expect(seen.activeConversationId).toBe('c-same'))
    expect(seen.projectRoot).toBe(workspace)
    expect(seen.openFiles).toEqual([file.path])
  })

  it('(b) a conversation OUTSIDE the workspace is selected but the workspace root is NOT changed', async () => {
    const workspace = 'C:/Users/me/project'
    const elsewhere = 'C:/Users/me/other-repo' // a different folder
    const file = openBuffer('C:/Users/me/project/index.mjs')

    mount({
      projectRoot: workspace,
      openFiles: [file.path],
      activeFile: file.path,
      files: { [file.path]: file },
      conversations: [conversation('c-out', 'Other repo', elsewhere)],
    })

    fireEvent.click(screen.getByText('Other repo'))

    // The conversation is selected read-only; the open folder and buffers are untouched.
    // (The "open that folder" notice + send block live in AgentChat/Composer.)
    await waitFor(() => expect(seen.activeConversationId).toBe('c-out'))
    expect(seen.projectRoot).toBe(workspace)
    expect(seen.openFiles).toEqual([file.path])
  })

  it('(b, parent) a conversation rooted at a PARENT of the open folder does not widen the workspace', async () => {
    const workspace = 'C:/Users/me/project/web-app'
    const parent = 'C:/Users/me/project'

    mount({
      projectRoot: workspace,
      openFiles: [],
      activeFile: null,
      files: {},
      conversations: [conversation('c-parent', 'Parent folder', parent)],
    })

    fireEvent.click(screen.getByText('Parent folder'))

    await waitFor(() => expect(seen.activeConversationId).toBe('c-parent'))
    expect(seen.projectRoot).toBe(workspace)
  })

  it('(c) with no folder open, selecting a conversation adopts its root as the workspace', async () => {
    const root = 'C:/Users/me/project/web-app'

    mount({
      projectRoot: null,
      openFiles: [],
      activeFile: null,
      files: {},
      conversations: [conversation('c-fresh', 'Fresh', root)],
    })

    fireEvent.click(screen.getByText('Fresh'))

    await waitFor(() => expect(seen.projectRoot).toBe(root))
    expect(seen.activeConversationId).toBe('c-fresh')
  })
})

describe('ConversationSidebar — delete is behind a destructive confirmation', () => {
  it('does NOT delete on the first click; the conversation survives until confirmed', async () => {
    mount({
      projectRoot: 'C:/Users/me/project',
      conversations: [conversation('c1', 'Keep me', 'C:/Users/me/project')],
    })

    fireEvent.click(screen.getByLabelText('Delete conversation Keep me'))
    // A confirmation dialog appears; nothing is removed yet.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/cannot be undone/i)).toBeTruthy()
    expect(seen.conversations).toHaveLength(1)
  })

  it('removes the conversation only after the danger button is pressed', async () => {
    mount({
      projectRoot: 'C:/Users/me/project',
      conversations: [conversation('c1', 'Delete me', 'C:/Users/me/project')],
    })

    fireEvent.click(screen.getByLabelText('Delete conversation Delete me'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(seen.conversations).toHaveLength(0))
  })

  it('keeps the conversation when the user cancels the confirmation', async () => {
    mount({
      projectRoot: 'C:/Users/me/project',
      conversations: [conversation('c1', 'Spare me', 'C:/Users/me/project')],
    })

    fireEvent.click(screen.getByLabelText('Delete conversation Spare me'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(seen.conversations).toHaveLength(1)
  })
})

describe('ConversationSidebar — inline rename', () => {
  it('Enter commits the new title (and the follow-on blur does not commit twice)', async () => {
    mount({
      projectRoot: 'C:/Users/me/project',
      conversations: [conversation('c1', 'Old name', 'C:/Users/me/project')],
    })

    fireEvent.click(screen.getByLabelText('Rename conversation Old name'))
    const input = screen.getByLabelText('Rename conversation Old name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Brand new name' } })
    // Enter blurs the field; the ref makes the blur commit exactly once.
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    await waitFor(() => expect(seen.conversations[0]!.title).toBe('Brand new name'))
  })

  it('Escape cancels — the title is unchanged even though blur follows', async () => {
    mount({
      projectRoot: 'C:/Users/me/project',
      conversations: [conversation('c1', 'Keep this', 'C:/Users/me/project')],
    })

    fireEvent.click(screen.getByLabelText('Rename conversation Keep this'))
    const input = screen.getByLabelText('Rename conversation Keep this') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Discarded edit' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.queryByLabelText('Rename conversation Keep this')?.tagName).not.toBe('INPUT'))
    expect(seen.conversations[0]!.title).toBe('Keep this')
  })

  it('blur alone commits the edit', async () => {
    mount({
      projectRoot: 'C:/Users/me/project',
      conversations: [conversation('c1', 'Before blur', 'C:/Users/me/project')],
    })

    fireEvent.click(screen.getByLabelText('Rename conversation Before blur'))
    const input = screen.getByLabelText('Rename conversation Before blur') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Committed on blur' } })
    fireEvent.blur(input)

    await waitFor(() => expect(seen.conversations[0]!.title).toBe('Committed on blur'))
  })
})

describe('ConversationSidebar — Copy as Markdown (W9 invariant 8a)', () => {
  function withMessages(): AppState['conversations'][number] {
    return {
      id: 'c1',
      title: 'Login bug',
      createdAt: 1,
      updatedAt: 1,
      root: 'C:/Users/me/project',
      messages: [
        { id: 'm1', role: 'user', content: 'Why does login fail?', timestamp: 1 },
        { id: 'm2', role: 'agent', content: 'Token expired.', timestamp: 2 },
      ],
    }
  }

  it('copies a Markdown transcript to the clipboard, and never changes selection or title', async () => {
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } },
    })
    mount({ projectRoot: 'C:/Users/me/project', conversations: [withMessages()] })

    fireEvent.click(screen.getByLabelText('Copy conversation Login bug as Markdown'))

    await waitFor(() => expect(writes.length).toBe(1))
    expect(writes[0]).toContain('# Login bug')
    expect(writes[0]).toContain('Why does login fail?')
    expect(writes[0]).toContain('Token expired.')
    // Pure read: selection and title are untouched (W2 open() / W6 rename unaffected).
    expect(seen.activeConversationId).toBeNull()
    expect(seen.conversations[0]!.title).toBe('Login bug')
  })
})
