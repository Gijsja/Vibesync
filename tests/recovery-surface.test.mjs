import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, releaseTaskLease } from '../src/tasks.mjs';
import { startTask, inspectWorkspaceDeliverables } from '../src/workspace.mjs';

test('first claim reports clean workspace and generation 1 in anchor', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-REC-1', title: 'Recovery Feature 1', target_milestone: 'v1', spec_markdown: 'Spec 1' }, db);
    createTask({ id: 'TASK-REC-1', feature_id: 'FEAT-REC-1', title: 'Task 1', allowed_paths: ['src/**'], required_gates: [] }, db);

    const started = startTask({ taskId: 'TASK-REC-1', actorName: 'first-actor' }, db, sandbox.dir);
    assert.ok(started.workspaceStatus);
    assert.equal(started.workspaceStatus.clean, true);
    assert.deepEqual(started.workspaceStatus.uncommitted_files, []);
    assert.equal(started.workspaceStatus.commits_ahead, 0);

    const anchor = fs.readFileSync(started.activeTaskAnchorPath, 'utf8');
    assert.ok(anchor.includes('**Lease Generation:** 1'));
    assert.ok(!anchor.includes('## Prior Workspace State'));
  });
});

test('reclaimed task surfaces uncommitted deliverables from prior lease in anchor and response', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-REC-2', title: 'Recovery Feature 2', target_milestone: 'v1', spec_markdown: 'Spec 2' }, db);
    createTask({ id: 'TASK-REC-2', feature_id: 'FEAT-REC-2', title: 'Task 2', allowed_paths: ['src/**'], required_gates: [] }, db);

    const first = startTask({ taskId: 'TASK-REC-2', actorName: 'first-actor' }, db, sandbox.dir);
    // Simulate actor leaving unfinished deliverables
    fs.mkdirSync(path.join(first.worktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(first.worktreePath, 'src/unfinished.js'), 'const workInProgress = true;');

    // Release lease
    releaseTaskLease('TASK-REC-2', db);

    // Reclaim task with second actor
    const second = startTask({ taskId: 'TASK-REC-2', actorName: 'second-actor' }, db, sandbox.dir);
    assert.equal(second.task.lease_generation, 2);
    assert.equal(second.workspaceStatus.clean, false);
    assert.ok(second.workspaceStatus.uncommitted_files.includes('src/unfinished.js'));

    const anchor = fs.readFileSync(second.activeTaskAnchorPath, 'utf8');
    assert.ok(anchor.includes('**Lease Generation:** 2'));
    assert.ok(anchor.includes('## Prior Workspace State (Generation 2)'));
    assert.ok(anchor.includes('src/unfinished.js'));
    assert.ok(anchor.includes('Uncommitted deliverables (1 files):'));
  });
});

test('reclaimed clean task explicitly reports zero uncommitted deliverables', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-REC-3', title: 'Recovery Feature 3', target_milestone: 'v1', spec_markdown: 'Spec 3' }, db);
    createTask({ id: 'TASK-REC-3', feature_id: 'FEAT-REC-3', title: 'Task 3', allowed_paths: ['src/**'], required_gates: [] }, db);

    startTask({ taskId: 'TASK-REC-3', actorName: 'first-actor' }, db, sandbox.dir);
    releaseTaskLease('TASK-REC-3', db);

    const second = startTask({ taskId: 'TASK-REC-3', actorName: 'second-actor' }, db, sandbox.dir);
    assert.equal(second.task.lease_generation, 2);
    assert.equal(second.workspaceStatus.clean, true);

    const anchor = fs.readFileSync(second.activeTaskAnchorPath, 'utf8');
    assert.ok(anchor.includes('## Prior Workspace State (Generation 2)'));
    assert.ok(anchor.includes('Clean working tree (no uncommitted deliverables preserved from prior leases).'));
  });
});
