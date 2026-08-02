# Requirement 26.2 — clean-machine offline proof

This document defines the evidence needed to claim that Sketch installs, indexes a repository, and
completes a task on a clean offline machine using local Ollama. **No retained run satisfying every
item exists yet. Task 12.2 remains in progress.**

The source-sidecar preflight below is useful preparation, but it is not this proof: it does not
install or launch the packaged app, exercise UI review/apply, or observe process-level network and
DNS activity.

## Source-sidecar real-Ollama preflight

Prerequisites: a host-native sidecar, an operator-supplied real Ollama process listening on
loopback, and an explicitly installed model. The script creates no stub or fake-provider fallback
and requires Ollama's `/api/version` and `/api/tags` responses; process provenance is retained only
by the clean-machine procedure below.

```bash
npm run build:sidecar -w @sketch/desktop
npm run preflight:ollama -- --model llama3.2
```

Use `--endpoint http://127.0.0.1:11434/v1` only to override the default. Non-loopback endpoints,
credentials in URLs, non-`/v1` paths, missing Ollama `/api/version`, and absent exact model names are
refused. A passing run drives the production sidecar through `ping`, indexes a temporary fixture,
runs an editing task with the explicit key-free provider, verifies exact final bytes, and retains a
JSON preflight artifact under `.sketch/preflight/`.

A preflight artifact labels itself non-evidence and records its limitations. It must never be cited
as an installed-app, clean-machine, or no-egress result.

## Clean-machine procedure

1. Start from a fresh VM snapshot with no prior Sketch installation, user configuration, `.sketch`
   directory, package checkout, or inherited provider credentials. Record OS edition, build, VM
   platform, snapshot id, time source, and disk-image hash where available.
2. Before disconnecting the VM, preload a genuine Ollama installation and the chosen model. Record
   Ollama version, exact model name, model digest from `/api/tags`, and installer/package hash.
3. Transfer one native Sketch installer produced by the matching successful task 12.1 job. Record
   workflow run/job identity, installer name, SHA-256, exact bytes, and its passing package-size
   manifest. A locally renamed file or configured workflow is not acceptable.
4. Transfer a small version-controlled fixture repository plus expected final bytes and an offline
   verification command. Record its commit and whole-tree hash.
5. Disconnect every non-loopback network interface or place the VM behind a deny-all boundary.
   Preserve loopback because Ollama is the one allowed endpoint. Record the boundary configuration.
6. Begin process-tree, DNS, and socket capture before installation. Coverage must include the
   installer, Sketch, its Tauri webview, `sketch-engine`, verification children, and Ollama.
7. Install and launch Sketch. Configure the exact key-free Ollama entry through Provider Settings,
   test it explicitly, and capture the resulting `providers.json` bytes.
8. Open the fixture with the native folder picker. In Live Architecture choose **Index this
   project**; retain `.sketch/index/graph.json`, its SHA-256, and nonzero indexed-file/chunk counts.
9. Submit the fixture task in Agent Chat. Retain the complete JSONL event log showing provider/model,
   `plan_written`, `edit_proposed`, verification, and one terminal event.
10. Review the proposal in the shipped Diff Review surface and explicitly accept/apply it. Retain
    screenshots or screen recording, final file bytes and hash, unified diff, and verification output.
11. Stop capture only after the app and sidecar exit. Export raw packet, DNS, socket, process-start,
    and process-exit records before interpreting them.

## Required network evidence

A static source scan, an offline firewall rule by itself, or a packet capture without process
attribution is insufficient. Retain both:

- raw packet/DNS capture covering the full procedure; and
- process-attributed socket/DNS records joined to a process tree and timestamps.

Platform-appropriate examples include Sysmon network/process events plus `pktmon`/ETW on Windows,
Endpoint Security or `nettop` plus `tcpdump` on macOS, and eBPF/audit process tracing plus
`tcpdump` on Linux. Tool choice is not evidence by itself: preserve configuration, raw outputs,
versions, clocks, dropped-event counters, and the join from PID to executable hash.

The verdict table must enumerate every destination. Allowed traffic is only loopback traffic to the
recorded Ollama listener. Any DNS query, non-loopback connect attempt, unresolved process, capture
gap, dropped records, or clock mismatch makes the verdict **inconclusive or failed**, never passed.
Denied connection attempts still count as attempted egress and must be reported.

## Evidence bundle

Retain one immutable directory containing:

- `environment.json`: OS/VM/snapshot identity and capture-tool versions;
- `installer.json`: workflow identity, artifact bytes, SHA-256, and size-manifest bytes;
- `ollama.json`: version, endpoint, exact model name, and model digest;
- `fixture.json`: repository commit/tree hash, task text, expected bytes, and check command;
- raw install/app logs, provider configuration, graph, event JSONL, final diff, and check output;
- raw packet, DNS, socket, and process-tree captures;
- `verdict.json`: destination-by-destination classification and explicit no-non-loopback result; and
- `MANIFEST.sha256`: hashes for every retained file, generated only after capture is complete.

Record operator, start/end timestamps, anomalies, retries, and whether the snapshot was restored
between retries. Do not merge evidence from different attempts into one passing bundle.

## Pass conditions

Task 12.2 may be checked complete only when one retained attempt proves all of the following:

- the matching native installer genuinely installed and launched on the clean snapshot;
- genuine Ollama served the recorded local model;
- indexing produced a nonempty graph artifact;
- the installed UI completed the task through explicit review/apply and the final check passed;
- raw process-attributed evidence shows no DNS query or socket attempt to a non-loopback address; and
- the evidence bundle is complete and internally hash-consistent.

Until then, documentation must say **preflight implemented; clean-machine evidence pending**.
