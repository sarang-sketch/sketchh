# Release provenance and verification

Sketch's release workflow distinguishes two claims that are often both called “signed.”

1. **GitHub build provenance:** the tag workflow uses GitHub OIDC to attest the exact bytes assembled
   from all three successful native package jobs. A consumer can verify repository/workflow origin
   and byte integrity.
2. **Native platform code signing:** Windows Authenticode and Apple Developer ID signing/notarization
   establish an OS-trusted publisher identity. Sketch does not currently have those project-owned
   certificates or identities. Installers may therefore still show an operating-system warning.

Task 12.3 remains evidence-gated until an actual version-tag workflow publishes a release and its
attestations are independently verified. Workflow configuration is not signed-release evidence.

## Maintainer release procedure

1. Update the root and desktop package versions to the same semantic version and commit the change.
2. Require the canonical build, typecheck, core tests, desktop tests, benchmark check, and the Phase 6
   registry/hash/scope/review tests to pass.
3. Create and push a version tag exactly matching the package version, for example `v0.1.0`.
4. Require all Windows, macOS, and Linux package matrix jobs to succeed. The release job is tag-only,
   depends on both the complete matrix and the canonical release-gates job, and has no `always()`
   escape path.
5. The assembler joins the tag to root npm, desktop npm, Tauri, and Cargo versions; parses, hashes,
   and emits each size manifest from one captured byte buffer; re-hashes each installer against that
   passing manifest; rejects missing, duplicate, unexpected, traversing, or changed files; and emits
   `release-manifest.json` plus `SHA256SUMS` atomically.
6. GitHub attests every validated release asset. The same job verifies every attestation before
   `gh release create --verify-tag` publishes anything.
7. Retain the release URL, tag, commit, workflow run, installer names/sizes/digests, canonical manifest
   digest, and independent verifier output in `tasks-executed.md` before marking task 12.3 complete.

## Consumer verification

Download an installer, `release-manifest.json`, `SHA256SUMS`, and its
`package-sizes-<platform>.json` from the same GitHub Release. From that directory:

```bash
gh attestation verify ./Sketch_0.1.0_amd64.AppImage --repo OWNER/REPOSITORY
sha256sum -c SHA256SUMS
```

Run `gh attestation verify` separately for every asset you consume, including both manifests. Match
its repository and workflow identity to the expected project, then confirm the tag, commit, filename,
byte count, and SHA-256 in `release-manifest.json`. `gh attestation verify` normally contacts GitHub;
use GitHub's documented offline bundle procedure when networkless verification is required.

PowerShell users without `sha256sum` can compare each value with:

```powershell
Get-FileHash -Algorithm SHA256 .\Sketch_0.1.0_x64-setup.exe
```

The expected digest comes from both `SHA256SUMS` and `release-manifest.json`; a mismatch, missing
attestation, unexpected repository/workflow identity, or disagreement between manifests is a failed
verification.

## Marketplace guarantees remain separate

Release provenance does not replace the skills marketplace gates:

- the registry pins every skill directory by a reproducible SHA-256 content digest;
- capability authorization remains fail-closed at the tool dispatcher; and
- open-marketplace review remains bound to the reviewed digest, so changed bytes invalidate approval.

A valid release attestation says where release bytes were built. It does not grant a skill more
capabilities, review changed skill content, or prove who authored a registry entry.

## References

- [GitHub: artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub: generating build provenance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub CLI: `gh release create`](https://cli.github.com/manual/gh_release_create)

GitHub documentation content was rephrased for compliance with licensing restrictions.
