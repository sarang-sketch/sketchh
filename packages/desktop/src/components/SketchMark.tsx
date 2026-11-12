/** A compact, code-native mark that stays crisp at every display scale. */
export function SketchMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="var(--accent-fill)" />
      <path d="M28 11H17a6 6 0 0 0 0 12h6a3 3 0 1 1 0 6H12M28 11v5M12 29v-5" stroke="var(--text-on-accent)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
