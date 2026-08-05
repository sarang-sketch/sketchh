# README image assets

The root `README.md` shows the two product surfaces, in this order:

| Order | Surface | Screenshot | Vector reference |
|---|---|---|---|
| 1 | **Cowork** — the agent surface | `sketch-agent-cowork.png` | `sketch-agent-cowork.svg` |
| 2 | **Code** — the IDE surface | `sketch-ide-code.png` | `sketch-ide-code.svg` |

Real screenshots are preferred. The `.svg` files are hand-built vector references of the same two
screens, kept as a fallback that always renders, stays crisp at any width, and diffs readably when the
UI changes.

## Adding or replacing the screenshots

From the repository root:

```powershell
# both surfaces
./docs/assets/add-screenshots.ps1 -Agent "C:\path\to\cowork.png" -Ide "C:\path\to\ide.png"

# just one, when you have retaken a single screen
./docs/assets/add-screenshots.ps1 -Agent "C:\path\to\cowork.png"
```

The script copies each capture into place under the exact name above, verifies it is a real PNG or
JPEG by its magic bytes, runs the egress guard, then commits and pushes. Add `-NoPush` to stop before
pushing.

Both switches are optional so one surface can be replaced without re-supplying the other — retaking a
single screen is the common case, and demanding both invites passing a stale file just to satisfy the
signature. The script refuses rather than committing a broken image, because a renamed error page or a
zero-byte placeholder passes a size check and then renders as a broken image on GitHub. If a capture is
byte-identical to what is already committed, it says so and commits nothing.

Doing it by hand instead is fine — save both files here under those names, then check the rendered
README before pushing.

## Capture rules

These are product documentation, not marketing renders.

- Capture at **1024×635 or larger**, PNG, at the real window size, default dark theme, no zoom.
- Show the **genuine state**. Do not configure a model just to hide the `No model configured` label,
  and do not open a project just to hide an honest empty state.
- **Never** capture a window containing an API key, a private repository name, a customer path, or
  any credential. Open a throwaway project first.
- Do not annotate, retouch, or upscale. If the UI changes, retake the capture.

## Editing the vector references

Each `.svg` is commented by region — title bar, sidebar, main canvas, terminal, status bar. Keep the
shared palette:

| Token | Value | Used for |
|---|---|---|
| Page background | `#141414` | main canvas |
| Panel background | `#1a1a1a` | sidebars, panels |
| Card background | `#1f1f1f` – `#242424` | cards, composer, inputs |
| Border | `#282828` – `#363636` | dividers, card outlines |
| Primary text | `#e6e6e6` | labels, headings |
| Muted text | `#8b8b8b` / `#6a6a6a` | secondary and hint text |
| Accent | `#E8631A` → `#FF7A3D` | logo, primary button, active tab, badges |

Keep the `role="img"` and `aria-label` attributes accurate — they are the only description a screen
reader gets. The vector references must keep reporting the same honest strings the app does, including
`No model configured`, `swarm is off`, and `allowlisted, no shell — not a sandbox`.
