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

## Retained native package evidence

Workflow run [`30936156941`](https://github.com/sarang-sketch/sketch/actions/runs/30936156941)
(`Native packages`, push event) completed with conclusion `success` at commit
`642b70ae8d9a360e8bbdb3940907df2a0aa9955f`. The `windows native package`, `macos native package`,
`linux native package`, and `Release behavioral and security gates` jobs each concluded `success`.
`Attest and publish release` was correctly skipped because a branch push is not a version tag.

All three uploaded artifacts were downloaded and independently re-measured. Each installer's actual
byte count and SHA-256 equal its uploaded `package-sizes-<platform>.json` entry exactly, each
manifest records `passed: true`, and each is strictly under the unchanged 100,000,000-byte ceiling:

| Platform | Deliverable | Bytes | SHA-256 | Container check |
|---|---|---|---|---|
| Windows | `nsis/Sketch_0.1.0_x64-setup.exe` | 25,236,326 | `0bcc779fb1922682ebba65caab614cb8b8c137a3e47d1eac1158fbbc32b219b1` | PE image (`MZ`) |
| macOS | `dmg/Sketch_0.1.0_aarch64.dmg` | 40,239,845 | `68ef4372f90b9387b9be0ed588e69a5d190430887cd45900f52d8dbcf749a437` | UDIF `koly` trailer |
| Linux | `deb/Sketch_0.1.0_amd64.deb` | 48,572,918 | `c155fdd3a9d97efa637b39daaab1bfd8b5b2cb807f6cb628f7b6e9116720b93b` | `ar` archive, `debian-binary` 2.0 |

Task 12.1 is complete on this evidence. Two limits are explicit: local Windows packaging on the
development host remains blocked by Application Control (OS error 4551) and missing `dlltool.exe`,
and none of these packages is Authenticode- or Developer ID-signed. A successful native matrix is
also not release publication, so task 12.3 stays open.
