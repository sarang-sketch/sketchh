// What's New — the list the title bar's popover shows.
//
// W9 invariant 6: this must list only real, shipped changes. Every entry below is drawn
// from this overhaul's own fix docs (docs/overhaul/fix-*.md, items W2–W8) and names a
// feature that exists in this build. `source` records which fix doc each line comes from
// so the claim is traceable; it is not shown in the UI. Keep each line short and plain,
// and never add a line for something that is not shipped.

export interface WhatsNewEntry {
  /** One short, plain sentence shown in the popover. */
  text: string
  /** The overhaul fix doc this change was shipped by (traceability, not shown). */
  source: string
}

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    text: 'Personalize colors, fonts, density and pane placement, or choose a layout for writing and review.',
    source: 'fix-workspace-design.md',
  },
  {
    text: 'Start with an editable workflow, save your own, and keep your draft when switching between Code and Cowork.',
    source: 'fix-workspace-design.md',
  },
  {
    text: 'Use the Code agent’s Context tab to attach open files and reach project memory, skills and tools.',
    source: 'fix-workspace-design.md',
  },
  // W2 — workspace/paths: the open folder is the one workspace; selecting a conversation
  // no longer moves the root (fix-workspace-paths.md invariants 1–2, B-001).
  {
    text: 'The folder you open stays your workspace: opening a past conversation no longer changes it.',
    source: 'fix-workspace-paths.md',
  },
  // W5/W4 — honest completion + the model receipt (fix-agent-engine.md inv.1 B-003,
  // fix-ai-providers.md the answered-model receipt).
  {
    text: 'A run only says it is done when its edits actually applied, and reads as Stopped when you stop it.',
    source: 'fix-agent-engine.md',
  },
  {
    text: 'Each reply shows the model that answered and what it cost, even when a router picks a different one.',
    source: 'fix-ai-providers.md',
  },
  // W5 — Ask mode is read-only at the tool layer (fix-agent-engine.md invariant 2).
  {
    text: 'Ask mode is now read-only: it can read and search your project but never edits or runs commands.',
    source: 'fix-agent-engine.md',
  },
  // W6 — chat: copy and retry under a reply; rename conversations (fix-chat-panel.md inv.3, inv.6).
  {
    text: 'Copy or retry any reply, and rename or delete a conversation from the Recents list.',
    source: 'fix-chat-panel.md',
  },
  // W7 — skills can be removed; MCP servers add/approve/test/list (fix-skills-mcp.md).
  {
    text: 'Install a skill from the curated registry and uninstall it again, and add and test your own MCP servers.',
    source: 'fix-skills-mcp.md',
  },
  // W8 — git one parser; run detects scripts; terminal stops cleanly (fix-editor-workbench.md).
  {
    text: 'Source Control, Run and the terminal share one reliable engine: no orphaned processes after a Stop.',
    source: 'fix-editor-workbench.md',
  },
  // W9 — settings grouped, keys protected, settings export/import (this item).
  {
    text: 'Settings are grouped clearly, API keys stay masked, and you can export or import your preferences.',
    source: 'fix-settings-misc.md',
  },
]
