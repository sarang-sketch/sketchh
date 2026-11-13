---
name: egm-review-loop
description: Run a configured group of Goldfish reviewers against a document, resolve the findings, and repeat until the review converges (or hits the round cap).
capabilities: fs:read:project, fs:write:project
---

<!-- Adapted for Sketch from Google's Elephant-Goldfish Model (EGM).
     Source: https://github.com/google/elephant-goldfish-model
     Upstream commit: 270b10326bf366d823bc76fd662cf83808d5781e
     License: Apache-2.0. Original skill: egm-review-loop.
     Sketch adaptation: harness subagent spawning replaced with sequential
     reviewer passes in one fresh session (Sketch has no isolated subagent
     contexts yet). The convergence rules, round cap, and settled-findings
     list are unchanged. -->

# EGM Review Loop: the sharpening loop

The orchestration driver for a multi-reviewer audit. Two memory models:

- **Goldfish (adversarial auditors):** reviewers that read only the target
  document, the standard they audit against, and the Goldfish context —
  never the drafting conversation.
- **Elephant (persistent resolver):** the drafting conversation, which holds
  the institutional knowledge and applies approved fixes (see
  `/egm-resolve`).

## The Goldfish rule (read first, enforce it)

Run the loop in a **fresh session** (no prior chat history). If you are in
the drafting conversation, stop and tell the user to start a new conversation
first. Sketch cannot yet spawn isolated subagent contexts, so the reviewers
below run as **sequential passes in the one fresh session** instead of
parallel isolated subagents. State that in the report header. The passes
still read only the document, their standard, and the Goldfish context.

## Inputs

- **`TargetFile`** (required): path to the document.
- **`SemanticTarget`**: what to audit — `full file`, or a description such as
  "the H4 block with SS-ID 'S1.12'".
- **`Reviewers`**: list of reviewer lenses (below). If missing, recommend:
  feature specs → `design_critic`, `structural`; implementation plans →
  `implementation_readiness`, `codebase_details`.
- **`Standards`**: which standard each reviewer audits against (below).
- **`GoldfishContext`**: a reading list (files, directories). An empty list
  counts as provided — do not ask for it again. Save any URL in it as a local
  file first; if a page cannot be saved, leave it out and say so.

**Reviewer lenses:** `design_critic`, `structural`, `style`,
`implementation_readiness`, `codebase_details`, `comprehension`, `zoom_out`,
`inventive_catalyst`.

**Standards:** `feature-spec-standard`, `implementation-readiness-standard`,
`zoom-out-standard`, `heilmeier-standard`, `re-implementation-standard`.
(A standard is a rubric: what counts as complete, clear, and checkable for
that kind of document. State which standard each reviewer used.)

## Workflow

### Step 1: Intake & configuration

Ask for missing inputs one at a time. Show the consolidated plan (target,
reviewers, standards) and get the user's confirmation before the first round.

### Step 2: The sharpening loop

Repeat until converged, capped, or halted:

#### 2.1 Re-resolve the target

Before **every** round, re-read `TargetFile` and re-locate `SemanticTarget`
to get current line numbers. The file may have been edited in the previous
round; never trust stale line numbers.

#### 2.2 Review passes

Run each requested reviewer as a pass over the target at the resolved range,
against its standard, with `GoldfishContext`. Each finding carries a severity
(🔴 Blocker, 🟡 Major, 🟢 Nit), line numbers, a discrepancy description, and
a rationale. A reviewer that fails or returns no report is **not run** —
retry once, then record it. Never count it as zero findings.

Collect all findings into one flat list. Give each a stable id
(`<reviewer>-<round>-<n>`) and record reviewer, severity, and scope.

#### 2.3 Resolve

Hand `TargetFile`, the line range, and the findings list to `/egm-resolve`
in the Elephant (drafting) conversation: categorize each finding (CONTEST /
ESCALATE / PROPOSE FIX / DECLINE), write `goldfish_review_report.md`, and
apply the fixes the user approves. **Respect the turn-taking checkpoint in
egm-resolve**: stay idle across human turns and loop back only when the user
confirms another round.

#### 2.4 Convergence

- **Settled finding:** contested or recorded without a fix (accepted risk).
  Keep the settled list across rounds. If a later reviewer raises a settled
  finding again at the same scope, do not re-open it.
- **Fixed finding:** an applied fix does **not** settle it. If a later
  reviewer raises the same issue at the same scope, the fix failed or a later
  edit reintroduced it — re-open it.
- **Clean round:** no reviewer raises a Blocker or Major that is not settled.
  Nits do not block. A reviewer recorded as not run makes the round **not**
  clean.
- **Converged:** two consecutive clean rounds. One is not enough — the next
  fresh reviewer can find a different gap in the same text.
- **Cap:** 5 rounds.
- **Churn:** a new finding is at the scope of an applied fix, and reverting
  that fix would resolve it.

On converged, go to Step 3. On cap or churn, list the open findings by
severity and ask the user one question: accept and proceed, continue past
the cap, or return the document to drafting.

### Step 3: Final checkpoint

Report: "The review loop has completed after [N] rounds ([converged |
accepted at cap | halted]). Open findings are in the report." Ask whether
the user wants to proceed to the next stage or has final questions.
