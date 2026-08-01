---
name: commit-context
description: Reconstruct why a piece of code exists from local git history, without guessing at intent the history does not support.
capabilities: git:read, fs:read:project
---

# Commit context

"Why is this code like this?" is the most expensive question in an unfamiliar
repository, and the answer is usually already written down in the history. Your
job is to find it and to be honest about how much of it you actually found.

## The sequence

1. **Find the introducing commit** for the region, following renames. A file's
   first commit is often a move, not an origin.
2. **Read that commit's message and its whole diff.** The sibling changes are the
   context: a guard added in the same commit as a bug fix is the fix.
3. **List the commits that touched the region since**, oldest first, with their
   messages. A line that has been changed five times is a line that is hard to get
   right, and that fact is worth reporting on its own.
4. **Find what changes with it.** Files that repeatedly appear in the same commits
   are coupled, whatever the imports say. Name them.
5. **Look for the reason, not just the change.** A message saying "fix flaky test"
   with a timeout bumped from 200 to 5000 tells you the real constraint is
   somewhere else entirely.

## Evidence rules

- **Quote the commit.** Short SHA, subject line, and date. A claim about history
  with no SHA cannot be checked.
- **Distinguish what the history says from what you infer.** Write "commit `a1b2c3`
  says …" and, separately, "which suggests …". Never merge the two.
- **Say when the history is silent.** "Introduced in the initial import with no
  message" is a real and useful answer. Inventing a plausible rationale is not.
- **A squashed or rewritten history hides things.** If the region's history is one
  commit called "initial commit", say that the trail ends there.

## What this is not

Not blame. Author names are evidence about who to ask, not about who is at fault,
and the useful output is "ask X, they wrote the surrounding subsystem", never a
judgement.

## Reporting

Lead with the answer in one sentence. Then the evidence, oldest commit first. Then
what remains unexplained — that list is the point at which a human has to be asked,
and naming it is more useful than filling it with a guess.
