# Hardening notes

VibeSync is a local tool and its HTTP API should remain bound to loopback. This
does not introduce authentication for remote or multi-user hosting. Command
approval is deliberately exposed through the administrator MCP surface, not the
unauthenticated local HTTP API.

## Enforced boundaries

- HTTP requests must use the listener's Host and, when supplied, matching Origin.
  Cross-site browser requests are rejected, including reads and preflights.
- POST bodies require application/json, an object root, and at most 1,000,000
  bytes. Invalid JSON, oversized bodies, and unsupported media types return
  400, 413, and 415 respectively.
- Hotfix messages are passed to Git through stdin, preserving shell syntax as
  literal text. The hotfix action still stages all workspace changes.
- Embedded dashboard state escapes HTML script terminators and preserves dollar
  sequences literally. Responses disable framing, MIME sniffing and caching.
- Lease release only transitions in-progress tasks. Settled and blocked tasks
  cannot be reopened through releaseTaskLease.
- Settled feature contracts cannot be edited through updateFeature. Settlement
  must go through settleFeature and its verification pipeline.
- readArtifact accepts only generated hexadecimal hashes and rejects symlink
  files, preventing path traversal through its hash argument.

- Scope checks preserve unusual filenames, fail closed for missing Git refs,
  and run again after gates to catch generated out-of-scope files.
- Settlement checks dirty-file overlap, tracks its exact stash, and reports
  restoration failures instead of silently discarding developer changes.
- Background verification is serialized per workspace. Interrupted jobs are
  recorded as failures; gate results and inspector logs use recorded evidence.
- Task setup, verification gates, and holistic feature gates share structured
  command resolution, hash-bound approvals, sanitized inherited environments,
  redacted logs, diagnostics, runtime records, and optional Bubblewrap isolation.
- Verification gates snapshot persistent tracked and non-ignored workspace state
  before and after every command. Writes must remain inside both the task scope
  and the command's optional narrower `write_paths`; Git history mutation is
  always rejected. Bubblewrap mounts the workspace read-only and overlays only
  the declared write roots, containing ignored or transient writes as well.
- Approval hashes include resolved npm script content, so editing a package script
  invalidates its prior approval. Non-idempotent commands consume their approval.
- Gemini, Claude, Codex, and local-model profiles affect suitability, heartbeat
  cadence, lease duration, and resource guidance only—not authorization.
- Lease heartbeats require the current actor and opaque claim token. Expired or
  reassigned leases reject stale heartbeats, and settlement/release clears tokens.
- High-confidence secret patterns are rejected before task settlement and direct
  hotfix staging; findings identify file and category without echoing the secret.
- SQLite-backed gate slots enforce global and per-actor concurrency across
  processes. Every exit path releases its slot; abandoned slots are reclaimed by
  PID or a bounded TTL. Project policy caps time and output, and partial
  verification accepts only structured, explicitly safe commands.
- Public lease run identifiers correlate task events and gate evidence without
  exposing opaque owner tokens. Audit rollups are deterministic, redact sensitive
  text, and reference large artifacts by hash instead of copying their contents.
- Model adapters are structured CLI launchers with explicit environment allowlists,
  private redacted context files, bounded output, supervised leases, and no shell.
  Provider handoff terminates the old process before releasing and reacquiring the
  task, preventing overlapping ownership.
- Repair restores durable Git snapshots into a replacement database, preserving
  backups of the original database and its sidecars.
- Initialization preserves existing MCP bindings, dashboards, and user files.

## Command-policy rollout

The compatibility default is `approval_mode: audit` with `sandbox_mode: process`.
This records unapproved commands while existing projects migrate. Set approval
mode to `enforce` to fail closed. Set sandbox mode to `required` to fail closed
unless Bubblewrap filesystem/network containment is usable. Structured command
profiles reduce ambiguity but do not make test code intrinsically trustworthy.

## Verification

Run `npm test` with Node 24 or later. The fixtures require child-process execution,
temporary Git repositories and local HTTP listeners. HTTP attack regressions are
in tests/http-hardening.test.mjs; lifecycle and artifact regressions are in
tests/adversarial-m1.test.mjs. Historical tests that asserted successful exploits
now assert rejection and preserved state.
