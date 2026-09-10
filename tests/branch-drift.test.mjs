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

if (typeof Bun !== 'undefined') {
  let fail = false;
  for (const e of queued) {
    try { await e.f(); }
    catch (err) { fail = true; console.error(err); }
  }
  if (fail) process.exitCode = 1;
}
