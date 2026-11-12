# Sketch website

The launch page for Sketch: plain HTML, CSS and JavaScript. No framework, no build step, no npm install, and no requests to font or analytics services.

| File | What it is |
|---|---|
| `index.html` | The whole page |
| `css/site.css` | Styles, with the light colours checked for readable contrast |
| `js/config.js` | **The only file to edit:** repository, download link, launch email form |
| `js/site.js` | The animations and the interactive bits |
| `assets/fonts/` | Inter and JetBrains Mono, served from the site itself (SIL Open Font License, files included) |
| `assets/img/og.png` | The 1200x630 image link previews show |

## Look at it on your computer

```powershell
python -m http.server 8077 --bind 127.0.0.1 --directory website
```

Then open http://127.0.0.1:8077. Opening `index.html` straight from the disk also works, apart from the fonts, which browsers refuse to load from `file://`.

## Before you share the link

1. **Publish the beta installer as a GitHub release.** "Download the beta for Windows" goes to the repository's Releases page, and links straight to the `.exe` as soon as a release has one (a pre-release counts). Until then visitors land on an empty Releases page. `RELEASES.md` in the repository describes the release steps. To host the installer somewhere else, put its address in `downloadUrl` in `js/config.js`.
2. **Optional: switch on the launch email form.** Set `launchEmailEndpoint` in `js/config.js` to an address that accepts a JSON `POST` of `{"email": "...", "source": "sketch-website"}`, for example a Formspree form or a small Cloudflare Worker. The form shows "You're on the list" only after that address answers with a success status, and shows the error otherwise. While the setting is empty, the form stays hidden.
3. **Once you have a domain,** change `assets/img/og.png` in the `og:image` tag of `index.html` to the full address (for example `https://your-domain/assets/img/og.png`). Some sites only show a preview image from a full address.

## Put it online

Any static host works, because the folder is just files:

- **Embarko (set up):** in PowerShell, run `powershell -ExecutionPolicy Bypass -File "C:\Users\saran\Downloads\sketch\website\deploy-embarko.ps1"`. It reads your deploy token from the first line of `%USERPROFILE%\.embarko\credentials`, uploads this folder as the app `sketch-ide`, waits until it is live and prints the address. Run it again to redeploy. `-DryRun` lists what would be sent without uploading.
- **GitHub Pages:** in the repository settings, Pages → Build and deployment → GitHub Actions, then deploy the `website` folder with the standard "Static HTML" workflow.
- **Cloudflare Pages, Netlify, Vercel:** create a project with no build command and `website` as the output folder.

## What the page claims, and where it comes from

- Every feature on the page exists in the app; `docs/IMPLEMENTATION_STATUS.md` lists them with their tests.
- The four percentages are from the [Stack Overflow Developer Survey 2025, AI section](https://survey.stackoverflow.co/2025/ai/), checked on 2026-11-10: 46% distrust the accuracy of AI tools and 33% trust it, 66% name "almost right, but not quite" as their biggest frustration, 81% have security and privacy concerns about AI agents, and 51% of professional developers use AI tools daily.
- "An example run" is an illustration, and the page says so. Its steps (reading files, a plan before any edit, asking before a command, running the tests, Undo) are the ones the agent really performs.
- The model card uses the real recommendation for a 16 GB laptop with an RTX 3060 (6 GB): `qwen2.5-coder:7b`, 4.7 GB download.

## Privacy of the page itself

The page loads nothing from other sites, with one exception: when it opens, it asks `api.github.com` for the latest releases so the download button can link to the installer. Set `checkLatestRelease: false` in `js/config.js` to turn that off. There is no analytics or tracking code.

## Accessibility

- Every animation stops when the visitor's system asks for reduced motion, and the hero animation has a Pause button.
- The page works without JavaScript: all the text is in the HTML, and the example run shows every step as done.
- Text colours meet WCAG AA contrast, controls have visible keyboard focus, and the page has a skip link.
