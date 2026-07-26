import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Plus, Check } from './Icons';
import styles from './ModelSelector.module.css';

const PROVIDERS = [
  {
    name: 'Anthropic',
    connected: true,
    models: [
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', badges: ['Fast', 'Vision'], cost: '$$' },
      { id: 'claude-3-opus', name: 'Claude 3 Opus', badges: ['Powerful'], cost: '$$$$' },
      { id: 'claude-3-haiku', name: 'Claude 3 Haiku', badges: ['Fastest'], cost: '$' }
    ]
  },
  {
    name: 'OpenAI',
    connected: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', badges: ['Fast', 'Vision'], cost: '$$$' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', badges: [], cost: '$$$' }
    ]
  },
  {
    name: 'Local',
    connected: false,
    models: []
  }
];

export function ModelSelector() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState('claude-3-5-sonnet');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedName = PROVIDERS.flatMap(p => p.models).find(m => m.id === selectedModel)?.name || 'Select Model';

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button className={styles.triggerBtn} onClick={() => setIsOpen(!isOpen)}>
        <div className={styles.statusDot} />
        <span className={styles.selectedName}>{selectedName}</span>
        <ChevronDown size={14} className={styles.chevron} />
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownContent}>
            {PROVIDERS.map(provider => (
              <div key={provider.name} className={styles.providerGroup}>
                <div className={styles.providerHeader}>
                  <div className={`${styles.providerDot} ${provider.connected ? styles.connected : styles.disconnected}`} />
                  <span>{provider.name}</span>
                </div>
                
                {provider.models.map(model => (
                  <div 
                    key={model.id}
                    className={`${styles.modelItem} ${selectedModel === model.id ? styles.selected : ''}`}
                    onClick={() => {
                      setSelectedModel(model.id);
                      setIsOpen(false);
                    }}
                  >
                    <div className={styles.modelMain}>
                      {selectedModel === model.id && <Check size={14} className={styles.checkIcon} />}
                      <span className={styles.modelName} style={{ marginLeft: selectedModel === model.id ? 0 : 22 }}>
                        {model.name}
                      </span>
                    </div>
                    
                    <div className={styles.modelMeta}>
                      {model.badges.map(b => (
                        <span key={b} className={styles.badge}>{b}</span>
                      ))}
                      <span className={styles.cost}>{model.cost}</span>
                    </div>
                  </div>
                ))}
                
                {!provider.connected && (
                  <div className={styles.notConnected}>Not configured</div>
                )}
              </div>
            ))}
          </div>
          
          <div className={styles.dropdownFooter}>
            <button className={styles.addProviderBtn}>
              <Plus size={14} />
              Add Provider
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
