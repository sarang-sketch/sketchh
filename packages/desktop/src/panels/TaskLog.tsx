import { useState } from 'react';
import { Activity, Zap, CheckCircle, AlertCircle, Clock, ChevronDown, ChevronRight } from '../components/Icons';
import styles from './TaskLog.module.css';

type TaskStatus = 'running' | 'done' | 'failed';

const MOCK_TASKS = [
  { id: 1, name: 'Analyze workspace structure', status: 'done' as TaskStatus, duration: '2.4s', agent: 'Architect', cost: '$0.02' },
  { id: 2, name: 'Generate React components', status: 'done' as TaskStatus, duration: '14.1s', agent: 'Coder', cost: '$0.15' },
  { id: 3, name: 'Install dependencies', status: 'failed' as TaskStatus, duration: '45.0s', agent: 'System', cost: null, error: 'npm ERR! code ERESOLVE' },
  { id: 4, name: 'Fix dependency conflicts', status: 'done' as TaskStatus, duration: '8.2s', agent: 'Coder', cost: '$0.05' },
  { id: 5, name: 'Run test suite', status: 'running' as TaskStatus, duration: '12s...', agent: 'QA', cost: null, progress: 65 }
];

export function TaskLog() {
  const [filter, setFilter] = useState('All');
  const [expanded, setExpanded] = useState<number | null>(null);

  const getStatusIcon = (status: TaskStatus) => {
    switch (status) {
      case 'running': return <div className={styles.spinner} />;
      case 'done': return <CheckCircle size={14} className={styles.iconDone} />;
      case 'failed': return <AlertCircle size={14} className={styles.iconFailed} />;
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Activity size={16} />
          <span>Tasks</span>
        </div>
        <select className={styles.filterDropdown} value={filter} onChange={e => setFilter(e.target.value)}>
          <option>All</option>
          <option>Running</option>
          <option>Done</option>
          <option>Failed</option>
        </select>
      </div>

      <div className={styles.costBar}>
        <Zap size={14} className={styles.zapIcon} />
        <span>Total Session Cost:</span>
        <span className={styles.costAmount}>$1.4025</span>
      </div>

      <div className={styles.timeline}>
        {MOCK_TASKS.map((task, idx) => (
          <div key={task.id} className={styles.taskItem}>
            <div className={styles.timelineLine}>
              <div className={styles.timelineDot}>
                {getStatusIcon(task.status)}
              </div>
              {idx < MOCK_TASKS.length - 1 && <div className={styles.timelineConnector} />}
            </div>
            
            <div className={styles.taskContent}>
              <div 
                className={styles.taskHeader} 
                onClick={() => setExpanded(expanded === task.id ? null : task.id)}
              >
                <div className={styles.taskMain}>
                  <span className={styles.taskName}>{task.name}</span>
                  <span className={styles.agentBadge}>{task.agent}</span>
                </div>
                
                <div className={styles.taskMeta}>
                  {task.cost && <span className={styles.taskCost}>{task.cost}</span>}
                  <div className={styles.duration}>
                    <Clock size={12} />
                    <span>{task.duration}</span>
                  </div>
                  {expanded === task.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
              </div>

              {task.status === 'running' && (
                <div className={styles.progressContainer}>
                  <div className={styles.progressBar} style={{ width: `${task.progress}%` }} />
                </div>
              )}

              {expanded === task.id && (
                <div className={styles.taskDetails}>
                  {task.error ? (
                    <div className={styles.errorLog}>{task.error}</div>
                  ) : (
                    <div className={styles.logText}>
                      [INFO] Starting {task.name.toLowerCase()}<br/>
                      [INFO] Connecting to agent {task.agent}<br/>
                      {task.status === 'done' ? '[SUCCESS] Completed successfully' : '[INFO] Processing...'}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
