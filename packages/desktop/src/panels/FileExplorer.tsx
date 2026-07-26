import { useState } from 'react';
import { 
  Folder, FolderOpen, FileText, FileCode, FileJson, 
  ChevronRight, ChevronDown, Plus, Refresh, File
} from '../components/Icons';
import { useAppState } from '../state/AppState';
import styles from './FileExplorer.module.css';

type FileNode = {
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  isOpen?: boolean;
};

const MOCK_TREE: FileNode[] = [
  {
    name: 'src',
    type: 'folder',
    isOpen: true,
    children: [
      {
        name: 'components',
        type: 'folder',
        isOpen: true,
        children: [
          { name: 'AppLayout.tsx', type: 'file' },
          { name: 'FileExplorer.tsx', type: 'file' },
          { name: 'Icons.tsx', type: 'file' }
        ]
      },
      {
        name: 'styles',
        type: 'folder',
        isOpen: false,
        children: [
          { name: 'globals.css', type: 'file' }
        ]
      },
      { name: 'App.tsx', type: 'file' },
      { name: 'main.tsx', type: 'file' }
    ]
  },
  {
    name: 'public',
    type: 'folder',
    isOpen: false,
    children: [
      { name: 'vite.svg', type: 'file' }
    ]
  },
  { name: 'package.json', type: 'file' },
  { name: 'tsconfig.json', type: 'file' },
  { name: 'vite.config.ts', type: 'file' },
  { name: 'README.md', type: 'file' }
];

export function FileExplorer() {
  const state = useAppState();
  const [tree, setTree] = useState(MOCK_TREE);
  const [activeFile, setActiveFile] = useState('FileExplorer.tsx');

  const toggleFolder = (nodeName: string) => {
    const newTree = JSON.parse(JSON.stringify(tree)); // Deep copy for mock
    
    const toggleRecursive = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.name === nodeName) {
          node.isOpen = !node.isOpen;
          return true;
        }
        if (node.children && toggleRecursive(node.children)) {
          return true;
        }
      }
      return false;
    };
    
    toggleRecursive(newTree);
    setTree(newTree);
  };

  const getFileIcon = (name: string) => {
    if (name.endsWith('.tsx') || name.endsWith('.ts')) return <FileCode size={14} className={styles.iconTs} />;
    if (name.endsWith('.css')) return <FileCode size={14} className={styles.iconCss} />;
    if (name.endsWith('.json')) return <FileJson size={14} className={styles.iconJson} />;
    if (name.endsWith('.md')) return <FileText size={14} className={styles.iconMd} />;
    if (name.endsWith('.rs')) return <FileCode size={14} className={styles.iconRust} />;
    if (name.endsWith('.py')) return <FileCode size={14} className={styles.iconPython} />;
    return <File size={14} className={styles.iconDefault} />;
  };

  const renderTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map(node => (
      <div key={node.name} className={styles.treeNodeWrapper}>
        <div 
          className={`${styles.treeNode} ${activeFile === node.name ? styles.active : ''}`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => {
            if (node.type === 'folder') toggleFolder(node.name);
            else setActiveFile(node.name);
          }}
        >
          {node.type === 'folder' ? (
            <>
              <div className={`${styles.chevron} ${node.isOpen ? styles.open : ''}`}>
                <ChevronRight size={14} />
              </div>
              <Folder size={14} className={styles.iconFolder} />
            </>
          ) : (
            <div className={styles.fileIconSpacer}>
              {getFileIcon(node.name)}
            </div>
          )}
          <span className={styles.nodeName}>{node.name}</span>
        </div>
        
        {node.type === 'folder' && node.isOpen && node.children && (
          <div className={styles.childrenWrapper}>
            <div className={styles.indentLine} style={{ left: `${depth * 12 + 14}px` }} />
            {renderTree(node.children, depth + 1)}
          </div>
        )}
      </div>
    ));
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>EXPLORER</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} title="New File"><Plus size={14} /></button>
          <button className={styles.actionBtn} title="Refresh"><Refresh size={14} /></button>
        </div>
      </div>
      
      {!state.projectRoot ? (
        <div className={styles.emptyState}>
          <FolderOpen size={32} className={styles.emptyIcon} />
          <p>No folder opened</p>
          <button className={styles.openBtn}>Open Folder</button>
        </div>
      ) : (
        <div className={styles.treeContainer}>
          <div className={styles.projectName}>
            <ChevronDown size={14} />
            <span>sketch-desktop</span>
          </div>
          <div className={styles.tree}>
            {renderTree(tree)}
          </div>
        </div>
      )}
    </div>
  );
}
