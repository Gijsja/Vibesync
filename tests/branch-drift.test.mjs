import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox, execGit } from './harness.mjs';
import { inspectBranchDrift } from '../src/workspace.mjs';

const queued = [];
const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });

test('inspectBranchDrift reports up-to-date branch when at trunk HEAD', async () => {
  await withSandbox(async sandbox => {
    const wtDir = path.join(sandbox.dir, '.vibesync', 'worktrees', 'drift-test');
    execGit(`git worktree add -b task/drift-test ${wtDir} main`, sandbox.dir);

    const drift = inspectBranchDrift(wtDir, sandbox.dir);
    assert.equal(drift.behind_trunk, 0);
    assert.equal(drift.ahead_trunk, 0);
    assert.equal(drift.can_merge_cleanly, true);
    assert.deepEqual(drift.conflict_files, []);
    assert.equal(drift.warning, null);
  });
});

test('inspectBranchDrift detects when trunk advances cleanly', async () => {
  await withSandbox(async sandbox => {
    const wtDir = path.join(sandbox.dir, '.vibesync', 'worktrees', 'drift-test-2');
    execGit(`git worktree add -b task/drift-test-2 ${wtDir} main`, sandbox.dir);

    // Commit a clean new file to main
    fs.writeFileSync(path.join(sandbox.dir, 'new-file.txt'), 'clean content\n');
    execGit('git add new-file.txt', sandbox.dir);
    execGit('git commit -m "trunk advance"', sandbox.dir);

    const drift = inspectBranchDrift(wtDir, sandbox.dir);
    assert.equal(drift.behind_trunk, 1);
    assert.equal(drift.can_merge_cleanly, true);
    assert.deepEqual(drift.conflict_files, []);
    assert.ok(drift.warning.includes('1 commit(s) behind'));
  });
});

test('inspectBranchDrift detects merge conflicts on divergent edits', async () => {
  await withSandbox(async sandbox => {
    // Set up shared tracked file
    fs.writeFileSync(path.join(sandbox.dir, 'conflict.txt'), 'base line\n');
    execGit('git add conflict.txt', sandbox.dir);
    execGit('git commit -m "add conflict base"', sandbox.dir);

    const wtDir = path.join(sandbox.dir, '.vibesync', 'worktrees', 'drift-conflict');
    execGit(`git worktree add -b task/drift-conflict ${wtDir} main`, sandbox.dir);

    // Edit in worktree
    fs.writeFileSync(path.join(wtDir, 'conflict.txt'), 'worktree edit\n');
    execGit('git add conflict.txt', wtDir);
    execGit('git commit -m "worktree change"', wtDir);

    // Edit differently on trunk
    fs.writeFileSync(path.join(sandbox.dir, 'conflict.txt'), 'trunk conflicting edit\n');
    execGit('git add conflict.txt', sandbox.dir);
    execGit('git commit -m "trunk conflict change"', sandbox.dir);

    const drift = inspectBranchDrift(wtDir, sandbox.dir);
    assert.equal(drift.behind_trunk, 1);
    assert.equal(drift.ahead_trunk, 1);
    assert.equal(drift.can_merge_cleanly, false);
    assert.ok(drift.conflict_files.includes('conflict.txt'));
    assert.ok(drift.warning.includes('Potential merge conflict in: conflict.txt'));
  });
});

test('previewTask includes drift diagnostic when task has a provisioned worktree', async () => {
  await withSandbox(async sandbox => {
    const { getDb } = await import('../src/db.mjs');
    const { createFeature } = await import('../src/features.mjs');
    const { createTask } = await import('../src/tasks.mjs');
    const { previewTask } = await import('../src/policy.mjs');

    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-D1', title: 'Drift feature', target_milestone: 'v1.0', spec_markdown: 'Spec text' }, db);

    const wtDir = path.join(sandbox.dir, '.vibesync', 'worktrees', 'task-d1-1');
    execGit(`git worktree add -b task/task-d1-1 ${wtDir} main`, sandbox.dir);

    // Commit on trunk so task branch is behind
    fs.writeFileSync(path.join(sandbox.dir, 'trunk-bump.txt'), 'bump\n');
    execGit('git add trunk-bump.txt', sandbox.dir);
    execGit('git commit -m "bump trunk"', sandbox.dir);

    createTask({
      id: 'TASK-D1.1',
      feature_id: 'FEAT-D1',
      title: 'Drift preview task',
      allowed_paths: ['*']
    }, db);
    db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run(wtDir, 'TASK-D1.1');

    const preview = previewTask({ taskId: 'TASK-D1.1', actorName: 'antigravity' }, db, sandbox.dir);
    assert.ok(preview.drift);
    assert.equal(preview.drift.behind_trunk, 1);
    assert.equal(preview.drift.can_merge_cleanly, true);
  });
});

test('hydrateActiveTaskAnchor includes Branch Drift Notice when behind trunk', async () => {
  await withSandbox(async sandbox => {
    const { getDb } = await import('../src/db.mjs');
    const { createFeature } = await import('../src/features.mjs');
    const { createTask, hydrateActiveTaskAnchor } = await import('../src/tasks.mjs');

    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    const feature = createFeature({ id: 'FEAT-D2', title: 'Drift anchor feature', target_milestone: 'v1.0', spec_markdown: 'Spec text' }, db);

    const wtDir = path.join(sandbox.dir, '.vibesync', 'worktrees', 'task-d2-1');
    execGit(`git worktree add -b task/task-d2-1 ${wtDir} main`, sandbox.dir);

    // Advance trunk
    fs.writeFileSync(path.join(sandbox.dir, 'trunk-advance.txt'), 'advance\n');
    execGit('git add trunk-advance.txt', sandbox.dir);
    execGit('git commit -m "advance trunk"', sandbox.dir);

    const task = createTask({
      id: 'TASK-D2.1',
      feature_id: 'FEAT-D2',
      title: 'Drift anchor task',
      allowed_paths: ['*']
    }, db);

    hydrateActiveTaskAnchor(wtDir, task, feature);
    const anchorContent = fs.readFileSync(path.join(wtDir, '.vibesync_ACTIVE_TASK.md'), 'utf8');
    assert.ok(anchorContent.includes('## Branch Drift Notice'));
    assert.ok(anchorContent.includes('1 commit(s) behind'));
  });
});

test('MCP vibesync_get_active_task compact response includes drift when behind trunk', async () => {
  await withSandbox(async sandbox => {
    const { getDb } = await import('../src/db.mjs');
    const { createFeature } = await import('../src/features.mjs');
    const { createTask } = await import('../src/tasks.mjs');
    const { createMcpServer } = await import('../src/mcp.mjs');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-D3', title: 'Active drift feature', target_milestone: 'v1.0', spec_markdown: 'Spec text' }, db);

    const wtDir = path.join(sandbox.dir, '.vibesync', 'worktrees', 'task-d3-1');
    execGit(`git worktree add -b task/task-d3-1 ${wtDir} main`, sandbox.dir);

    // Advance trunk
    fs.writeFileSync(path.join(sandbox.dir, 'bump3.txt'), 'bump3\n');
    execGit('git add bump3.txt', sandbox.dir);
    execGit('git commit -m "advance trunk 3"', sandbox.dir);

    createTask({
      id: 'TASK-D3.1',
      feature_id: 'FEAT-D3',
      title: 'Active drift task',
      status: 'in_progress',
      allowed_paths: ['*']
    }, db);
    db.prepare("UPDATE tasks SET worktree_path = ?, assigned_actor = 'test-worker', lease_expires_at = datetime('now', '+1 hour') WHERE id = ?")
      .run(wtDir, 'TASK-D3.1');

    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const call = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const res = await call({
      method: 'tools/call',
      params: {
        name: 'vibesync_get_active_task',
        arguments: { actor_name: 'test-worker' }
      }
    });

    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.drift);
    assert.equal(parsed.drift.behind_trunk, 1);
  });
});

if (typeof Bun !== 'undefined') {
  let fail = false;
  for (const e of queued) {
    try { await e.f(); }
    catch (err) { fail = true; console.error(err); }
  }
  if (fail) process.exitCode = 1;
}
