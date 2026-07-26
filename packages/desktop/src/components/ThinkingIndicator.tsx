import React from 'react';
import styles from './ThinkingIndicator.module.css';

interface ThinkingIndicatorProps {
  stage?: string;
  compact?: boolean;
}

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ 
  stage = 'Thinking...', 
  compact = false 
}) => {
  return (
    <div className={`${styles.container} ${compact ? styles.compact : ''}`}>
      <div className={styles.shimmerBar}>
        <div className={styles.shimmer}></div>
      </div>
      <div className={styles.content}>
        <span className={styles.stage}>{stage}</span>
        <div className={styles.dots}>
          <span>.</span><span>.</span><span>.</span>
        </div>
      </div>
    </div>
  );
};
