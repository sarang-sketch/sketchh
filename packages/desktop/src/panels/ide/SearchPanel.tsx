
import styles from './SearchPanel.module.css';
import { Search, FileCode } from '../../components/Icons';

export default function SearchPanel() {
  const mockResults = [
    {
      file: 'src/components/Button.tsx',
      matches: [
        { line: 12, text: 'const [isActive, ', match: 'useState', after: '](false);' },
        { line: 45, text: '  const [hover, ', match: 'useState', after: '](false);' }
      ]
    },
    {
      file: 'src/panels/ide/Terminal.tsx',
      matches: [
        { line: 8, text: 'import { ', match: 'useState', after: ', useEffect } from "react";' },
        { line: 15, text: '  const [output, setOutput] = ', match: 'useState', after: '([]);' }
      ]
    },
    {
      file: 'src/App.tsx',
      matches: [
        { line: 22, text: '  const [ready, setReady] = ', match: 'useState', after: '(false);' }
      ]
    }
  ];

  return (
    <div className={styles.searchPanel}>
      <div className={styles.inputGroup}>
        <div className={styles.searchBox}>
          <Search className={styles.searchIcon} size={14} />
          <input className={styles.searchInput} defaultValue="useState" placeholder="Search" />
        </div>
        <div className={styles.optionsRow}>
          <button className={styles.optionBtn} title="Match Case">Aa</button>
          <button className={styles.optionBtn} title="Match Whole Word">Ab|</button>
          <button className={styles.optionBtn} title="Use Regular Expression">.*</button>
        </div>
      </div>

      <div className={styles.resultsList}>
        {mockResults.map((group, i) => (
          <div key={i} className={styles.fileGroup}>
            <div className={styles.fileHeader}>
              <FileCode size={14} />
              <span>{group.file}</span>
              <span className={styles.badge}>{group.matches.length}</span>
            </div>
            {group.matches.map((match, j) => (
              <div key={j} className={styles.matchLine}>
                <span className={styles.lineNumber}>{match.line}</span>
                <span className={styles.matchContent}>
                  {match.text}
                  <span className={styles.highlight}>{match.match}</span>
                  {match.after}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
