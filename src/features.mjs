/**
 * src/features.mjs
 * 
 * VibeSync Features Contract Management & Holistic Gating
 * Milestone 1: 3-Tier State Engine & Persistence
 */

import { getDb, recordSettlementEvent, checkpointState, saveArtifact } from './db.mjs';
import { execGitWithBackoff } from './incubator.mjs';
import { FEATURE_STATUSES, PRIORITY_LEVELS } from './config.mjs';
import { runCommand } from './commands.mjs';
import { randomUUID } from 'node:crypto';
import { resolveCommandSpec, requireCommandApproval, prepareSandboxedCommand, identifyModelProfile, getExecutionPolicy } from './policy.mjs';
import { captureWorkspaceState, validateWorkspaceWriteDelta } from './guard.mjs';
import { acquireGateSlot, releaseGateSlot } from './scheduler.mjs';

/**
 * Validates feature identifier syntax.
 * 
 * @param {string} id 
 * @returns {boolean}
 */
export function isValidFeatureId(id) {
  return typeof id === 'string' && /^FEAT-[A-Za-z0-9_.-]+$/.test(id);
}

export function generateNextFeatureId(db = getDb()) {
  const ids = db.prepare("SELECT id FROM features WHERE id LIKE 'FEAT-%'").all();
  const max = ids.reduce((value, row) => Math.max(value, Number(row.id.match(/^FEAT-(\d+)$/)?.[1] || 0)), 0);
  return `FEAT-${String(max + 1).padStart(2, '0')}`;
}

/**
 * Deserializes feature record fields from SQLite JSON strings.
 * 
 * @param {object|null} row 
 * @returns {object|null}
 */
export function deserializeFeature(row) {
  if (!row) return null;
  let holisticGate = row.holistic_gate_cmd;
  if (typeof holisticGate === 'string' && (holisticGate.startsWith('[') || holisticGate.startsWith('{'))) {
    try { holisticGate = JSON.parse(holisticGate); } catch {}
  }
  return {
    ...row,
    holistic_gate_cmd: holisticGate,
    labels: typeof row.labels === 'string' ? JSON.parse(row.labels) : (row.labels || [])
  };
}

/**
 * Creates and registers a new feature contract.
 * 
 * @param {object} params
 * @param {string} params.id - e.g. 'FEAT-01'
 * @param {string} params.title - Human-readable contract title
 * @param {string} params.target_milestone - e.g. 'v1.0'
 * @param {string} params.spec_markdown - Frozen specification markdown
 * @param {string|null} [params.holistic_gate_cmd=null] - Shell command executed prior to settlement
 * @param {string} [params.status='ready'] - 'draft' | 'ready' | 'in_progress' | 'settled'
 * @param {string} [params.priority='medium'] - 'urgent' | 'high' | 'medium' | 'low'
 * @param {Array<string>} [params.labels=[]] - Tags or labels
 * @param {string|null} [params.external_ref=null] - External tracker issue id (e.g. 'GH-42', 'LIN-101')
 * @param {string} [params.actor='system'] - Actor identifier for event auditing
 * @param {DatabaseSync} [db]
 * @returns {object} Created feature record
 */
export function createFeature(params, db = getDb()) {
  const {
    id = generateNextFeatureId(db),
    title,
    target_milestone,
    spec_markdown,
    holistic_gate_cmd = null,
    status = 'ready',
    priority = 'medium',
    labels = [],
    external_ref = null,
    actor = 'system'
  } = params;

  if (!id || !title || !target_milestone || !spec_markdown) {
    throw new Error('Missing required feature parameters: id, title, target_milestone, spec_markdown.');
  }

  if (!FEATURE_STATUSES.includes(status)) {
    throw new Error(`Invalid feature status: "${status}". Must be one of: ${FEATURE_STATUSES.join(', ')}`);
  }

  if (!PRIORITY_LEVELS.includes(priority)) {
    throw new Error(`Invalid feature priority: "${priority}". Must be one of: ${PRIORITY_LEVELS.join(', ')}`);
  }

  const labelsJson = Array.isArray(labels) ? JSON.stringify(labels) : (typeof labels === 'string' ? labels : '[]');

  const stmt = db.prepare(`
    INSERT INTO features (id, title, target_milestone, status, priority, labels, external_ref, spec_markdown, holistic_gate_cmd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, title, target_milestone, status, priority, labelsJson, external_ref, spec_markdown,
    holistic_gate_cmd && typeof holistic_gate_cmd === 'object' ? JSON.stringify(holistic_gate_cmd) : holistic_gate_cmd);

  recordSettlementEvent(db, {
    feature_id: id,
    actor,
    action: 'feature_created',
    commit_ref: 'HEAD',
    evidence_payload: { title, target_milestone, status, priority, labels, external_ref }
  });

  checkpointState(db);
  return getFeature(id, db);
}

/**
 * Retrieves a feature contract by ID.
 * 
 * @param {string} id 
 * @param {DatabaseSync} [db] 
 * @returns {object|null}
 */
export function getFeature(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM features WHERE id = ?').get(id);
  return deserializeFeature(row);
}

/**
 * Lists features matching optional filtering criteria.
 * 
 * @param {DatabaseSync} [db] 
 * @param {object} [filter={}] 
 * @param {string} [filter.status] 
 * @param {string} [filter.target_milestone] 
 * @param {string} [filter.priority] 
 * @returns {Array<object>}
 */
export function listFeatures(dbOrFilter = getDb(), maybeFilter = {}) {
  let db = dbOrFilter;
  let filter = maybeFilter;
  if (dbOrFilter && typeof dbOrFilter.prepare !== 'function') {
    filter = dbOrFilter;
    db = (maybeFilter && typeof maybeFilter.prepare === 'function') ? maybeFilter : getDb();
  }
  let query = 'SELECT * FROM features';
  const conditions = [];
  const args = [];

  if (filter.status) {
    conditions.push('status = ?');
    args.push(filter.status);
  }
  if (filter.target_milestone) {
    conditions.push('target_milestone = ?');
    args.push(filter.target_milestone);
  }
  if (filter.priority) {
    conditions.push('priority = ?');
    args.push(filter.priority);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at ASC';

  const rows = db.prepare(query).all(...args);
  return rows.map(deserializeFeature);
}

/**
 * Updates an existing feature contract.
 * 
 * @param {string} id 
 * @param {object} updates 
 * @param {DatabaseSync} [db] 
 * @returns {object} Updated feature record
 */
export function updateFeature(id, updates, db = getDb()) {
  const feature = getFeature(id, db);
  if (!feature) throw new Error(`Feature ${id} not found.`);

  if (feature.status === 'settled') throw new Error(`Feature ${id} is settled and immutable.`);
  if (updates.status === 'settled') throw new Error('Use settleFeature to verify and settle a feature.');

  const allowedFields = [
    'title',
    'spec_markdown',
    'holistic_gate_cmd',
    'target_milestone',
    'status',
    'priority',
    'labels',
    'external_ref'
  ];
  const setClauses = [];
  const args = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      if (key === 'priority') {
        if (!PRIORITY_LEVELS.includes(value)) {
          throw new Error(`Invalid feature priority: "${value}". Must be one of: ${PRIORITY_LEVELS.join(', ')}`);
        }
        setClauses.push(`${key} = ?`);
        args.push(value);
      } else if (key === 'labels') {
        setClauses.push(`${key} = ?`);
        args.push(Array.isArray(value) ? JSON.stringify(value) : value);
      } else {
        setClauses.push(`${key} = ?`);
        args.push(value);
      }
    }
  }

  if (setClauses.length === 0) return feature;

  args.push(id);
  const result = db.prepare(`UPDATE features SET ${setClauses.join(', ')} WHERE id = ? AND status != 'settled'`).run(...args);
  if (result.changes === 0) throw new Error(`Feature ${id} is settled or no longer exists.`);
  checkpointState(db);
  return getFeature(id, db);
}

/**
 * Settles a feature contract after verifying child tasks and executing the holistic gate.
 * 
 * @param {object} params
 * @param {string} params.featureId
 * @param {string} params.actorName
 * @param {DatabaseSync} [db]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ success: boolean, featureId: string, commitSha: string, settledAt: string }}
 */
export function settleFeature(params, db = getDb(), repoRoot = process.cwd()) {
  const { featureId, actorName } = params;
  if (!featureId || !actorName) {
    throw new Error('Missing required settlement parameters: featureId, actorName.');
  }

  const feature = getFeature(featureId, db);
  if (!feature) {
    throw new Error(`Feature ${featureId} not found.`);
  }
  if (feature.status === 'settled') {
    throw new Error(`Feature ${featureId} is already settled.`);
  }

  // 1. Settlement Validation Invariant: Check child tasks
  const unsettledTasks = db.prepare(`
    SELECT id, status, title FROM tasks
    WHERE feature_id = ? AND status != 'settled' AND superseded_by_task_id IS NULL
  `).all(featureId);

  if (unsettledTasks.length > 0) {
    const listStr = unsettledTasks.map(t => `${t.id} (${t.status})`).join(', ');
    throw new Error(`Cannot settle feature ${featureId}: ${unsettledTasks.length} child task(s) remain unsettled [${listStr}].`);
  }

  // 2. Holistic Gate Command Execution
  if (feature.holistic_gate_cmd && (typeof feature.holistic_gate_cmd !== 'string' || feature.holistic_gate_cmd.trim() !== '')) {
    const spec = resolveCommandSpec(feature.holistic_gate_cmd, { cwd: repoRoot, phase: 'feature', policyVersion: getExecutionPolicy(repoRoot).version });
    const approval = requireCommandApproval(spec, db, repoRoot);
    const policy = getExecutionPolicy(repoRoot);
    const slot = acquireGateSlot(db, actorName, null, 'feature', policy.resource_policy);
    if (!slot.acquired) throw Object.assign(new Error(slot.reason), { code: 'GATE_CAPACITY', ...slot, retryAfterMs: policy.resource_policy.retry_after_ms });
    try {
    const sandbox = prepareSandboxedCommand(spec, repoRoot, repoRoot, ['*']);
    const beforeState = captureWorkspaceState(repoRoot);
    const started = Date.now();
    const proc = runCommand(sandbox.argv, { cwd: repoRoot,
      timeoutMs: Math.min(spec.timeout_ms || 300000, policy.resource_policy.timeout_ceiling_ms),
      maxBuffer: policy.resource_policy.output_limit_bytes, redactLogs: policy.redact_logs !== false });
    const durationMs = Date.now() - started;
    const writeScope = validateWorkspaceWriteDelta(beforeState, captureWorkspaceState(repoRoot), ['*'], spec.write_paths);
    if (!writeScope.valid) {
      proc.success = false;
      proc.exitCode = proc.exitCode || 1;
      proc.error = writeScope.error;
      proc.summary = writeScope.error;
    }
    const runArtifact = proc.success ? null : saveArtifact(JSON.stringify({ stdout: proc.stdout, stderr: proc.stderr, diagnostics: proc.diagnostics, writeScope }, null, 2), repoRoot);
    db.prepare(`INSERT INTO gate_runs (id, feature_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, summary, artifact_hash, evidence_payload)
      VALUES (?, ?, 'feature', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), featureId, spec.policyHash, actorName, identifyModelProfile(actorName).id, proc.success ? 'passed' : 'failed', proc.exitCode, durationMs, proc.summary || null, runArtifact,
        JSON.stringify({ sandbox: sandbox.sandbox, approval: approval.approved ? 'approved' : approval.mode, writes: writeScope.writes, declared_write_paths: writeScope.declaredWritePaths, diagnostics: proc.diagnostics }));
    if (spec.idempotency === 'unsafe' && approval.approved) db.prepare('UPDATE gate_approvals SET revoked_at = CURRENT_TIMESTAMP WHERE policy_hash = ?').run(spec.policyHash);

    if (!proc.success) {
      const output = (proc.stderr || '') + '\n' + (proc.stdout || '') + (proc.error ? `\nError: ${proc.error}` : '');
      let artifactHash = null;
      try {
        artifactHash = runArtifact || saveArtifact(output, repoRoot);
      } catch {}

      recordSettlementEvent(db, {
        feature_id: featureId,
        actor: actorName,
        action: 'gate_failed',
        commit_ref: 'HEAD',
        artifact_hash: artifactHash,
        evidence_payload: {
          command: feature.holistic_gate_cmd,
          exit_code: proc.exitCode,
          error: proc.summary
        }
      });

      throw new Error(`Holistic feature gate failed (exit code ${proc.exitCode}): ${proc.summary || proc.error}`);
    }
    } finally {
      releaseGateSlot(db, slot.slotId);
    }
  }

  // 3. Resolve Git HEAD SHA
  let settledCommit = '0000000';
  try {
    settledCommit = execGitWithBackoff(['rev-parse', 'HEAD'], { cwd: repoRoot });
  } catch {}

  // 4. Update Feature to Settled
  db.prepare(`
    UPDATE features
    SET status = 'settled',
        settled_commit = ?,
        settled_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(settledCommit, featureId);

  // 5. Record Audit Ledger Event
  recordSettlementEvent(db, {
    feature_id: featureId,
    actor: actorName,
    action: 'feature_settled',
    commit_ref: settledCommit,
    artifact_hash: null,
    evidence_payload: {
      holistic_gate_cmd: feature.holistic_gate_cmd,
      settled_commit: settledCommit
    }
  });

  const updatedFeature = getFeature(featureId, db);
  return {
    success: true,
    featureId,
    commitSha: settledCommit,
    settledAt: updatedFeature.settled_at
  };
}
