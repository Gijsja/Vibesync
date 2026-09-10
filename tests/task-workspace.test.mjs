import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, releaseTaskLease, ejectTaskToHuman } from '../src/tasks.mjs';
import { startTask } from '../src/workspace.mjs';

test('starting a task provisions its real branch, preserves work on release and resumes it', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-WORK', title: 'Workspace', target_milestone: 'v1', spec_markdown: 'Scoped implementation' }, db);
    createTask({ id: 'TASK-WORK', feature_id: 'FEAT-WORK', title: 'Implement', allowed_paths: ['src/**'], required_gates: ['git diff --check'], setup: [['node', '-e', "require('fs').mkdirSync('src',{recursive:true});require('fs').writeFileSync('src/setup.txt','ready')"]] }, db);
    const started = startTask({ taskId: 'TASK-WORK', actorName: 'openai-codex' }, db, sandbox.dir);
    assert.equal(started.task.worktree_path, started.worktreePath);
    const anchor = fs.readFileSync(started.activeTaskAnchorPath, 'utf8');
    assert.ok(anchor.includes('Scoped implementation'));
    assert.ok(anchor.includes('src/**'));
    assert.ok(anchor.includes('git diff --check'));
    assert.ok(anchor.includes(started.task.lease_expires_at));
    assert.ok(anchor.includes(started.task.base_commit));
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: started.worktreePath, encoding: 'utf8' }).trim(), started.task.branch_name);
    assert.equal(fs.readFileSync(path.join(started.worktreePath, 'src/setup.txt'), 'utf8'), 'ready');
    assert.equal(fs.statSync(started.preCommitHookPath).mode & 0o111, 0o111);
    fs.writeFileSync(path.join(started.worktreePath, 'unfinished.txt'), 'keep my work');
    assert.throws(() => startTask({ taskId: 'TASK-WORK', actorName: 'other' }, db, sandbox.dir), /in_progress/);
    releaseTaskLease('TASK-WORK', db);
    const resumed = startTask({ taskId: 'TASK-WORK', actorName: 'human' }, db, sandbox.dir);
    assert.equal(resumed.worktreePath, started.worktreePath);
    assert.equal(fs.readFileSync(path.join(resumed.worktreePath, 'unfinished.txt'), 'utf8'), 'keep my work');
    const status = execFileSync('git', ['status', '--short'], { cwd: resumed.worktreePath, encoding: 'utf8' });
    assert.ok(!status.includes('.vibesync_ACTIVE_TASK.md'));
  });
});

test('a stale task branch is rejected before it can receive a lease', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-COLLISION', title: 'Collision', target_milestone: 'v1', spec_markdown: 'Do not adopt stale branches' }, db);
    createTask({ id: 'TASK-COLLISION', feature_id: 'FEAT-COLLISION', title: 'Guard branch identity', allowed_paths: ['src/**'], required_gates: [] }, db);
    execFileSync('git', ['branch', 'task/task-collision'], { cwd: sandbox.dir });

    assert.throws(
      () => startTask({ taskId: 'TASK-COLLISION', actorName: 'openai-codex' }, db, sandbox.dir),
      /already exists without its managed worktree/
    );

    const task = db.prepare('SELECT status, assigned_actor, branch_name FROM tasks WHERE id = ?').get('TASK-COLLISION');
    assert.equal(task.status, 'ready');
    assert.equal(task.assigned_actor, null);
    assert.equal(task.branch_name, null);
  });
});


test('human takeover resets a tripped breaker and receives a fresh lease', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-HUMAN', title: 'Recovery', target_milestone: 'v1', spec_markdown: 'Recover failed work' }, db);
    createTask({ id: 'TASK-HUMAN', feature_id: 'FEAT-HUMAN', title: 'Repair', allowed_paths: ['src/**'], required_gates: ['git diff --check'] }, db);
    db.prepare("UPDATE tasks SET status = 'blocked', consecutive_failures = 3 WHERE id = 'TASK-HUMAN'").run();
    assert.throws(() => startTask({ taskId: 'TASK-HUMAN', actorName: 'openai-codex' }, db, sandbox.dir), /blocked/);
    const resumed = startTask({ taskId: 'TASK-HUMAN', actorName: 'human' }, db, sandbox.dir);
    assert.equal(resumed.task.status, 'in_progress');
    assert.equal(resumed.task.consecutive_failures, 0);
    db.prepare("UPDATE tasks SET assigned_actor = 'openai-codex', lease_expires_at = datetime('now', '+1 minute') WHERE id = 'TASK-HUMAN'").run();
    const ejected = ejectTaskToHuman('TASK-HUMAN', db, sandbox.dir);
    assert.equal(ejected.assigned_actor, 'human');
    assert.ok(Date.parse(ejected.lease_expires_at + 'Z') - Date.now() > 44 * 60 * 1000);
  });
});
