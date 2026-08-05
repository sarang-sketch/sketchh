# Security policy

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.**

Use GitHub private vulnerability reporting:
[**Report a vulnerability**](https://github.com/sarang-sketch/sketch/security/advisories/new).
That opens a private advisory visible only to you and the maintainer.

Please include:

- what breaks, and the trust boundary it crosses
- the smallest reproduction you have — a failing test in the style of the existing guards is ideal
- the commit you tested, your OS, and whether you ran the packaged app, `dev:desktop`, or the CLI
- **no real credentials.** Redact keys, private paths, and repository names from logs and captures

There is no bounty. Every report is read personally, so a response may take days, and longer for
anything touching the event log, capabilities, the native host, or a gate. You will get specifics:
what was reproduced, what was fixed, and what was not.

## Supported versions

Pre-1.0. Only `main` is supported. Fixes land on `main`; there are no backports.

## In scope

The guarantees this project actually claims, so breaking one is a security bug:

| Area | The claim it breaks |
|---|---|
| Event log | A provider key, token, or other secret reaching disk unredacted |
| Capability gate | A tool running without a grant, or reachable outside `ToolDispatcher` |
| Path containment | Any read, write, or persisted path escaping the project root |
| Command execution | Shell interpretation of a command, or an executable off the allowlist |
| MCP | A server started outside the prefilter, or inheriting ambient secrets it was not granted |
| Skills / registry | Content executing that does not match its pinned digest |
| Egress | The window loading anything from off this machine, or any telemetry path |
| Native host | A Tauri command reachable without its capability, or a sidecar RPC bypassing Rust authority |
| Credentials | A key readable outside the OS credential store, or exposed to the browser context |
| Releases | An installer accepted without its attestation and size manifest verifying |

## Out of scope

Not because they do not matter, but because they are documented behaviour rather than a broken
promise. Report them as normal issues:

- **A model writing bad, insecure, or wrong code.** Sketch verifies with the nine-stage contract; it
  does not vouch for generated content.
- **An allowlisted executable doing something powerful.** Commands run as argument vectors, so shell
  metacharacters are not interpreted — but an allowed program can still run arbitrary code. The UI
  says `allowlisted, no shell — not a sandbox`, and that is the honest claim.
- **Anything requiring an attacker who already controls your machine or user account.**
- **Vulnerabilities in a model provider you configured**, including a local Ollama instance.
- **Dependency advisories with no reachable path in this code.** Say which call reaches it.

## What hardening is not finished

Named plainly rather than left for you to discover:

- There is **no process sandbox**. Tool execution is allowlisted and shell-free, not isolated.
- Release artifacts carry **build provenance attestations**, not Windows Authenticode or Apple
  Developer ID signing/notarization.
- Clean-machine evidence is still incomplete — see [OFFLINE-PROOF.md](OFFLINE-PROOF.md).

Work on any of these is especially welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
