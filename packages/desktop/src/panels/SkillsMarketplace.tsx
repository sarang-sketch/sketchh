import { useState } from 'react';
import { ShoppingBag, Search, Star } from '../components/Icons';
import styles from './SkillsMarketplace.module.css';

const MOCK_SKILLS = [
  { id: 1, name: 'SkillOpt', author: 'Microsoft', description: 'ML-driven skill optimization. Trains your SKILL.md files.', category: 'AI/ML', version: '2.1.0', featured: true, enabled: true },
  { id: 2, name: 'Superpowers', author: 'AgenticLabs', description: 'TDD + sub-agent orchestration. Red-green-refactor.', category: 'Testing', version: '1.4.2', featured: true, enabled: true },
  { id: 3, name: 'Grill Me', author: 'InterviewDAO', description: 'Interactive design interview. Forces planning before coding.', category: 'Workflow', version: '3.0.1', featured: true, enabled: false },
  { id: 4, name: 'Caveman', author: 'TokenSaver', description: 'Token optimization. Strips narration by ~65%.', category: 'Workflow', version: '1.0.5', featured: true, enabled: true },
  { id: 5, name: 'Frontend Design', author: 'Sketch', description: 'Production-grade UI generation with modern frameworks.', category: 'Frontend', version: '2.0.0', featured: true, enabled: true },
  { id: 6, name: 'Code Reviewer', author: 'SecureCode', description: 'Automated code review with security, performance, and style checks.', category: 'Security', version: '1.8.4', featured: true, enabled: false },
  { id: 7, name: 'React Skill', author: 'Meta', description: 'React best practices, hooks patterns, component architecture.', category: 'Frontend', version: '4.2.1', featured: false, enabled: true },
  { id: 8, name: 'Docker Skill', author: 'DevOpsPro', description: 'Dockerfile optimization, multi-stage builds, compose orchestration.', category: 'DevOps', version: '1.1.0', featured: false, enabled: false },
];

const CATEGORY_COLORS: Record<string, string> = {
  'Workflow': 'var(--purple)',
  'Testing': 'var(--success)',
  'Security': 'var(--error)',
  'Frontend': 'var(--accent)',
  'Backend': 'var(--warning)',
  'DevOps': 'var(--text-secondary)',
  'AI/ML': 'var(--pink)'
};

export function SkillsMarketplace() {
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace' | 'create'>('installed');
  const [search, setSearch] = useState('');
  const [skills, setSkills] = useState(MOCK_SKILLS);

  const toggleSkill = (id: number) => {
    setSkills(skills.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  const filteredSkills = skills.filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <ShoppingBag size={16} />
          <span>Skills</span>
        </div>
        <div className={styles.searchBox}>
          <Search size={14} className={styles.searchIcon} />
          <input 
            type="text" 
            placeholder="Search skills..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={styles.searchInput}
          />
        </div>
      </div>

      <div className={styles.tabs}>
        <button className={`${styles.tab} ${activeTab === 'installed' ? styles.active : ''}`} onClick={() => setActiveTab('installed')}>Installed</button>
        <button className={`${styles.tab} ${activeTab === 'marketplace' ? styles.active : ''}`} onClick={() => setActiveTab('marketplace')}>Marketplace</button>
        <button className={`${styles.tab} ${activeTab === 'create' ? styles.active : ''}`} onClick={() => setActiveTab('create')}>Create</button>
      </div>

      <div className={styles.content}>
        {activeTab === 'installed' && (
          <div className={styles.skillList}>
            {filteredSkills.map(skill => (
              <div key={skill.id} className={`${styles.skillCard} ${!skill.enabled ? styles.disabled : ''}`}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitle}>
                    {skill.featured && <Star size={14} className={styles.featuredIcon} />}
                    <span className={styles.name}>{skill.name}</span>
                  </div>
                  <button 
                    className={`${styles.toggleSwitch} ${skill.enabled ? styles.toggleOn : styles.toggleOff}`}
                    onClick={() => toggleSkill(skill.id)}
                  >
                    <div className={styles.toggleKnob} />
                  </button>
                </div>
                <div className={styles.description}>{skill.description}</div>
                <div className={styles.cardFooter}>
                  <div className={styles.meta}>
                    <span className={styles.author}>{skill.author}</span>
                    <span className={styles.version}>v{skill.version}</span>
                  </div>
                  <span className={styles.badge} style={{ backgroundColor: CATEGORY_COLORS[skill.category] || 'var(--bg-hover)' }}>
                    {skill.category}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'marketplace' && (
          <div className={styles.emptyState}>
            <ShoppingBag size={32} className={styles.emptyIcon} />
            <div className={styles.emptyText}>Discover new skills</div>
            <p className={styles.emptySubtext}>Enhance your agent with specialized capabilities.</p>
          </div>
        )}

        {activeTab === 'create' && (
          <div className={styles.createPanel}>
            <div className={styles.createGuide}>
              <h3>Create a Custom Skill</h3>
              <p>Skills are defined using a <code>SKILL.md</code> file in your workspace.</p>
              <div className={styles.codeBlock}>
                <pre>
{`# My Custom Skill
Description: What it does
Version: 1.0.0

## Instructions
1. Step one
2. Step two`}
                </pre>
              </div>
              <button className={styles.actionButton}>Create SKILL.md</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
