# Contributing to Sketch

Requirement 26.3 asks for this file alongside `README.md`, `PRIVACY.md` and `LICENSE`. It is short
on purpose: the long version lives in `NEED-TO-DO.md` (the working plan) and
`.kiro/specs/sketch-engineering-os/` (the contract).

## Setup

```bash
npm install
npm run build
npm test
```

Node 20+. Rust is needed only for the Tauri desktop build, not for the engine or the test suite.
Everything runs offline with no API key.

## The five rules that are not style preferences

Each of these exists because something broke.

1. **`packages/core` has zero runtime dependencies.** `packages/core/test/deps.test.ts` fails the
   build if `dependencies` is non-empty or if any file under `src/` imports a specifier that is not
   relative or `node:`. If you think you need a library, write the 80-line module instead. This is
   what makes the engine embeddable, auditable and offline.
2. **Never weaken a gate, guard or redaction to make a test pass.** Deleting an assertion, loosening
   a matcher, adding `.skip`, or introducing an epsilon into a comparison are the same act:
   destroying the only evidence the system works. If a test is red, the cause is in the code until
   you have proven otherwise out loud.
3. **No fixture data in a shipped panel.** A panel with no data shows an honest empty state naming
   *why* it is empty.
4. **Green output is not evidence.** For every guard you touch: break it, watch the test fail,
   restore it, watch it pass. Include both in the pull request. A test that has never failed has
   never been shown to test anything.
5. **Commit at every green point, one task per commit.** This project's worst incident — API keys
   reaching disk unredacted after a cancelled agent silently removed a `sanitizePayload` call — was
   invisible precisely because there was nothing to bisect.

## Before you open a pull request

```bash
npm run build        # first: desktop typecheck consumes core's emitted declarations
npm run typecheck    # must exit 0
npm test             # must exit 0, offline, with NO API key in the environment
```

Run the suite twice: once with `SKETCH_FAKE_PROVIDER=1` and once with it unset. A test that reads an
ambient environment variable it never set makes the whole suite order-dependent.

For anything that touches secrets, the event log, provider settings, or the Tauri surface, also do
it cold — `node_modules` and `packages/core/dist` deleted, then `npm install && npm run build &&
npm test`. A warm `dist` has hidden a real security regression in this repository before.

## Privacy is a test, not a promise

`PRIVACY.md` names every outbound path in the source. If you add one, the document is part of the
change. Three guards will stop you otherwise:

- `packages/core/test/privacy.test.ts` — no usage-tracking or crash-reporting vocabulary in any
  `packages/**/src` file, no such dependency in any manifest or in the lockfile, and no provider
  error that carries the configured key
- `packages/core/test/store.test.ts` — no key reaches the event log on disk
- `packages/desktop/src/privacy.egress.test.ts` — nothing the window loads comes from off this
  machine: no font CDN, no non-loopback subresource, no `preconnect`

## Talking about the work

Say "seam" where it is a seam and "stub" where it is a stub. Nothing in this project has ever run
against a real hosted model provider. Do not describe a wired interface as a working feature, in a
commit message, a pull request, or a document.

## Environment quirks

- `cargo test` cannot link on some Windows setups here (missing GNU `dlltool`). Run the Rust policy
  tests with `rustc --test src/command_policy.rs -o <tmp>/policy` and execute the binary;
  `command_policy.rs` is deliberately std-only so this works. Do not claim `cargo test` passes.
- The symlink containment test **skips** on Windows without Developer Mode. It prints `SKIPPED …`
  and returns. A skip is not a pass.
- `packages/core/test/cli.test.ts` uses `describe.skip` when `dist/cli.js` is absent, so 20 tests
  vanish silently. Always `npm run build` before `npm test`.

## Releases

Only a pushed semantic version tag matching the package version may publish a release. Publication
waits for all three native package jobs, re-hashes every installer against its size manifest,
generates a deterministic canonical manifest, obtains GitHub OIDC build-provenance attestations,
and verifies those attestations before creating the release. Write/OIDC permissions exist only on
that tag-only release job.

This is release **provenance**, not Windows Authenticode or Apple Developer ID
signing/notarization. Do not describe installers as OS code-signed until those identities exist and
native verification output has been retained. The full maintainer and consumer procedure is in
[`RELEASES.md`](RELEASES.md).

Release provenance also does not replace marketplace controls: skill content remains hash-pinned,
capabilities remain fail-closed, and review remains bound to the reviewed digest.

## Licence

Contributions are accepted under Apache-2.0, the licence in `LICENSE`.
