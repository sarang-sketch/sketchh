import { useEffect, useRef, useState } from 'react';
import styles from './AgentChat.module.css';
import { Sparkles, Folder, Key, AlertTriangle, Info, Copy, Check, Refresh } from '../../components/Icons';
import { Markdown } from '../../components/Markdown';
import { ChangedFilesCard, LiveRun, RunReceiptLine, RunSteps } from '../../components/RunCards';
import { useAppState, useAppDispatch, type ChatMessage } from '../../state/AppState';
import { useFileActions } from '../../editor/useFileActions';
import { canonicalPath, conversationRootRelation, relativeToRoot } from '../../editor/paths';
import { insertEditorText } from '../../editor/editorBridge';
import { useSketchEvents } from '../../lib/ClientProvider';
import { AgentSessionProvider, useOptionalAgentSession, useAgentSession, NORMAL_MAX_TURNS, TURBO_MAX_TURNS } from '../../lib/AgentSession';
import { contextSummary, formatContextSummary } from '../../lib/contextMeter';
import { ApprovalCard, Composer } from './Composer';

// The composer lives in its own module; it is re-exported here because both chat
// surfaces have always imported it from this file.
export { Composer } from './Composer';

import { CoworkHome } from './CoworkHome';

export const AgentChat: React.FC = () => {
  // Production mounts one session for the window (App.tsx). A panel rendered on its
  // own — a test, a storybook — brings its own, so it is never sessionless.
  const shared = useOptionalAgentSession();
  if (shared === null) {
    return (
      <AgentSessionProvider>
        <AgentChatView />
      </AgentSessionProvider>
    );
  }
  return <AgentChatView />;
};

export function Blocker() {
  const session = useAgentSession();
  const dispatch = useAppDispatch();
  const fileActions = useFileActions();
  const blocker = session.blocker;
  if (blocker === null) return null;
  return (
    <div className={styles.blocker} role="status">
      <Info size={14} />
      <span>{blocker.reason}</span>
      {blocker.action === 'connect' && (
        <button className={styles.blockerBtn} onClick={() => dispatch({ type: 'OPEN_CONNECT' })}>
          <Key size={12} /> Connect a model
        </button>
      )}
      {blocker.action === 'folder' && (
        <button className={styles.blockerBtn} onClick={() => void fileActions.openFolder()}>
          <Folder size={12} /> Open folder
        </button>
      )}
    </div>
  );
}

/** Within this many pixels of the end counts as "at the end": new output is followed. */
const FOLLOW_SLACK_PX = 80;

/** The nearest ancestor that scrolls vertically: the chat's own scroller, wherever it is mounted. */
function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  let at = node?.parentElement ?? null;
  while (at !== null) {
    const overflow = typeof window !== 'undefined' ? window.getComputedStyle(at).overflowY : '';
    if (overflow === 'auto' || overflow === 'scroll') return at;
    at = at.parentElement;
  }
  return null;
}

/**
 * The actions under a finished assistant reply: Copy the reply text, and Retry — re-send
 * the request this reply answered, as one fresh run. Both are real: Copy writes to the
 * clipboard with a "Copied" state, Retry calls the one session's retry(). No dead button —
 * Retry is only shown when there is an earlier request to retry and no run is in flight.
 */
function MessageActions({ message }: { message: ChatMessage }) {
  const session = useAgentSession();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [copied, setCopied] = useState(false);
  const canRetry = session.activeRunId === null && session.promptBehind(message) !== null;
  const feedback = state.messageFeedback[message.id];
  const copy = () => {
    void navigator.clipboard
      ?.writeText(message.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className={styles.messageActions}>
      <button type="button" className={styles.msgActionBtn} onClick={copy} aria-label={copied ? 'Copied' : 'Copy reply'} title="Copy reply">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {canRetry && (
        <button type="button" className={styles.msgActionBtn} onClick={() => session.retry(message)} aria-label="Retry this request" title="Send this request again">
          <Refresh size={12} /> Retry
        </button>
      )}
      <button
        type="button"
        className={styles.msgActionBtn}
        aria-label="Good reply"
        aria-pressed={feedback?.vote === 'up'}
        title={feedback?.vote === 'up' ? 'You marked this reply helpful (click again to clear)' : 'Mark this reply helpful'}
        onClick={() => dispatch({ type: 'SET_MESSAGE_FEEDBACK', payload: { messageId: message.id, vote: 'up' } })}
      >
        👍{feedback?.vote === 'up' ? ' ✓' : ''}
      </button>
      <button
        type="button"
        className={styles.msgActionBtn}
        aria-label="Poor reply"
        aria-pressed={feedback?.vote === 'down'}
        title={feedback?.vote === 'down' ? 'You marked this reply unhelpful (click again to clear)' : 'Mark this reply unhelpful'}
        onClick={() => dispatch({ type: 'SET_MESSAGE_FEEDBACK', payload: { messageId: message.id, vote: 'down' } })}
      >
        👎{feedback?.vote === 'down' ? ' ✓' : ''}
      </button>
    </div>
  );
}

export function MessageList({
  compact = false,
  onJumpChange,
}: {
  compact?: boolean;
  /** Host-placed "Jump to latest": called with the action while scrolled up, null otherwise. */
  onJumpChange?: (jump: (() => void) | null) => void;
}) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const session = useAgentSession();
  const events = useSketchEvents();
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = state.chatMessages;
  const [stopping, setStopping] = useState(false);
  /** The user message being edited for edit-and-resend, or null. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  useEffect(() => {
    if (session.activeRunId === null) setStopping(false);
  }, [session.activeRunId]);

  // FOLLOW THE CONVERSATION ONLY WHILE THE READER IS AT THE END OF IT. A run streams
  // dozens of updates; scrolling to the bottom on each one dragged anybody reading an
  // earlier answer back down. Scrolled up, new output waits behind a "Jump to latest"
  // button instead. Sending a message always returns to the end.
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    const scroller = scrollParentOf(bottomRef.current);
    if (scroller === null) return;
    const onScroll = () => {
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK_PX;
      pinned.current = atEnd;
      if (atEnd) setBehind(false);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  const last = messages[messages.length - 1];
  useEffect(() => {
    if (last?.role === 'user') pinned.current = true;
  }, [last?.id, last?.role]);

  useEffect(() => {
    if (!pinned.current) {
      setBehind(true);
      return;
    }
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages, session.liveEvents.length, session.pendingApproval]);

  const jumpToLatest = () => {
    pinned.current = true;
    setBehind(false);
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  };
  const jumpRef = useRef(jumpToLatest);
  jumpRef.current = jumpToLatest;
  useEffect(() => {
    onJumpChange?.(behind ? () => jumpRef.current() : null);
    // The host only needs to hear when "behind" flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behind]);

  const openReview = () => {
    dispatch({ type: 'SET_MODE', payload: 'ide' });
    dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'review' });
  };

  // Code in a reply goes straight into the open file, at the caret, while one is open.
  const insertCode =
    state.mode === 'ide' && state.activeFile !== null
      ? (code: string) => {
          if (!insertEditorText(code)) {
            dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'info', message: 'Open a file in the editor to insert code into it.' } });
          }
        }
      : undefined;

  const renderMessage = (msg: ChatMessage) => {
    if (msg.role === 'system') {
      return (
        <div key={msg.id} className={styles.systemRow} role="note">
          <AlertTriangle size={13} />
          <span>{msg.content}</span>
        </div>
      );
    }
    const isUser = msg.role === 'user';
    return (
      <div key={msg.id} className={`${styles.messageRow} ${isUser ? styles.userRow : styles.assistantRow}`}>
        {!isUser && !compact && (
          <div className={styles.avatarWrapper}>
            <Sparkles className={styles.avatarIcon} />
          </div>
        )}
        <div className={`${styles.messageBubble} ${isUser ? styles.userBubble : styles.assistantBubble}`}>
          {!isUser && (
            <div className={styles.agentName}>
              Sketch
              {session.wasStopped(msg.runId) ? (
                <span className={styles.stopped}>Stopped</span>
              ) : (
                msg.ok === false && <span className={styles.notOk}>did not finish</span>
              )}
            </div>
          )}
          {isUser ? (
            editingId === msg.id ? (
              <div>
                <textarea
                  aria-label="Edit your message"
                  value={editingText}
                  onChange={(e) => setEditingText(e.target.value)}
                  rows={3}
                  style={{ width: '100%', resize: 'vertical' }}
                />
                <div className={styles.messageActions}>
                  <button
                    type="button"
                    className={styles.msgActionBtn}
                    disabled={editingText.trim() === '' || session.activeRunId !== null}
                    onClick={() => {
                      const text = editingText;
                      setEditingId(null);
                      session.resendEdited(msg.id, text);
                    }}
                  >
                    Save &amp; resend
                  </button>
                  <button type="button" className={styles.msgActionBtn} onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className={styles.userText}>{msg.content}</div>
                {session.activeRunId === null && (
                  <div className={styles.messageActions}>
                    <button
                      type="button"
                      className={styles.msgActionBtn}
                      aria-label="Edit and resend this message"
                      title="Edit this message and run again from it — replies below it are dropped"
                      onClick={() => {
                        setEditingId(msg.id);
                        setEditingText(msg.content);
                      }}
                    >
                      Edit &amp; resend
                    </button>
                  </div>
                )}
              </div>
            )
          ) : (
            <Markdown text={msg.content} onInsertCode={insertCode} />
          )}
          {!isUser && msg.files && msg.files.length > 0 && (
            <ChangedFilesCard
              message={msg}
              events={events}
              onUndo={() => session.undo(msg)}
              onAccept={() => session.acceptProposals(msg)}
              onReject={() => session.rejectProposals(msg)}
              onReview={openReview}
            />
          )}
          {!isUser && msg.steps && <RunSteps steps={msg.steps} />}
          {!isUser && msg.receipt && <RunReceiptLine receipt={msg.receipt} />}
          {!isUser && msg.content.trim() !== '' && <MessageActions message={msg} />}
        </div>
      </div>
    );
  };

  return (
    <div className={compact ? styles.compactMessages : styles.messagesWrapper} role="log" aria-label="Conversation messages" aria-relevant="additions text">
      {messages.map(renderMessage)}
      {session.activeRunId !== null && (
        <div className={styles.assistantRow} style={{ display: 'flex' }}>
          <LiveRun
            events={session.liveEvents}
            stopping={stopping}
            onStop={() => {
              setStopping(true);
              session.stop();
            }}
          />
        </div>
      )}
      <ApprovalCard />
      {behind && onJumpChange === undefined && (
        <button type="button" className={styles.jumpLatest} onClick={jumpToLatest}>
          ↓ Jump to latest
        </button>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

/**
 * Tells the user where the ACTIVE conversation runs, when that differs from the open
 * workspace. Selecting a conversation never moves the workspace boundary (W2 invariants
 * 1-2), so this line is how the difference is made visible instead of silent:
 *   - inside the workspace but not the workspace root itself: a quiet "Runs in <rel>"
 *     line (its follow-up runs use that sub-path; the editor boundary stays the workspace).
 *   - outside the workspace (another folder, or a PARENT of the open one): a plain notice
 *     with a guarded "Open folder" button; the composer blocks send until then.
 * Nothing is shown when the conversation has no root or runs at the workspace root.
 */
const ConversationRootNotice: React.FC = () => {
  const state = useAppState();
  const fileActions = useFileActions();
  const conversation = state.conversations.find((c) => c.id === state.activeConversationId);
  const convRoot = conversation?.root ? canonicalPath(conversation.root) : null;
  const workspaceRoot = state.projectRoot;
  const relation = conversationRootRelation(workspaceRoot, convRoot);

  if (relation === 'outside' && convRoot !== null) {
    return (
      <div className={styles.blocker} role="status">
        <Info size={14} />
        <span>This conversation ran in {convRoot}. Open that folder to continue it.</span>
        <button className={styles.blockerBtn} onClick={() => void fileActions.openFolderPath(convRoot)}>
          <Folder size={12} /> Open folder
        </button>
      </div>
    );
  }

  if (relation === 'inside' && convRoot !== null && workspaceRoot !== null && convRoot !== workspaceRoot) {
    const rel = relativeToRoot(workspaceRoot, convRoot);
    return (
      <div className={styles.blocker} role="status">
        <Info size={12} />
        <span>Runs in {rel}</span>
      </div>
    );
  }

  return null;
};

const AgentChatView: React.FC = () => {
  const state = useAppState();
  const session = useAgentSession();
  const [jump, setJump] = useState<(() => void) | null>(null);
  const isEmpty = state.chatMessages.length === 0 && session.activeRunId === null;

  if (isEmpty) return <CoworkHome blocker={<Blocker />} />;

  return (
    <div className={`${styles.container} dottedCanvas`}>
      <div className={styles.conversationHeader}>
        <span>{state.conversations.find((c) => c.id === state.activeConversationId)?.title ?? 'Current task'}</span>
        <span
          className={styles.contextMeter}
          title={`Estimated from message text (~1 token per 4 characters). Only the last ${state.agentPrefs.speed === 'turbo' ? TURBO_MAX_TURNS : NORMAL_MAX_TURNS} turns are sent to the model in ${state.agentPrefs.speed === 'turbo' ? 'Turbo' : 'Normal'} speed; older turns stay in the transcript.`}
        >
          {formatContextSummary(contextSummary(state.chatMessages, state.agentPrefs.speed === 'turbo' ? TURBO_MAX_TURNS : NORMAL_MAX_TURNS))}
        </span>
        <span className={styles.conversationStatus}>{session.activeRunId !== null ? 'Working' : 'Conversation'}</span>
      </div>
      <MessageList onJumpChange={(fn) => setJump(() => fn)} />
      <div className={styles.activeChatInputWrapper}>
        {jump !== null && <button type="button" className={styles.jumpLatestFloating} onClick={jump}>↓ Jump to latest</button>}
        <Blocker />
        <ConversationRootNotice />
        <div className={styles.activeChatCard}>
          <Composer placeholder="Ask a follow up, / for commands, @ for files" rows={1} compact acceptSeeds surface="agent" />
        </div>
      </div>
    </div>
  );
};
