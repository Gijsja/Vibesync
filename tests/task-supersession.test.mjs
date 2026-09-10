import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature, settleFeature } from '../src/features.mjs';
import { createTask, claimTask, getTask, supersedeTask } from '../src/tasks.mjs';
import { startServer } from '../src/server.mjs';

test('a settled sibling can supersede a ready task without forging a settlement', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-SUPERSEDE', title: 'Supersession', target_milestone: 'v1', spec_markdown: 'x' }, db);
    createTask({ id: 'TASK-OLD', feature_id: 'FEAT-SUPERSEDE', title: 'Old path' }, db);
    createTask({ id: 'TASK-NEW', feature_id: 'FEAT-SUPERSEDE', title: 'Replacement path' }, db);
    createTask({ id: 'TASK-AFTER', feature_id: 'FEAT-SUPERSEDE', title: 'Dependent', labels: ['after-TASK-OLD'] }, db);
    db.prepare("UPDATE tasks SET status = 'settled', settled_commit = 'abc1234' WHERE id = 'TASK-NEW'").run();

    const result = supersedeTask({ taskId: 'TASK-OLD', replacementTaskId: 'TASK-NEW', actorName: 'human' }, db);
    assert.equal(result.status, 'ready');
    assert.equal(result.superseded_by_task_id, 'TASK-NEW');
    assert.equal(result.settled_commit, null);
    assert.throws(() => claimTask({ taskId: 'TASK-OLD', actorName: 'openai-codex' }, db, sandbox.dir), /superseded/);
    assert.equal(claimTask({ taskId: 'TASK-AFTER', actorName: 'openai-codex' }, db, sandbox.dir).task.id, 'TASK-AFTER');
    assert.equal(db.prepare("SELECT action FROM settlement_events WHERE task_id = 'TASK-OLD' ORDER BY id DESC LIMIT 1").get().action, 'task_superseded');
  });
});

test('a feature can settle when every unfinished child is explicitly superseded', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-TERMINAL', title: 'Terminal children', target_milestone: 'v1', spec_markdown: 'x' }, db);
    createTask({ id: 'TASK-TERMINAL-OLD', feature_id: 'FEAT-TERMINAL', title: 'Old' }, db);
    createTask({ id: 'TASK-TERMINAL-NEW', feature_id: 'FEAT-TERMINAL', title: 'New' }, db);
    db.prepare("UPDATE tasks SET status = 'settled', settled_commit = 'abc1234' WHERE id = 'TASK-TERMINAL-NEW'").run();
    supersedeTask({ taskId: 'TASK-TERMINAL-OLD', replacementTaskId: 'TASK-TERMINAL-NEW', actorName: 'human' }, db);

    const settled = settleFeature({ featureId: 'FEAT-TERMINAL', actorName: 'human' }, db, sandbox.dir);
    assert.equal(settled.success, true);
  });
});

test('the loopback API exposes audited task supersession', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-API', title: 'API', target_milestone: 'v1', spec_markdown: 'x' }, db);
    createTask({ id: 'TASK-API-OLD', feature_id: 'FEAT-API', title: 'Old' }, db);
    createTask({ id: 'TASK-API-NEW', feature_id: 'FEAT-API', title: 'New' }, db);
    db.prepare("UPDATE tasks SET status = 'settled' WHERE id = 'TASK-API-NEW'").run();
    const server = await startServer({ port: 0, db, repoRoot: sandbox.dir, quiet: true });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/tasks/supersede`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'TASK-API-OLD', replacementTaskId: 'TASK-API-NEW', actorName: 'human' })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).task.superseded_by_task_id, 'TASK-API-NEW');
      assert.equal(getTask('TASK-API-OLD', db).superseded_by_task_id, 'TASK-API-NEW');
    } finally { await server.close(); }
  });
});
