import test from './bun-node-test.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask } from '../src/tasks.mjs';
import { recordGateFailure } from '../src/gatekeeper.mjs';
import { detectDefaultGateCommand, provisionFastPathTask } from '../src/fastpath.mjs';
import { computeAgentTelemetry, computeAttentionQueue, formatAttentionQueue } from '../src/telemetry.mjs';

const runtime = path.resolve('scripts/vibesync.mjs');

test('detectDefaultGateCommand detects project test script', () => {
  const gate = detectDefaultGateCommand(process.cwd());
  assert.equal(gate, 'npm test');
});

test('computeAgentTelemetry returns confidence, evidence, and uncertainty', async () => {
  await withSandbox(async (sandbox) => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-T1', title: 'Telemetry Feature', target_milestone: 'v0.5', spec_markdown: 'Spec' }, db);
    const task = createTask({ id: 'TASK-T1', feature_id: 'FEAT-T1', title: 'Telemetry Task' }, db);
    claimTask({ taskId: 'TASK-T1', actorName: 'bot' }, db, sandbox.dir);

    const telemetry = computeAgentTelemetry(task, db, sandbox.dir);
    assert.ok(['high', 'medium', 'low'].includes(telemetry.confidence));
    assert.ok(typeof telemetry.evidence === 'string');
    assert.ok(typeof telemetry.uncertainty === 'string');
  });
});

test('computeAttentionQueue categorizes blocked, review, and in-progress tasks', async () => {
  await withSandbox(async (sandbox) => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-Q', title: 'Queue Feature', target_milestone: 'v0.5', spec_markdown: 'Spec' }, db);

    // 1. In-progress human task (needs decision)
    createTask({ id: 'TASK-HUMAN', feature_id: 'FEAT-Q', title: 'Human Work' }, db);
    claimTask({ taskId: 'TASK-HUMAN', actorName: 'human' }, db, sandbox.dir);

    // 2. In-progress agent task
    createTask({ id: 'TASK-AGENT', feature_id: 'FEAT-Q', title: 'Agent Work' }, db);
    claimTask({ taskId: 'TASK-AGENT', actorName: 'claude' }, db, sandbox.dir);

    // 3. Blocked task
    createTask({ id: 'TASK-BLOCK', feature_id: 'FEAT-Q', title: 'Blocked Work' }, db);
    claimTask({ taskId: 'TASK-BLOCK', actorName: 'flaky' }, db, sandbox.dir);
    recordGateFailure(db, 'TASK-BLOCK', { failure: 'fail 1' });
    recordGateFailure(db, 'TASK-BLOCK', { failure: 'fail 2' });
    recordGateFailure(db, 'TASK-BLOCK', { failure: 'fail 3' });

    const queue = computeAttentionQueue(db, sandbox.dir);
    assert.equal(queue.counts.decisions, 1);
    assert.equal(queue.counts.inProgress, 1);
    assert.equal(queue.counts.blocked, 1);
    assert.equal(queue.counts.totalNeedsAttention, 2); // 1 decision + 1 blocked

    const formatted = formatAttentionQueue(queue);
    assert.match(formatted, /VIBESYNC HUMAN ATTENTION QUEUE/);
    assert.match(formatted, /TASK-HUMAN/);
    assert.match(formatted, /TASK-AGENT/);
    assert.match(formatted, /TASK-BLOCK/);
  });
});

test('provisionFastPathTask creates feature, task, and worktree in one call', async () => {
  await withSandbox(async (sandbox) => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    const result = provisionFastPathTask({
      prompt: 'Refactor database query helper',
      actor: 'dev-user',
      repoRoot: sandbox.dir,
      db
    });

    assert.ok(result.taskId.startsWith('TASK-FAST-'));
    assert.equal(result.title, 'Refactor database query helper');
    assert.equal(result.actor, 'dev-user');
    assert.ok(result.worktreePath);
    assert.ok(result.branch.startsWith('task/task-fast-'));
  });
});

test('CLI vibesync run and vibesync --queue work end-to-end', async () => {
  await withSandbox(async (sandbox) => {
    // 1. Run fast-path task via CLI
    const runOut = execFileSync(process.execPath, [runtime, '--repo', sandbox.dir, 'run', 'Fix UI header bug'], { encoding: 'utf8' });
    assert.match(runOut, /\[VibeSync Fast-Path\] Provisioned task TASK-FAST-/);
    assert.match(runOut, /Fix UI header bug/);
    assert.match(runOut, /Worktree:/);

    // 2. Query queue via CLI
    const queueOut = execFileSync(process.execPath, [runtime, '--repo', sandbox.dir, '--queue'], { encoding: 'utf8' });
    assert.match(queueOut, /VIBESYNC HUMAN ATTENTION QUEUE/);
    assert.match(queueOut, /TASK-FAST-/);
  });
});
