# VibeSync Product Baseline Specification (v0.5.0 Developer Preview)

**Version:** `0.5.0`  
**Status:** Developer Preview  
**Primary Runtime:** Node.js 24+ (`>=22.13.0` supported with experimental SQLite flag/warnings)  
**Alternative Runtime:** Bun 1.3+ (native SQLite)  

---

## 1. Product Mission & Positioning

VibeSync is a local-first coordination harness and Model Context Protocol (MCP) server for concurrent AI pair-programming and human-in-the-loop software development.

Rather than running autonomous agent loops or bundling proprietary LLM client subscriptions, VibeSync serves as the **judicial operating harness** that connects to external AI agents (via stdio MCP) and human developers (via local CLI and Ambient HUD).

### Honest SemVer Versioning Note
While VibeSync contains a feature-complete workflow engine, production-grade test coverage, and transactional crash-recovery mechanisms, its primary Node runtime uses Node's native `node:sqlite` module (`DatabaseSync`). Because upstream Node.js marks `node:sqlite` as an experimental feature, VibeSync is designated honestly as **`v0.5.0 Developer Preview`**. Version 1.0.0 will be released once `node:sqlite` stabilizes upstream or upon finalizing the native driver abstraction.

---

## 2. Five Core Architectural Capabilities

### 1. Stdio Model Context Protocol (MCP) Server
- **Spec Compliance:** Implements MCP `@modelcontextprotocol/sdk` over standard input/output.
- **Contract-Bound Execution:** Exposes fine-grained tools for:
  - Feature lifecycle (`vibesync_create_feature`, `vibesync_preview_feature`, `vibesync_settle_feature`)
  - Task lease lifecycle (`vibesync_claim_task`, `vibesync_heartbeat_task`, `vibesync_release_task`, `vibesync_preview_task`)
  - Verification & settlement (`vibesync_partial_verify`, `vibesync_verify_and_settle`)
  - Discovery & park incubator (`vibesync_park_insight`, `vibesync_merge_insights`, `vibesync_promote_insight`)
  - State queries (`vibesync_get_summary`, `vibesync_get_operation`)
- **Safety Annotations:** Tools carry explicit read-only, destructive, and idempotency annotations to guide LLM tool planners.

### 2. Isolated Git Worktree Sandboxing
- **Clean Separation:** Each in-progress task receives its own branch (`task/<task-id>`) and isolated directory under `.vibesync/worktrees/<task-slug>`.
- **Allowed Path Whitelist:** Tasks define explicit path boundaries (e.g., `["src/api/**", "tests/**"]`). Changes outside allowed boundaries fail during pre-merge validation.
- **Trunk Protection:** Workers never touch trunk (`main`/`master`) directly. All mutations take place in sandboxed worktrees.

### 3. Five-Stage Judicial Pipeline
Settlement and verification pass through a strict, multi-stage judicial barrier:
- **Stage A (Path Whitelist Guard):** Diff inspection confirms no unapproved files or path traversal outside `allowed_paths`.
- **Stage B (Shift-Left Gate Execution):** Deterministic execution of task acceptance tests and holistic feature test commands. Subprocesses enforce strict timeouts, byte buffers, and environment sandboxing (optional Linux bubblewrap support).
- **Stage C (In-Memory Conflict Detection):** Three-way tree simulation via `git merge-tree --write-tree` detects merge collisions without touching the working copy.
- **Stage D (Transactional Squash Settlement):** Successful changes are atomically squashed into the target branch with standardized commit trailers (`Task-Id`, `Actor`, `Gates-Passed`).
- **Stage E (Audit Provenance & Git Notes):** Verification logs and cryptographic gate receipts are attached to commit SHAs via Git Notes (`refs/notes/vibesync`).

### 4. Zero-CDN Ambient HUD & Pixel Room
- **Local Self-Containment:** Serves a reactive dark/light web interface on loopback (`http://127.0.0.1:4040`).
- **No External CDNs:** All frontend dependencies, CSS, icons, and Mermaid diagram libraries are vendored locally in `src/assets/mermaid/`.
- **Real-Time Visibility:** Server-Sent Events (SSE) push task state changes, lease statuses, consecutive failure warnings, and agent activity instantly.

### 5. Git-Backed Disaster Recovery & Self-Healing
- **Automatic Snapshots:** Local SQLite database state (`.vibesync/state.db`) is snapshotted into orphaned Git refs (`refs/vibesync/snapshots`).
- **Self-Healing Repair Engine:** CLI repair commands (`vibesync --repair` / `vibesync-repair`) reconstruct missing SQLite databases, repair corrupted task records, detach stale worktrees, and reconcile unmerged branches against Git history.

---

## 3. Runtime & Platform Support Matrix

| Platform / Runtime | Support Level | Notes |
| :--- | :--- | :--- |
| **Node.js 24+** | **Primary (Recommended)** | Full ESM, native `node:sqlite`, complete test pass |
| **Node.js 22.13+** | **Supported** | Minimum supported Node version; emits experimental SQLite warning |
| **Bun 1.3+** | **Supported Alternative** | Bun-native SQLite via `bun:sqlite`, standalone CLI binaries |
| **Linux (Kernel 5.4+)** | **Full Feature Support** | Supports optional Bubblewrap sandboxing for verification gates |
| **macOS / Windows** | **Process Isolation** | Standard subprocess timeouts and env filtering; bubblewrap skipped |

---

## 4. Stability & Quality Invariants

- **Zero Tolerance for Silent Failures:** 3 consecutive gate failures automatically suspend a task to prevent runaway agent thrashing.
- **Lease Boundary Guarantees:** Concurrent agents cannot steal unexpired leases. Monotonic lease tokens and expiration timestamps prevent split-brain edits.
- **Sanitized Git History:** All squashed settlements produce clean, linear histories on the target branch.
