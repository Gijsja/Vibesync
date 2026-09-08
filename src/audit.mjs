import { getDb } from './db.mjs';
import { redactSensitive } from './commands.mjs';

function json(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function redact(value) {
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

export function buildLeaseRollup(leaseRunId, db = getDb()) {
  if (typeof leaseRunId !== 'string' || !/^[a-f0-9-]{16,64}$/i.test(leaseRunId)) throw new Error('A valid lease run id is required.');
  const task = db.prepare(`SELECT t.id, t.feature_id, t.title, t.status, t.assigned_actor, t.branch_name,
    t.base_commit, t.settled_commit, t.model_hint, t.lease_run_id, t.created_at, t.updated_at,
    f.title AS feature_title FROM tasks t LEFT JOIN features f ON f.id = t.feature_id
    WHERE t.lease_run_id = ? OR EXISTS (SELECT 1 FROM settlement_events e WHERE e.task_id = t.id AND e.lease_run_id = ?)`)
    .get(leaseRunId, leaseRunId);
  if (!task) throw new Error(`Lease run ${leaseRunId} not found.`);
  const events = db.prepare(`SELECT id, timestamp, action, actor, commit_ref, artifact_hash, evidence_payload
    FROM settlement_events WHERE lease_run_id = ? ORDER BY timestamp, id`).all(leaseRunId)
    .map(row => ({ ...row, evidence: json(row.evidence_payload, {}), evidence_payload: undefined }));
  const gates = db.prepare(`SELECT id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code,
    duration_ms, summary, artifact_hash, started_at, finished_at, evidence_payload
    FROM gate_runs WHERE lease_run_id = ? ORDER BY started_at, id`).all(leaseRunId)
    .map(row => ({ ...row, evidence: json(row.evidence_payload, {}), evidence_payload: undefined }));
  const hashes = [...new Set(gates.map(run => run.policy_hash))].sort();
  const approvals = hashes.length ? db.prepare(`SELECT policy_hash, phase, approved_by, approved_at, revoked_at
    FROM gate_approvals WHERE policy_hash IN (${hashes.map(() => '?').join(',')}) ORDER BY policy_hash`).all(...hashes) : [];
  const files = [...new Set(gates.flatMap(run => run.evidence?.writes || []))].sort();
  const startedAt = events[0]?.timestamp || gates[0]?.started_at || null;
  const finishedAt = [...events].reverse().find(event => ['task_settled', 'lease_released', 'lease_expired', 'lease_handoff_requested'].includes(event.action))?.timestamp || null;
  return redact({
    lease_run_id: leaseRunId,
    task: { id: task.id, title: task.title, feature_id: task.feature_id, feature_title: task.feature_title,
      status: task.status, actor: events.find(event => event.action === 'task_claimed')?.actor || task.assigned_actor,
      model_hint: task.model_hint, branch: task.branch_name, base_commit: task.base_commit, settled_commit: task.settled_commit },
    started_at: startedAt,
    finished_at: finishedAt,
    files,
    commands: gates,
    approvals,
    events
  });
}

export function listLeaseRollups(filter = {}, db = getDb()) {
  const clauses = ['lease_run_id IS NOT NULL'];
  const params = [];
  if (filter.taskId) { clauses.push('task_id = ?'); params.push(filter.taskId); }
  if (filter.actor) { clauses.push('actor = ?'); params.push(filter.actor); }
  const limit = Math.max(1, Math.min(Number(filter.limit) || 50, 200));
  return db.prepare(`SELECT lease_run_id, MIN(timestamp) AS started_at, MAX(timestamp) AS last_activity_at,
    MIN(task_id) AS task_id, MIN(actor) AS actor, COUNT(*) AS event_count
    FROM settlement_events WHERE ${clauses.join(' AND ')} GROUP BY lease_run_id
    ORDER BY last_activity_at DESC, lease_run_id LIMIT ?`).all(...params, limit);
}
