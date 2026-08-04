import { useEffect, useRef, useState } from 'react';
import styles from './AgentChat.module.css';
import { 
  Sparkles, Copy, Plus, Send, Folder
} from '../../components/Icons';
import { ThinkingIndicator } from '../../components/ThinkingIndicator';
import { ModelSelector } from '../../components/ModelSelector';
import { useAppState, useAppDispatch } from '../../state/AppState';
import { useFileActions } from '../../editor/useFileActions';
import { useSketchClient } from '../../lib/ClientProvider';
import { withDesktopRunDefaults } from '../../lib/runDefaults';
import { resolveApiKeyForRun } from '../../lib/secrets';

interface DisplayMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  isThinking?: boolean;
}

/** Ids for local chat rows. `crypto.randomUUID` is present in the webview. */
function newId(): string {
  return crypto.randomUUID();
}

export const AgentChat: React.FC = () => {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const fileActions = useFileActions();
  const client = useSketchClient();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState('');

  const messages: DisplayMessage[] = state.chatMessages.length > 0 ? state.chatMessages : [];

  const isEmpty = messages.length === 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Sends go through the client seam. The reply is the engine's real `finalText`,
  // and the events the run emits show up in the Timeline and the Agent Console as
  // they arrive — no simulated response. Provider selection has one authority:
  // the key-free entry in AppState loaded from providers.json. No selection means
  // no provider on the wire, so the engine gives its existing honest refusal.
  const handleSend = () => {
    const prompt = inputText.trim();
    if (!prompt) return;
    const provider = state.providers.find((entry) => entry.id === state.selectedProvider);

    dispatch({
      type: 'ADD_MESSAGE',
      payload: { id: newId(), role: 'user', content: prompt, timestamp: Date.now() }
    });
    setInputText('');
    dispatch({ type: 'SET_THINKING', payload: { isThinking: true, stage: 'Running task through the engine...' } });

    // The stored key is resolved HERE, for this call, and held in nothing but the
    // argument below (Requirement 17.4). A store that cannot be read is reported rather
    // than swallowed: a local provider needs no key, so this must not fail the run.
    const withKey = async () => {
      if (provider === undefined) return undefined;
      return resolveApiKeyForRun(provider.id, (reason) => {
        dispatch({
          type: 'ADD_MESSAGE',
          payload: {
            id: newId(),
            role: 'system',
            content: `Continuing without a stored key for ${provider.label}: ${reason}`,
            timestamp: Date.now(),
          },
        });
      });
    };

    withKey()
      .then((apiKey) =>
        client.run(
          { id: newId(), prompt, verify: [] },
          // Retrieval and the spend ceiling come from one authority so this panel and
          // its tests cannot drift. Without them a desktop run reaches the model with no
          // repository context and no bill ceiling — see runDefaults.ts.
          withDesktopRunDefaults({
            ...(provider !== undefined ? { provider } : {}),
            // Present only when the store actually held one. `apiKey: undefined` would
            // still be an own property on the wire object.
            ...(apiKey !== null && apiKey !== undefined ? { apiKey } : {}),
            ...(state.projectRoot ? { root: state.projectRoot } : {}),
            reviewEdits: true,
          }),
        ),
      )
      .then((result) => {
        dispatch({ type: 'SET_THINKING', payload: { isThinking: false } });
        dispatch({
          type: 'ADD_MESSAGE',
          payload: { id: newId(), role: 'agent', content: result.finalText, timestamp: Date.now() }
        });
      })
      .catch((err: unknown) => {
        dispatch({ type: 'SET_THINKING', payload: { isThinking: false } });
        dispatch({
          type: 'ADD_MESSAGE',
          payload: {
            id: newId(),
            role: 'system',
            // Name the tool and the reason (Req 27.5).
            content: `Engine (${client.transport} transport) failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: Date.now()
          }
        });
      });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFolderClick = () => {
    void fileActions.openFolder();
  };

  if (isEmpty) {
    return (
      <div className={`${styles.welcomeContainer} dottedCanvas`}>
        {/* Screenshot 1 Welcome View */}
        <div className={styles.centerCardArea}>
          
          {/* Headline with Asterisk/Sparkle */}
          <div className={styles.headerTitleRow}>
            <span className={styles.asteriskIcon}>✳</span>
            <h1 className={styles.heroTitle}>What can I take off your plate?</h1>
          </div>
          <p className={styles.heroSubtitle}>Learn how to use Cowork safely.</p>

          {/* Screenshot 1 Prompt Box Card */}
          <div className={styles.promptCard}>
            <textarea
              className={styles.promptInput}
              placeholder="How can I help you today?"
              rows={2}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
            />

            {/* Prompt Card Bottom Row */}
            <div className={styles.promptCardBottomRow}>
              <button className={styles.attachBtn} title="Attach files">
                <Plus size={16} />
              </button>

              <div className={styles.promptRightActions}>
                {/* Real providers, from providers.json. The pill that used to be
                    here named a model on machines with nothing configured. */}
                <ModelSelector />

                <button 
                  className={`${styles.sendCircleBtn} ${inputText.trim() ? styles.sendActive : ''}`} 
                  onClick={handleSend}
                >
                  <Send size={14} />
                </button>
              </div>
            </div>

            {/* Folder context button inside prompt box */}
            <div className={styles.folderContextRow}>
              <button className={styles.folderPillBtn} onClick={handleFolderClick}>
                <Folder size={14} />
                <span>{state.projectRoot ? state.projectRoot.split(/[/\\]/).pop() : 'Work in a project or folder'}</span>
              </button>
            </div>
          </div>

          {/* Screenshot 1 Suggestions Section */}
          <div className={styles.suggestionsSection}>
            <div className={styles.suggestionHeaderRow}>
              <span className={styles.shuffleIcon}>🔀</span>
              <span className={styles.suggestionTitleLabel}>Pick a task, any task</span>
            </div>

            <div className={styles.suggestionCardList}>
              <div className={styles.suggestionCardItem} onClick={() => setInputText('Optimize my week')}>
                <span className={styles.cardEmoji}>🌅</span>
                <span className={styles.cardText}>Optimize my week</span>
              </div>

              <div className={styles.suggestionCardItem} onClick={() => setInputText('Organize my screenshots')}>
                <span className={styles.cardEmoji}>📁</span>
                <span className={styles.cardText}>Organize my screenshots</span>
              </div>

              <div className={styles.suggestionCardItem} onClick={() => setInputText('Find insights in files')}>
                <span className={styles.cardEmoji}>📊</span>
                <span className={styles.cardText}>Find insights in files</span>
              </div>
            </div>

            <div className={styles.customizeFooterLink}>
              <span>Customize with plugins</span>
            </div>
          </div>

        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.container} dottedCanvas`}>
      <div className={styles.messagesWrapper}>
        {messages.map((msg) => (
          <div 
            key={msg.id} 
            className={`${styles.messageRow} ${msg.role === 'user' ? styles.userRow : styles.assistantRow}`}
          >
            {msg.role === 'agent' && (
              <div className={styles.avatarWrapper}>
                <Sparkles className={styles.avatarIcon} />
              </div>
            )}
            
            <div className={`${styles.messageBubble} ${msg.role === 'user' ? styles.userBubble : styles.assistantBubble}`}>
              {msg.role === 'agent' && (
                <div className={styles.agentName}>Sketch Cowork</div>
              )}
              
              <MessageContent content={msg.content} />
            </div>
          </div>
        ))}

        {state.isThinking && (
          <div className={styles.thinkingRow}>
            <ThinkingIndicator stage={state.thinkingStage || "Working..."} compact={false} />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Floating Input at bottom when chat active */}
      <div className={styles.activeChatInputWrapper}>
        <div className={styles.activeChatCard}>
          <textarea
            className={styles.promptInput}
            placeholder="Ask a follow up..."
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className={styles.promptCardBottomRow}>
            <button className={styles.attachBtn} title="Attach files">
              <Plus size={16} />
            </button>
            <div className={styles.promptRightActions}>
              <ModelSelector />
              <button 
                className={`${styles.sendCircleBtn} ${inputText.trim() ? styles.sendActive : ''}`} 
                onClick={handleSend}
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const MessageContent = ({ content }: { content: string }) => {
  const parts = content.split(/(```[\s\S]*?```)/g);
  
  return (
    <div className={styles.content}>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const lines = part.split('\n');
          const lang = lines[0].replace('```', '').trim() || 'text';
          const code = lines.slice(1, -1).join('\n');
          
          return (
            <div key={i} className={styles.codeBlock}>
              <div className={styles.codeHeader}>
                <span className={styles.codeLang}>{lang}</span>
                <button className={styles.copyBtn}>
                  <Copy size={12} /> Copy
                </button>
              </div>
              <pre className={styles.codeContent}>
                <code>{code}</code>
              </pre>
            </div>
          );
        }
        
        return <div key={i} className={styles.textContent}>{part}</div>;
      })}
    </div>
  );
};
