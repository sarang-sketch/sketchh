---
name: egm-review
description: Review a design document with fresh-eyes Goldfish reviewers across five stages, and write a consolidated report. The review runs in a fresh session with no prior chat history.
capabilities: fs:read:project, fs:write:project
---

<!-- Adapted for Sketch from Google's Elephant-Goldfish Model (EGM).
     Source: https://github.com/google/elephant-goldfish-model
     Upstream commit: 270b10326bf366d823bc76fd662cf83808d5781e
     License: Apache-2.0. Original skill: egm-review.
     Sketch adaptation: harness subagent spawning replaced with Sketch's
     fresh review session (a run started with no prior chat history). The
     five stages run sequentially in that one fresh session — Sketch has no
     isolated subagent contexts yet, so stages share the fresh session but
     never the drafting conversation. That limit is stated in the panel and
     in docs, not hidden. -->

# EGM Review: Goldfish review protocol (five stages)

Review a design document with reviewers that have **never seen the drafting
conversation**. That is the whole point: a reviewer who knows why a decision
was made cannot tell you the document fails to say so.

## The Goldfish rule (read first, enforce it)

- The review runs in a **fresh session**: a run started with **no prior chat
  history** — only the target document, its linked files, and this skill.
- If you are running in the same conversation that drafted the document, **do
  not review**. Stop and tell the user: start a new conversation (the EGM
  panel's "Run fresh review" does this) and run `/egm-review <path>` there.
  A review in the drafting conversation is not a Goldfish review.
- Sketch cannot yet spawn isolated subagent contexts, so the five stages below
  run **sequentially in the one fresh session** instead of in five isolated
  ones. Say that in the report header. Stages still read only the document and
  its linked files — never the drafting history, which the fresh session does
  not have.

## Rules

1. **Artifact-first.** Never dump reports in the chat. Write each stage report
   to a file and tell the user the path.
2. **Plain English.** Simple, direct, jargon-free. No ungrounded adjectives.
3. **Stress-test by default.** Lead with what is wrong, missing, or risky.
   Do not praise the document; earn agreement.
4. **One question per gate.** Each stage ends with exactly one question.

## Inputs

- **`TargetFile`** (required): path to the design document. If missing, ask
  for it in plain chat and end your turn.
- **`GoldfishContext`** (optional): extra files to establish the system
  baseline. Linked files inside the project are added automatically (Step 1.3);
  links outside the project or URLs need the user's approval first.
- **`Step`** (optional): a preset (`interactive`, `uninterrupted`,
  `feature_spec`, `implementation`) or a single stage (`5`, `6`, `7`, `8`,
  `9`). If omitted, ask the user to pick a preset.

## Workflow

### Step 1: Intake

1. Read `TargetFile`. If it does not exist, say so and stop.
2. Ask whether the user wants to add context files. An empty list counts as
   provided — do not ask twice.
3. **Linked files** (run once, after the preset is chosen, before the first
   stage that takes context): read `TargetFile`, skip anchor-only links
   (`#...`), strip `#fragment` from the rest, resolve each relative link
   against the document's folder, and add every file that stays inside the
   project. List links that resolve outside the project or are URLs and ask
   which to include; leave unapproved ones out and say which were left out.

### Step 2: Preset

- **Interactive** (default): Stages 5 → 6 → 7 → 8 → 9, with a checkpoint
  gate after each stage.
- **Consolidated**: all five stages without pausing, into
  `consolidated_review_report.md`.
- **Feature spec only**: Stages 5–8, then stop before Stage 9.
- **Implementation only**: jump to Stage 9.

### Step 3: Semantic split

Find the boundary header `## Detailed Implementation Plan` (or `## Implementation
Plan`, `## Work Breakdown`, `## Implementation Steps`). If found at line L:
`FeatureRange = 1..(L-1)`, `DetailedRange = L..End`. If several candidates
match, ask the user to confirm the split. If there is no implementation plan,
`FeatureRange = 1..End`, `DetailedRange = N/A`, and run Stages 5–8 only.

## The five stages

Run in order. Each stage reads only the target ranges plus `GoldfishContext`
— except Stage 6, which reads the document alone. Write each stage's report
before the next stage starts.

| Stage | Name | Reviewers (lenses) | Range | Report file |
| --- | --- | --- | --- | --- |
| 5 | Initial Zoom Out | zoom-out, inventive-catalyst | full file | `zoom_out_report.md` |
| 6 | Comprehension Test | comprehension | Feature + Detailed | `comprehension_report.md` |
| 7 | Critic Review | design, structural, style | FeatureRange | `critic_report.md` |
| 8 | Intermediate Zoom Out | zoom-out | full file | `intermediate_zoom_out_report.md` |
| 9 | Implementation Readiness | implementation-readiness, codebase-details, style | DetailedRange | `implementation_readiness_report.md` |

**Reviewer lenses** (what each one checks):

- **zoom-out**: does the design solve the right problem at the right altitude?
  Are goals, non-goals, and trade-offs explicit?
- **inventive-catalyst**: what trade-off is accepted as inevitable, and can it
  be resolved instead of accepted?
- **comprehension**: paraphrase the design in your own words from the document
  alone. Anything you cannot paraphrase is a gap in the document — that is
  the finding, not a detail question.
- **design**: is the feature spec complete, unambiguous, and internally
  consistent?
- **structural**: does the document's structure carry the argument? Are
  sections in the right place and cross-references correct?
- **style**: is it plain, precise English? Remove jargon, buzzwords, and
  decoration.
- **implementation-readiness**: can the plan be implemented from the document
  alone, without inventing decisions? Every file listed, with rationale?
- **codebase-details**: do the named files, symbols, and APIs actually exist
  in the code as described?

**Findings** carry a severity (🔴 Blocker, 🟡 Major, 🟢 Nit), reviewer lens,
affected scope (lines or section), a discrepancy description, and a rationale
with a recommendation. A reviewer that fails or returns no report is recorded
as **not run** — never as "zero findings". Retry once, then record it.

**Stage gates.** Stages 5, 6, 8 end with: proceed to the next stage / I will
update the doc first (pause; re-run the stage once, max 1 re-audit) / pause
the review. Stages 7 and 9 add: resolve findings with the agent (runs
`/egm-resolve` on that range). After a re-audit, further manual updates are
recorded as accepted trade-offs and the review advances.

## Consolidated report

For the consolidated preset, collect all stage reports, deduplicate findings,
order Blockers → Majors → Nits, build a traceability matrix from raw findings
to consolidated items, and write `consolidated_review_report.md`. Tell the
user the path and the severity counts. Then hand off to `/egm-resolve`.
