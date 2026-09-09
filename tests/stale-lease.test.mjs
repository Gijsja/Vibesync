import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
const queuedTests = [];
const test = typeof Bun === 'undefined' ? nodeTest : (name, run) => queuedTests.push({ name, run });
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, checkAndExpireLeases } from '../src/tasks.mjs';

function setup(dir) {
  const db = getDb(path.join(dir, '.vibesync', 'state.db'), dir);
  createFeature({ id: 'FEAT-LEASE', title: 'Lease', target_milestone: 'v1', spec_markdown: 'x' }, db);
  createTask({ id: 'TASK-LEASE', feature_id: 'FEAT-LEASE', title: 'Lease', allowed_paths: ['src/'], required_gates: [] }, db);
  return db;
}

test('expired lease is recoverable with generation and audit evidence', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(setup(sandbox.dir));
    const claim = claimTask({ taskId: 'TASK-LEASE', actorName: 'openai-codex' }, db, sandbox.dir);
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 minute') WHERE id = 'TASK-LEASE'").run();
    assert.equal(checkAndExpireLeases(db), 1);
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'TASK-LEASE'").get();
    const event = db.prepare("SELECT evidence_payload FROM settlement_events WHERE task_id = 'TASK-LEASE' AND action = 'lease_expired'").get();
    assert.equal(task.status, 'ready'); assert.equal(task.lease_token_hash, null); assert.equal(task.lease_generation, 2);
    assert.equal(JSON.parse(event.evidence_payload).recovery, 'STALE_LEASE_RECOVERABLE');
    assert.equal(JSON.parse(event.evidence_payload).lease_run_id, claim.leaseRunId);
  });
});

test('automatic recovery is capped after three previous expiries', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(setup(sandbox.dir));
    claimTask({ taskId: 'TASK-LEASE', actorName: 'openai-codex' }, db, sandbox.dir);
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 minute') WHERE id = 'TASK-LEASE'").run();
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO settlement_events (task_id, feature_id, actor, action, commit_ref, evidence_payload) VALUES ('TASK-LEASE', 'FEAT-LEASE', 'system', 'lease_expired', 'HEAD', '{}')").run();
    assert.equal(checkAndExpireLeases(db), 0);
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'TASK-LEASE'").get().status, 'in_progress');
  });
});

if (typeof Bun !== 'undefined') {
  let failed = false;
  for (const entry of queuedTests) { try { await entry.run(); } catch (error) { failed = true; console.error('not ok - ' + entry.name, error); } }
  if (failed) process.exitCode = 1;
}
