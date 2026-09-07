import fs from 'node:fs';
import { checkpointState } from './db.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getFeature } from './features.mjs';
import { claimTask, getTask, releaseTaskLease, hydrateActiveTaskAnchor } from './tasks.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function getTrunk(repoRoot) {
  for (const branch of ['main', 'master']) {
    try { git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]); return branch; } catch {}
  }
  throw new Error('Create a main or master branch with an initial commit before starting tasks.');
}

/** Claim a task and provision its actual isolated Git worktree. Never reset an existing branch. */
export function startTask({ taskId, actorName = 'human' }, db, repoRoot) {
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const trunk = getTrunk(repoRoot);
  const result = claimTask({ taskId, actorName }, db, repoRoot);
  const branch = result.task.branch_name;
  const worktreePath = path.join(repoRoot, '.vibesync', 'worktrees', branch.slice(5));
  try {
    if (fs.existsSync(worktreePath)) {
      const actualBranch = git(worktreePath, ['symbolic-ref', '--short', 'HEAD']);
      const common = git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const expected = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (actualBranch !== branch || common !== expected) throw new Error('Existing task worktree does not match this task repository and branch.');
    } else {
      let branchExists = false;
      try { git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch {}
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(repoRoot, branchExists ? ['worktree', 'add', worktreePath, branch] : ['worktree', 'add', '-b', branch, worktreePath, trunk]);
    }
    const baseCommit = git(repoRoot, ['merge-base', trunk, branch]);
    db.prepare('UPDATE tasks SET worktree_path = ?, base_commit = ? WHERE id = ?').run(worktreePath, baseCommit, taskId);
    const activeTaskAnchorPath = hydrateActiveTaskAnchor(worktreePath, getTask(taskId, db), getFeature(task.feature_id, db));
    checkpointState(db);
    return { success: true, task: getTask(taskId, db), worktreePath, activeTaskAnchorPath };
  } catch (err) {
    releaseTaskLease(taskId, db);
    throw err;
  }
}
