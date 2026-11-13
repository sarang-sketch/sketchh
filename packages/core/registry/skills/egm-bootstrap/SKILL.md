---
name: egm-bootstrap
description: Document an existing codebase bottom-up — a README contract per directory, rolled up into parent blueprints — without changing any code.
capabilities: fs:read:project, fs:write:project
---

<!-- Adapted for Sketch from Google's Elephant-Goldfish Model (EGM).
     Source: https://github.com/google/elephant-goldfish-model
     Upstream commit: 270b10326bf366d823bc76fd662cf83808d5781e
     License: Apache-2.0. Original skill: egm-bootstrap.
     Sketch adaptation: sub-orchestrator workers replaced with sequential
     passes in one run (Sketch has no isolated subagent contexts yet); the
     safety gate and the no-code rule are unchanged. -->

# EGM Bootstrap: document an existing codebase ("peanuts and hay")

Create or correct `README.md` contracts across a directory tree so that the
Elephant — and the next human — can navigate the codebase. **Documentation
only. Do not write or refactor any functional source code, and do not run
`git commit` or `git add`.**

- **Peanuts**: leaf-level READMEs — one per directory, naming each file's
  purpose and its contracts (interfaces, invariants, side effects).
- **Hay**: parent-level blueprints that roll the children's contracts up into
  a high-altitude index of the system.

Bootstrap does not run Goldfish reviews: its passes read the code directly.
The fresh-eyes property — reviewers with no prior chat history — belongs to
the review skills (`/egm-review`, `/egm-review-loop`), not to this one.

## Inputs

- **`path`** (required): the target root directory.
- **`target_filename`** (optional, default `README.md`): use another name
  such as `EGM.md` when a human-maintained README must not be modified.

## Rules

1. **No code generation.** Documentation only.
2. **No version control.** Never commit. All changes are local files for the
   human to review and submit.
3. **Safety gate.** If the tree has more than **15 subdirectories**, stop and
   ask the user for approval before full-tree execution. Say how many
   directories there are and what will be written.
4. **Read files, don't guess.** Every contract states what the code does,
   verified by reading it. Mark anything unverified as such.
5. **Clean Markdown.** Standard headers, tables, fenced code blocks.

## Workflow

### Step 0: Discover the ecosystem

Inspect the root for build manifests and record the verification command for
the generated READMEs:

- Node.js / TypeScript: `package.json` → `npm test`
- Rust: `Cargo.toml` → `cargo test`
- Go: `go.mod` → `go test ./...`
- Python: `pyproject.toml` → `pytest`
- .NET: `*.sln` → `dotnet test`
- C/C++: `Makefile` → `make test`
- Bazel: `BUILD` → `bazel test //...`
- None found: record `<test-command>` as unknown and say so.

### Step 1: Map the tree (breadth-first, one level at a time)

Walk the target directory level by level. Never run a recursive search.
Ignore symbolic links (they can loop), hidden/system directories (`.git`,
`node_modules`, `venv`, `dist`, `build`, `third_party`), and anything in
`.gitignore` / `.egmignore`. Keep package and build manifests in the map —
they carry the verification targets.

If the running count of discovered directories passes 15, **stop and ask**
(the safety gate above) before continuing.

### Step 2: Leaf directories first

For each leaf directory, write or update its `README.md`:

- What the directory is for, in one paragraph.
- Every file: its purpose, its public interface, its invariants, its side
  effects. One line each for small files; a short section for the important
  ones.
- The verification command for that package, if it has one.

### Step 3: Roll up

Move up one level at a time. Each parent README summarizes its children's
READMEs — it links to them and states the subsystem's contract, it does not
repeat their file lists.

### Step 4: Root blueprint

Compile the root `README.md`: a complete high-altitude map of the system —
top-level directories, what each owns, how data flows between them, and where
the design documents live (`docs/designs/`).

### Step 5: Verify and report

Re-read each generated README against the code it describes and fix
inaccuracies. Then report: how many READMEs were created/updated, the paths,
and anything you could not verify. Remind the user to review the output —
humans stay in control of these contracts.
