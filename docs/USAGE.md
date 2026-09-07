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
`npm start` runs the MCP stdio service and dashboard together. Use `npm run hud`
when you only want the browser interface.

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
keep their history. No sample features or tasks are inserted.

`vibesync --help` lists runtime options. Use `--port 0` to choose a free port.

## Everyday workflow

1. **Create a feature.** Give it a title, acceptance criteria, target milestone,
   and holistic gate command. Define what successful delivery means.
2. **Add scoped tasks.** Restrict each task to path globs such as `src/auth/**`
   and enter one verification command per line. Shell commands containing commas
   stay intact.
3. **Start a task.** Choose an owner. VibeSync creates a task branch and isolated
   worktree under `.vibesync/worktrees/`, with a 45-minute lease. Open the displayed
   directory in your editor or agent. The local `.vibesync_ACTIVE_TASK.md` file
   includes the parent feature acceptance criteria, scope, gates, and lease details.
   This action does not launch an AI agent.
4. **Implement and verify.** Install project dependencies in the task worktree as
   needed. Use **Verify & settle** in the dashboard or the MCP `vibesync_verify_and_settle` tool. Both run scope
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

## MCP tools

The generated `.mcp.json` uses an absolute runtime path and explicit repository
argument. Configure your MCP-capable client to use that server definition. MCP
stdout is reserved for JSON-RPC; runtime diagnostics go to stderr.

| Tool | Purpose |
| --- | --- |
| `vibesync_get_state` | Read contracts, tasks, agents, incubator, and audit state |
| `vibesync_create_feature` | Define a feature contract and holistic gate |
| `vibesync_create_task` | Register an execution task with allowed paths and gates |
| `vibesync_claim_task` | Lease a task and provision its worktree when no path is supplied |
| `vibesync_release_task` | Release an active lease and preserve work |
| `vibesync_verify_and_settle` | Run the judicial pipeline and settle a passing task |
| `vibesync_park_insight` | Park an idea on the incubator orphan branch |
| `vibesync_merge_insights` | Merge related incubator ideas while retaining provenance |
| `vibesync_settle_feature` | Verify and settle a completed feature contract |
| `vibesync_repair_state` | Reconcile state from Git provenance |

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

This is a trusted local tool. Keep the HTTP server bound to loopback. Gate commands
execute with your user permissions. Hotfix stages all workspace changes; review
those changes first. See [HARDENING.md](../HARDENING.md) for enforced boundaries.

```sh
npm test
```

Tests use temporary Git repositories, subprocesses, SQLite databases, and local
HTTP listeners. Run them in an environment that permits those capabilities.
