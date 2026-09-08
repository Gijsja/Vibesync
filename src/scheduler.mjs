/**
 * src/scheduler.mjs
 *
 * VibeSync Gate Resource Scheduler
 * Phase 2: Partial verification and resource governance
 *
 * Provides an in-process gate-slot semaphore backed by SQLite so that
 * concurrent gate executions are capped at configurable limits.
 *
 * Rules:
 * - Global limit: max_concurrent_gates (default 4)
 * - Per-actor limit: max_concurrent_gates_per_actor (default 2)
 * - Abandoned slots (process no longer alive) are cleaned on startup
 *   and before each acquire attempt.
 * - Model identity may not influence authorization, but may influence
 *   resource allocation (e.g., local models run one gate at a time).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db.mjs';
import { identifyModelProfile } from './policy.mjs';

const DEFAULT_MAX_CONCURRENT_GATES = 4;
const DEFAULT_MAX_CONCURRENT_GATES_PER_ACTOR = 2;
const DEFAULT_SLOT_TTL_MS = 5 * 3600000;

/**
 * Returns true when the given PID is still alive on this host.
 * Falls back to true on non-Linux platforms (TTL-based eviction handles cleanup).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    // POSIX: signal 0 checks process existence without sending a real signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH'; // EPERM means running but owned by another user → alive
  }
}

/**
 * Removes gate_slots whose registered process is no longer alive.
 * Call on startup and before each acquire attempt.
 *
 * @param {object} db - SQLite database handle
 * @returns {number} Number of slots cleaned
 */
export function cleanAbandonedGateSlots(db = getDb(), maxAgeMs = DEFAULT_SLOT_TTL_MS) {
  let cleaned = 0;
  const rows = db.prepare("SELECT id, pid, (unixepoch('now') - unixepoch(started_at)) * 1000 AS age_ms FROM gate_slots").all();
  for (const row of rows) {
    if (!isPidAlive(row.pid) || row.age_ms > maxAgeMs) {
      db.prepare('DELETE FROM gate_slots WHERE id = ?').run(row.id);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Attempts to acquire a gate slot subject to global and per-actor limits.
 *
 * @param {object} db         - SQLite database handle
 * @param {string} actor      - Actor identifier (e.g. 'openai-codex')
 * @param {string|null} taskId  - Task ID (may be null for feature gates)
 * @param {string} phase      - Gate phase ('setup', 'gate', 'feature', 'partial')
 * @param {object} [policy]   - Parsed resource_policy from policy.json
 * @returns {{ slotId: string, acquired: boolean, queuePosition: number, activeLimits: object, reason?: string }}
 */
export function acquireGateSlot(db = getDb(), actor, taskId, phase, policy = {}) {
  // Clean abandoned slots before counting.
  cleanAbandonedGateSlots(db);

  const profile = identifyModelProfile(actor);
  const globalMax = policy.max_concurrent_gates ?? DEFAULT_MAX_CONCURRENT_GATES;
  // Local models are single-threaded for resource protection unless overridden.
  const perActorDefaultMax = profile.maxConcurrentGates ?? DEFAULT_MAX_CONCURRENT_GATES_PER_ACTOR;
  const perActorMax = policy.max_concurrent_gates_per_actor ?? perActorDefaultMax;

  const slotId = randomUUID();
  const inserted = db.prepare(`
    INSERT INTO gate_slots (id, actor, task_id, phase, pid)
    SELECT ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM gate_slots) < ?
      AND (SELECT COUNT(*) FROM gate_slots WHERE actor = ?) < ?
  `).run(slotId, actor, taskId ?? null, phase, process.pid, globalMax, actor, perActorMax);
  const counts = db.prepare(`SELECT COUNT(*) AS globalActive,
    SUM(CASE WHEN actor = ? THEN 1 ELSE 0 END) AS actorActive FROM gate_slots`).get(actor);
  const globalActive = Number(counts.globalActive || 0);
  const actorActive = Number(counts.actorActive || 0);

  if (!inserted.changes) {
    const globalLimited = globalActive >= globalMax;
    return {
      acquired: false,
      slotId: null,
      queuePosition: Math.max(1, globalLimited ? globalActive - globalMax + 1 : actorActive - perActorMax + 1),
      activeLimits: { globalActive, globalMax, actorActive, perActorMax },
      reason: globalLimited
        ? `Global gate concurrency limit reached (${globalActive}/${globalMax}). Retry after another gate completes.`
        : `Per-actor gate concurrency limit reached for ${actor} (${actorActive}/${perActorMax}). Retry after your running gate completes.`
    };
  }

  return {
    acquired: true,
    slotId,
    queuePosition: 0,
    activeLimits: { globalActive, globalMax, actorActive, perActorMax },
    reason: null
  };
}

/**
 * Releases a previously acquired gate slot.
 *
 * @param {object} db     - SQLite database handle
 * @param {string} slotId - Slot ID returned by acquireGateSlot
 * @returns {boolean} True if the slot was found and deleted
 */
export function releaseGateSlot(db = getDb(), slotId) {
  if (!slotId) return false;
  const result = db.prepare('DELETE FROM gate_slots WHERE id = ?').run(slotId);
  return result.changes > 0;
}

/**
 * Returns a snapshot of all active gate slots.
 *
 * @param {object} db - SQLite database handle
 * @returns {object[]}
 */
export function getSlotStatus(db = getDb()) {
  return db.prepare('SELECT id, actor, task_id, phase, started_at, pid FROM gate_slots ORDER BY started_at ASC').all();
}
