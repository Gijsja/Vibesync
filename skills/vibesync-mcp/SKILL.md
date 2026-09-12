---
name: vibesync-mcp
description: "Operate a VibeSync project through its local MCP server: inspect task contracts, claim and maintain leases, verify work, and administer planning when explicitly requested. Use when a user asks to control VibeSync or its task workflow."
---

# VibeSync MCP

Operate a VibeSync project using the local stdio MCP server configured in `.mcp.json` or through supported client bindings documented in [`docs/AGENT_IDE_SETUP.md`](../../docs/AGENT_IDE_SETUP.md).

For a local CLI session, connect with:
```bash
node scripts/vibesync.mjs --repo <repo-root> --mcp-role worker
```
Use `--mcp-role admin` only for human-authorized planning, command approval, repair, or policy migration. Worker and admin roles are strictly disjoint.

---

## 1. Compact Dogfood & Efficiency Protocol

Follow the compact dogfood protocol established in [`ROADMAP.md`](../../ROADMAP.md):

1. **Plan Before Editing**:
   - Inspect ready tasks with `vibesync_list_ready_tasks` or `node scripts/vibesync.mjs --tasks`.
   - Call `vibesync_preview_task` with the target task ID and your actor name.
   - Verify resolved commands, hash approvals, baseline readiness, branch drift, and model suitability before claiming.
2. **Work Exclusively in the Managed Worktree**:
   - Claim one ready task with `vibesync_claim_task`.
   - Work strictly within the returned managed worktree (`.vibesync/worktrees/<task-id>`) and modify only files matching `allowed_paths`.
   - Keep the private lease token confidential; do not write it to shared artifacts or logs.
3. **Heartbeat Regularly**:
   - Renew ongoing work via `vibesync_heartbeat_task` before the lease expires.
4. **Focused Verification**:
   - Use `vibesync_partial_verify` for fast, early feedback on safe declared gates.
   - Settle completed in-scope work with `vibesync_verify_and_settle`.
5. **Bounded Diagnostics**:
   - Rely on default compact responses (`detail: "compact"`). Request `detail: "full"` only when complete gate diagnostics or specific artifact evidence are needed.
6. **Stop on Failure / Circuit Breaker**:
   - Do not loop blindly on gate failures. If a task fails verification or triggers the 3-strike circuit breaker (`status: "blocked"`), halt immediately and request human intervention or handoff (`vibesync --handoff`).
7. **Park Out-of-Scope Discoveries**:
   - Do not expand active task scope. Use `vibesync_park_insight` to park unrelated tech debt, architectural findings, or ideas into the incubator without modifying trunk.

---

## 2. Standard Operational Lifecycle

| Stage | Worker MCP Tool | Action / Invariant |
| :--- | :--- | :--- |
| **Discovery** | `vibesync_list_ready_tasks` | Query claimable tasks; avoid fetching the full state ledger. |
| **Inspection** | `vibesync_get_task_detail` | Read task contract and parent feature acceptance criteria. |
| **Preview** | `vibesync_preview_task` | Inspect resolved command hashes, approvals, and working tree drift. |
| **Claim** | `vibesync_claim_task` | Provision isolated worktree and acquire private lease token. |
| **Progress** | `vibesync_heartbeat_task` | Extend lease cadence; server computes workspace progress. |
| **Pre-Check** | `vibesync_partial_verify` | Run safe, idempotent declared gates for early feedback. |
| **Settlement** | `vibesync_verify_and_settle` | Adjudicate all gates and squash-merge worktree into trunk. |
| **Incubator** | `vibesync_park_insight` | Record out-of-scope insights to the orphan incubator branch. |

---

## 3. Role Boundaries & Administration

- **Worker Session**: Reserved for coding agents. Only worker tools are accessible. Workers cannot self-approve commands, alter claimed scope, or bypass judicial verification gates.
- **Admin Session**: Used exclusively when the human operator explicitly requests planning or administrative mutations:
  - `vibesync_create_feature` / `vibesync_create_task` (planning contracts)
  - `vibesync_approve_task_command` / `vibesync_approve_feature_command` (hash approvals)
  - `vibesync_release_task` (requeue abandoned leases)
  - `vibesync_settle_feature` (settle completed feature contracts)
  - `vibesync_repair_state` (Git provenance state reconciliation)
  - `vibesync_policy_status` / `vibesync_migrate_policy` (fail-closed policy management)

---

## 4. Operational Diagnostics & Baseline Verification

- **Unified Status**: Run `node scripts/vibesync.mjs --status` for a single-call overview of human attention items, working tree baseline readiness, active leases, and ready tasks.
- **Task Queue**: Run `node scripts/vibesync.mjs --tasks` to list ready tasks with allowed scopes and gate definitions.
- **Baseline Consolidation**: Run `npm run baseline` (or `node scripts/vibesync-baseline.mjs`) to verify that the packaged release, CLI help, worker/admin tool catalogs, canonical skill, and runtime documentation remain synchronized.
