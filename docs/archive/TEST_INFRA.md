# VibeSync Test Infrastructure Specification (TEST_INFRA.md)

**Project:** VibeSync  
**Specification Level:** E2E Dual-Track Testing Infrastructure  
**Target Runtime:** Node.js >= 24.0.0 (Node 24 LTS verified)  
**Primary Test Framework:** Built-in `node:test` and `node:assert/strict`  
**Last Updated:** 2026-09-05  

---

## 1. Testing Philosophy & Core Principles

VibeSync governs concurrent AI pair-programming, judicial Git-native merges, in-memory conflict detection, and self-healing disaster recovery. A single defect in merge simulation or state reconstruction can destroy uncommitted code or corrupt Git commit history. Therefore, the testing infrastructure adheres strictly to the following non-negotiable principles:

### 1.1. Requirement-Driven, Opaque-Box Testing
Tests treat VibeSync as an opaque black box. Tests never import internal private functions, bypass schema constraints, or manipulate SQLite database tables directly when evaluating feature correctness. All interactions occur strictly through official public interfaces:
- **Git Plumbing & CLI**: Standard Git CLI commands (`git status`, `git log`, `git notes`, `git show`, `git branch`, `git merge-tree`).
- **Stdio Model Context Protocol (MCP)**: Standard JSON-RPC 2.0 frames over `stdin`/`stdout` (`tools/call`, `tools/list`, `resources/read`, `prompts/get`).
- **Ambient Control HUD**: HTTP loopback requests (`GET /`, `POST /api/eject`, `POST /api/park`, `POST /api/hotfix`) and real-time Server-Sent Events (`GET /api/events`).
- **Disaster Recovery Binary**: Execution of `node scripts/vibesync-repair.mjs` (`npm run repair`).

### 1.2. Hermetic Sandboxing & Zero State Leakage
No test may ever touch, inspect, or mutate the developer's working directory (`<project-root>`) or persistent state.
- Every test suite execution instantiates an isolated, temporary Git repository inside `os.tmpdir()` (`/tmp/vibesync-sandbox-<random>`).
- Sandboxes configure isolated Git author credentials (`user.name = 'VibeSync Test Runner'`, `user.email = 'test@vibesync.local'`), disable GPG commit signing (`commit.gpgsign false`), set default branch `main`, and execute with `GIT_CONFIG_NOSYSTEM=1`.
- Upon test completion, sandboxes are forcefully purged, leaving zero dangling worktrees, processes, or temporary files.

### 1.3. Elimination of the "AI Honor System"
Tests never accept self-reported success or arbitrary assertions from models. The test runner validates real, physical side effects:
- Subprocesses assert actual operating system exit codes (`proc.status === 0`).
- Merge simulations are checked against actual Git tree objects and commit graphs.
- Database state reconstruction is verified by physical table deletion followed by bit-level record matching.

---

## 2. Infrastructure Architecture & Topology

The VibeSync test architecture consists of three interlocking layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        tests/runner.mjs                                │
│  - CLI Flags Parsing (--tier, --filter, --verbose, --bail)             │
│  - Hierarchical Test Discovery (Tiers 1, 2, 3, 4)                      │
│  - Subprocess Execution Isolation (spawnSync node --test)              │
│  - Spec/TAP Output Aggregation & ANSI Table Reporting                  │
│  - Strict Exit Code 0 Verification                                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ executes test suites
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Test Suites (Tiers 1, 2, 3, 4)                         │
│  - tests/tier1-features/     (Feature Coverage, ≥35 tests)             │
│  - tests/tier2-boundaries/   (Boundary & Edge Cases, ≥35 tests)        │
│  - tests/tier3-combinations/ (Pairwise & Pipelines, ≥15 tests)         │
│  - tests/tier4-scenarios/    (Multi-Agent Real Scenarios, ≥10 tests)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ instantiates fixtures via
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        tests/harness.mjs                               │
│  ├── Git Sandbox Manager: initRepo(), commitFile(), createBranch()     │
│  ├── Multi-Worktree Simulator: createWorktree(), removeWorktree()      │
│  ├── Stdio MCP Client: spawnMcpServer(), callTool(), listTools()       │
│  ├── HTTP & SSE Client: VibeSyncHttpClient, VibeSyncSseClient          │
│  └── Teardown Manager: terminateProcess(), safeRmDir(), cleanup()      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ targets
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Ephemeral Sandbox (/tmp/vibesync-sandbox-XXXXXX)          │
│  ├── .git/ (initialized repo with main branch, Git notes, blobs)       │
│  ├── .vibesync/ (state.db, artifacts/<hash>.log, dashboard.html)       │
│  └── .vibesync/worktrees/ (isolated agent checkouts)                   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Test Fixture Harness (`tests/harness.mjs`) API Contract

The fixture harness provides a comprehensive suite of utilities imported by all test suites:

### 3.1. Sandbox Lifecycle
- `createSandbox(options?: object): Promise<GitSandbox>`:
  - Generates a fresh temporary directory under `os.tmpdir()` resolved via `fs.realpathSync`.
  - Initializes Git repository (`git init -b main`) and sets local `user.name` and `user.email`.
  - Configures `commit.gpgsign false` to ensure non-interactive headless commits.
  - Creates baseline `.gitignore` (`node_modules/`, `.vibesync/state.db*`, `.vibesync/artifacts/`, `.vibesync/hud.url`, `.vibesync/*.log`, `.vibesync_ACTIVE_TASK.md`).
  - Commits baseline repository state to trunk (`main`).
  - Returns `GitSandbox` instance with bound helper methods.
- `withSandbox(fn: (sandbox: GitSandbox) => Promise<any>, options?: object): Promise<any>`:
  - Higher-order helper that instantiates a sandbox, passes it to `fn`, and guarantees `sandbox.cleanup()` runs in `finally`.
- `sandbox.cleanup(): void`:
  - Terminates all active child processes registered via `sandbox.registerProcess(proc)`.
  - Closes any open SQLite databases registered via `sandbox.registerDb(db)`.
  - Prunes and removes registered Git worktrees with `git worktree remove --force` and `git worktree prune`.
  - Executes resilient recursive deletion via `safeRmDir(this.dir)` with exponential backoff.

### 3.2. Git Plumbing & Judicial Helpers
- `execGit(cmd: string | string[], cwd: string, options?: object): string`:
  - Runs git command with isolated environment (`GIT_CONFIG_NOSYSTEM=1`, author credentials).
  - Automatically handles `.git/index.lock` contention with jittered exponential backoff (up to 5 retries).
- `sandbox.execGit(cmd: string | string[], options?: object): string`:
  - Bound version executing within `sandbox.dir`.
- `sandbox.commitFile(relPath: string, content: string, message: string, options?: { allowEmpty?: boolean, trailers?: Record<string, string> }): string`:
  - Creates parent directories, writes file, stages changes (`git add`), and creates commit with optional RFC 2822 trailers. Returns new commit SHA.
- `sandbox.createBranch(branchName: string, fromRef?: string, checkout?: boolean): void`
- `sandbox.checkout(branchOrRef: string): void`
- `sandbox.getHeadSha(options?: { short?: boolean }): string`
- `sandbox.getNotes(commitSha: string, ref?: string): any | null`:
  - Retrieves note from `refs/notes/vibesync`. Returns parsed JSON if valid, raw string, or `null` if note does not exist.
- `sandbox.attachNote(commitSha: string, payload: any, ref?: string): void`
- `sandbox.getOrphanContent(branchName?: string, filePath?: string): any | null`:
  - Inspects file from orphan branch (`vibesync/incubator:incubator.json`) without checkout. Returns parsed JSON or `null`.
- `sandbox.syncOrphanContent(records: any, branchName?: string, filePath?: string): string`:
  - Writes Merkle tree directly using Git plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`).
- `sandbox.getCommitTrailers(commitSha?: string): Record<string, string>`:
  - Parses RFC 2822 commit trailers into key-value map.
- `sandbox.simulateMergeTree(targetBranch?: string, sourceBranch: string): { clean: boolean, conflict: boolean, treeSha: string | null, rawOutput: string }`:
  - Headless in-memory conflict detector via `git merge-tree --write-tree`.
- `sandbox.createWorktree(relativePath: string, branchName: string, fromRef?: string): string`
- `sandbox.removeWorktree(worktreePath: string): void`
- `sandbox.setupMultiAgentWorktrees(agents?: string[]): Record<string, string>`
- `sandbox.isDirty(): { dirty: boolean, output: string }`

### 3.3. Stdio MCP Client Helper (`McpStdioClient`)
- `spawnMcpServer(options: { cwd: string, scriptPath?: string, port?: number, env?: Record<string, string>, autoInit?: boolean, requestTimeoutMs?: number }): Promise<McpServerHandle>`:
  - Spawns `node scripts/vibesync.mjs` with `stdio: ['pipe', 'pipe', 'pipe']`.
  - Attaches `McpStdioClient`, `VibeSyncHttpClient`, and `VibeSyncSseClient`.
- `mcpClient.sendRequest(method: string, params?: object, timeoutMs?: number): Promise<any>`
- `mcpClient.sendNotification(method: string, params?: object): void`
- `mcpClient.sendRaw(rawString: string): void`
- `mcpClient.initialize(clientInfo?: object): Promise<any>`
- `mcpClient.callTool(name: string, args?: object): Promise<ToolCallResult>`
- `mcpClient.callToolJson(name: string, args?: object): Promise<any>`
- `mcpClient.getState(): Promise<StateSnapshot>`
- `mcpClient.claimTask(params: { taskId: string, actorName: string, worktreePath?: string }): Promise<ToolCallResult>`
- `mcpClient.verifyAndSettle(params: { taskId: string, actorName: string, worktreePath?: string }): Promise<any>`
- `mcpClient.parkInsight(params: { id?: string, title: string, category: string, contextNotes: string, actorName: string }): Promise<ToolCallResult>`
- `mcpClient.settleFeature(params: { featureId: string, actorName: string }): Promise<any>`
- `mcpClient.repairState(): Promise<ToolCallResult>`
- `mcpClient.listTools(): Promise<any>`
- `mcpClient.readResource(uri: string): Promise<any>`
- `mcpClient.listResources(): Promise<any>`
- `mcpClient.listPrompts(): Promise<any>`
- `mcpClient.getPrompt(name: string, args?: object): Promise<any>`
- `mcpClient.getStderr(): string`
- `mcpClient.waitForStderr(pattern: string | RegExp, timeoutMs?: number): Promise<string>`

### 3.4. HTTP REST Client Helper (`VibeSyncHttpClient`)
- `http.waitForReady(timeoutMs?: number, intervalMs?: number): Promise<void>`:
  - Continuously probes `GET /api/state` until HTTP 200 is returned.
- `http.getState(): Promise<StateSnapshot>`
- `http.getHudHtml(): Promise<{ status: number, headers: Headers, html: string }>`
- `http.ejectTask(taskId: string): Promise<{ success: boolean }>`
- `http.parkIdea(params: { title: string, category?: string, notes?: string }): Promise<{ success: boolean, id: string }>`
- `http.hotfix(message?: string): Promise<{ success: boolean, commit: string }>`
- `http.request(method: string, endpointPath: string, options?: object): Promise<object>`

### 3.5. Server-Sent Events Client Helper (`VibeSyncSseClient`)
- `sse.connect(timeoutMs?: number): Promise<StateSnapshot>`:
  - Opens persistent SSE connection to `/api/events` and receives initial state broadcast.
- `sse.waitForState(predicate: (state: StateSnapshot) => boolean, timeoutMs?: number): Promise<StateSnapshot>`:
  - Checks past event history first to eliminate race conditions, then listens for future state broadcasts matching predicate.
- `sse.getLatestState(): StateSnapshot | null`
- `sse.getAllStates(): StateSnapshot[]`
- `sse.clearHistory(): void`
- `sse.close(): void`:
  - Aborts request and destroys socket cleanly.

### 3.6. Concurrency & Process Helpers
- `isPortInUse(port: number, host?: string): Promise<boolean>`
- `waitForPortFree(port: number, timeoutMs?: number, intervalMs?: number): Promise<boolean>`
- `occupyPort(port: number, host?: string): Promise<{ port: number, host: string, close: () => Promise<void> }>`
- `terminateProcess(child: ChildProcess, timeoutMs?: number): Promise<void>`:
  - Two-stage termination: closes `stdin`, sends `SIGTERM`, waits, and escalates to `SIGKILL` on timeout.
- `terminateAllProcesses(timeoutMs?: number): Promise<void>`
- `setupHarnessCleanup(): void`

---

## 4. 4-Tier Test Taxonomy

The test suite is partitioned into four hierarchical tiers:

| Tier | Directory | Focus | Target Volume | Execution Scope |
|---|---|---|:---:|---|
| **Tier 1** | `tests/tier1-features/` | Core Feature Coverage | ≥35 tests | Happy-path functional verification of each isolated feature area. |
| **Tier 2** | `tests/tier2-boundaries/` | Boundary & Corner Cases | ≥35 tests | Pathological inputs, limits, thresholds, error codes, and rollback invariants. |
| **Tier 3** | `tests/tier3-combinations/` | Cross-Feature Combinations | ≥15 tests | Pairwise module interactions, multi-step state transitions, end-to-end pipelines. |
| **Tier 4** | `tests/tier4-scenarios/` | Real-World Application Scenarios | ≥10 tests | Complex multi-agent concurrent pairing, disaster recovery under load, unstaged preservation. |

---

## 5. Traceability & Feature Coverage Matrix

Every feature from `PROJECT.md` (Features 1–49) and requirements from `ORIGINAL_REQUEST.md` (R1–R5) maps directly to tests across Tiers 1–4:

| Feature Area | Core Requirements | Tier 1 (Coverage) | Tier 2 (Boundaries) | Tier 3 (Combinations) | Tier 4 (Scenarios) |
|---|---|:---:|:---:|:---:|:---:|
| **1. SQLite State Engine & WAL** | WAL mode, FK cascades, CHECK constraints, artifacts offload | `01-sqlite-engine.test.mjs` (5) | `01-db-boundaries.test.mjs` (5) | `01-settlement-pipeline.test.mjs` | `03-catastrophic-failure.test.mjs` |
| **2. Incubator & Orphan Branch** | Parking, zero main footprint, git plumbing mirror, promotion | `02-incubator.test.mjs` (5) | `02-incubator-boundaries.test.mjs` (5) | `02-incubator-feature.test.mjs` | `01-multi-agent-pair.test.mjs` |
| **3. Features & Tasks Engine** | Contracts, worktree binding, 45m TTL, anchor hydration | `03-features-tasks.test.mjs` (5) | `03-task-boundaries.test.mjs` (5) | `01-settlement-pipeline.test.mjs` | `01-multi-agent-pair.test.mjs` |
| **4. Path Guard & Gatekeeper** | Glob whitelist, exit code check, 3-strike circuit breaker | `04-guard-gatekeeper.test.mjs` (5) | `04-guard-boundaries.test.mjs` (5) | `03-circuit-breaker-eject.test.mjs` | `02-dirty-working-copy.test.mjs` |
| **5. Merge Simulation & Settle** | `git merge-tree`, squash merge, RFC trailers, Git notes | `05-merge-settle.test.mjs` (5) | `05-merge-boundaries.test.mjs` (5) | `01-settlement-pipeline.test.mjs` | `02-dirty-working-copy.test.mjs` |
| **6. Stdio MCP & Ambient HUD** | 6 MCP tools, JSON-RPC stdio, port 4040 resilience, SSE | `06-mcp-hud.test.mjs` (5) | `06-mcp-hud-boundaries.test.mjs` (5) | `04-concurrent-worktree.test.mjs` | `04-ambient-hud-hotfix.test.mjs` |
| **7. Disaster Recovery (`repair`)** | Scratch DB rebuild from trailers, notes, orphan branch | `07-repair.test.mjs` (5) | `07-repair-boundaries.test.mjs` (5) | `05-disaster-recovery.test.mjs` | `03-catastrophic-failure.test.mjs` |

---

## 6. Execution Playbook & CI Integration

### 6.1. CLI Test Commands
```bash
# Run complete test suite across all 4 tiers
node tests/runner.mjs --tier=all

# Run specific tier
node tests/runner.mjs --tier=1
node tests/runner.mjs --tier=2
node tests/runner.mjs --tier=3
node tests/runner.mjs --tier=4

# Filter tests by pattern or filename
node tests/runner.mjs --filter=mcp
node tests/runner.mjs --filter=repair --verbose

# Fail-fast mode (stop on first failure)
node tests/runner.mjs --bail
```

### 6.2. Quality Gate Invariants
- **100% Pass Rate**: Every single test in Tiers 1–4 must pass with exit code `0`.
- **Zero Sandbox Leakage**: `/tmp/vibesync-sandbox-*` directories must be cleaned up 100%.
- **Zero Network Egress**: All tests run strictly local without outbound network requests.
- **Publication Requirement**: When all 95+ tests pass, `TEST_READY.md` is published to project root to authorize milestone transition to implementation.
