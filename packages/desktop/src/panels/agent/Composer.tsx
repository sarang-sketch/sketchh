// The message composer shared by Cowork and the Code sidebar.
//
// What a person can do here, the same way they would in Claude Code or Codex:
//   * type a request and press Enter (Shift+Enter for a new line);
//   * pick how much the agent may do — Ask / Agent / Auto — and cycle with Shift+Tab;
//   * type `/` for commands (built-ins, the project's `.sketch/commands/*.md`, installed
//     skills), `@` to point at a file with fuzzy search, or `+` to attach open files;
//   * answer a paused run, or Allow / Deny a command it wants to run.
//
// Nothing here talks to a model: it builds a prompt and hands it to the one agent
// session, so every path — typed, slash command, editor action — runs the same way.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import styles from './AgentChat.module.css'
import ui from './Composer.module.css'
import { AlertTriangle, FileCode, Mic, Plus, Send, Shield, Sparkles, Stop, Terminal, X, Zap } from '../../components/Icons'
import { ModelSelector } from '../../components/ModelSelector'
import { useVoiceInput } from '../../lib/useVoiceInput'
import { useAppDispatch, useAppState, AGENT_MODES, AGENT_SPEEDS, type AgentMode, type AgentSpeed, type ChatMessage } from '../../state/AppState'
import { useComposerDraft } from '../../state/ComposerDrafts'
import { useAgentSession } from '../../lib/AgentSession'
import { conversationRootRelation, relativeToRoot } from '../../editor/paths'
import { fuzzyFilter } from '../../lib/fuzzy'
import { isComposing } from '../../lib/keys'
import { parseSlash, type AppAction, type MenuCommand } from '../../lib/slashCommands'
import { useCommandMenu, useProjectFiles } from '../../lib/useProjectIndex'

const MODE_INFO: Record<AgentMode, { label: string; hint: string }> = {
  ask: { label: 'Ask', hint: 'Read-only. Answers, explains and plans — never changes a file or runs a command.' },
  agent: { label: 'Agent', hint: 'Edits files (every run can be undone) and asks you before running any command.' },
  auto: {
    label: 'Auto',
    hint:
      'Works to completion without interrupting you: edits, runs tests and builds, fixes what fails. ' +
      'Commands that look destructive (deleting folders, pushing, publishing) still need your OK. It is not a sandbox.',
  },
}

export function nextMode(mode: AgentMode): AgentMode {
  return AGENT_MODES[(AGENT_MODES.indexOf(mode) + 1) % AGENT_MODES.length]!
}

function ModeIcon({ mode }: { mode: AgentMode }) {
  if (mode === 'ask') return <Shield size={11} />
  if (mode === 'auto') return <Zap size={11} />
  return <Sparkles size={11} />
}

/** Ask / Agent / Auto. Shift+Tab in the composer cycles it. */
export function ModeSwitcher() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const mode = state.agentPrefs.mode
  return (
    <div className={ui.modeGroup} dir="ltr" role="radiogroup" aria-label="Agent mode">
      {AGENT_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          className={`${ui.modeBtn} ${mode === m ? ui[`mode_${m}`] : ''}`}
          title={`${MODE_INFO[m].label}: ${MODE_INFO[m].hint} (Shift+Tab to switch)`}
          onClick={() => dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: m } })}
        >
          <ModeIcon mode={m} />
          {MODE_INFO[m].label}
        </button>
      ))}
    </div>
  )
}

const SPEED_INFO: Record<AgentSpeed, { label: string; hint: string }> = {
  normal: {
    label: 'Normal',
    hint: 'The full agent: up to the configured number of turns, with the last 12 turns of context.',
  },
  turbo: {
    label: 'Turbo',
    hint: 'Faster and lighter: turns capped at 10 (20 in Auto) and only the last 6 turns of context. Same model, same permissions — it just stops sooner and reads less.',
  },
}

/**
 * Normal / Turbo speed. This is the control the user reported as displaying in
 * the wrong direction: it did not exist in the committed code at all (only
 * Ask/Agent/Auto did), so a local Turbo toggle had nowhere to live. It is a
 * plain left-to-right segmented control — Normal first, Turbo second — with an
 * explicit `dir="ltr"` and `flex-direction: row` in CSS, so no ancestor's
 * direction or flex reversal can flip it. Speed is orthogonal to mode: it caps
 * turns and context (see modeRunOptions), it never switches the model.
 */
export function SpeedSwitcher() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const speed = state.agentPrefs.speed
  return (
    <div className={ui.speedGroup} dir="ltr" role="radiogroup" aria-label="Speed">
      {AGENT_SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={speed === s}
          className={`${ui.speedBtn} ${speed === s ? ui[`speed_${s}`] : ''}`}
          title={`${SPEED_INFO[s].label}: ${SPEED_INFO[s].hint}`}
          onClick={() => dispatch({ type: 'SET_AGENT_PREFS', payload: { speed: s } })}
        >
          {s === 'turbo' && <Zap size={11} />}
          {SPEED_INFO[s].label}
        </button>
      ))}
    </div>
  )
}

/** A command waiting for Allow / Deny, shown above the composer in both surfaces. */
export function ApprovalCard() {
  const session = useAgentSession()
  const approval = session.pendingApproval
  if (approval === null) return null
  return (
    <div className={ui.approval} role="alertdialog" aria-label="Command approval">
      <div className={ui.approvalHead}>
        <Terminal size={13} /> The agent wants to run a command
      </div>
      <pre className={ui.approvalCmd}>{approval.command}</pre>
      {approval.cwd !== '.' && <div className={ui.approvalMeta}>in {approval.cwd}</div>}
      {approval.risk !== null && (
        <div className={ui.approvalRisk}>
          <AlertTriangle size={12} /> Asked because {approval.risk}.
        </div>
      )}
      <div className={ui.approvalActions}>
        <button type="button" className={`${ui.approvalBtn} ${ui.approvalAllow}`} onClick={() => session.approve('allow')}>
          Allow
        </button>
        {approval.risk === null && (
          <button type="button" className={ui.approvalBtn} onClick={() => session.approve('allow-always')} title="Do not ask again for this command during this run">
            Allow for this run
          </button>
        )}
        <button type="button" className={ui.approvalBtn} onClick={() => session.approve('deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}

type Menu =
  | { kind: 'slash'; query: string }
  | { kind: 'mention'; query: string; start: number; end: number }
  | null

/** Which menu the text at the caret calls for, if any. */
export function menuAt(text: string, caret: number): Menu {
  const head = text.slice(0, caret)
  if (/^\/[^\s]*$/.test(head)) return { kind: 'slash', query: head.slice(1) }
  const mention = /(^|\s)@([^\s@]*)$/.exec(head)
  if (mention !== null) {
    const query = mention[2] ?? ''
    return { kind: 'mention', query, start: head.length - query.length - 1, end: caret }
  }
  return null
}

/** Paths written as `@path` in a message. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/(^|\s)@([^\s]+)/g)) {
    const path = match[2]!.replace(/[.,;:!?)]+$/, '')
    if (path !== '' && !out.includes(path)) out.push(path)
  }
  return out
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

export function Composer({
  placeholder,
  rows,
  compact,
  acceptSeeds = false,
  surface = 'ide',
}: {
  placeholder: string
  rows: number
  compact: boolean
  /** Take text placed by an editor action (Ask about / Edit this code). One composer per window does. */
  acceptSeeds?: boolean
  surface?: 'agent' | 'ide'
}) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const session = useAgentSession()
  const commands = useCommandMenu()
  const { text, attached, setText, setAttached } = useComposerDraft()
  const [caret, setCaret] = useState(text.length)
  // Dictation: final transcripts are appended to the draft, so a spoken sentence
  // never wipes what was already typed. Unsupported browsers get a disabled
  // button with a plain title instead of a dead one.
  const voice = useVoiceInput({
    onFinal: (spoken) => {
      setText((current) => {
        const joined = current === '' ? spoken : `${current}${current.endsWith(' ') ? '' : ' '}${spoken}`
        setCaret(joined.length)
        return joined
      })
    },
  })
  const [attachOpen, setAttachOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const attachWrapRef = useRef<HTMLDivElement | null>(null)
  const running = session.activeRunId !== null
  const answering = session.pendingQuestion !== null || session.pendingApproval !== null

  const seed = state.composerSeed
  useEffect(() => {
    if (!acceptSeeds || seed === null || state.mode !== surface || (surface === 'agent' && state.agentView !== 'new_task')) return
    if (!seed.preserveText) {
      setText(seed.text)
      setCaret(seed.text.length)
    }
    setAttached((current) => [...new Set([...current, ...seed.files])])
    dispatch({ type: 'CLEAR_COMPOSER_SEED' })
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      const length = inputRef.current?.value.length ?? 0
      inputRef.current?.setSelectionRange(length, length)
    })
  }, [acceptSeeds, dispatch, seed, state.mode, state.agentView, surface, setText, setAttached])

  useEffect(() => {
    if (!acceptSeeds || state.mode !== surface || (surface === 'agent' && state.agentView !== 'new_task') || state.composerFocusNonce === 0) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [acceptSeeds, state.composerFocusNonce, state.mode, state.agentView, surface])

  // The attach popover behaves like every other popover: a click elsewhere or
  // Escape closes it. The trigger sits inside the wrapper, so using it to close
  // still works as a plain toggle.
  useEffect(() => {
    if (!attachOpen) return
    const onDown = (event: PointerEvent) => {
      if (attachWrapRef.current !== null && !attachWrapRef.current.contains(event.target as Node)) setAttachOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAttachOpen(false)
        inputRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [attachOpen])

  const menu = dismissed ? null : menuAt(text, caret)
  const { files } = useProjectFiles(menu?.kind === 'mention' || attachOpen)

  const items: Array<{ key: string; label: string; detail: string; badge?: string; command?: MenuCommand; path?: string }> = useMemo(() => {
    if (menu === null) return []
    if (menu.kind === 'slash') {
      return fuzzyFilter(commands, menu.query, (c) => c.name, 10).map((c) => ({
        key: `cmd:${c.name}`,
        label: `/${c.name}${c.argumentHint !== undefined ? ` ${c.argumentHint}` : ''}`,
        detail: c.description,
        ...(c.source !== 'builtin' ? { badge: c.source === 'skill' ? 'skill' : c.source } : {}),
        command: c,
      }))
    }
    return fuzzyFilter(files, menu.query, (f) => f, 10).map((path) => ({
      key: `file:${path}`,
      label: path.split('/').pop() ?? path,
      detail: path,
      path,
    }))
  }, [commands, files, menu])

  useEffect(() => setSelected(0), [menu?.kind, menu?.query])

  const activeRel = state.activeFile && state.projectRoot ? relativeToRoot(state.projectRoot, state.activeFile) : null

  // A conversation that ran OUTSIDE the open workspace must not be continued here: its
  // history and file references are relative to a folder Sketch has not opened, so a run
  // would execute against the wrong root. Sending is blocked with that reason; the user
  // opens that folder (AgentChat's notice + guarded Open-folder button) to continue it.
  // (W2 invariant 1-2; the lead's product decision for round 2.)
  const activeConversation = state.conversations.find((c) => c.id === state.activeConversationId)
  const rootOutsideWorkspace =
    conversationRootRelation(state.projectRoot, activeConversation?.root ?? null) === 'outside'

  const note = (content: string) =>
    dispatch({ type: 'ADD_MESSAGE', payload: { id: newId(), role: 'system', content, timestamp: Date.now() } })

  const runAction = (action: AppAction) => {
    switch (action) {
      case 'clear':
        dispatch({ type: 'NEW_CONVERSATION' })
        return
      case 'undo': {
        const last = [...state.chatMessages].reverse().find((m: ChatMessage) => m.role === 'agent' && m.filesState === 'applied')
        if (last === undefined) note('There is nothing to undo in this conversation.')
        else void session.undo(last)
        return
      }
      case 'model':
        dispatch({ type: 'OPEN_SETTINGS', payload: 'models' })
        return
      case 'connect':
        dispatch({ type: 'OPEN_CONNECT' })
        return
      case 'settings':
        dispatch({ type: 'OPEN_SETTINGS' })
        return
      case 'skills':
        if (state.mode === 'agent') dispatch({ type: 'SET_AGENT_VIEW', payload: 'customize' })
        else dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'skills' })
        return
      case 'help':
        note(
          'Type a request and press Enter. "/" lists commands (' +
            commands.slice(0, 12).map((c) => `/${c.name}`).join(', ') +
            ', …), "@" mentions a file, Shift+Tab switches Ask / Agent / Auto, Ctrl+P opens a file, Ctrl+Shift+P runs any command.',
        )
        return
      case 'mode:ask':
      case 'mode:agent':
      case 'mode:auto':
        dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: action.slice(5) as AgentMode } })
        return
    }
  }

  const clear = () => {
    setText('')
    setCaret(0)
    setAttached([])
    setDismissed(false)
  }

  const submit = (raw = text) => {
    const value = raw.trim()
    if (value === '') return
    const files = [...new Set([...attached, ...mentionedPaths(value)])]
    const slash = parseSlash(value)
    const command = slash === null ? undefined : commands.find((c) => c.name === slash.name)
    // A pure local action (/clear, /undo) does not run against a root, so it is allowed
    // even for an out-of-workspace conversation.
    const isLocalAction = slash !== null && command !== undefined && command.action !== undefined
    // Block anything that would START A RUN against the wrong root.
    if (rootOutsideWorkspace && !isLocalAction) {
      note(
        `This conversation ran in ${activeConversation?.root ?? 'another folder'}, which is not the folder you have open. ` +
          `Open that folder to continue it — its history and file references are relative to it.`,
      )
      return
    }
    if (slash !== null && command !== undefined) {
      if (command.action !== undefined) {
        runAction(command.action)
        clear()
        return
      }
      const prompt = command.expand?.(slash.args, { file: activeRel }) ?? value
      session.send(prompt, {
        files,
        display: value,
        ...(command.skillNames !== undefined ? { skillNames: command.skillNames } : {}),
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
      })
      clear()
      return
    }
    session.send(value, { files })
    clear()
  }

  const pick = (index: number, execute: boolean) => {
    const item = items[index]
    if (item === undefined || menu === null) return
    if (menu.kind === 'slash' && item.command !== undefined) {
      const c = item.command
      if (execute && (c.action !== undefined || c.argumentHint === undefined)) {
        submit(`/${c.name}`)
        return
      }
      const next = `/${c.name} `
      setText(next)
      setCaret(next.length)
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.length, next.length))
      return
    }
    if (menu.kind === 'mention' && item.path !== undefined) {
      const next = `${text.slice(0, menu.start)}@${item.path} ${text.slice(menu.end)}`
      const at = menu.start + item.path.length + 2
      setText(next)
      setCaret(at)
      if (!attached.includes(item.path)) setAttached([...attached, item.path])
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at))
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter and the arrows belong to the input method while it is composing a word.
    if (isComposing(e)) return
    if (menu !== null && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        // From the latest value: a held key repeats faster than React re-renders.
        setSelected((current) => (current + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((current) => (current - 1 + items.length) % items.length)
        return
      }
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pick(selected, e.key === 'Enter')
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: nextMode(state.agentPrefs.mode) } })
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (running && !answering) return
      submit()
    }
  }

  const openPaths = state.projectRoot
    ? state.openFiles.map((path) => relativeToRoot(state.projectRoot!, path)).filter((path) => !attached.includes(path))
    : []

  const effectivePlaceholder = session.pendingApproval !== null
    ? 'Allow the command above? Type yes, always or no…'
    : session.pendingQuestion !== null
      ? 'Answer the question above...'
      : placeholder

  return (
    <>
      {attached.length > 0 && (
        <div className={styles.attachedRow}>
          {attached.map((path) => (
            <span key={path} className={styles.attachedChip}>
              <FileCode size={11} /> {path}
              <button aria-label={`Remove ${path}`} onClick={() => setAttached(attached.filter((p) => p !== path))}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={ui.inputWrap}>
        {menu !== null && items.length > 0 && (
          <div className={ui.menu} role="listbox" aria-label={menu.kind === 'slash' ? 'Commands' : 'Files'}>
            <div className={ui.menuTitle}>{menu.kind === 'slash' ? 'Commands' : 'Files'} <span>↑↓ to move · Enter to pick · Esc to close</span></div>
            {items.map((item, index) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={index === selected}
                className={`${ui.menuItem} ${index === selected ? ui.menuItemActive : ''}`}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(index, false)
                }}
              >
                <span className={ui.menuLabel}>{item.label}</span>
                {item.badge !== undefined && <span className={ui.menuBadge}>{item.badge}</span>}
                <span className={ui.menuDetail}>{item.detail}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className={styles.promptInput}
          placeholder={effectivePlaceholder}
          rows={rows}
          value={text}
          aria-label="Message the agent"
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart ?? e.target.value.length)
            setDismissed(false)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className={styles.promptCardBottomRow} style={compact ? { borderBottom: 'none', marginBottom: 0, paddingBottom: 0 } : undefined}>
        <div className={styles.leftActions}>
          <div className={styles.attachWrap} ref={attachWrapRef}>
            <button className={styles.attachBtn} title="Point the agent at files (or type @)" aria-label="Attach files" onClick={() => setAttachOpen(!attachOpen)}>
              <Plus size={16} />
            </button>
            {attachOpen && (
              <AttachMenu
                openPaths={openPaths}
                files={files}
                attached={attached}
                hasRoot={state.projectRoot !== null}
                onAdd={(path) => {
                  if (!attached.includes(path)) setAttached([...attached, path])
                }}
                onClose={() => setAttachOpen(false)}
              />
            )}
          </div>
          <SpeedSwitcher />
          <ModeSwitcher />
          <button
            className={styles.attachBtn}
            aria-label={voice.listening ? 'Stop dictation' : 'Dictate'}
            title={
              !voice.supported
                ? 'Voice input is not available in this browser'
                : voice.listening
                  ? 'Listening… click to stop'
                  : 'Dictate (speech recognition)'
            }
            disabled={!voice.supported}
            onClick={() => {
              if (voice.listening) voice.stop();
              else voice.start();
            }}
            style={voice.listening ? { color: 'var(--accent, #f58a50)' } : undefined}
          >
            <Mic size={16} />
          </button>
          {voice.listening && <span style={{ fontSize: 12, opacity: 0.8 }}>Listening…</span>}
          {voice.error !== null && (
            <span style={{ fontSize: 12, opacity: 0.8 }} role="alert" title={voice.error}>
              Voice input failed
            </span>
          )}
        </div>
        <div className={styles.promptRightActions}>
          <ModelSelector />
          <button
            className={`${styles.sendCircleBtn} ${!rootOutsideWorkspace && (running || text.trim()) ? styles.sendActive : ''}`}
            onClick={running && !answering ? session.stop : () => submit()}
            disabled={rootOutsideWorkspace && !(running && !answering)}
            title={
              running && !answering
                ? 'Stop this run'
                : rootOutsideWorkspace
                  ? 'This conversation ran in another folder — open that folder to continue it'
                  : 'Send (Enter)'
            }
            aria-label={running && !answering ? 'Stop this run' : 'Send'}
          >
            {running && !answering ? <Stop size={12} /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </>
  )
}

/** "+": open tabs first, then a fuzzy search over every project file. */
function AttachMenu({
  openPaths,
  files,
  attached,
  hasRoot,
  onAdd,
  onClose,
}: {
  openPaths: string[]
  files: string[]
  attached: readonly string[]
  hasRoot: boolean
  onAdd: (path: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const matches = useMemo(
    () => (query.trim() === '' ? [] : fuzzyFilter(files.filter((f) => !attached.includes(f)), query, (f) => f, 8)),
    [attached, files, query],
  )
  return (
    <div className={styles.attachMenu} role="dialog" aria-label="Attach files">
      <div className={styles.attachTitle}>
        Point the agent at files
        <button className={styles.attachClose} onClick={onClose} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      {!hasRoot ? (
        <div className={styles.attachHint}>Open a project folder first.</div>
      ) : (
        <>
          <input
            className={styles.attachInput}
            placeholder="Search files…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e)) return
              if (e.key === 'Enter' && matches[0] !== undefined) {
                e.preventDefault()
                onAdd(matches[0])
                setQuery('')
              }
              if (e.key === 'Escape') onClose()
            }}
            aria-label="Search project files"
          />
          <div className={styles.attachList}>
            {(query.trim() === '' ? openPaths.slice(0, 8) : matches).map((path) => (
              <button key={path} className={styles.attachOption} onClick={() => onAdd(path)}>
                <FileCode size={12} /> {path}
              </button>
            ))}
          </div>
          <div className={styles.attachHint}>Tip: type @ in the message to mention a file inline.</div>
        </>
      )}
    </div>
  )
}
