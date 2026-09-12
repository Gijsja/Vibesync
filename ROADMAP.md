# VibeSync product roadmap

## Fit assessment

The external review is a useful product-maturity input, but it is not adopted
verbatim. This roadmap includes only gaps verified in the v0.5.0 codebase and
documentation as of 2026-09-12.

VibeSync already has its differentiated foundation: isolated worktrees,
structured gates, leases, recovery snapshots, policy v2, human handoffs, MCP
worker/admin surfaces, and provider adapters. The route to 1.0 is reliability
and adoption work—not a redesign of the coordination model.

## Release outcome

**1.0 is ready when** the storage/runtime support story is deliberate and
portable, platform-specific security behavior is unambiguous, supervised work
recovers predictably after a restart, and a new user can install and complete a
verified example workflow without cloning internal development assumptions.

## Priority 0 — unblock a credible 1.0

### 1. Make persistence a deliberate runtime boundary

**Why now:** Node's `node:sqlite` remains the stated reason for the Developer
Preview designation. Bun is supported, but Node 24+ is the documented primary
runtime.

**Deliverables**

- Introduce a small storage-driver boundary with migration and backup coverage.
- Select a 1.0 support policy: stable upstream `node:sqlite`, or a pinned,
  maintained driver behind that boundary. Do not promote Bun merely to hide the
  Node warning without a compatibility decision.
- Add upgrade fixtures from existing `.vibesync/state.db` snapshots, including
  WAL/backups and failed-migration rollback.
- Publish the runtime matrix and remove the Developer Preview label only when
  the selected primary path is stable.

**Exit evidence:** migration fixtures pass on every supported runtime and a
fresh/recovered workspace produces equivalent state.

### 2. Complete restart-safe adapter supervision

**Why now:** adapter supervision is intentionally process-local. After a
supervisor restart, VibeSync cannot reattach to a surviving provider CLI.

**Deliverables**

- Persist a minimal, redacted run record: run ID, task/lease-run ID, PID,
  provider, start time, worktree, and lifecycle status.
- On startup, reconcile each record: reattach where supported, mark the run as
  lost with a safe human handoff, or terminate an orphan only after ownership
  and PID-identity checks.
- Test crash/restart, stale PID, PID reuse, and handoff-during-recovery.

**Exit evidence:** a restart leaves every routed task reattached, safely handed
off, or stopped, with an audit event.

### 3. Define cross-platform containment without weakening policy semantics

**Why now:** Bubblewrap containment is Linux-only and policy v2 deliberately
refuses `required` gates when it is unavailable.

**Deliverables**

- Document a capability matrix: Linux Bubblewrap and macOS/Windows process
  hardening until equivalent containment is proven.
- Investigate native platform sandboxes as optional, explicitly labelled
  backends, with adversarial tests before claiming equivalent containment.
- Keep `sandbox_mode: required` fail-closed. Offer explicit `process` or
  `auto` choices rather than silently degrading `required`.

**Exit evidence:** unsupported-required runs explain the missing capability and
safe alternatives; no platform receives weaker containment than requested.

## Priority 1 — make the proven workflow easy to adopt

### 4. Ship an installable, supported first-run path

- Publish and test package installation (`npx` and Bun equivalent), including
  exported CLI assets.
- Add one initialization command that reports policy posture and prints
  client-specific MCP configuration.
- Maintain two small examples: one verified task and one parallel-worktree plus
  handoff workflow.

**Exit evidence:** clean-machine CI completes initialization, claim,
verification, and settlement for both examples.

### 5. Turn existing reliability coverage into a public compatibility matrix

- Add fault injection for concurrent claims, lease-expiry races, worktree
  conflicts, interrupted gates, HUD reconnect, and policy migration.
- Run a released-runtime/platform matrix and publish supported versus degraded
  modes.
- Add smoke contracts for documented MCP clients/adapters; label provider
  support by tested surface rather than intent.

**Exit evidence:** CI exposes the matrix and every documented degraded mode has
a regression test.

### 6. Surface the operational evidence VibeSync already records

- Promote lease, gate, and handoff evidence into a searchable dashboard “needs
  human attention” view.
- Add local-only aggregates for task outcomes, settle time, gate failures, and
  worktree provisioning latency; document retention and avoid cost inference.
- Make handoff cards link a compact diff summary, remaining risks, and next
  action, keeping full artifacts opt-in.
- Expose that compact handoff summary through a read-only MCP tool so agents can
  request bounded operational context without parsing CLI output.

**Exit evidence:** an operator can answer “what needs me, why, and what
changed?” from one dashboard view or handoff card.

## Priority 2 — compound usability after the foundation is stable

### 7. Improve agent onboarding without bloating the default protocol

- Retain compact worker responses and `detail: full` for evidence-heavy calls.
- Add an optional training/profile mode explaining claim → heartbeat → verify →
  settle with a runnable sample task.
- Measure protocol changes with deterministic fixtures before treating them as
  efficiency improvements.

### 8. Strengthen policy and documentation ergonomics

- Publish a versioned policy schema and concise threat-model/TCB guide.
- Make secret-scan-before-settle a reviewed default candidate, configurable for
  false-positive-sensitive repositories.
- Add recovery output that lists restorable state and separately flags
  uncommitted worktrees requiring human review.

## Dogfood findings

This roadmap was created through the VibeSync MCP workflow. The exercise
confirmed structured task creation, preview, hash-bound gate approval, scoped
worktree provisioning, and lease management. It also revealed two adoption
issues worth tracking under Priority 1:

- A local MCP stdio session needs permission to bind its companion HUD; in a
  restricted execution environment it fails even with `--port 0`.
- The fast-path CLI reported failure while leaving its `FEAT-FAST` container
  present, so the fast-path operation needs transactional error reporting and a
  regression test.
- A `node-test` task contract did not preserve its requested target and instead
  ran the complete Bun suite. The replacement task uses explicit argv and this
  behavior needs a contract-resolution regression test.

## Deferred or not adopted from the review

| Proposal | Decision | Reason |
| --- | --- | --- |
| Make Bun the primary runtime | Deferred | Bun is supported, but Node 24+ is the documented primary runtime. The gap is a stable, explicit storage boundary. |
| Let `required` sandboxing degrade gracefully off Linux | Rejected | It violates policy v2's fail-closed contract. Explicit weaker modes are safer and clearer. |
| Expose a handoff card through MCP | Partly covered | CLI/API cards and lease evidence exist, but no dedicated bounded MCP handoff-card tool exists. |
| Add basic metrics | Partly covered | Efficiency metrics and telemetry exist; durable aggregates and operator-facing views remain valuable. |
| Rebuild the core multi-agent model | Not needed | Worktrees, leases, gates, recovery, and worker/admin separation are the differentiated foundation. |

## Sequencing

1. **0.6:** persistence decision and migration harness; adapter-restart design;
   platform containment matrix.
2. **0.7:** restart reconciliation and platform policy UX; fault injection and
   compatibility CI.
3. **0.8:** package/install path, maintained examples, operational metrics,
   attention dashboard, and fast-path transaction hardening.
4. **1.0:** release only after all Priority 0 exit evidence and the clean-machine
   example workflow are continuously verified.
5. **Post-1.0:** training mode, richer handoffs, optional stronger platform
   sandbox backends, and ecosystem integrations.

## Evidence used

- `README.md`: preview rationale, primary runtime, policy v2, containment,
  recovery limits, adapters, and handoff workflow.
- `HARDENING.md`: Linux-specific Bubblewrap and process-local adapter limits.
- `docs/PRODUCT_BASELINE.md`: explicit 1.0 storage criterion and runtime matrix.
- `docs/USAGE.md`, `src/mcp.mjs`, `src/usage.mjs`, and `src/telemetry.mjs`:
  existing MCP, metric, and evidence surfaces.
