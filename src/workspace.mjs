import fs from 'node:fs';
import { checkpointState } from './db.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getFeature } from './features.mjs';
import { claimTask, getTask, releaseTaskLease, hydrateActiveTaskAnchor } from './tasks.mjs';
import { executeGates } from './gatekeeper.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function installScopeHook(worktreePath, allowedPaths) {
  git(worktreePath, ['config', 'extensions.worktreeConfig', 'true']);
  git(worktreePath, ['config', '--worktree', 'core.hooksPath', '.vibesync/hooks']);
  const hooksDir = path.join(worktreePath, '.vibesync', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  // Write allowed_paths to a data file — avoids any shell quoting/escaping issues.
  const dataPath = path.join(hooksDir, 'allowed_paths.json');
  fs.writeFileSync(dataPath, JSON.stringify(allowedPaths), 'utf8');
  const hookPath = path.join(hooksDir, 'pre-commit');
  const guardUrl = new URL('./guard.mjs', import.meta.url).href;
  const script = `#!/bin/sh\nexec node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; import { checkScopeBoundary } from ${JSON.stringify(guardUrl)}; const allowed=JSON.parse(fs.readFileSync(path.join(process.cwd(),".vibesync","hooks","allowed_paths.json"),"utf8")); const result=checkScopeBoundary(process.cwd(),allowed,{stagedOnly:true}); if(!result.valid){console.error("VibeSync scope violation. Commit blocked:"); console.error(result.violations.join("\\n")); process.exit(1);}'\n`;
  fs.writeFileSync(hookPath, script, { encoding: 'utf8', mode: 0o755 });
  return hookPath;
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
    const scopedTask = getTask(taskId, db);
    const preCommitHookPath = installScopeHook(worktreePath, scopedTask.allowed_paths);
    if ((scopedTask.setup || []).length) {
      const setupResult = executeGates(scopedTask.setup, { cwd: worktreePath, db, taskId, actorName, repoRoot,
        allowedPaths: scopedTask.allowed_paths, phase: 'setup' });
      if (!setupResult.success) {
        const error = new Error(`Worktree setup failed: ${setupResult.failedGate?.summary || setupResult.failedGate?.error || 'unknown error'}`);
        error.code = setupResult.failedGate?.code || 'SETUP_FAILED';
        throw error;
      }
    }
    const activeTaskAnchorPath = hydrateActiveTaskAnchor(worktreePath, getTask(taskId, db), getFeature(task.feature_id, db));
    checkpointState(db);
    return { success: true, task: getTask(taskId, db), worktreePath, activeTaskAnchorPath, preCommitHookPath,
      leaseToken: result.leaseToken, heartbeatMinutes: result.heartbeatMinutes, modelProfile: result.modelProfile };
  } catch (err) {
    releaseTaskLease(taskId, db);
    throw err;
  }
}
