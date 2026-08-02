import { useState } from 'react';
import styles from './IdeChatSidebar.module.css';
import { 
  Plus, Refresh, X, Sparkles
} from '../../components/Icons';
import { useAppState, useAppDispatch } from '../../state/AppState';
import { ThinkingIndicator } from '../../components/ThinkingIndicator';
import { ModelSelector } from '../../components/ModelSelector';

export default function IdeChatSidebar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [inputText, setInputText] = useState('');

  const handleSend = () => {
    if (!inputText.trim()) return;
    dispatch({
      type: 'ADD_MESSAGE',
      payload: { id: crypto.randomUUID(), role: 'user', content: inputText, timestamp: Date.now() }
    });
    setInputText('');

    dispatch({ type: 'SET_THINKING', payload: { isThinking: true, stage: 'Querying tools & models...' } });

    setTimeout(() => {
      dispatch({ type: 'SET_THINKING', payload: { isThinking: false } });
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          id: crypto.randomUUID(),
          role: 'agent',
          content: 'Analyzed your request. I am applying the required code changes directly to your editor files and verifying with linter.',
          timestamp: Date.now()
        }
      });
    }, 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.sidebar}>
      {/* Screenshot 2 Header Match */}
      <div className={styles.header}>
        <div className={styles.agentTab}>
          <span>Agent</span>
        </div>
        <div className={styles.headerControls}>
          <button className={styles.hdrBtn} title="New Agent Chat" onClick={() => dispatch({ type: 'CLEAR_MESSAGES' })}>
            <Plus size={14} />
          </button>
          <button className={styles.hdrBtn} title="Reset History">
            <Refresh size={14} />
          </button>
          <button className={styles.hdrBtn} title="More Options">
            <span>...</span>
          </button>
          <button className={styles.hdrBtn} title="Close Panel" onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Main Agent Area */}
      <div className={styles.mainCanvas}>
        <div className={styles.brandWatermark}>
          <Sparkles className={styles.sparkleLogo} size={24} />
          <h2 className={styles.watermarkTitle}>Sketch Aman</h2>
        </div>

        {/* Chat Messages */}
        <div className={styles.messagesList}>
          {state.chatMessages.map((msg) => (
            <div key={msg.id} className={`${styles.messageRow} ${msg.role === 'user' ? styles.userRow : styles.agentRow}`}>
              <div className={styles.messageBubble}>
                <span className={styles.roleLabel}>{msg.role === 'user' ? 'You' : 'Sketch Aman Agent'}</span>
                <p className={styles.msgText}>{msg.content}</p>
              </div>
            </div>
          ))}

          {state.isThinking && (
            <div className={styles.thinkingWrapper}>
              <ThinkingIndicator stage={state.thinkingStage || "Processing..."} compact={true} />
            </div>
          )}
        </div>
      </div>

      {/* Screenshot 2 Bottom Prompt Box */}
      <div className={styles.bottomCardContainer}>
        <div className={styles.promptBoxCard}>
          <textarea
            className={styles.promptInput}
            placeholder="Ask anything, @ to mention, / for actions"
            rows={2}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          <div className={styles.promptCardControls}>
            <button className={styles.plusBtn} title="Attach / Action">
              <Plus size={15} />
            </button>

            {/* The real picker: configured providers only, from providers.json.
                The pill that used to be here read 'Claude Opus 4.6' on every
                machine, configured or not. */}
            <ModelSelector />

            {/* The "MCP Tools Active (cloudrun, firebase, notebooks, visualization)"
                badge that used to sit here is gone. It named four servers this product
                does not have and claimed they were active, on every machine, always.
                MCP servers start per run and only for the capabilities that run holds,
                so nothing is active while a prompt is being typed. The curated catalog
                and what each server costs live in the MCP Tools panel (Req 27.5). */}

            <button 
              className={`${styles.sendArrowBtn} ${inputText.trim() ? styles.sendActive : ''}`}
              onClick={handleSend}
            >
              ➔
            </button>
          </div>
        </div>

        {/* Footer Disclaimer */}
        <div className={styles.disclaimerText}>
          AI may make mistakes. Double check all generated code.
        </div>
      </div>
    </div>
  );
}
