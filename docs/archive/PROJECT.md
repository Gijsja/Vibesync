# Project: VibeSync

## Architecture
VibeSync is a local-first Git-native coordination harness and stdio Model Context Protocol (MCP) server for concurrent AI pair-programming (Google Antigravity and OpenAI Codex GUI) with an ambient real-time Control HUD and Pixel Agent Room.

### Component Topology
- **Core Engine & Persistence (`src/db.mjs`, `src/incubator.mjs`)**:
  - Embedded SQLite database at `.vibesync/state.db` using Node.js built-in `node:sqlite` (`DatabaseSync`).
  - WAL mode (`PRAGMA journal_mode = WAL;`), foreign keys (`PRAGMA foreign_keys = ON;`), and `busy_timeout = 5000;`.
  - 4 core tables: `incubator`, `features`, `tasks`, `settlement_events`.
  - Heavy terminal traces offloaded to git-ignored `.vibesync/artifacts/<hash>.log` with 12-character SHA-256 hash stored in DB and Git notes.
  - Headless orphan branch synchronization: updates `vibesync/incubator` branch using Git plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`) with zero checkout and zero footprint on `main`.

- **Git Judicial Harness & Gatekeeper (`src/guard.mjs`, `src/gatekeeper.mjs`, `src/merge.mjs`, `src/settle.mjs`)**:
  - Path whitelist guard matching staged changes against `task.allowed_paths` via POSIX glob matching (`picomatch`).
  - Shift-left subprocess runner (`spawnSync`) asserting actual OS exit code 0 on all `required_gates`.
  - 3-strike circuit breaker flipping task to `'blocked'` on 3 consecutive failures to halt token burn.
  - In-memory headless merge simulation via `git merge-tree --write-tree` detecting conflicts before disk mutation.
  - Transactional squash-merge settlement with RFC 2822 trailers (`Task-Id`, `Feature-Id`, `Agent-Actor`, `Base-Commit`, `Gate-Verification`) and Git notes (`refs/notes/vibesync`), with automated `git merge --abort` rollback.

- **Stdio MCP Server & Ambient Control HUD (`src/mcp.mjs`, `src/server.mjs`, `scripts/vibesync.mjs`)**:
  - Stdio MCP server powered by `@modelcontextprotocol/sdk` exposing tools, resources, and prompts.
  - Strict stdio hygiene: `stdout` reserved strictly for JSON-RPC 2.0 messages; all logging directed to `stderr` or `.vibesync/vibesync.log`.
  - In-process HTTP & SSE server listening on `127.0.0.1:4040` (with graceful `EADDRINUSE` handling for sibling agent instances).
  - Ambient Control HUD (`.vibesync/dashboard.html`) served at `/` and `/index.html`. Active URL saved to `.vibesync/hud.url`.
  - SSE endpoint `/api/events` streaming real-time engine state changes.
  - REST endpoints: `/api/state`, `/api/events`, `/api/eject`, `/api/park`, `/api/hotfix`, `/api/features`, `/api/tasks`, `/api/logs`, `/api/usage`.

- **Pixel Agent Room & Teamwork Visualization Engine (`.vibesync/dashboard.html`)**:
  - Native 2D Canvas engine (`AgentRoomEngine`) at 920x155 resolution running at 60fps.
  - Dynamic multi-agent mapping across 4 core subagent lifecycle roles:
    - **Team Lead** (`👑 Team Lead`, `#06b6d4`, slot 0): Feature specs, milestone orchestration, coordinator.
    - **Implementer** (`💻 Implementer`, `#10b981`, slot 1): Active task lease coding, branch worktree commits.
    - **Reviewer** (`🔍 Reviewer`, `#c084fc`, slot 2): Shift-left verification at server rack, audit analysis.
    - **Judge** (`⚖️ Judge`, `#f59e0b`, slot 3): Invariant gate settlement, atomic squash merges.
  - Real-time activity animations:
    - **Coding / Leased**: Seated at desk, typing arms, scrolling syntax lines, light cone, overhead task & branch badge.
    - **Verifying at Gate Rig**: Reviewer/Implementer transitions to Server Rack (`rackX: 180, rackY: 104`), holds diagnostics tablet, rack LEDs switch to high-frequency verification scan, marquee displays `'VERIFYING GATES ⚡'`.
    - **Circuit Breaker Tripped (Blocked)**: Strobe flashing hazard beacon mounted above desk, red alert monitor, warning badge (`🚨 3 STRIKES BLOCKED`), distressed character pose.
    - **Cooldown Lounge**: Idle agents rest on sofa or at coffee counter in Break Lounge.
  - Interactive Agent Inspector: Clicking any agent opens modal directly displaying Leased Task ID, Worktree Branch, and embedded recent verification logs from `/api/logs?taskId=...`.

---

## Code Layout
```
<project-root>/
├── package.json                   # Project manifest, dependencies, test scripts
├── package-lock.json
├── .gitignore                     # Ignores .vibesync/*.db, .vibesync/artifacts/, node_modules/
├── ORIGINAL_REQUEST.md            # Authoritative user requirements
├── blank.pdf                      # Reference architectural specification
├── scripts/
│   ├── vibesync.mjs               # Executable entry point: stdio MCP server + in-process HTTP/SSE HUD
│   ├── vibesync-db.mjs            # Database migration and CLI inspection utility
│   └── vibesync-repair.mjs        # Self-healing disaster recovery script
├── src/
│   ├── index.mjs                  # Main exports
│   ├── config.mjs                 # Workspace paths, constants, pragma definitions
│   ├── db.mjs                     # SQLite DatabaseSync wrapper, DDL migrations, transaction helpers
│   ├── incubator.mjs              # Incubator CRUD and Git plumbing to orphan branch
│   ├── features.mjs               # Features state machine, contracts, holistic gating
│   ├── tasks.mjs                  # Tasks leasing, active anchor hydration, status transitions
│   ├── guard.mjs                  # Path whitelist glob containment validator
│   ├── gatekeeper.mjs             # Subprocess verification runner & 3-strike circuit breaker
│   ├── merge.mjs                  # In-memory git merge-tree collision detector
│   ├── settle.mjs                 # Atomic squash settlement, RFC 2822 trailers, Git notes
│   ├── mcp.mjs                    # MCP server definition, tool schemas, handlers
│   ├── server.mjs                 # In-process HTTP & SSE server with resilient port binding
│   ├── repair.mjs                 # State reconstruction engine from Git logs and notes
│   └── usage.mjs                  # AI provider quota calculation and rate limits
├── .vibesync/
│   ├── dashboard.html             # Ambient Control HUD & Pixel Agent Room UI
│   ├── hud.url                    # Current active HUD URL (e.g. http://127.0.0.1:4040)
│   └── artifacts/                 # Offloaded terminal output logs (git-ignored)
└── tests/
    ├── harness.mjs                # Test fixture generator, isolated git sandbox manager
    ├── runner.mjs                 # E2E test runner
    ├── harness.test.mjs           # Sandbox & client test suite
    ├── m1-state-engine.test.mjs   # M1 state engine tests
    ├── adversarial-m1.test.mjs    # M1 stress tests
    ├── m2-judicial-harness.test.mjs # M2 judicial harness tests
    ├── adversarial-m2.test.mjs    # M2 edge case tests
    ├── m3-mcp-hud.test.mjs        # M3 MCP & HUD tests
    ├── m4-repair.test.mjs         # M4 disaster recovery tests
    ├── providers-usage.test.mjs   # Provider usage tests
    └── agent-room-engine.test.mjs # Pixel Agent Room canvas engine & teamwork test suite
```

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | SQLite WAL Mode Configuration | Set `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;` | M1 | blank.pdf p.10,22 |
| 2 | Foreign Key Enforcement & Cascades | Enforce `PRAGMA foreign_keys = ON;` and `ON DELETE CASCADE` | M1 | blank.pdf p.10,22 |
| 3 | Strict Schema CHECK Constraints | Check constraint validation on status, category, action enums | M1 | blank.pdf p.10,22 |
| 4 | Artifact Log Offloading | Hash terminal logs into `.vibesync/artifacts/<hash>.log` | M1 | blank.pdf p.11,22 |
| 5 | Incubator Parking (`INC-###`) | Append-only ideation parking with zero code authorization | M1 | ORIGINAL_REQUEST R1 |
| 6 | Orphan Branch Sync Plumbing | Git plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`) | M1 | blank.pdf p.18,23 |
| 7 | Zero-Footprint on Main | Ensure incubator commits never touch `main` branch | M1 | ORIGINAL_REQUEST R1 |
| 8 | Feature Contract Management | Registration of `FEAT-###` with holistic acceptance criteria | M1 | ORIGINAL_REQUEST R1 |
| 9 | Feature Holistic Gate Check | Execution of `holistic_gate_cmd` upon all child tasks settled | M1 | blank.pdf p.12,22 |
| 10 | Feature Settlement Invariant | Cannot settle feature if child tasks remain unsettled | M1 | blank.pdf p.12,22 |
| 11 | Task Creation & Worktree Binding | Binding `TASK-###` to feature with dedicated `task/*` branch | M1 | ORIGINAL_REQUEST R1 |
| 12 | Task Leasing & 45-Min TTL | Lease duration expiration check and ownership tracking | M1 | blank.pdf p.19,22 |
| 13 | Active Anchor Hydration | Generate `.vibesync_ACTIVE_TASK.md` in active worktree | M1 | blank.pdf p.19,22 |
| 14 | Event Ledger Auditing | Record state mutations into `settlement_events` table | M1 | blank.pdf p.10,22 |
| 15 | Path Whitelist Glob Matching | Validate staged diffs against `task.allowed_paths` via `picomatch` | M2 | ORIGINAL_REQUEST R3 |
| 16 | Shift-Left Gate Subprocess Runner | Execute shell commands in `required_gates` checking exit code 0 | M2 | ORIGINAL_REQUEST R3 |
| 17 | 3-Strike Failure Counter | Increment and track `consecutive_failures` per task | M2 | ORIGINAL_REQUEST R3 |
| 18 | Circuit Breaker Trip to Blocked | Mark task `blocked` on 3rd failure and lock branch | M2 | ORIGINAL_REQUEST R3 |
| 19 | Circuit Breaker Failure Offload | Save gate failure traces into `.vibesync/artifacts/<hash>.log` | M2 | blank.pdf p.20,22 |
| 20 | In-Memory Conflict Detection | Pre-flight `git merge-tree` collision detection before checkout | M2 | ORIGINAL_REQUEST R3 |
| 21 | Pre-Flight Merge Rejection | Abort settlement if `git merge-tree` outputs conflict markers | M2 | blank.pdf p.20,23 |
| 22 | Transactional Squash Settlement | Squash-merge task branch to `main` with atomic commit | M2 | ORIGINAL_REQUEST R3 |
| 23 | RFC 2822 Commit Trailers | Append `Task-Id`, `Feature-Id`, `Agent-Actor`, `Base-Commit` | M2 | ORIGINAL_REQUEST R3 |
| 24 | Git Notes Verification Stamping | Attach verification log to `refs/notes/vibesync` | M2 | ORIGINAL_REQUEST R3 |
| 25 | Working Tree Preservation | Ensure uncommitted/unstaged developer files on `main` remain untouched | M2 | ORIGINAL_REQUEST R3 |
| 26 | Settlement Rollback on Error | Execute `git merge --abort` if squash settlement encounters errors | M2 | blank.pdf p.20,23 |
| 27 | Stdio MCP Protocol Server | JSON-RPC 2.0 stdio server via `@modelcontextprotocol/sdk` | M3 | ORIGINAL_REQUEST R2 |
| 28 | Stdio Output Stream Hygiene | Reserve `stdout` strictly for JSON-RPC; route all logs to `stderr` | M3 | blank.pdf p.18,22 |
| 29 | MCP Tool: `vibesync_get_state` | Retrieve full system state snapshot (features, tasks, incubator, events) | M3 | blank.pdf p.23 |
| 30 | MCP Tool: `vibesync_claim_task` | Atomically lease task to actor and hydrate `.vibesync_ACTIVE_TASK.md` | M3 | blank.pdf p.23 |
| 31 | MCP Tool: `vibesync_verify_and_settle` | Run path guard, gates, merge-tree, squash-merge, trailers, notes | M3 | blank.pdf p.23 |
| 32 | MCP Tool: `vibesync_park_insight` | Park off-task idea into incubator and sync to orphan branch | M3 | blank.pdf p.23 |
| 33 | MCP Tool: `vibesync_settle_feature` | Verify all child tasks settled, execute holistic gate, stamp feature | M3 | blank.pdf p.12,23 |
| 34 | MCP Tool: `vibesync_repair_state` | Trigger self-healing state reconstruction via tool call | M3 | blank.pdf p.21,23 |
| 35 | In-Process Loopback HTTP Server | Spawn HTTP server on `127.0.0.1:4040` concurrent with stdio MCP | M3 | ORIGINAL_REQUEST R2 |
| 36 | Resilient Port Negotiation | Catch `EADDRINUSE` gracefully without crashing stdio MCP process | M3 | ORIGINAL_REQUEST R2 |
| 37 | Ambient HUD Serving | Serve `.vibesync/dashboard.html` at `GET /` and `/index.html` | M3 | ORIGINAL_REQUEST R2 |
| 38 | SSE Real-Time Stream (`/api/events`) | Broadcast state updates to connected HUD clients | M3 | ORIGINAL_REQUEST R2 |
| 39 | HUD Action: Agent Eject (`/api/eject`) | Reassign task to `'human'` to release lock | M3 | blank.pdf p.23 |
| 40 | HUD Action: Idea Parking (`/api/park`) | Web form endpoint to park insight into incubator | M3 | blank.pdf p.23 |
| 41 | HUD Action: Hotfix (`/api/hotfix`) | Emergency commit direct to `main` with `--allow-empty` | M3 | blank.pdf p.23 |
| 42 | Disaster Recovery CLI (`vibesync:repair`) | Standalone CLI script `scripts/vibesync-repair.mjs` | M4 | ORIGINAL_REQUEST R4 |
| 43 | Incubator Recovery from Orphan Branch | Reconstruct incubator records from `vibesync/incubator:incubator.json` | M4 | blank.pdf p.21,24 |
| 44 | State Recovery from Commit Trailers | Reconstruct features and tasks from `git log main` RFC 2822 trailers | M4 | blank.pdf p.21,24 |
| 45 | Event Recovery from Git Notes | Reconstruct settlement events from `refs/notes/vibesync` | M4 | blank.pdf p.21,24 |
| 46 | In-Flight Branch Recovery | Reconstruct in-progress tasks from `git branch --list 'task/*'` | M4 | blank.pdf p.21,24 |
| 47 | Identical Provenance Verification | Restored `.vibesync/state.db` matches pre-deletion state | M4 | ORIGINAL_REQUEST AC |
| 48 | 100% E2E Test Suite Validation | All Tiers 1-4 tests pass with exit code 0 | M5 | ORIGINAL_REQUEST AC |
| 49 | Adversarial Coverage Hardening | White-box stress-testing & edge case penetration (Tier 5) | M5 | Project Pattern |
| 50 | Dynamic Multi-Agent Role & Workstation Mapping | Map `Team Lead`, `Implementer`, `Reviewer`, `Judge` to workstations from SQLite | M6 | ORIGINAL_REQUEST R1 |
| 51 | Workstation Desk Seating & Active Task Lease Binding | Automatically seat leased agent at desk with task pill & branch name | M6 | ORIGINAL_REQUEST AC 1 |
| 52 | Dual-Monitor Code Typing & Activity Animation | Render animated scrolling code lines, light cone, typing arms, sparkline | M6 | ORIGINAL_REQUEST AC 1 |
| 53 | Gate Rig Reviewer/Implementer Movement | Move agent to server rack (`rackX, rackY`) during verification | M6 | ORIGINAL_REQUEST AC 2 |
| 54 | Server Rack Blinking LEDs & Verification Marquee | High-speed test LED pattern and active marquee on verification run | M6 | ORIGINAL_REQUEST AC 2 |
| 55 | Tripped Circuit Breaker Flashing Hazard Beacon | Render flashing amber/red hazard beacon above desk on 3 strikes / blocked | M6 | ORIGINAL_REQUEST AC 3 |
| 56 | Multi-Agent Canvas Hit-Testing & Click Inspector | Hit-test any agent across room zones and open inspection detail modal | M6 | ORIGINAL_REQUEST AC 4 |
| 57 | Embedded Live Verification Logs in Agent Detail Modal | Embed stdout/stderr gate logs and audit records directly in inspector view | M6 | ORIGINAL_REQUEST AC 4 |
| 58 | Automated Dual-Layer Test Suite for Agent Room Canvas | Pure Node.js VM mock 2D canvas and HTTP/SSE integration test suite | M6 | ORIGINAL_REQUEST AC 1-4 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | 3-Tier State Engine & Persistence | SQLite WAL schema, tables, incubator orphan branch plumbing | none | DONE |
| M2 | Git Judicial Harness & Gatekeeper | Path whitelist guard, shift-left gatekeeper, 3-strike circuit breaker, in-memory merge-tree, atomic squash settlement | M1 | DONE |
| M3 | Stdio MCP Server & Ambient HUD | Stdio MCP server, 6 tools, in-process HTTP/SSE server, port 4040 resilience, dashboard.html | M1, M2 | DONE |
| M4 | Disaster Recovery (`vibesync:repair`) | Reconstruction script rebuilding state.db from git log, trailers, notes, and incubator branch | M1, M2 | DONE |
| M5 | Test Infrastructure Baseline | 155 tests passing across 8 files | M1-M4 | DONE |
| M6 | Dynamic Multi-Agent Pixel Teamwork Visualization | Dynamic subagent mapping, lifecycle animations, gate rig, hazard beacon, agent inspection with embedded logs, automated test suite | M1-M5 | IN_PROGRESS |

---

## Interface Contracts

### Backend State Engine / HTTP Server ↔ Pixel Agent Room Canvas (`src/server.mjs` ↔ `.vibesync/dashboard.html`)
```typescript
interface AgentRoomPayload {
  gitHead: string;
  features: FeatureRecord[];
  tasks: TaskRecord[];
  incubator: IncubatorRecord[];
  events: EventRecord[];
  providers: Record<string, ProviderUsage>;
  // Dynamic agent synthesis in getPayload()
  agents?: Array<{
    id: string;              // e.g. "team-lead", "implementer-1", "reviewer-1", "judge"
    name: string;            // e.g. "👑 Team Lead", "💻 Implementer [Codex]"
    role: "Team Lead" | "Implementer" | "Reviewer" | "Judge";
    actorName: string;       // e.g. "gemini-antigravity", "openai-codex"
    color: string;           // hex color
    darkColor: string;       // hex dark shade
    state: "idle" | "working" | "verifying" | "blocked" | "cooldown";
    deskSlot: number;        // 0, 1, 2, 3
    activeTask?: {
      id: string;
      title: string;
      branch: string;
      status: string;
      consecutiveFailures: number;
    } | null;
    hazardBeacon: boolean;   // true if status === 'blocked' or consecutiveFailures >= 3
  }>;
}
```

### Agent Inspection Modal ↔ Backend Logs API (`.vibesync/dashboard.html` ↔ `GET /api/logs?taskId=...`)
```typescript
interface TaskLogsResponse {
  taskId: string;
  logs: Array<{
    file: string;
    content: string;
  }>;
  events: Array<{
    id: number;
    action: string;
    actor: string;
    timestamp: string;
    evidence_payload?: any;
  }>;
}
```
