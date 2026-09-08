/**
 * src/fingerprint.mjs
 *
 * VibeSync Server-Side Workspace Fingerprint Computation
 * Phase 1: Evidence-based lease renewal
 *
 * Produces a deterministic hash covering worktree HEAD, staged diff,
 * unstaged diff, non-ignored untracked file identity/content hashes,
 * and the latest gate-run identifier. The fingerprint is always computed
 * server-side; caller-supplied fingerprints are never trusted.
 */

import crypto from 'node:crypto';
import { captureWorkspaceState } from './guard.mjs';

/**
 * Computes a deterministic workspace fingerprint for evidence-based lease renewal.
 *
 * Covers:
 *   - Worktree HEAD SHA (detects commits)
 *   - Staged diff hash (detects `git add`)
 *   - Unstaged diff hash (detects file edits)
 *   - Non-ignored untracked file identities and content hashes
 *   - Latest gate_run id + finished_at (detects successful gate execution)
 *
 * @param {string|null} worktreePath  - Absolute path to the task worktree (may be null)
 * @param {string} repoRoot           - Repository root (fallback when worktreePath is null)
 * @param {object|null} db            - SQLite database handle (may be null in tests)
 * @param {string|null} taskId        - Task ID for gate_runs lookup
 * @returns {string} 64-character hex SHA-256 fingerprint
 */
export function computeWorkspaceFingerprint(worktreePath, repoRoot, db, taskId) {
  let workspaceState = { head: null, entries: {} };
  const targetPath = worktreePath || repoRoot;
  try {
    workspaceState = captureWorkspaceState(targetPath);
  } catch {
    // When the worktree does not exist yet the first fingerprint is deterministically
    // empty so that the very first heartbeat always detects "progress" relative to NULL.
  }

  // Include the latest gate_run for this task so a successful gate run always
  // counts as evidence of progress even when no files changed.
  let latestGateRun = null;
  if (db && taskId) {
    try {
      const row = db.prepare(
        'SELECT id, finished_at FROM gate_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1'
      ).get(taskId);
      if (row) latestGateRun = `${row.id}:${row.finished_at || ''}`;
    } catch {}
  }

  const payload = JSON.stringify({
    head: workspaceState.head,
    entries: workspaceState.entries,
    latestGateRun
  });

  return crypto.createHash('sha256').update(payload).digest('hex');
}
