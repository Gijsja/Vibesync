/**
 * tests/task-efficiency.test.mjs
 *
 * Deterministic acceptance tests for computeTaskEfficiency and
 * computeFeatureEfficiency (src/usage.mjs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { withSandbox } from './harness.mjs';
import { getDb, recordSettlementEvent } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, releaseTaskLease } from '../src/tasks.mjs';
import { computeTaskEfficiency, computeFeatureEfficiency } from '../src/usage.mjs';
import { randomUUID } from 'node:crypto';

function makeDb(sandboxDir) {
  const dbPath = path.join(sandboxDir, '.vibesync', 'state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return getDb(dbPath, sandboxDir);
}

function seed(db, taskOverrides = {}) {
  createFeature({ id: 'FEAT-EFF', title: 'Efficiency', target_milestone: 'v1', spec_markdown: 'eff' }, db);
  createTask({
    id: 'TASK-EFF',
    feature_id: 'FEAT-EFF',
    title: 'Efficiency task',
    allowed_paths: ['src/'],
    required_gates: [{ type: 'argv', argv: ['git', 'diff', '--check'], network: false, idempotency: 'safe' }],
    ...taskOverrides
  }, db);
}

function insertGateRun(db, taskId, leaseRunId, { status = 'passed', phase = 'gate', durationMs = 1000, evidencePayload = null } = {}) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO gate_runs (id, task_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, lease_run_id, evidence_payload, started_at, finished_at)
    VALUES (?, ?, ?, 0, 'hash-test', 'antigravity', 'gemini', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, taskId, phase, status, status === 'passed' ? 0 : 1, durationMs, leaseRunId, evidencePayload ? JSON.stringify(evidencePayload) : null);
  return id;
}

test('ready task has null timing and gate fields — not zero', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const eff = computeTaskEfficiency('TASK-EFF', db);

    assert.equal(eff.task_id, 'TASK-EFF');
    assert.equal(eff.status, 'ready');
    assert.equal(eff.first_claimed_at, null, 'first_claimed_at must be null for unclaimed task');
    assert.equal(eff.settled_at, null);
    assert.equal(eff.time_to_settle_ms, null, 'time_to_settle_ms must be null, not zero');
    assert.equal(eff.verification_attempts, 0);
    assert.equal(eff.failed_gates, 0);
    assert.equal(eff.passed_gates, 0);
    assert.equal(eff.handoff_count, 0);
    assert.equal(eff.tokens_used, null, 'tokens_used must be null without provider evidence');
    assert.equal(eff.cost_usd, null, 'cost_usd must be null without provider evidence');
  });
});

test('successful single-lease settlement populates time_to_settle_ms', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim = claimTask({ taskId: 'TASK-EFF', actorName: 'antigravity' }, db, sandbox.dir);
    const leaseRunId = claim.leaseRunId;

    insertGateRun(db, 'TASK-EFF', leaseRunId, { status: 'passed', durationMs: 2500 });

    recordSettlementEvent(db, {
      task_id: 'TASK-EFF', feature_id: 'FEAT-EFF', actor: 'antigravity',
      action: 'task_settled', commit_ref: 'abc123', lease_run_id: leaseRunId, evidence_payload: {}
    });
    db.prepare("UPDATE tasks SET status = 'settled' WHERE id = 'TASK-EFF'").run();

    const eff = computeTaskEfficiency('TASK-EFF', db);

    assert.equal(eff.status, 'settled');
    assert.ok(eff.first_claimed_at !== null, 'first_claimed_at must be set after claim');
    assert.ok(eff.settled_at !== null, 'settled_at must be set after settlement event');
    assert.ok(typeof eff.time_to_settle_ms === 'number' && eff.time_to_settle_ms >= 0,
      `time_to_settle_ms must be a non-negative number, got ${eff.time_to_settle_ms}`);
    assert.equal(eff.verification_attempts, 1);
    assert.equal(eff.passed_gates, 1);
    assert.equal(eff.failed_gates, 0);
    assert.equal(eff.handoff_count, 0);
    assert.deepEqual(eff.lease_run_ids, [leaseRunId]);
    assert.equal(eff.total_gate_duration_ms, 2500);
  });
});

test('failed gate followed by passing retry is counted correctly', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim = claimTask({ taskId: 'TASK-EFF', actorName: 'antigravity' }, db, sandbox.dir);
    const leaseRunId = claim.leaseRunId;

    insertGateRun(db, 'TASK-EFF', leaseRunId, { status: 'failed', durationMs: 800 });
    insertGateRun(db, 'TASK-EFF', leaseRunId, { status: 'passed', durationMs: 1200 });

    recordSettlementEvent(db, {
      task_id: 'TASK-EFF', feature_id: 'FEAT-EFF', actor: 'antigravity',
      action: 'task_settled', commit_ref: 'def456', lease_run_id: leaseRunId, evidence_payload: {}
    });
    db.prepare("UPDATE tasks SET status = 'settled' WHERE id = 'TASK-EFF'").run();

    const eff = computeTaskEfficiency('TASK-EFF', db);

    assert.equal(eff.verification_attempts, 2, 'Both gate phase runs count as verification attempts');
    assert.equal(eff.failed_gates, 1);
    assert.equal(eff.passed_gates, 1);
    assert.equal(eff.total_gate_duration_ms, 2000);
  });
});

test('partial verifications are counted separately from full gate runs', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim = claimTask({ taskId: 'TASK-EFF', actorName: 'antigravity' }, db, sandbox.dir);
    const leaseRunId = claim.leaseRunId;

    insertGateRun(db, 'TASK-EFF', leaseRunId, { status: 'passed', phase: 'partial', durationMs: 300 });
    insertGateRun(db, 'TASK-EFF', leaseRunId, { status: 'passed', phase: 'gate', durationMs: 1500 });

    const eff = computeTaskEfficiency('TASK-EFF', db);

    assert.equal(eff.partial_verifications, 1);
    assert.equal(eff.verification_attempts, 1, 'Only phase=gate runs count as verification attempts');
    assert.equal(eff.passed_gates, 1);
  });
});

test('multi-lease handoff is detected via distinct lease_run_ids', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim1 = claimTask({ taskId: 'TASK-EFF', actorName: 'openai-codex' }, db, sandbox.dir);
    const run1 = claim1.leaseRunId;
    releaseTaskLease('TASK-EFF', db);

    const claim2 = claimTask({ taskId: 'TASK-EFF', actorName: 'antigravity' }, db, sandbox.dir);
    const run2 = claim2.leaseRunId;

    recordSettlementEvent(db, {
      task_id: 'TASK-EFF', feature_id: 'FEAT-EFF', actor: 'antigravity',
      action: 'task_settled', commit_ref: 'ghi789', lease_run_id: run2, evidence_payload: {}
    });
    db.prepare("UPDATE tasks SET status = 'settled' WHERE id = 'TASK-EFF'").run();

    const eff = computeTaskEfficiency('TASK-EFF', db);

    assert.ok(eff.lease_run_ids.includes(run1), 'First lease_run_id must appear');
    assert.ok(eff.lease_run_ids.includes(run2), 'Second lease_run_id must appear');
    assert.equal(eff.handoff_count, 1, 'One handoff between two distinct lease runs');
  });
});

test('ejected_to_human records explicit_handoff_events', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim = claimTask({ taskId: 'TASK-EFF', actorName: 'openai-codex' }, db, sandbox.dir);

    recordSettlementEvent(db, {
      task_id: 'TASK-EFF', feature_id: 'FEAT-EFF', actor: 'openai-codex',
      action: 'ejected_to_human', commit_ref: 'HEAD', lease_run_id: claim.leaseRunId, evidence_payload: {}
    });

    const eff = computeTaskEfficiency('TASK-EFF', db);
    assert.equal(eff.explicit_handoff_events, 1);
  });
});

test('tokens_used is null when no provider evidence_payload', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim = claimTask({ taskId: 'TASK-EFF', actorName: 'antigravity' }, db, sandbox.dir);
    insertGateRun(db, 'TASK-EFF', claim.leaseRunId, { status: 'passed', evidencePayload: null });

    const eff = computeTaskEfficiency('TASK-EFF', db);
    assert.equal(eff.tokens_used, null, 'tokens_used must stay null without provider evidence');
    assert.equal(eff.cost_usd, null);
  });
});

test('tokens_used is populated from real evidence_payload', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim = claimTask({ taskId: 'TASK-EFF', actorName: 'antigravity' }, db, sandbox.dir);
    insertGateRun(db, 'TASK-EFF', claim.leaseRunId, {
      status: 'passed',
      evidencePayload: { tokens_used: 1500, cost_usd: 0.003 }
    });

    const eff = computeTaskEfficiency('TASK-EFF', db);
    assert.equal(eff.tokens_used, 1500);
    assert.ok(Math.abs(eff.cost_usd - 0.003) < 1e-9);
  });
});

test('malformed evidence_payload is silently skipped without crashing', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);

    const claim = claimTask({ taskId: 'TASK-EFF', actorName: 'antigravity' }, db, sandbox.dir);
    const id = randomUUID();
    db.prepare(`
      INSERT INTO gate_runs (id, task_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, lease_run_id, evidence_payload, started_at, finished_at)
      VALUES (?, 'TASK-EFF', 'gate', 0, 'hash-bad', 'antigravity', 'gemini', 'passed', 0, 500, ?, '{not: valid json}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, claim.leaseRunId);

    const eff = computeTaskEfficiency('TASK-EFF', db);
    assert.equal(eff.tokens_used, null, 'Malformed payload must not crash or produce false tokens_used');
  });
});

test('computeTaskEfficiency throws for unknown task', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);
    assert.throws(() => computeTaskEfficiency('TASK-UNKNOWN', db), /not found/i);
  });
});

test('computeFeatureEfficiency returns one record per task in creation order', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    createFeature({ id: 'FEAT-MULTI', title: 'Multi', target_milestone: 'v1', spec_markdown: 'm' }, db);
    createTask({ id: 'TASK-M1', feature_id: 'FEAT-MULTI', title: 'First', allowed_paths: ['a/'], required_gates: [] }, db);
    createTask({ id: 'TASK-M2', feature_id: 'FEAT-MULTI', title: 'Second', allowed_paths: ['b/'], required_gates: [] }, db);

    const results = computeFeatureEfficiency('FEAT-MULTI', db);

    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.feature_id === 'FEAT-MULTI'));
    assert.deepEqual(results.map(r => r.task_id), ['TASK-M1', 'TASK-M2']);
  });
});

test('computeFeatureEfficiency returns empty array for unknown feature', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seed(db);
    const results = computeFeatureEfficiency('FEAT-NOPE', db);
    assert.equal(results.length, 0, 'Unknown feature returns empty array');
  });
});
