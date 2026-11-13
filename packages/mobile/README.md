# Sketch Mobile — code on your phone

A mobile coding app with the same Asta design as the desktop IDE (canvas
`#141414`, sidebar `#191919`, graphite `#222222`, dividers `#303030`, porcelain
`#eeeeec`, ember `#f58a50`). Bottom navigation, touch targets of at least 44px,
safe-area insets, and reduced-motion support.

## What it does (for real)

- **Files** — create, rename and delete files in a project stored on the phone
  (browser storage). Export the whole project as one JSON file; import it back.
- **Editor** — edit any file with line numbers, saved automatically on the phone.
- **Agent** — chat with Ask / Agent / Auto modes and a Normal / Turbo speed
  switch (same mapping as desktop: Turbo caps turns and reads less context).
  The agent calls a provider the user configures in Settings (OpenAI-compatible
  base URL + model + API key, stored only on the phone). Without a provider it
  cannot send, and says so. In Agent mode the model proposes code in a fenced
  block and the user applies it to a file with one tap.
- **Preview** — HTML files render live in a sandboxed frame; JavaScript runs
  in the frame and its console output is shown below. There is **no terminal
  on mobile** — commands, git and builds run in the desktop app, and Preview
  says so.
- **Settings** — dark/light theme, accent (Ember / Sky / Mint), text size,
  model settings, project export/import.

## Run it in a browser

```sh
npm ci
npm run dev -w @sketch/mobile   # http://localhost:1421
```

Add it to the home screen from the browser to use it like an app (the
`manifest.webmanifest` and icons are included).

## Build the Android APK

The app is Capacitor-ready (`capacitor.config.ts`, app id
`dev.sketch.mobile`). The APK itself was **not** built in the Linux VM used
for this work, because that VM has no Java, no Gradle and no Android SDK
(`java`, `gradle` and `ANDROID_HOME` are all absent) — no APK file is
included, and none is faked.

On a machine with the Android SDK (or in Android Studio), from the repo root:

```sh
npm ci
npm run build -w @sketch/mobile
npm install -D @capacitor/core @capacitor/cli
npx cap add android
npx cap sync
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

For a release APK, create a signing keystore and run
`./gradlew assembleRelease` with the signing config from the
[Capacitor Android guide](https://capacitorjs.com/docs/android).

## Tests

```sh
npm run test -w @sketch/mobile       # file store + agent + sync bundle + service worker tests
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
