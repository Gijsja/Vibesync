import fs from 'node:fs';
import { checkpointState } from './db.mjs';
import path from 'node:path';
import { getFeature } from './features.mjs';
import { claimTask, getTask, releaseTaskLease, hydrateActiveTaskAnchor } from './tasks.mjs';
import { executeGates } from './gatekeeper.mjs';
import { execGitWithBackoff } from './incubator.mjs';

function git(cwd, args) {
  return execGitWithBackoff(args, { cwd });
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
  const runtime = JSON.stringify(process.execPath);
  const script = `#!/bin/sh\nexec ${runtime} --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; import { checkScopeBoundary } from ${JSON.stringify(guardUrl)}; const allowed=JSON.parse(fs.readFileSync(path.join(process.cwd(),".vibesync","hooks","allowed_paths.json"),"utf8")); const result=checkScopeBoundary(process.cwd(),allowed,{stagedOnly:true}); if(!result.valid){console.error("VibeSync scope violation. Commit blocked:"); console.error(result.violations.join("\\n")); process.exit(1);}'\n`;
  fs.writeFileSync(hookPath, script, { encoding: 'utf8', mode: 0o755 });
  return hookPath;
}

export function getTrunk(repoRoot) {
  for (const branch of ['main', 'master']) {
    try { git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]); return branch; } catch {}
  }
  throw new Error('Create a main or master branch with an initial commit before starting tasks.');
}

function taskBranchName(taskId) {
  return `task/${taskId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
}

/**
 * Validate the deterministic task branch before a lease is issued. A branch
 * left behind without its managed worktree may belong to earlier work and
 * must never be silently adopted as the base for a new lease.
 */
function preflightTaskWorkspace({ taskId, repoRoot }) {
  const branch = taskBranchName(taskId);
  const worktreePath = path.join(repoRoot, '.vibesync', 'worktrees', branch.slice(5));
  let branchExists = false;
  try { git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch {}

  if (!fs.existsSync(worktreePath)) {
    if (branchExists) {
      throw new Error(`Task branch ${branch} already exists without its managed worktree. Refusing to reuse an unknown branch; repair or remove it before claiming this task.`);
    }
    return { branch, worktreePath, branchExists };
  }

  const actualBranch = git(worktreePath, ['symbolic-ref', '--short', 'HEAD']);
  const common = git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const expected = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (actualBranch !== branch || common !== expected) {
    throw new Error('Existing task worktree does not match this task repository and branch.');
  }
  return { branch, worktreePath, branchExists };
}

export function inspectWorkspaceDeliverables(worktreePath, baseCommit = 'HEAD') {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { clean: true, uncommitted_files: [], commits_ahead: 0 };
  }
  let uncommitted_files = [];
  try {
    const rawStatus = git(worktreePath, ['status', '--porcelain', '-uall']);
    uncommitted_files = rawStatus
      .split('\n')
      .map(line => line.trim())
      .filter(line => Boolean(line) && !line.includes('.vibesync'))
      .map(line => line.slice(3).trim());
  } catch {}

  let commits_ahead = 0;
  try {
    if (baseCommit && baseCommit !== '0000000') {
      const aheadStr = git(worktreePath, ['rev-list', '--count', `${baseCommit}..HEAD`]);
      commits_ahead = parseInt(aheadStr.trim(), 10) || 0;
    }
  } catch {}

  return {
    clean: uncommitted_files.length === 0 && commits_ahead === 0,
    uncommitted_files,
    commits_ahead
  };
}

/** Claim a task and provision its actual isolated Git worktree. Never reset an existing branch. */
export function startTask({ taskId, actorName = 'human' }, db, repoRoot) {
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const trunk = getTrunk(repoRoot);
  const workspace = preflightTaskWorkspace({ taskId, repoRoot });
  const result = claimTask({ taskId, actorName }, db, repoRoot);
  const { branch, worktreePath, branchExists } = workspace;
  try {
    if (fs.existsSync(worktreePath)) {
      // Preflight already established that this is the managed task worktree.
    } else {
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
    const workspaceStatus = inspectWorkspaceDeliverables(worktreePath, baseCommit);
    const activeTaskAnchorPath = hydrateActiveTaskAnchor(worktreePath, getTask(taskId, db), getFeature(task.feature_id, db), workspaceStatus);
    checkpointState(db);
    return { success: true, task: getTask(taskId, db), worktreePath, activeTaskAnchorPath, preCommitHookPath,
      workspaceStatus,
      leaseToken: result.leaseToken, heartbeatMinutes: result.heartbeatMinutes, modelProfile: result.modelProfile };
  } catch (err) {
    releaseTaskLease(taskId, db);
    throw err;
  }
}
