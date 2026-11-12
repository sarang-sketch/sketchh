//
// The modal question asked before anything is discarded, deleted or overwritten. In
// user terms: it takes the keyboard while it is open — Tab and Shift+Tab move between
// its own buttons and never reach the editor behind it — and Escape answers "cancel".

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ConfirmProvider, useConfirm } from './ConfirmDialog'

afterEach(() => {
  cleanup()
})

function Asker({ onAnswer }: { onAnswer: (id: string) => void }) {
  const confirm = useConfirm()
  return (
    <>
      <button type="button">Behind the dialog</button>
      <button
        type="button"
        onClick={() =>
          void confirm({
            title: 'Save changes to a.ts?',
            buttons: [
              { id: 'save', label: 'Save', kind: 'primary' },
              { id: 'discard', label: "Don't Save" },
              { id: 'cancel', label: 'Cancel' },
            ],
            cancelId: 'cancel',
          }).then(onAnswer)
        }
      >
        Ask
      </button>
    </>
  )
}

function open(): string[] {
  const answers: string[] = []
  render(
    <ConfirmProvider>
      <Asker onAnswer={(id) => answers.push(id)} />
    </ConfirmProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
  return answers
}

describe('ConfirmDialog keyboard', () => {
  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    open()
    await screen.findByRole('alertdialog', { name: 'Save changes to a.ts?' })
    const save = screen.getByRole('button', { name: 'Save' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(document.activeElement).toBe(save)

    // From the last button, Tab wraps to the first instead of leaving the dialog.
    act(() => cancel.focus())
    fireEvent.keyDown(cancel, { key: 'Tab' })
    expect(document.activeElement).toBe(save)

    // And Shift+Tab from the first wraps to the last.
    fireEvent.keyDown(save, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)

    // Focus that somehow got behind the backdrop is brought back in.
    act(() => screen.getByRole('button', { name: 'Behind the dialog' }).focus())
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(save)
  })

  it('answers the cancel button for Escape', async () => {
    const answers = open()
    await screen.findByRole('alertdialog', { name: 'Save changes to a.ts?' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await act(async () => {})
    expect(answers).toEqual(['cancel'])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
