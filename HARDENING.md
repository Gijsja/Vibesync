# Hardening notes

VibeSync is a local, trusted-workspace tool. Its HTTP API should remain bound to
loopback. Local programs and MCP clients have access to privileged actions;
required gates are intentionally executable commands supplied by trusted users.
This change does not introduce authentication for remote or multi-user hosting.

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
- Repair restores durable Git snapshots into a replacement database, preserving
  backups of the original database and its sidecars.
- Initialization preserves existing MCP bindings, dashboards, and user files.

## Verification

Run `npm test` with Node 24 or later. The fixtures require child-process execution,
temporary Git repositories and local HTTP listeners. HTTP attack regressions are
in tests/http-hardening.test.mjs; lifecycle and artifact regressions are in
tests/adversarial-m1.test.mjs. Historical tests that asserted successful exploits
now assert rejection and preserved state.
