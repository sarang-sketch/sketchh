// Two keyboard rules every text box and hand-made button in the app follows.

interface KeyLike {
  key?: string
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
}

/**
 * True while an input method is composing text (Japanese, Chinese, Korean and others).
 * Enter and the arrow keys then pick a candidate, so a text box must not act on them:
 * without this, confirming a word with Enter sent a half-typed message. `keyCode` 229
 * covers webviews that report a composition only that way.
 */
export function isComposing(event: KeyLike): boolean {
  return event.nativeEvent?.isComposing === true || event.isComposing === true || event.keyCode === 229
}

/** Enter or Space: how the keyboard activates anything with `role="button"`. */
export function isActivationKey(event: KeyLike): boolean {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
}
