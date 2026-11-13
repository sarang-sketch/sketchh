// EGM Design & Review — the visible entry point for the Elephant-Goldfish
// Model in the desktop IDE.
//
// Elephant holds the project context and drafts the spec; Goldfish reviewers
// read the draft with NO prior conversation; you approve the spec before
// anything is built. The panel lists the seven skills, starts each one in the
// chat, and — for reviews — shows exactly what the reviewers will see.
//
// THE FRESH-CONTEXT RULE, AND THE HONEST LIMIT. A Goldfish review runs in a
// fresh session: the run is sent with an empty history, so the reviewers
// never see the drafting conversation. Sketch cannot yet spawn isolated
// subagent contexts, so the five stages run sequentially in that one fresh
// session instead of in five isolated ones. The panel says that, and the
// review report says it too — a same-conversation "review" would not be a
// Goldfish review at all, so the panel refuses to start one that way.

import { useState } from 'react'
import { Brain, Copy } from '../components/Icons'
import { useAppDispatch, useAppState } from '../state/AppState'
import { useComposerDraft } from '../state/ComposerDrafts'
import { useOptionalSketchClient } from '../lib/ClientProvider'
import { useOptionalAgentSession } from '../lib/AgentSession'
import { EGM_COMMANDS, type EgmCommandDef } from '../lib/egm'
import type { EgmGoldfishContextResult } from '../lib/client'
import styles from './ToolsPanels.module.css'

const EGM_SOURCE_URL = 'https://github.com/google/elephant-goldfish-model'

export function EgmPanel() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const client = useOptionalSketchClient()
  const session = useOptionalAgentSession()
  const { setText } = useComposerDraft()
  const [target, setTarget] = useState(() =>
    state.activeFile !== null && state.activeFile.endsWith('.md') ? state.activeFile : '',
  )
  const [preview, setPreview] = useState<EgmGoldfishContextResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const projectRoot = state.projectRoot
  const runInFlight = session?.activeRunId !== null && session?.activeRunId !== undefined

  /** Open the chat with a command prefilled, ready to send. */
  const prefillChat = (text: string) => {
    setText(text)
    dispatch({ type: 'SET_MODE', payload: 'agent' })
    dispatch({ type: 'FOCUS_COMPOSER' })
  }

  /**
   * Start a command. Review commands go through a fresh session: a new
   * conversation (the old one stays in Recents) and a run sent with an empty
   * history, so the reviewers see only the document and its linked files.
   * Other commands just prefill the composer in the current chat.
   */
  const startCommand = (command: EgmCommandDef) => {
    const arg = command.freshSession === true ? target.trim() : ''
    const prompt = command.expand(arg, { file: state.activeFile })
    if (command.freshSession === true && session !== null) {
      dispatch({ type: 'NEW_CONVERSATION' })
      session.send(prompt, {
        display: `/${command.name}${arg !== '' ? ` ${arg}` : ''}`,
        skillNames: [command.name],
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
        // The Goldfish property: this run's model-visible history is empty.
        history: [],
      })
      setNotice(`Fresh review started: /${command.name} in a new conversation with no prior chat history.`)
      return
    }
    if (command.freshSession === true) {
      // No live session (e.g. the mock transport): still start fresh, via a
      // new conversation, and let the user send it.
      dispatch({ type: 'NEW_CONVERSATION' })
      prefillChat(`/${command.name}${arg !== '' ? ` ${arg}` : ''}`)
      setNotice('New conversation started. Press Enter to run the review with no prior chat history.')
      return
    }
    prefillChat(`/${command.name} `)
  }

  const copyCommand = (command: EgmCommandDef) => {
    void navigator.clipboard?.writeText(`/${command.name} `).catch(() => {})
    setNotice(`Copied /${command.name} — paste it in the chat.`)
  }

  const previewContext = async () => {
    if (projectRoot === null) {
      setPreviewError('Open a folder first — the reviewers read files from the project.')
      return
    }
    if (target.trim() === '') {
      setPreviewError('Enter a design document path first.')
      return
    }
    if (client?.egmGoldfishContext === undefined) {
      setPreviewError('This transport does not offer the reviewer-context preview.')
      return
    }
    setPreviewLoading(true)
    setPreviewError(null)
    setPreview(null)
    try {
      const result = await client.egmGoldfishContext({ root: projectRoot, target: target.trim() })
      if (!result.ok) {
        setPreviewError(result.error ?? 'The reviewer context could not be built.')
      } else {
        setPreview(result)
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewLoading(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Brain size={16} />
          <span>EGM Design &amp; Review</span>
        </div>
      </div>
      <div className={styles.body}>
        <p className={styles.note}>
          Elephant drafts the spec with full project context. Goldfish reviewers
          read it with no prior conversation, to expose unstated assumptions.
          You approve it before anything is built.
        </p>
        <p className={styles.note}>
          Adapted from Google&apos;s Elephant-Goldfish Model ({EGM_SOURCE_URL}),
          Apache-2.0. The seven skills install from the Skills panel (egm pack);
          the commands below work from their prompt even before installing.
        </p>
        <p className={styles.note} role="note">
          Honest limit: Sketch runs the five review stages sequentially in one
          fresh session. It cannot yet spawn isolated subagent contexts, so a
          review is fresh-eyes — never the drafting conversation — but the
          stages share that one session.
        </p>

        <h3 className={styles.sectionTitle}>Workflow</h3>
        <ol className={styles.list}>
          <li><strong>Brainstorm</strong> the idea → <code>concepts_brief.md</code></li>
          <li><strong>Draft</strong> the design, section by section → <code>design_draft.md</code></li>
          <li><strong>Review</strong> it with Goldfish reviewers → stage reports</li>
          <li><strong>Resolve</strong> the findings → <code>goldfish_review_report.md</code></li>
          <li>Approve, save under <code>docs/designs/</code>, then implement</li>
        </ol>

        <h3 className={styles.sectionTitle}>Skills</h3>
        <ul className={styles.list}>
          {EGM_COMMANDS.map((command) => (
            <li key={command.name} className={styles.row}>
              <div className={styles.rowTitle}>
                {command.title} <code>/{command.name}</code>
                {command.freshSession === true ? <span className={styles.badge}>fresh session</span> : null}
              </div>
              <div className={styles.rowDetail}>{command.description}</div>
              <div className={styles.rowMeta}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={runInFlight}
                  onClick={() => startCommand(command)}
                >
                  {command.freshSession === true ? 'Run fresh review' : 'Use in chat'}
                </button>
                <button type="button" className={styles.button} onClick={() => copyCommand(command)} aria-label={`Copy /${command.name}`}>
                  <Copy size={14} /> Copy
                </button>
              </div>
            </li>
          ))}
        </ul>

        <h3 className={styles.sectionTitle}>What reviewers will see</h3>
        <label className={styles.label} htmlFor="egm-target">
          Design document
        </label>
        <input
          id="egm-target"
          className={styles.input}
          value={target}
          onChange={(e) => {
            setTarget(e.target.value)
            setPreview(null)
            setPreviewError(null)
          }}
          placeholder="docs/designs/webhooks.md"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className={styles.rowMeta}>
          <button type="button" className={styles.button} disabled={previewLoading} onClick={() => void previewContext()}>
            {previewLoading ? 'Reading…' : 'Preview reviewer context'}
          </button>
        </div>
        {previewError !== null ? <div className={styles.error} role="alert">{previewError}</div> : null}
        {preview !== null && preview.ok ? (
          <div className={styles.note} role="status">
            <div>Target: <code>{preview.target?.path}</code></div>
            <div>
              Linked files the reviewers will read ({preview.files?.length ?? 0}):
              {(preview.files?.length ?? 0) === 0
                ? ' none'
                : ` ${preview.files?.map((f) => f.path).join(', ')}`}
            </div>
            {(preview.excluded?.length ?? 0) > 0 ? (
              <div>
                Left out ({preview.excluded?.length}):{' '}
                {preview.excluded?.map((e) => `${e.link} (${e.reason})`).join(', ')}
              </div>
            ) : null}
            <div>Prior chat turns the reviewers will see: <strong>{preview.priorChatTurns ?? 0}</strong></div>
          </div>
        ) : null}

        {notice !== null ? <div className={styles.note} role="status">{notice}</div> : null}
        {projectRoot === null ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyText}>No folder open</div>
            <p className={styles.emptySubtext}>
              EGM writes briefs, drafts, and reports into the project. Open a folder to use it.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
