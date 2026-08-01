---
name: frontend-design
description: Build interface code that is accessible, honest about state, and uses the project's existing design language.
capabilities: fs:read:project
---

# Frontend design

## Use what is already there

Read the existing components, tokens, and stylesheets before writing any. A new
button that looks almost like the existing button is worse than reusing the
existing one, and a second spacing scale is a permanent tax.

Find and reuse: the component that already does this; the design tokens (colour,
spacing, radius, type scale); the project's styling approach. Match it even if you
would have chosen differently.

## Accessibility is not a later pass

- **Semantic element first.** A `<button>` before a `<div onClick>`. You get focus,
  keyboard activation, and the accessibility tree for free, and you cannot
  retrofit them convincingly.
- **Every control is reachable and operable by keyboard**, in an order that
  matches the visual one.
- **Every control has an accessible name.** An icon-only button needs an
  `aria-label`; an input needs a real `<label>`.
- **Focus is visible.** Never remove a focus ring without replacing it with
  something at least as clear.
- **Colour is never the only signal.** Pair it with text, an icon, or a shape.
- **Contrast**: 4.5:1 for body text, 3:1 for large text and for the boundary of an
  interactive element.
- **Respect `prefers-reduced-motion`.** Motion is a preference and, for some
  users, a health constraint.

Full conformance requires manual testing with assistive technology and expert
review. Say that rather than claiming a component is "accessible" because these
rules were followed.

## Every state, drawn

A component that only handles its happy path is unfinished. Handle, explicitly:

- **empty** — and say *why* it is empty ("no results for X", not a blank panel);
- **loading** — and hold the layout, so nothing jumps when data arrives;
- **error** — with what failed and what the user can do;
- **partial** — some data, some missing, and the gap named;
- **too much** — a hundred thousand rows, capped, and the cap stated on screen.

An honest empty state that names its cause is a feature. A spinner that never
resolves is a bug that looks like a feature.

## Never build markup from untrusted text

Model output, file contents, command output, and anything from the network are all
attacker-influenced. Render them as **text nodes**. No `innerHTML`, no
`dangerouslySetInnerHTML`, no building a DOM string from data.

## No invented data

Do not ship a fixture, a placeholder array, or a hardcoded number in a shipped
component. A panel with no data shows its honest empty state. A mock that reaches
production is a lie the user cannot see through.

## Performance, where it is visible

Cap long lists and say so. Debounce work driven by keystrokes. Avoid layout
thrash in a scroll handler. Do not optimise anything else without a measurement.
