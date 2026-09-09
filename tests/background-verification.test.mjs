import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb, readArtifact } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, getTask } from '../src/tasks.mjs';
import { startTask } from '../src/workspace.mjs';
import { beginOperation, listOperations } from '../src/operations.mjs';
import { startServer, getPayload } from '../src/server.mjs';
import { getChangedFiles } from '../src/guard.mjs';

test('background gates keep HTTP live, serialize operations, and settle the actual workspace', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-JOB', title: 'Background', target_milestone: 'v1', spec_markdown: 'Verify real work', holistic_gate_cmd: 'git diff --check' }, db);
    createTask({ id: 'TASK-JOB', feature_id: 'FEAT-JOB', title: 'Build', allowed_paths: ['src/**'], required_gates: ['node -e "setTimeout(() => console.log(987654321), 600)"'] }, db);
    const { worktreePath } = startTask({ taskId: 'TASK-JOB', actorName: 'openai-codex' }, db, sandbox.dir);
    fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'src/module.txt'), 'verified content');
    const server = await startServer({ db, repoRoot: sandbox.dir, port: 0, quiet: true });
    try {
      const operation = beginOperation('task', 'TASK-JOB', 'openai-codex', db, sandbox.dir, server.broadcastState);
      assert.equal(getPayload(db, sandbox.dir).tasks[0].verifying, true);
      assert.throws(() => beginOperation('task', 'TASK-JOB', 'other', db, sandbox.dir), /running/);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/state`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).operations[0].status, 'running');
      const result = await operation.completion;
      if (result.failedGate?.code === 'SANDBOX_UNAVAILABLE') return;
    assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(getTask('TASK-JOB', db).status, 'settled');
      assert.equal(listOperations(db)[0].status, 'completed');
      const gateEvent = db.prepare("SELECT artifact_hash FROM settlement_events WHERE action = 'gate_passed' AND task_id = 'TASK-JOB'").get();
      assert.ok(readArtifact(gateEvent.artifact_hash, sandbox.dir).includes('987654321'));
      assert.equal(fs.readFileSync(path.join(sandbox.dir, 'src/module.txt'), 'utf8'), 'verified content');
    } finally { await server.close(); }
  });
});

test('gate-created out-of-scope files block settlement', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-SCOPE', title: 'Scope', target_milestone: 'v1', spec_markdown: 'No escaped files' }, db);
    createTask({ id: 'TASK-SCOPE', feature_id: 'FEAT-SCOPE', title: 'Build', allowed_paths: ['src/**'], required_gates: ['node -e "require(\'fs\').writeFileSync(\'outside.txt\', \'unexpected\')"'] }, db);
    startTask({ taskId: 'TASK-SCOPE', actorName: 'human' }, db, sandbox.dir);
    const { completion } = beginOperation('task', 'TASK-SCOPE', 'human', db, sandbox.dir);
    const result = await completion;
    assert.equal(result.success, false);
    assert.equal(result.phase, 'WRITE_SCOPE_VIOLATION');
    assert.equal(getTask('TASK-SCOPE', db).status, 'in_progress');
    assert.equal(listOperations(db)[0].status, 'failed');
    assert.equal(fs.existsSync(path.join(sandbox.dir, 'outside.txt')), false);
  });
});

test('scope discovery preserves unusual filenames and fails on missing explicit refs', async () => {
  await withSandbox(async sandbox => {
    const filename = ' leading space\nand-newline.txt';
    fs.writeFileSync(path.join(sandbox.dir, filename), 'content');
    assert.ok(getChangedFiles({ cwd: sandbox.dir }).includes(filename));
    assert.throws(() => getChangedFiles({ cwd: sandbox.dir, baseCommit: 'missing-ref' }));
  });
});

test('operation notification failures cannot strand a running job or escape completion', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    assert.throws(() => beginOperation('task', 'MISSING', 'human', db, sandbox.dir, () => {
      throw new Error('notification unavailable');
    }), /notification unavailable/);
    assert.equal(listOperations(db)[0].status, 'failed');
    let notifications = 0;
    const { completion } = beginOperation('task', 'MISSING', 'human', db, sandbox.dir, () => {
      if (++notifications > 1) throw new Error('completion notification unavailable');
    });
    await assert.rejects(completion, /completion notification unavailable/);
    assert.ok(listOperations(db).every(op => op.status === 'failed'));
  });
});

test('first settlement preserves uncommitted setup files while runtime ignores remain active', async () => {
  const { initializeWorkspace } = await import('../src/init.mjs');
  const { approveTaskCommand } = await import('../src/policy.mjs');
  await withSandbox(async sandbox => {
    initializeWorkspace(sandbox.dir);
    const db = getDb(null, sandbox.dir);
    createFeature({ id: 'FEAT-FIRST', title: 'First run', target_milestone: 'v1', spec_markdown: 'Deliver source' }, db);
    createTask({ id: 'TASK-FIRST', feature_id: 'FEAT-FIRST', title: 'Source', allowed_paths: ['src/**'],
      required_gates: [{ type: 'argv', argv: ['git', 'diff', '--check'] }] }, db);
    approveTaskCommand({ taskId: 'TASK-FIRST', phase: 'gate', index: 0, approvedBy: 'test-admin' }, db, sandbox.dir);
    const setup = ['.gitignore', '.mcp.json', '.vibesync/dashboard.html'].map(file => [file, fs.readFileSync(path.join(sandbox.dir, file), 'utf8')]);
    const { worktreePath } = startTask({ taskId: 'TASK-FIRST', actorName: 'human' }, db, sandbox.dir);
    fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'src/first.txt'), 'first delivery');
    const { completion } = beginOperation('task', 'TASK-FIRST', 'human', db, sandbox.dir);
    const result = await completion;
    if (result.failedGate?.code === 'SANDBOX_UNAVAILABLE') return;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.warnings, []);
    for (const [file, contents] of setup) assert.equal(fs.readFileSync(path.join(sandbox.dir, file), 'utf8'), contents);
    assert.equal(fs.readFileSync(path.join(sandbox.dir, 'src/first.txt'), 'utf8'), 'first delivery');
  });
});
