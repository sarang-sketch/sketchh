# Code and Cowork workspace design

Implemented 11 November 2026. The research, visual direction, architecture decisions
and validation results live in [asta.md](../../asta.md).

## What changed

- Shared project navigation and layout controls connect the Code and Cowork surfaces.
- Appearance settings persist accent, surface palette, density, typography, pane
  placement, activity bar placement, Cowork background and reading width. Settings
  exports include appearance; earlier exports still import.
- Code keeps the editor and terminal together beside a full-height agent. Its Context
  tab shows the real open files and project, with explicit attachment controls.
- Cowork provides real projects, runs, workflows, skills, tools, memory and history.
  Ten editable starter workflows and personal workflows prepare a draft; using one
  does not start a model request. Personal workflows are saved locally.
- A draft follows the current conversation between surfaces and survives closing
  the agent panel. Drafts are kept in this window's memory, not persisted to disk.
- Built-in editor and terminal colors follow the chosen workbench palette. Custom
  editor themes keep their own syntax colors.
- Code, Monaco, terminal rendering, settings and optional panels load on demand.
  Previously visited modes stay mounted, with inactive controls hidden and inert.

## Checks

Interaction tests cover navigation, shared drafts, context attachments, focus mode,
workflow save/edit/delete, busy-run protection, keyboard shortcuts and the model
picker. Appearance tests cover persistence, legacy imports, malformed values and
text contrast for the palettes and custom accents. The production bundle graph
check verifies that heavy optional modules stay outside Cowork's startup imports.

The Cowork surface received a visual pass at 1440 × 960. Further browser automation
was blocked by Computer Use URL verification on Windows; Code and narrow layouts
have interaction/source checks but no completed visual pass from this session.
