# Native packaging and size budget

Sketch packages on native GitHub-hosted runners because the bundled engine sidecar includes that
runner's Node executable. Renaming one host's runtime to another target triple is not cross-platform
packaging and is forbidden by the Phase 12.1 guard.

## Release matrix

| Platform | Runner | Tauri bundle | Deliverable |
|---|---|---|---|
| Windows | `windows-latest` | NSIS | `.exe` installer |
| macOS | `macos-latest` | DMG | `.dmg` disk image |
| Linux | `ubuntu-22.04` | Debian package | `.deb` installer |

The Linux job installs the [official Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
plus `patchelf` for packaging. Ubuntu 22.04 is intentional: building on a newer distribution can
raise the minimum glibc version required by the artifact. The Debian package declares its GTK and
WebKit system dependencies instead of embedding duplicate copies. A clean offline-machine attempt
must therefore preload those declared packages before disconnecting.

The executable packages are not currently Windows Authenticode-signed or Apple Developer ID-signed
and notarized. A successful version-tag workflow now assembles and GitHub-OIDC-attests the exact
validated release bytes, but no such release has run yet. Provenance attestation and native OS code
signing are different claims; [`RELEASES.md`](RELEASES.md) defines both and the consumer checks.

## Size budget

Each deliverable must be **strictly less than 100,000,000 bytes** (decimal 100 MB, approximately
95.37 MiB). The measured object is the largest distributable installer artifact from each native
job. Unpacked applications, debug symbols, checksums, and JSON manifests are excluded. The committed
machine-readable authority is `packages/desktop/packaging/budgets.json`.

This preserves the PRD's `<100 MB` target rather than quietly changing units or raising the limit.
The embedded Node runtime is about 119 MiB uncompressed on the hosted Linux runner, so the margin is
small and the package gate is intentionally strict. A complete AppImage was measured at 121,412,088
bytes and correctly refused; Linux therefore uses Tauri's native Debian installer rather than
weakening the budget.

## Commands and evidence

```bash
npm run build:sidecar -w @sketch/desktop
npm run verify:sidecar -w @sketch/desktop
npm run package:windows -w @sketch/desktop   # native Windows only
npm run package:macos -w @sketch/desktop     # native macOS only
npm run package:linux -w @sketch/desktop     # native Linux only
npm run package:size -w @sketch/desktop -- --platform windows
```

`.github/workflows/package.yml` runs the matching command on each native OS, checks the sidecar
protocol, enforces the budget, writes `package-sizes-<platform>.json`, and uploads both installer and
manifest. A workflow definition proves the path is wired; only a successful native job with its
uploaded artifact proves that platform's build was produced.

Hosted status on 2026-08-04: the icon-fixed run produced passing Windows/NSIS and macOS/DMG jobs.
Linux produced a valid 121,412,088-byte AppImage, which the unchanged strict budget correctly
rejected; the replacement native DEB path has not yet completed. Local Windows packaging remains
blocked by Application Control (OS error 4551) and missing `dlltool.exe`. Task 12.1 remains evidence-gated until one run completes all three native jobs.
