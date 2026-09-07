# VibeSync

**A little control room for your AI coding team.**

Working with several coding agents is useful—until they step on the same files,
lose track of an idea, or call a task “done” before the tests pass. VibeSync gives
you one local place to organize that work and see what is happening.

Turn ideas into feature contracts, give each task its own Git worktree, and let
real verification commands decide when a change is ready to merge. A live
light/dark dashboard and animated pixel agent room make the process easy to follow.

## What you can do

- **Keep good ideas without derailing a task.** Park discoveries in an incubator,
  merge related ideas, and promote them when you are ready.
- **Give agents clear boundaries.** Tasks carry acceptance context, allowed paths,
  required checks, and a 45-minute ownership lease.
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

You will need **Node.js 24+** and Git with `merge-tree --write-tree` support.

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

Initialization preserves existing MCP configuration, dashboards, and user files.
It creates no sample tasks and does not stage your source files.

## Your first workflow

1. **Create a feature:** describe the outcome and its acceptance criteria.
2. **Add a task:** choose allowed paths and enter one gate command per line.
3. **Start it:** pick an owner and open the displayed worktree in your editor or agent.
4. **Build and verify:** make your changes, then choose **Verify & settle**.
5. **Finish the feature:** once every task has settled, run its final feature gate.

Found something unrelated along the way? Use **Park Idea** and come back to it.

## Connect a coding agent

`npm start` runs the stdio MCP server and dashboard together. For another project,
initialization generates a local `.mcp.json` binding with the correct absolute
paths. Enable that server in your MCP client. A portable template is available in
[.mcp.example.json](.mcp.example.json).

MCP tools cover state, feature/task creation, leases, verification, incubator
parking and merging, feature settlement, and repair. See the
[usage guide](docs/USAGE.md) for details.

## A few useful boundaries

VibeSync is a **trusted local development tool**. Gate commands run with your user
permissions; review commands before running unfamiliar projects. Keep the HUD on
loopback. The hotfix action stages workspace changes, so inspect its preview.

The activity panel estimates local activity, not provider billing or account
quotas. Recovery restores recorded state; separately back up uncommitted source
files and worktrees. See [security notes](SECURITY.md) and
[recovery instructions](docs/USAGE.md#recovery-and-local-state).

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
