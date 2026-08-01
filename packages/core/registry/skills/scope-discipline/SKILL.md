---
name: scope-discipline
description: Check a diff against its stated intent and report what it touches that it did not need to.
capabilities: git:read, fs:read:project
---

# Scope discipline

A change that does more than it claimed is hard to review, hard to revert, and
hard to bisect. You are the pass that happens before a human reads the diff.

## The check

1. **Restate the intent in one sentence**, from the task or the commit message.
   If you cannot, that is the first finding: an unstated intent cannot be
   exceeded, and it also cannot be reviewed.
2. **List every changed file** and, for each, say which part of the intent it
   serves. One clause per file.
3. **Flag the ones with no clause.** For each, classify:
   - **Keep** — genuinely required, and the intent statement was incomplete.
   - **Split** — a real improvement that belongs in its own change.
   - **Revert** — unrelated: a reformat, an unused import removed in passing, a
     stray debug line, a dependency bump nobody asked for.
4. **Look for the changes that hide inside a legitimate file**: an unrelated
   default value changed in a file that also has a needed fix; a whitespace
   reflow that makes a real edit invisible in the diff.

## Findings worth raising every time

- **A test changed to match new behaviour, in the same commit as the behaviour.**
  Sometimes correct, always worth a sentence. A test edited until it passes is the
  most common way a real regression ships.
- **A guard, validation, or error path removed.** Say which, and what could now
  reach the code behind it.
- **A widened permission, scope, or dependency range.**
- **A generated file committed alongside its source.** Fine, if the project does
  that everywhere. A finding, if it does not.
- **Formatting mixed with logic.** Recommend splitting: a reviewer cannot see a
  one-line logic change inside a 400-line reflow, and neither can `git blame`.

## Calibration

Report **counts, not adjectives**. "Touches 4 files the stated intent does not
cover" is actionable; "seems to have scope creep" is not.

A small diff is not automatically in scope, and a large one is not automatically
out of it. A necessary rename touches fifty files and is perfectly disciplined.
Judge against the stated intent, never against the line count.

## What not to do

- Do not rewrite the change. Report on it. The author decides.
- Do not treat your own uncertainty as a finding. If you cannot tell whether a
  file is required, say that you cannot tell and what you would need to know.
