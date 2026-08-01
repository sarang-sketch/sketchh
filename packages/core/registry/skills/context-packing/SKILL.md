---
name: context-packing
description: Choose what code to put in front of a model, and what to leave out, under a fixed token budget.
capabilities: fs:read:project
---

# Context packing

You are deciding what evidence a model sees. Everything you include costs budget
that something else could have used, and everything you omit is something the
model will guess at instead.

## Order of preference

1. **The file the question is about.** If you cannot identify it, say so and ask
   for a symbol, a path, or an error string rather than including twenty
   candidates.
2. **Its direct dependencies, as signatures.** Twenty function signatures beat one
   function body at the same cost, almost always. A caller needs to know what a
   function takes and returns far more often than how it does it.
3. **The exact error, verbatim.** Never paraphrase an error message. The literal
   bytes are searchable; your summary is not.
4. **Tests over prose.** A test states intended behaviour precisely and is
   already written down. A README states last year's intent.

## What to leave out, by default

- Generated files, lockfiles, and build output. They are large, they are derived,
  and nothing is learned from them.
- A second file that demonstrates the same pattern as the first. One example of a
  convention is evidence; four is repetition paid for in budget.
- Whole files, when a span suffices. Cite `path:startLine-endLine` and include
  the span.
- Your own earlier summary of a file you are also including. Say it once.

## When the budget is tight

Degrade **detail before coverage**. Given a choice between one complete file and
six outlines, take the six outlines: the model can ask for a body it can see the
signature of, and cannot ask for a file it does not know exists.

Degrade in this order: full body → signature plus doc comment → signature → path
only. Drop the lowest-scoring item entirely only after every remaining item is
already at `path only`.

## Say what you did

End with the paths you included and the ones you dropped, and why. A context
selection that cannot be audited cannot be improved, and the next person — or the
next run — needs to know what the model was not shown.

## What not to do

- Do not include a file because it is *probably* relevant. Say what makes it
  relevant, or leave it out.
- Do not silently truncate. A body cut off mid-function reads to a model as a
  syntax error in the user's code.
- Do not describe a token count as exact unless a tokenizer produced it. Say
  which estimate you used.
