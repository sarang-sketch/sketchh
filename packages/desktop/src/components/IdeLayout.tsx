import { useEffect, useState } from 'react'
import styles from './IdeLayout.module.css'
import ActivityBar from './ide/ActivityBar'
import SidePanel from './ide/SidePanel'
import EditorArea from './EditorArea'
import IdeChatSidebar from '../panels/ide/IdeChatSidebar'
import BottomPanel from './BottomPanel'
import { ResizeHandle } from './ResizeHandle'
import { useAppDispatch, useAppState } from '../state/AppState'
import { useWindowWidth } from '../lib/useWindowWidth'

const CHAT_WIDTH_KEY = 'sketch.layout.chatWidth.v1'
const DEFAULT_CHAT_WIDTH = 360
export const NARROW_CHAT_PX = 1000
export const NARROW_SIDE_PX = 760

function readChatWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(CHAT_WIDTH_KEY))
    return Number.isFinite(value) && value >= 280 ? Math.min(value, 760) : DEFAULT_CHAT_WIDTH
  } catch { return DEFAULT_CHAT_WIDTH }
}

export function IdeLayout() {
  const { ideActivePanel, rightPanelCollapsed, bottomPanelOpen, bottomPanelHeight, appearance, focusMode } = useAppState()
  const dispatch = useAppDispatch()
  const width = useWindowWidth()
  const [height, setHeight] = useState(() => window.innerHeight)
  const [chatWidth, setChatWidth] = useState(readChatWidth)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const resize = () => setHeight(window.innerHeight)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    try { window.localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth)) } catch { /* Usable without storage. */ }
  }, [chatWidth])

  const chatFloats = width < NARROW_CHAT_PX
  const sideFloats = width < NARROW_SIDE_PX
  const showSide = ideActivePanel !== null && !focusMode
  const showChat = !rightPanelCollapsed && !focusMode
  const showBottom = bottomPanelOpen && !focusMode
  const topActivity = appearance.activityBar === 'top'
  const showActivity = appearance.activityBar !== 'hidden' && !focusMode
  const agentLeft = appearance.agentPosition === 'left'
  const maxChatWidth = Math.max(300, Math.min(760, width - 560))
  const maxBottom = Math.max(120, height - 220)

  return (
    <div className={styles.layout} data-narrow={chatFloats ? 'true' : 'false'} data-chat-overlay={chatFloats && showChat ? 'true' : undefined} data-sidebar={appearance.sidebarPosition} data-agent={appearance.agentPosition} data-activity={appearance.activityBar}>
      {showActivity && topActivity && <ActivityBar />}
      <div className={styles.workbenchRow}>
        {showActivity && !topActivity && <div className={styles.activitySlot}><ActivityBar /></div>}
        {showSide && <div className={styles.sideSlot + (sideFloats ? ' ' + styles.floatingSide : '')}><SidePanel /></div>}
        {sideFloats && showSide && <button type="button" className={styles.scrim} aria-label="Close the side panel" onClick={() => dispatch({ type: 'TOGGLE_IDE_SIDE_PANEL' })} />}
        <div className={styles.mainContent}>
          <div className={styles.editorColumn}>
            <div className={styles.editorSection} style={maximized && showBottom ? { display: 'none' } : undefined}><EditorArea /></div>
            {showBottom && (
              <div className={styles.bottomSection} style={maximized ? { flex: 1, height: 'auto' } : { height: Math.min(bottomPanelHeight, maxBottom) }}>
                {!maximized && <ResizeHandle orientation="horizontal" size={Math.min(bottomPanelHeight, maxBottom)} min={120} max={maxBottom} direction={-1} defaultSize={250} onResize={(size) => dispatch({ type: 'SET_BOTTOM_PANEL_HEIGHT', payload: size })} label="Resize the bottom panel" className={styles.bottomHandle} />}
                <BottomPanel maximized={maximized} onToggleMaximize={() => setMaximized((m) => !m)} />
              </div>
            )}
          </div>
          {showChat && (
            <aside className={styles.chatSlot + (chatFloats ? ' ' + styles.floatingChat : '')} aria-label="Code agent" style={{ width: chatFloats ? Math.min(chatWidth, Math.max(260, width - 64)) : Math.min(chatWidth, maxChatWidth) }}>
              {!chatFloats && <ResizeHandle orientation="vertical" size={Math.min(chatWidth, maxChatWidth)} min={280} max={maxChatWidth} direction={agentLeft ? 1 : -1} defaultSize={DEFAULT_CHAT_WIDTH} onResize={setChatWidth} label="Resize the chat panel" className={styles.chatHandle} />}
              <IdeChatSidebar />
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}

export default IdeLayout
