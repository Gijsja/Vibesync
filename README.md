# VibeSync (v0.5.0 Developer Preview)

**A little control room for your AI coding team.**

Working with several coding agents is useful—until they step on the same files,
lose track of an idea, or call a task “done” before the tests pass. VibeSync gives
you one local place to organize that work and see what is happening.

Turn ideas into feature contracts, give each task its own Git worktree, and let
real verification commands decide when a change is ready to merge. A live
light/dark dashboard and animated pixel agent room make the process easy to follow.

> **Developer Preview Notice (v0.5.0):** VibeSync uses standard Git, lightweight SQLite storage, and the Model Context Protocol (MCP). Because Node's built-in `node:sqlite` module is marked experimental by upstream Node.js runtime maintainers, VibeSync is currently designated as a **v0.5.0 Developer Preview** rather than a finalized 1.x release. All core coordination, judicial gate enforcement, worktree sandboxing, and disaster recovery features are complete and covered by our test suite.

## What you can do

- **Keep good ideas without derailing a task.** Park discoveries in an incubator,
  merge related ideas, and promote them when you are ready.
- **Give agents clear boundaries.** Tasks carry acceptance context, allowed paths,
  structured checks, model-suitability hints, and renewable owner-token leases.
- **Work in parallel.** Each started task gets an isolated branch and worktree.
- **Verify before merging.** Run actual test, lint, or build commands, check scope
  and conflicts, then squash passing work into `main` or `master`.
- **See the evidence.** Follow live status, inspect gate output, and trace settled
  work through Git trailers and notes. Three consecutive failures pause a task
  for human intervention.
- **Recover project state.** Git-backed snapshots preserve contracts, leases,
  incubator links, audit records, and verification artifacts.

VibeSync coordinates work; it does not launch coding agents or include model
subscriptions. Connect your own MCP-capable coding client, or use the dashboard.

## Try it locally

You will need Git with `merge-tree --write-tree` support and either **Node.js 22.13+** or **Bun 1.3+**.

**Node 24+ is the primary, recommended runtime.** Bun 1.3+ is a supported alternative for Bun-native projects; you need one runtime, not both. Node 22.13+ is supported but reports Node's experimental SQLite warning.

```sh
git clone https://github.com/Gijsja/Vibesync.git
cd Vibesync
npm ci
npm run hud
```

Open the local URL printed in your terminal. VibeSync prefers port **4040** and
chooses another available port when needed. Your data stays in the local project.

To use VibeSync with a different project, run from this checkout:

```sh
node scripts/vibesync.mjs --init --repo /absolute/path/to/your-project
node scripts/vibesync.mjs --hud --repo /absolute/path/to/your-project
```

### One-time Bun install

Install this checkout as a Bun global package once, then use the Bun-native CLI from any project:

```sh
cd /absolute/path/to/Vibesync
bun link
vibesync-bun --init --repo /absolute/path/to/your-project
vibesync-bun --hud --repo /absolute/path/to/your-project
```

If `vibesync-bun` is not found, add `bun pm bin -g` to your shell `PATH`. The existing `vibesync` command remains the Node.js entrypoint.

### CLI shortcuts: handoff & agent instructions

- `vibesync --handoff [TASK_ID]`: Displays a one-screen human handoff card summarizing operational facts (what changed, why, verification evidence, drift risks, and next actions).
- `vibesync --eject <TASK_ID>`: Reclaims an active agent task for a human operator, resets tripped circuit breakers, and grants a fresh 45-minute lease.
- `vibesync --agent-instructions`: Outputs disciplined operating guidelines and tool protocol directly to stdout for AI coding agents.

Initialization connects an existing Git repository at its root. For a folder that
is not yet a repository, it initializes Git and creates one VibeSync-owned empty
anchor commit, so managed worktrees work immediately. It preserves existing MCP
configuration, dashboards, `.gitignore`, and user files; it creates no sample
tasks and never stages or commits user source files. VibeSync runtime files are
ignored locally through Git's `info/exclude` instead of changing your project’s
tracked ignore rules.

## Your first workflow

1. **Create a feature:** describe the outcome and its acceptance criteria.
2. **Add a task:** choose allowed paths, checks, and an optional Gemini, Claude,
   Codex, or local-model suitability hint.
3. **Preview and start it:** inspect resolved commands and approvals, pick an owner,
   and open the displayed worktree in your editor or agent.
4. **Build and verify:** make your changes, then choose **Verify & settle**.
5. **Finish the feature:** once every task has settled, run its final feature gate.

Found something unrelated along the way? Use **Park Idea** and come back to it.

## Connect a coding agent

`npm start` runs the worker stdio MCP server and dashboard together. For another project,
initialization generates a local `.mcp.json` binding with the correct absolute
paths. Enable that server in your MCP client. A portable template is available in
[.mcp.example.json](.mcp.example.json).

The default worker surface can list and inspect ready tasks, claim work, verify and
settle it, and park discoveries. Human administration tools are exposed separately
with `npm start -- --mcp-role admin`; they create contracts, curate insights,
settle features, and repair state. See the
[usage guide](docs/USAGE.md) for details.

For the smallest agent context footprint, connect an agent to the worker MCP server
only while it is assigned work, keep the administrator MCP server in a human-controlled
client, and use the HUD for supervision. Worker tool responses are compact by default;
pass `detail: "full"` only when complete evidence is needed. Leave CLI adapters
unconfigured unless you explicitly want VibeSync to launch a separate provider session.

Before claiming, workers can call `vibesync_preview_task`. The preview identifies
the model family from the actor name, reports whether it matches `model_hint`,
resolves structured gates, and shows approval hashes and historical runtime. A
claim returns an opaque lease token; long-running agents should renew it with
`vibesync_heartbeat_task`. Local-model actors receive a shorter recommended
heartbeat cadence and a longer renewable lease, without receiving broader command
permissions. Approvals are available only on the administrator MCP surface.

New projects receive fail-closed command policy in `.vibesync/policy.json`:

```json
{
  "version": 2,
  "approval_mode": "enforce",
  "sandbox_mode": "required",
  "network_default": false,
  "allow_legacy_commands": false
}
```

`sandbox_mode` accepts `process`, `auto`, or `required`. Process mode sanitizes
sensitive inherited environment variables and enforces time/output limits but is
not an OS security boundary. Auto/required use Bubblewrap when the host supports
it; required mode refuses execution when containment is unavailable.

Structured commands may declare `write_paths`. VibeSync fingerprints the workspace
around each gate and rejects persistent writes outside both those paths and the
task's `allowed_paths`. Omit `write_paths` to inherit the task boundary. This
detects tracked and non-ignored writes; required Bubblewrap is the boundary for
transient or ignored-path activity and mounts only the declared write roots as
writable.

Gate execution is governed by the `resource_policy` object in the same file.
Global and per-actor concurrency limits, timeout ceilings, and output ceilings
apply to setup, task, partial, and feature checks. Local-model actors default to
one concurrent gate. Workers may call `vibesync_partial_verify` for early feedback,
but only structured commands declared `idempotency: safe` are eligible and a
partial run never settles the task or changes its owner.

Each claim also receives a public `leaseRunId` distinct from its secret lease
token. Gate runs and lifecycle events carry that correlation key, allowing the
administrator MCP tool and HUD to show a deterministic, redacted lease rollup of
commands, approvals, persistent writes, failures, and handoffs without embedding
large artifacts or credentials.

Administrators may configure `adapters` for Gemini, Claude, Codex, and local-model
CLIs. Adapters use an executable plus argv template, pass redacted task context
through a private file, forward only explicitly named environment variables, and
never invoke a shell. Routing is deterministic and capability hints never alter
authorization. VibeSync supervises lease heartbeats; cancellation and handoff stop
the old process before ownership moves to another provider.

Newly initialized workspaces use policy version 2: approvals are enforced,
Bubblewrap isolation is required, network is denied by default, and legacy command
forms are disabled. Existing or versionless projects retain version-1 compatibility
until an administrator reviews `vibesync_policy_status` and explicitly applies
`vibesync_migrate_policy`; migration never rewrites contracts or grants approvals.
The preview lists every legacy command, its suggested structured replacement, and
each approval still required. Migration must include an explicit administrator
confirmation, and malformed policy files stop execution rather than falling back.

## A few useful boundaries

VibeSync is a **trusted local development tool**. The default process sandbox is
hardening, not full isolation; use enforced approvals and required Bubblewrap for
less-trusted projects or models. Scope checks cannot prevent reads or network
exfiltration without OS containment. Keep the HUD on loopback. Hotfix preview and
settlement scan changed files for high-confidence secret patterns before commit.

The Usage panel estimates local VibeSync activity and configured request quotas; it
does not measure provider tokens, billing, or account quotas unless real provider
evidence has been recorded. Recovery restores recorded state; separately back up uncommitted source
files and worktrees. See [security notes](SECURITY.md) and
[recovery instructions](docs/USAGE.md#recovery-and-local-state).

Adapter supervision state is currently process-local: restarting VibeSync does not
reattach to a provider CLI that survived independently. CLI adapters are not SDK
integrations, and configured provider executables remain part of the trusted
computing base. Gate CPU and memory are constrained indirectly through concurrency,
time, and output ceilings; VibeSync does not yet install portable per-process CPU
or memory quotas. On non-Linux systems Bubblewrap is unsupported, so policy v2
`required` mode intentionally refuses to run gates. Compatibility-mode projects
using process isolation do not receive filesystem or network containment.

## Contributing

Bug reports and small, focused improvements are welcome. Describe what you tried,
what you expected, and what happened. Please remove secrets and private project
content from logs before sharing them.

```sh
npm test
npm run test:runner
npm run check:public
```

Tests use temporary Git repositories, subprocesses, SQLite, and loopback HTTP
listeners. See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository layout and
[the development archive](docs/archive/README.md) for historical design notes.
