import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { startTask } from '../src/workspace.mjs';
import { verifyAndSettleTask } from '../src/settle.mjs';

test('settling a task cleanly detaches worktree and deletes task branch with zero warnings', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-SETTLE-CLEAN', title: 'Clean Settle', target_milestone: 'v1', spec_markdown: 'Settle cleanly' }, db);
    createTask({
      id: 'TASK-SETTLE-CLEAN',
      feature_id: 'FEAT-SETTLE-CLEAN',
      title: 'Implement clean settle',
      allowed_paths: ['src/**'],
      required_gates: []
    }, db);

    const started = startTask({ taskId: 'TASK-SETTLE-CLEAN', actorName: 'antigravity' }, db, sandbox.dir);
    assert.ok(fs.existsSync(started.worktreePath));

    fs.mkdirSync(path.join(started.worktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(started.worktreePath, 'src/clean.txt'), 'clean settlement\n');
    execFileSync('git', ['add', 'src/clean.txt'], { cwd: started.worktreePath });
    execFileSync('git', ['commit', '-m', 'feat: add clean.txt'], { cwd: started.worktreePath });

    const settled = verifyAndSettleTask({
      taskId: 'TASK-SETTLE-CLEAN',
      actorName: 'antigravity',
      worktreePath: started.worktreePath,
      repoRoot: sandbox.dir
    }, db, sandbox.dir);

    assert.equal(settled.phase, 'SETTLED');
    assert.deepEqual(settled.warnings, []);

    // Verify branch was deleted from repository
    const branches = execFileSync('git', ['branch', '--list', 'task/task-settle-clean'], { cwd: sandbox.dir, encoding: 'utf8' }).trim();
    assert.equal(branches, '', 'Task branch should be deleted cleanly');

    // Verify worktree HEAD is detached
    const wtHead = execFileSync('git', ['status', '--short', '--branch'], { cwd: started.worktreePath, encoding: 'utf8' });
    assert.ok(wtHead.includes('HEAD (no branch)'), 'Worktree should be in detached HEAD state');
  });
});

test('settling a task without explicit worktreePath uses task.worktree_path and detaches cleanly', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-SETTLE-AUTO', title: 'Auto Settle', target_milestone: 'v1', spec_markdown: 'Auto worktree resolve' }, db);
    createTask({
      id: 'TASK-SETTLE-AUTO',
      feature_id: 'FEAT-SETTLE-AUTO',
      title: 'Implement auto settle',
      allowed_paths: ['src/**'],
      required_gates: []
    }, db);

    const started = startTask({ taskId: 'TASK-SETTLE-AUTO', actorName: 'antigravity' }, db, sandbox.dir);
    fs.mkdirSync(path.join(started.worktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(started.worktreePath, 'src/auto.txt'), 'auto settlement\n');
    execFileSync('git', ['add', 'src/auto.txt'], { cwd: started.worktreePath });
    execFileSync('git', ['commit', '-m', 'feat: add auto.txt'], { cwd: started.worktreePath });

    // Call verifyAndSettleTask WITHOUT worktreePath argument
    const settled = verifyAndSettleTask({
      taskId: 'TASK-SETTLE-AUTO',
      actorName: 'antigravity',
      repoRoot: sandbox.dir
    }, db, sandbox.dir);

    assert.equal(settled.phase, 'SETTLED');
    assert.deepEqual(settled.warnings, []);

    const branches = execFileSync('git', ['branch', '--list', 'task/task-settle-auto'], { cwd: sandbox.dir, encoding: 'utf8' }).trim();
    assert.equal(branches, '', 'Task branch should be deleted cleanly');
  });
});
