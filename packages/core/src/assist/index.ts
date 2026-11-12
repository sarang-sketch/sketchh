// Editor and composer assistance: inline completion and custom slash commands.

export {
  COMPLETION_MAX_LINES,
  COMPLETION_PREFIX_CHARS,
  COMPLETION_SUFFIX_CHARS,
  CURSOR_MARKER,
  CompletionRateLimiter,
  buildCompletionMessages,
  cleanCompletion,
  clipPrefix,
  clipSuffix,
} from './completion.js'
export type { CompletionRequest } from './completion.js'

export {
  INLINE_EDIT_AFTER_CHARS,
  INLINE_EDIT_BEFORE_CHARS,
  INLINE_EDIT_MAX_INSTRUCTION,
  INLINE_EDIT_MAX_SELECTION,
  buildInlineEditMessages,
  cleanInlineEdit,
} from './inlineEdit.js'
export type { InlineEditRequest } from './inlineEdit.js'

export { expandSlashCommand, loadSlashCommands } from './commands.js'
export type { SlashCommand, SlashCommandSource } from './commands.js'
