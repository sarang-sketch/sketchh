---
name: egm-drift-report
description: Compare design documents in a directory with the current source code and report where they diverge. Produces a dated drift report.
capabilities: fs:read:project, fs:write:project
---

<!-- Adapted for Sketch from Google's Elephant-Goldfish Model (EGM).
     Source: https://github.com/google/elephant-goldfish-model
     Upstream commit: 270b10326bf366d823bc76fd662cf83808d5781e
     License: Apache-2.0. Original skill: egm-drift-report.
     Sketch adaptation: paths follow Sketch's docs/designs/ convention. -->

# EGM Drift Report: do the docs still describe the code?

Design documents rot. This skill finds where the checked-in designs (or
READMEs) no longer match the live code — and reports **only the differences**.
If a document matches the code, it says "No drift detected" and moves on.

Drift reporting is a direct comparison, not a Goldfish review: it reads the documents and the code in this conversation. For a fresh-eyes review with no prior chat history, use `/egm-review`.

## Inputs

A directory of design documents or READMEs (default: `docs/designs/`). If
none is given, ask the user for the target directory.

## Workflow

1. **List documents.** Every Markdown file in the target directory.
2. **For each document, in order** (process sequentially so nothing is
   skipped):
   - **Contextualize.** Read the document. Identify its intent, the proposed
     changes, and the specific filenames and symbols it mentions.
   - **Locate source.** Find the corresponding source files. If paths are not
     explicit, search the code for the named classes, functions, or endpoints.
     If a link is missing, tell the user to add it to the document so the
     next check is cheaper.
   - **Verify.** Read the current state of those source files. Trust what
     you read, not memory.
   - **Detect drift.** Compare design vs. reality. Reportable drift:
     - *Missing features:* logic described in the doc but absent in the code.
     - *Incomplete models:* classes, structs, or schemas missing fields the
       design specifies.
     - *Logic shortcuts:* hardcoded values where dynamic logic was planned.
     - *Architectural divergence:* different patterns or libraries than
       proposed.
     - *Undocumented code:* logic with no design or README reference at all.
   - **Filter.** Report only the differences. Do not describe what matches.
3. **Report.** Append the analysis for each file to
   `{YYYY-MM-DD}_DRIFT_REPORT.md` in the project root, in this strict format:

```markdown
## <DESIGN_DOC_NAME>

<Bulleted list of specific divergences found>
<Or "No drift detected">
```

## Rules

- Be rigorous. If a document names a specific object, field, or file and the
  code does not have it, that is reportable drift. Double-check before
  reporting — a false positive trains the user to ignore the report.
- Read files liberally. The check is against the current code, not against
  what the code looked like when the document was written.
- Never fix drift yourself. The human decides: update the document, or update
  the code. Your report is the input to that decision.
