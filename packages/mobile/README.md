# Sketch Mobile — code on your phone

A mobile coding app with the same Asta design as the desktop IDE (canvas
`#141414`, sidebar `#191919`, graphite `#222222`, dividers `#303030`, porcelain
`#eeeeec`, ember `#f58a50`). Chat-first home, slide-in drawer, bottom sheets
instead of system dialogs, touch targets of at least 44px, safe-area insets,
and reduced-motion support. Layout patterns follow the Freebuff mobile app;
the Sketch name, mark and palette are Sketch's own.

## What it does (for real)

- **Agent (home)** — chat-first: a centred Sketch mark, a mode pill
  (Chat only / Agent / Auto) and a Normal / Turbo speed switch, and a big
  rounded composer with the configured model, a + button to attach files as
  context, and a send button. Chats are saved on the phone and listed in the
  drawer; tapping one reopens it. The agent calls a provider the user
  configures in Settings (OpenAI-compatible base URL + model + API key,
  stored only on the phone). Without a provider it cannot send, and says so.
  In Agent mode the model proposes code in a fenced block and the user
  applies it to a file with one tap.
- **Drawer** — hamburger menu with New chat, New project, Daily usage (real
  on-phone counts: chats and tokens sent today — never a faked number),
  Projects (top-level folders), saved Chats, and a settings gear. The footer
  shows today's tokens and requests.
- **Files** — a proper explorer: collapsible folders, file-type icons, file
  size + line count + last-edited time per row, search, project stats and
  recent files at the bottom. A per-file menu (Open in Editor / Preview /
  Rename / Delete) lives in a bottom sheet. New files are created from a
  sheet that asks for a name and a type — nothing is ever silently created
  as "untitled.txt". Files live in a project stored on the phone (browser
  storage). Export the whole project as one JSON file; import it back.
- **Editor** — edit any file with line numbers, saved automatically on the phone.
- **Preview** — HTML files render live in a sandboxed frame; JavaScript runs
  in the frame and its console output is shown below. There is **no terminal
  on mobile** — commands, git and builds run in the desktop app, and Preview
  says so.
- **Settings** — profile header ("Local profile" — there is no cloud
  account), a search field that filters the rows, and grouped pages:
  General, Appearance (theme System / Dark / Light, accent Ember / Sky /
  Mint, text size), Model provider, Project (export/import, sync bundle v2),
  Usage (real on-phone counts), About. "Reset app data" clears everything
  stored on the phone after a confirm sheet.
- **New project sheet** — New project (blank, exports a JSON backup first),
  Chat only, GitHub repository (labelled "coming soon" — GitHub import is
  not implemented and is not faked), Start from a template
  (index.html + src/app.js + README.md).

## Run it in a browser

```sh
npm ci
npm run dev -w @sketch/mobile   # http://localhost:1421
```

Add it to the home screen from the browser to use it like an app (the
`manifest.webmanifest` and icons are included).

## Build the Android APK

The app is Capacitor-ready (`capacitor.config.ts`, app id
`dev.sketch.mobile`, Capacitor 8.6.2, Android project in `android/`).
Current version: **1.1.0** (versionCode 2).

On a machine with the Android SDK (or in Android Studio), from the repo root:

```sh
npm ci
npm run build -w @sketch/mobile
npx cap sync android
cd packages/mobile/android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

On the Linux VM used for this work, `./gradlew` cannot run: the sandbox
intercepts Java loopback TCP, so the Gradle daemon can never connect. The
debug APK there is built with the manual pipeline in
`~/Android/manual-build/build.sh` (aapt2 + javac JDK 21 + d8 + zipalign +
apksigner) after `npx cap sync android`. It produces the same app, and the
APK is verified with `aapt2 dump badging`, `apksigner verify` and
`zipalign -c` before it is handed over.

For a release APK, create a signing keystore and run
`./gradlew assembleRelease` with the signing config from the
[Capacitor Android guide](https://capacitorjs.com/docs/android).

## Tests

```sh
npm run test -w @sketch/mobile       # file store + chats + usage + agent + sync bundle + service worker tests
npm run typecheck -w @sketch/mobile
```

## What it is not (yet)

- No live sync with the desktop project: the phone project and the desktop
  folder are separate until a bundle is exchanged. A v2 sync bundle
  (`SketchSyncBundle`, see `SYNC_HANDOFF.md`) is the bridge: export it from
  Settings → Sync with desktop, move the file, import it on the other side.
  Newer files win; equal timestamps with different content keep the phone
  copy and are reported. This is file-bundle sync, not live/real-time sync.
- No local terminal, git, or builds on the phone — those stay on desktop.
- A service worker (`public/sw.js`, cache `sketch-mobile-v1`) caches the app
  shell after first load, so the app opens offline; provider calls are never
  cached, so the agent still needs network.
