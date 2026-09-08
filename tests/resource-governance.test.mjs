import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, getTask } from '../src/tasks.mjs';
import { executeGates, executePartialVerification } from '../src/gatekeeper.mjs';
import { acquireGateSlot, releaseGateSlot, cleanAbandonedGateSlots, getSlotStatus } from '../src/scheduler.mjs';

test('gate slots enforce global and model-aware per-actor limits', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    const first = acquireGateSlot(db, 'local-qwen', 'TASK-A', 'gate', { max_concurrent_gates: 4 });
    assert.equal(first.acquired, true);
    const localBlocked = acquireGateSlot(db, 'local-qwen', 'TASK-B', 'gate', { max_concurrent_gates: 4 });
    assert.equal(localBlocked.acquired, false);
    assert.equal(localBlocked.activeLimits.perActorMax, 1);
    const globalBlocked = acquireGateSlot(db, 'openai-codex', 'TASK-C', 'gate', { max_concurrent_gates: 1, max_concurrent_gates_per_actor: 2 });
    assert.equal(globalBlocked.acquired, false);
    assert.match(globalBlocked.reason, /Global/);
    assert.equal(releaseGateSlot(db, first.slotId), true);
    assert.deepEqual(getSlotStatus(db), []);
  });
});

test('abandoned slots are recovered and capacity rejection is structured', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    db.prepare("INSERT INTO gate_slots (id, actor, phase, pid) VALUES ('dead', 'agent', 'gate', 2147483647)").run();
    assert.equal(cleanAbandonedGateSlots(db), 1);
    db.prepare("INSERT INTO gate_slots (id, actor, phase, pid) VALUES ('busy', 'other', 'gate', ?)").run(process.pid);
    fs.writeFileSync(path.join(sandbox.dir, '.vibesync/policy.json'), JSON.stringify({ resource_policy: { max_concurrent_gates: 1 } }));
    const result = executeGates([{ type: 'argv', argv: ['node', '-e', 'process.exit(0)'] }], {
      cwd: sandbox.dir, db, actorName: 'openai-codex', repoRoot: sandbox.dir
    });
    assert.equal(result.failedGate.code, 'GATE_CAPACITY');
    assert.equal(result.queuePosition, 1);
    assert.ok(result.retryAfterMs > 0);
  });
});

test('resource ceilings cap time and release slots on failure', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    fs.writeFileSync(path.join(sandbox.dir, '.vibesync/policy.json'), JSON.stringify({ resource_policy: { timeout_ceiling_ms: 50, output_limit_bytes: 1024 } }));
    const result = executeGates([{ type: 'argv', argv: ['node', '-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)'], timeout_ms: 500 }], {
      cwd: sandbox.dir, db, actorName: 'openai-codex', repoRoot: sandbox.dir
    });
    assert.equal(result.success, false);
    assert.match(result.failedGate.error, /timed out/i);
    assert.deepEqual(getSlotStatus(db), []);
  });
});

test('partial verification accepts only safe structured task gates and never settles', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-PARTIAL', title: 'Partial', target_milestone: 'v1', spec_markdown: 'Early checks' }, db);
    createTask({ id: 'TASK-PARTIAL', feature_id: 'FEAT-PARTIAL', title: 'Partial', required_gates: [
      { type: 'argv', argv: ['node', '-e', 'process.exit(0)'], idempotency: 'safe' }
    ] }, db);
    claimTask({ taskId: 'TASK-PARTIAL', actorName: 'openai-codex' }, db, sandbox.dir);
    const result = executePartialVerification({ taskId: 'TASK-PARTIAL', actorName: 'openai-codex', repoRoot: sandbox.dir }, db);
    assert.equal(result.phase, 'PARTIAL_GATES_PASSED');
    assert.equal(result.ownershipChanged, false);
    assert.equal(getTask('TASK-PARTIAL', db).status, 'in_progress');
    assert.equal(db.prepare("SELECT phase FROM gate_runs WHERE task_id = ?").get('TASK-PARTIAL').phase, 'partial');

    db.prepare('UPDATE tasks SET required_gates = ? WHERE id = ?').run(JSON.stringify(['node --version']), 'TASK-PARTIAL');
    const unsafe = executePartialVerification({ taskId: 'TASK-PARTIAL', actorName: 'openai-codex', repoRoot: sandbox.dir }, db);
    assert.equal(unsafe.failedGate.code, 'PARTIAL_GATE_UNSAFE');
    assert.equal(getTask('TASK-PARTIAL', db).status, 'in_progress');
  });
});
