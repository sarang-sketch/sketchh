// The editor's two bridges to the model: ghost-text autocomplete, and "do something
// with this code" actions from the context menu.
//
// AUTOCOMPLETE is the status-bar toggle. When it is on, a pause in typing asks the
// engine's `complete` method for the text to insert at the caret, with the model the
// user picked for chat. Monaco renders the answer as ghost text; Tab accepts it. A
// request the user typed past is abandoned, both here and in the engine. Three failures
// in a row turn the feature off and say why, instead of failing silently on every key.
//
// EDITOR ACTIONS (Explain, Fix, Tests, Ask, Edit…) build a prompt from the selection and
// send it through the ONE agent session, so they run exactly like a typed message —
// same mode, same permissions, same Stop.

import { useCallback, useMemo, useRef } from 'react'

import { useSketchClient } from '../lib/ClientProvider'
import { resolveApiKeyForRun } from '../lib/secrets'
import { useOptionalAgentSession } from '../lib/AgentSession'
import { useAppDispatch, useAppState } from '../state/AppState'
import type { EditorAgentRequest } from './CodeEditor'
import type { GhostCompletionProvider } from './ghostCompletion'
import { relativeToRoot } from './paths'

/** Consecutive failures after which autocomplete switches itself off. */
const MAX_FAILURES = 3
/** Characters of selected code quoted into a prompt. */
const MAX_QUOTED = 8_000

/** A completion provider backed by the engine, or undefined when the transport has none. */
export function useInlineCompletionProvider(): GhostCompletionProvider | undefined {
  const client = useSketchClient()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const latest = useRef(state)
  latest.current = state
  const failures = useRef(0)

  return useMemo<GhostCompletionProvider | undefined>(() => {
    if (client.complete === undefined) return undefined
    return async (request) => {
      const snapshot = latest.current
      const selected = snapshot.providers.find((entry) => entry.id === snapshot.selectedProvider)
      if (selected === undefined) return null
      const provider =
        snapshot.selectedModel !== null && snapshot.selectedModel !== selected.model
          ? { ...selected, model: snapshot.selectedModel }
          : selected
      // Resolved per request and dropped, exactly like a run's key (see lib/secrets.ts).
      const apiKey = await resolveApiKeyForRun(provider.id)
      if (request.signal.aborted) return null
      const root = snapshot.projectRoot
      try {
        const result = await client.complete!(
          {
            provider,
            ...(apiKey !== null ? { apiKey } : {}),
            path: root !== null ? relativeToRoot(root, request.path) : request.path,
            ...(request.language !== undefined ? { language: request.language } : {}),
            prefix: request.content.slice(0, request.cursorOffset),
            suffix: request.content.slice(request.cursorOffset),
          },
          { signal: request.signal },
        )
        failures.current = 0
        return result.text === '' ? null : result.text
      } catch (err) {
        if (request.signal.aborted) return null
        failures.current += 1
        if (failures.current >= MAX_FAILURES) {
          failures.current = 0
          dispatch({ type: 'SET_GHOST_COMPLETIONS', payload: false })
          dispatch({
            type: 'SET_EDITOR_NOTICE',
            payload: {
              level: 'error',
              message: `Autocomplete was switched off after repeated errors from ${provider.label || provider.id}: ${
                err instanceof Error ? err.message : String(err)
              }. Check the model in Settings, then turn it back on in the status bar.`,
            },
          })
        }
        return null
      }
    }
  }, [client, dispatch])
}

/** What inline edit (Ctrl+K) sends: the file around the selection, and the instruction. */
export interface InlineEditInput {
  /** Canonical absolute path. */
  path: string
  language?: string
  before: string
  selection: string
  after: string
  instruction: string
}

/** Asks the model for the replacement; rejects with a sentence a person can act on. */
export type InlineEditRunner = (input: InlineEditInput, signal: AbortSignal) => Promise<string>

/**
 * Inline edit through the engine, with the model the user picked for chat. Undefined
 * when the transport has no inline edit (the editor then sends Ctrl+K to the chat).
 */
export function useInlineEditRunner(): InlineEditRunner | undefined {
  const client = useSketchClient()
  const state = useAppState()
  const latest = useRef(state)
  latest.current = state

  return useMemo<InlineEditRunner | undefined>(() => {
    if (client.inlineEdit === undefined) return undefined
    return async (input, signal) => {
      const snapshot = latest.current
      const selected = snapshot.providers.find((entry) => entry.id === snapshot.selectedProvider)
      if (selected === undefined) {
        throw new Error('Connect a model first: Settings → Models, or Connect a Model in the Help menu.')
      }
      const provider =
        snapshot.selectedModel !== null && snapshot.selectedModel !== selected.model
          ? { ...selected, model: snapshot.selectedModel }
          : selected
      const apiKey = await resolveApiKeyForRun(provider.id)
      if (signal.aborted) throw new Error('Stopped.')
      const root = snapshot.projectRoot
      const result = await client.inlineEdit!(
        {
          provider,
          ...(apiKey !== null ? { apiKey } : {}),
          path: root !== null ? relativeToRoot(root, input.path) : input.path,
          ...(input.language !== undefined ? { language: input.language } : {}),
          before: input.before,
          selection: input.selection,
          after: input.after,
          instruction: input.instruction,
        },
        { signal },
      )
      if (result.cancelled === true) {
        throw new Error(signal.aborted ? 'Stopped.' : 'The model did not answer within two minutes. Try again, or pick a faster model.')
      }
      if (result.text === '') {
        throw new Error(`${provider.label || provider.id} did not return any code. Try describing the change another way.`)
      }
      return result.text
    }
  }, [client])
}

function fence(code: string, path: string): string {
  const ext = path.split('.').pop() ?? ''
  const body = code.length > MAX_QUOTED ? `${code.slice(0, MAX_QUOTED)}\n… (selection truncated)` : code
  return `\`\`\`${/^[a-z0-9]+$/i.test(ext) ? ext : ''}\n${body}\n\`\`\``
}

/** The handler the editor's context-menu actions call. */
export function useEditorAgentActions(): (request: EditorAgentRequest) => void {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const session = useOptionalAgentSession()
  const latest = useRef(state)
  latest.current = state

  return useCallback(
    (request: EditorAgentRequest) => {
      const snapshot = latest.current
      const root = snapshot.projectRoot
      const rel = root !== null ? relativeToRoot(root, request.path) : request.path
      const where = request.lines === null ? `\`${rel}\`` : `\`${rel}\` (lines ${request.lines.start}–${request.lines.end})`
      const quoted = request.code.trim() !== '' ? `\n\n${fence(request.code, rel)}` : ''

      // The chat is where the answer appears: make sure it is on screen.
      if (snapshot.rightPanelCollapsed) dispatch({ type: 'TOGGLE_RIGHT_PANEL' })

      if (request.kind === 'ask' || request.kind === 'edit') {
        const instruction = request.instruction?.trim() ?? ''
        dispatch({
          type: 'SEED_COMPOSER',
          payload: {
            text: request.kind === 'edit' ? `Edit ${where}: ${instruction}` : `About ${where}: `,
            files: [rel],
          },
        })
        return
      }
      if (session === null) return
      const prompts: Record<'explain' | 'fix' | 'tests', string> = {
        explain: `Explain this code from ${where}: what it does, how it fits into the project, and anything surprising.${quoted}`,
        fix:
          `Find and fix bugs in this code from ${where}. Explain the root cause of each, make the smallest correct change, ` +
          `then run the project's checks.${quoted}`,
        tests:
          `Write tests for this code from ${where}, using the project's existing test framework and style. ` +
          `Cover the edge cases, run them, and make them pass.${quoted}`,
      }
      const labels = { explain: 'Explain', fix: 'Fix bugs in', tests: 'Write tests for' }
      session.send(prompts[request.kind], {
        files: [rel],
        display: `${labels[request.kind]} ${where}`,
        ...(request.kind === 'explain' ? { mode: 'ask' as const } : {}),
      })
    },
    [dispatch, session],
  )
}
