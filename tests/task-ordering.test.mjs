import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask } from '../src/tasks.mjs';
const queuedTests = []; const test = typeof Bun === 'undefined' ? nodeTest : (name, run) => queuedTests.push({ name, run });

test('after-TASK label blocks a claim until its dependency settles', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-ORDER', title: 'Order', target_milestone: 'v1', spec_markdown: 'x' }, db);
    createTask({ id: 'TASK-FIRST', feature_id: 'FEAT-ORDER', title: 'First', allowed_paths: ['a'], required_gates: [] }, db);
    createTask({ id: 'TASK-NEXT', feature_id: 'FEAT-ORDER', title: 'Next', labels: ['after-TASK-FIRST'], allowed_paths: ['b'], required_gates: [] }, db);
    assert.throws(() => claimTask({ taskId: 'TASK-NEXT', actorName: 'openai-codex' }, db, sandbox.dir), /TASK-FIRST/);
    db.prepare("UPDATE tasks SET status = 'settled' WHERE id = 'TASK-FIRST'").run();
    assert.equal(claimTask({ taskId: 'TASK-NEXT', actorName: 'openai-codex' }, db, sandbox.dir).task.id, 'TASK-NEXT');
  });
});
if (typeof Bun !== 'undefined') { let failed = false; for (const entry of queuedTests) { try { await entry.run(); } catch (error) { failed = true; console.error('not ok - ' + entry.name, error); } } if (failed) process.exitCode = 1; }
