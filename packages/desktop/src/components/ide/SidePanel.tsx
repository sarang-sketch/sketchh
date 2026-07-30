import React, { useState } from 'react';
import styles from './SidePanel.module.css';
import { useAppState } from '../../state/AppState';
import { FileExplorer } from '../../panels/FileExplorer';
import SearchPanel from '../../panels/ide/SearchPanel';
import { GitPanel } from '../../panels/GitPanel';
import { DiffReview } from '../../panels/DiffReview';
import { AgentTeamPanel } from '../../panels/agent/AgentTeamPanel';
import { SkillsMarketplace } from '../../panels/SkillsMarketplace';
import { AgentTimelinePanel } from '../../ui/panels/AgentTimeline';
import { AgentConsolePanel } from '../../ui/panels/AgentConsole';
import DebuggerPanel from '../../panels/ide/DebuggerPanel';

export default function SidePanel() {
  const { ideActivePanel } = useAppState();
  const [width, setWidth] = useState(280);

  let content: React.ReactNode = null;
  let title = '';

  switch (ideActivePanel) {
    case 'explorer':
      title = 'Explorer';
      content = <FileExplorer />;
      break;
    case 'search':
      title = 'Search';
      content = <SearchPanel />;
      break;
    case 'git':
      title = 'Source Control';
      content = <GitPanel />;
      break;
    case 'review':
      title = 'Diff Review';
      content = <DiffReview />;
      break;
    case 'agents':
      title = 'Agent Team';
      content = <AgentTeamPanel />;
      break;
    case 'skills':
      title = 'Skills';
      content = <SkillsMarketplace />;
      break;
    case 'timeline':
      title = 'Timeline';
      content = <AgentTimelinePanel />;
      break;
    case 'console':
      title = 'Agent Console';
      content = <AgentConsolePanel />;
      break;
    case 'run':
      title = 'Run & Debug';
      content = <DebuggerPanel />;
      break;
    default:
      // MCP Tools has an ActivityBar button but its real panel belongs to task 7.3.
      return null;
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(150, Math.min(600, startWidth + (moveEvent.clientX - startX)));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div className={styles.sidePanel} style={{ width }}>
      <div className={styles.header}>
        <span>{title}</span>
      </div>
      <div className={styles.content}>
        {content}
      </div>
      <div className={styles.resizeHandle} onMouseDown={handleMouseDown} />
    </div>
  );
}
