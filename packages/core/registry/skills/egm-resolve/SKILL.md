---
name: egm-resolve
description: Work through Goldfish review findings in the drafting conversation — contest, escalate, propose fixes, or decline — and write goldfish_review_report.md.
capabilities: fs:read:project, fs:write:project
---

<!-- Adapted for Sketch from Google's Elephant-Goldfish Model (EGM).
     Source: https://github.com/google/elephant-goldfish-model
     Upstream commit: 270b10326bf366d823bc76fd662cf83808d5781e
     License: Apache-2.0. Original skill: egm-resolve.
     Sketch adaptation: runs in the Elephant (drafting) conversation, which
     is the one place it belongs — resolving needs the history the reviewers
     must not have. -->

# EGM Resolve: work through review findings

You are the **Elephant**: you wrote the document under review, and you hold
the full conversation that produced it. Your job is to judge each Goldfish
finding on its merits — defend what is right, fix what is wrong, and hand
what only the human can decide to the human.

Run this in the **drafting conversation**, not in a fresh session. Resolution
needs the history; review must not have it. That asymmetry is the design: the
reviewers who produced these findings read the document with no prior chat history, and you, the resolver, read it with all of it.

## Inputs

- **`TargetFile`**: path to the document under review.
- **`LineRange`**: exact lines, or `full file`.
- **`FindingsList`**: the aggregated findings from the Goldfish reviewers
  (from `critic_report.md`, `implementation_readiness_report.md`, or
  `consolidated_review_report.md`). If any input is missing, ask for one
  piece at a time in chat until all three are specified.

## Rules

1. **Artifact-first.** Write `goldfish_review_report.md` in the project root
   and tell the user the path. Never dump the whole report in the chat.
2. **Plain English.** Simple, direct, jargon-free.
3. **A contest must be checkable.** "This was intentional" is not evidence.
   Cite a file and symbol, or a decision recorded in the document. If you
   cannot cite evidence the reviewer could have read, use ESCALATE or
   PROPOSE FIX.
4. **Do not add context only to satisfy a reviewer.** Add context when a human
   reader needs it. If only a zero-context reviewer needs it, use ESCALATE.
5. **Do not contest a comprehension gap.** If a fresh reader could not follow
   the document, the document is missing context.
6. **Do not change a severity.** If you think a Blocker is a Nit, CONTEST it
   and state why.
7. You wrote the document. Wanting to contest is not evidence the reviewer
   is wrong.

## Workflow

### Step 1: Intake

Read `TargetFile` at `LineRange` and parse the findings list.

### Step 2: Categorize — exactly one category per finding

- **CONTEST**: the critique is inaccurate or rests on a misunderstanding of
  the codebase. Cite the evidence.
- **ESCALATE**: the critique is inaccurate, but the evidence is outside every
  file the reviewer could read (a team convention, a verbal decision). State
  that fact. Do not fix it. Give it to the user.
- **PROPOSE FIX**: the critique is valid. Define the precise textual
  replacement or structural change that resolves it.
- **DECLINE**: the finding is a Nit. Record it. Do not fix it. (A Nit whose
  fix is clearly worth it may use PROPOSE FIX.)

### Step 3: Write the report

Save `goldfish_review_report.md`:

```markdown
# Goldfish Annotated Review Report

**Target:** `[TargetFile]` (`[LineRange]`)

## Prioritized Findings & AI Suggestions

### [Issue 1] [`[ReviewerLens]`] - Severity: [Blocker | Major | Nit]
*   **Affected Scope:** [Lines Start-End]([RelativePath]#L[Start]-L[End]) ([Sub-header])
*   **Discrepancy Description:** [copied from FindingsList]
*   **Rationale:** [copied from FindingsList]
*   ***AI Suggestion:*** [CONTEST | ESCALATE | PROPOSE FIX | DECLINE]
*   ***Justification:*** [Detailed reason]
*   ***Proposed Edit:***
    *   Location: [Line/Header]
    *   Change: [Precise replacement string or deletion note]
```

### Step 4: Resolution gate

List any ESCALATE findings first — they need the user's knowledge, not only
approval. Then ask the user to choose, and **yield the turn with zero tool
calls** while they decide:

- **Comment directly on the file**: review `goldfish_review_report.md` and
  leave comments/edits to approve, reject, or contest items.
- **Auto accept**: apply all PROPOSE FIX edits to `TargetFile` in one batch;
  CONTEST, ESCALATE, and DECLINE items are skipped.
- **Continue**: proceed without applying fixes.
- **Interactive breakdown**: walk through every item (except DECLINE) one at
  a time in chat. For PROPOSE FIX ask Accept / Skip / Discuss; for CONTEST
  ask Skip / Overrule / Discuss; for ESCALATE ask Confirm / Add the fact to
  the document / Discuss. Record decisions, apply accepted edits only after
  the walkthrough, then proceed.
- **Custom instruction**: apply it and proceed.

### Step 5: Finish

If the target file changed, re-verify it is still structurally coherent,
valid Markdown. Mark the report `Status: resolved` at the top. Exit with the
counts: accepted fixes, contested, escalated, declined, and remaining
unaddressed issues.
