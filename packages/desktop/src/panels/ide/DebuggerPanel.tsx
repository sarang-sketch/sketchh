// Task 3.4 requires a reachable debugger entry point, not a fabricated debugger.
// This panel therefore has no stack, variables, breakpoints, or sample process.
// Validates: Requirements 14.4, 27.3, 27.4

import { Info } from '../../components/Icons'
import styles from './DebuggerPanel.module.css'

export default function DebuggerPanel() {
  return (
    <div className={styles.panel}>
      <Info size={20} />
      <h2>Debugger is not implemented yet</h2>
      <p>
        Run and debug sessions are not available in this build. No process is attached and no
        debug data is being shown.
      </p>
    </div>
  )
}
