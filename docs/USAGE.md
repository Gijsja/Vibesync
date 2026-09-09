# Usage and recovery

A local control deck for coordinating AI pair programming. Keep ideas in an
incubator, define feature contracts, lease scoped tasks to agents, and verify
changes before squash-merging them into your Git trunk. The dashboard combines
an execution queue, audit trail, and animated pixel agent room in light and dark
themes.

## Requirements

- Node.js 24 or later (uses built-in SQLite).
- Git with `merge-tree --write-tree` support.
- A local repository with a `main` or `master` trunk.

## Run from this checkout

```sh
npm ci
npm run hud
```

Open the URL printed in the terminal. The preferred port is 4040; VibeSync selects
another port if necessary. The active URL is also saved in `.vibesync/hud.url`.
`npm start` runs the worker MCP stdio service and dashboard together. Use
`npm run hud` when you only want the browser interface. Run
`npm start -- --mcp-role admin` only for a separately configured, human-controlled
administration connection.

## Use with another project

Install the local checkout as a command with `npm link`, then run:

```sh
vibesync --init --repo /absolute/path/to/project
vibesync --hud --repo /absolute/path/to/project
```

Initialization creates the SQLite database, installs the dashboard, adds runtime
ignore rules, and merges a VibeSync server binding into `.mcp.json`. Existing MCP
servers and custom dashboards are preserved. New repositories receive an empty
initial Git commit; user files are not staged or committed. Existing repositories
keep their history. No sample features or tasks are inserted. New workspaces also
receive policy version 2, which requires command approval and Linux Bubblewrap,
denies undeclared network access, and disables legacy command contracts.

`vibesync --help` lists runtime options. Use `--port 0` to choose a free port.

## Everyday workflow

1. **Create a feature.** Give it a title, acceptance criteria, target milestone,
   and holistic gate command. Define what successful delivery means.
2. **Add scoped tasks.** Restrict each task to path globs such as `src/auth/**`
   and enter one verification command per line. Commands execute directly without
   an implicit shell; quoted arguments stay intact, while pipelines, redirects,
   and other unquoted shell operators are rejected. MCP contracts should prefer
   executable-and-argument arrays such as `["npm", "test"]`. If a shell is truly
   required, make it an explicit boundary such as `["bash", "-c", "..."]`.
3. **Start a task.** Choose an owner. VibeSync creates a task branch and isolated
   worktree under `.vibesync/worktrees/`, with a 45-minute lease. Open the displayed
   directory in your editor or agent. The local `.vibesync_ACTIVE_TASK.md` file
   includes the parent feature acceptance criteria, scope, gates, and lease details.
   This action does not launch an AI agent.
4. **Implement and verify.** Administrative MCP task creation may declare ordered
   `setup` command arrays so dependencies are ready as soon as the worktree is
   provisioned. Otherwise install dependencies in the task worktree as needed.
   Use **Verify & settle** in the dashboard or the MCP
   `vibesync_verify_and_settle` tool. Both run scope
   checks, real subprocess gates, merge conflict simulation, and squash settlement.
   Omit `worktree_path` for tasks started through the dashboard or automatic MCP
   provisioning. The stored workspace is used. Managed verification runs in a
   background worker so the dashboard stays responsive.
5. **Inspect failures.** Open Logs for gate artifacts and audit entries. Three
   consecutive failures block a task. Explicit human takeover resets the breaker
   and starts a new lease. Ejecting an active agent grants the human 45 minutes.
   Releasing a
   lease preserves its worktree and does not reopen settled or blocked tasks.
6. **Settle the feature.** Use the dashboard action or call
   `vibesync_settle_feature` after all child tasks are
   settled. Its holistic gate must pass.

Park distractions in the incubator. Promote an idea to a feature when its
acceptance criteria are ready, or discard it while retaining Git history.

The activity budget panel estimates local VibeSync activity. It is not a live
provider billing or account quota integration. Provider configuration lives in
`.vibesync/usage.json`.

## MCP tools and roles

The generated `.mcp.json` uses an absolute runtime path and explicit repository
argument. Configure your MCP-capable client to use that server definition. MCP
stdout is reserved for JSON-RPC; runtime diagnostics go to stderr. The generated
binding is a worker connection by default. Worker and administrative tools are
never exposed together by the CLI, preventing a worker from changing its own
scope, gates, strike state, or feature contract. Tool failures use structured JSON
with the current strike count, exact failure, and forbidden follow-up actions.

### Worker surface

| Tool | Purpose |
| --- | --- |
| `vibesync_list_ready_tasks` | Read a compact list of claimable tasks |
| `vibesync_get_task_detail` | Read one task and its parent feature contract |
| `vibesync_claim_task` | Lease a task and provision its worktree when no path is supplied |
| `vibesync_heartbeat_task` | Renew ownership from server-observed workspace evidence |
| `vibesync_partial_verify` | Run selected structured, safe gates without settlement |
| `vibesync_verify_and_settle` | Run the judicial pipeline and settle a passing task |
| `vibesync_park_insight` | Park an idea on the incubator orphan branch |

### Human administration surface

Start it with `npm start -- --mcp-role admin` and configure it only in a trusted
human-controlled client. Feature and task IDs are optional; when omitted, the
server assigns predictable IDs such as `FEAT-01` and `TASK-01.1`.

| Tool | Purpose |
| --- | --- |
| `vibesync_get_state` | Read the complete ledger for administration and diagnosis |
| `vibesync_preview_task` | Resolve model suitability, command hashes, runtime history, and approvals |
| `vibesync_approve_task_command` | Approve one hash-bound setup, task, or feature command |
| `vibesync_create_feature` | Define a feature contract and holistic gate |
| `vibesync_create_task` | Register scope, gates, and optional provisioning commands |
| `vibesync_release_task` | Release an active lease and preserve work |
| `vibesync_merge_insights` | Merge related incubator ideas while retaining provenance |
| `vibesync_promote_insight` | Turn a parked insight into a scoped draft feature |
| `vibesync_settle_feature` | Verify and settle a completed feature contract |
| `vibesync_get_lease_rollup` | Read redacted correlated lease, gate, approval, and handoff evidence |
| `vibesync_route_task` | Launch a configured Gemini, Claude, Codex, or local CLI adapter |
| `vibesync_adapter_status` | Inspect, cancel, collect, or hand off a supervised adapter run |
| `vibesync_policy_status` | Preview policy capabilities, legacy commands, and missing approvals |
| `vibesync_migrate_policy` | Explicitly apply the reviewed version-2 policy migration |
| `vibesync_repair_state` | Reconcile state from Git provenance |

## Execution policy and migration

Policy version 2 uses `approval_mode: enforce`, `sandbox_mode: required`,
`network_default: false`, and `allow_legacy_commands: false`. A structured command
declares its argv, idempotency, optional network requirement, timeout, and optional
write paths. Approval is bound to the resolved command hash; changing an executable
or npm script invalidates the approval, and unsafe commands consume it.

Existing versionless/version-1 projects remain in compatibility mode until an
administrator migrates them. First call `vibesync_policy_status`. Replace the
listed legacy commands, review the approvals it says are needed, confirm that the
host reports required-sandbox support, and then call `vibesync_migrate_policy`
with `apply: true` and a non-empty `confirmed_by`. The migration changes policy
only: it neither rewrites commands nor grants approvals. Invalid policy JSON or
unsupported versions fail closed.

Gemini, Claude, Codex, and local adapters are configured as executable/argv
templates with explicit environment allowlists. Task context is passed in a mode
0600 redacted file, not interpolated into a shell command. VibeSync owns the lease
heartbeat and stops the old process before provider handoff.

## Recovery and local state

The SQLite database is stored at `.vibesync/state.db`, using WAL and foreign-key
constraints. Gate logs are stored by content hash under `.vibesync/artifacts/`.
Settlement provenance lives in Git commit trailers and `refs/notes/vibesync`;
incubator data lives on `vibesync/incubator`.

Durable snapshots of contracts, leases, idea links, audit records, operation state,
and referenced logs live on `vibesync/state`. Preserve that ref, the incubator ref,
and Git notes when backing up or transferring the repository.

Stop VibeSync, then run `vibesync-repair --repo /absolute/path/to/project`.
Repair restores the last durable snapshot and backs up the original database
files under `.vibesync/backups/`. Repositories without a snapshot use limited
legacy recovery from settlement provenance and incubator records. State repair
cannot reconstruct uncommitted source files or missing worktrees; back up those
separately. Inspect interrupted verification before retrying.

## Safety and verification

This is a trusted local tool. Keep the HTTP server bound to loopback. Version-2
gates run as your user inside Linux Bubblewrap; compatibility process mode is not
OS containment. Hotfix stages all workspace changes, so review them first. Adapter
supervision is process-local and cannot reattach after restart. CPU and memory do
not have portable hard quotas beyond concurrency, time, and output ceilings. See
[HARDENING.md](../HARDENING.md) for the full boundaries and residual risks.

```sh
npm test
```

Tests use temporary Git repositories, subprocesses, SQLite databases, and local
HTTP listeners. Run them in an environment that permits those capabilities.

### Stale lease recovery

Expired leases are automatically returned to `ready` only when no task verification is running. Recovery clears the opaque token, advances `lease_generation`, preserves prior actor/workspace/run evidence, records `STALE_LEASE_RECOVERABLE`, and stops after three automatic recoveries for administrator review.

## MCP connection and long operations

Enable the local `vibesync` server from `.mcp.json` in your MCP client. Use the worker role for task selection, claims, heartbeats, partial verification, and settlement; start with `--mcp-role admin` only for contract and feature administration. Prefer `vibesync_get_summary` for routine coordination rather than the full `vibesync_get_state` ledger. When a verification request is long-running, retain its operation ID and call `vibesync_get_operation` for its current status and stored result instead of repeating the mutation.
