import React, { useState } from 'react';
import styles from './AgentTeamPanel.module.css';
import { ChevronDown, ChevronRight, Brain, Shield, Database, Layout } from '../../components/Icons';

export const AgentTeamPanel: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState(false);

  const agents = [
    { id: '1', name: 'Architect', role: 'System Design', status: 'idle', icon: <Brain /> },
    { id: '2', name: 'UI Builder', role: 'Frontend', status: 'working', icon: <Layout /> },
    { id: '3', name: 'Backend', role: 'API & DB', status: 'done', icon: <Database /> },
    { id: '4', name: 'Security', role: 'Audit', status: 'idle', icon: <Shield /> },
  ];

  return (
    <div className={styles.container}>
      <button 
        className={styles.header} 
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className={styles.headerLeft}>
          {isExpanded ? <ChevronDown className={styles.chevron} /> : <ChevronRight className={styles.chevron} />}
          <span className={styles.title}>Agent Team</span>
          <span className={styles.activeCount}>1 working</span>
        </div>
      </button>

      {isExpanded && (
        <div className={styles.grid}>
          {agents.map(agent => (
            <div key={agent.id} className={`${styles.card} ${styles[agent.status]}`}>
              <div className={styles.iconWrapper}>
                {agent.icon}
                {agent.status === 'working' && <div className={styles.pulseRing}></div>}
              </div>
              <div className={styles.info}>
                <div className={styles.name}>{agent.name}</div>
                <div className={styles.role}>{agent.role}</div>
              </div>
              <div className={`${styles.statusBadge} ${styles[`badge-${agent.status}`]}`}>
                {agent.status}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
