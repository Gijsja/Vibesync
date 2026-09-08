import { ensureRuntimeExcludes } from './init.mjs';
/**
 * src/settle.mjs
 * 
 * VibeSync Transactional Squash Settlement & Provenance
 * Milestone 2: Git Judicial Harness (Features 22–26)
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb, recordSettlementEvent, checkpointState } from './db.mjs';
import { getTask } from './tasks.mjs';
import { getFeature } from './features.mjs';
import { checkScopeBoundary } from './guard.mjs';
import { executeGates, recordGateFailure, resetGateFailures } from './gatekeeper.mjs';
import { scanSecretEntries } from './secrets.mjs';
import { simulateMergeTree } from './merge.mjs';
import { execGitWithBackoff, parkInsight } from './incubator.mjs';
import { getTrunk } from './workspace.mjs';
import { GIT_NOTES_REF } from './config.mjs';

/**
 * Formats RFC 2822 compliant commit message with structured trailers.
 * 
 * @param {object} params
 * @param {string} [params.title]
 * @param {string} params.taskId
 * @param {string} params.featureId
 * @param {string} params.actorName
 * @param {string} params.baseCommit
 * @param {Array<string|object>} [params.gates=[]]
 * @param {string} [params.body='']
 * @returns {string} Formatted commit message
 */
export function formatCommitTrailers(params) {
  const {
    title,
    taskId,
    featureId,
    actorName,
    baseCommit,
    gates = [],
    body = ''
  } = params;

  const gateList = Array.isArray(gates)
    ? gates.map(g => (typeof g === 'string' ? g : g.cmd || String(g)))
    : [];
  const gateStr = gateList.length > 0 ? `PASS (${gateList.join(', ')})` : 'PASS (all gates passed)';

  const lines = [
    `feat: ${title || taskId} (${taskId})`,
    ''
  ];

  if (body && body.trim()) {
    lines.push(body.trim(), '');
  }

  lines.push(
    `Task-Id: ${taskId}`,
    `Feature-Id: ${featureId}`,
    `Agent-Actor: ${actorName}`,
    `Base-Commit: ${baseCommit}`,
    `Gate-Verification: ${gateStr}`
  );

  if (params.priority) {
    lines.push(`Priority: ${params.priority}`);
  }
  if (params.labels && (Array.isArray(params.labels) ? params.labels.length > 0 : params.labels)) {
    lines.push(`Labels: ${Array.isArray(params.labels) ? params.labels.join(', ') : params.labels}`);
  }
  if (params.externalRef || params.external_ref) {
    lines.push(`External-Ref: ${params.externalRef || params.external_ref}`);
  }

  lines.push(`Signed-Off-By: VibeSync Engine <engine@local>`);

  return lines.join('\n');
}

// Alias for formatCommitTrailers
export const formatSettlementCommitMessage = formatCommitTrailers;

/**
 * Attaches structured Git Notes to a commit object via refs/notes/vibesync.
 * Uses stdin input piping (-F -) to eliminate shell quote escaping vulnerabilities.
 * 
 * @param {string} commitSha 
 * @param {object|string} payload 
 * @param {object|string} [optionsOrRepoRoot=process.cwd()] 
 * @param {string} [maybeRef] 
 */
export function appendGitNote(commitSha, payload, optionsOrRepoRoot = process.cwd(), maybeRef) {
  let repoRoot = process.cwd();
  let ref = GIT_NOTES_REF;

  if (typeof optionsOrRepoRoot === 'object' && optionsOrRepoRoot !== null) {
    repoRoot = optionsOrRepoRoot.repoRoot || process.cwd();
    ref = optionsOrRepoRoot.ref || GIT_NOTES_REF;
  } else if (typeof optionsOrRepoRoot === 'string') {
    repoRoot = optionsOrRepoRoot;
    if (maybeRef) ref = maybeRef;
  }

  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);

  execGitWithBackoff(['notes', `--ref=${ref}`, 'add', '-f', '-F', '-', commitSha], {
    cwd: repoRoot,
    input: serialized
  });
}

/**
 * Reads Git Notes attached to a commit object.
 * 
 * @param {string} commitSha 
 * @param {object|string} [optionsOrRepoRoot=process.cwd()] 
 * @param {string} [maybeRef] 
 * @returns {object|string|null} Parsed JSON payload, raw text, or null
 */
export function getGitNote(commitSha, optionsOrRepoRoot = process.cwd(), maybeRef) {
  let repoRoot = process.cwd();
  let ref = GIT_NOTES_REF;

  if (typeof optionsOrRepoRoot === 'object' && optionsOrRepoRoot !== null) {
    repoRoot = optionsOrRepoRoot.repoRoot || process.cwd();
    ref = optionsOrRepoRoot.ref || GIT_NOTES_REF;
  } else if (typeof optionsOrRepoRoot === 'string') {
    repoRoot = optionsOrRepoRoot;
    if (maybeRef) ref = maybeRef;
  }

  try {
    const raw = execGitWithBackoff(['notes', `--ref=${ref}`, 'show', commitSha], {
      cwd: repoRoot
    });
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

/**
 * Restores working tree and index to clean state after any settlement failure.
 * Two-tiered rollback: tries git merge --abort, falls back to git reset --merge (since squash does not set MERGE_HEAD).
 * 
 * @param {string} repoRoot 
 * @param {object} [stashInfo=null] 
 * @param {string} [originalBranch='main'] 
 * @param {string} [targetBranch='main'] - The branch settlement was targeting (used to determine whether a checkout-back is needed)
 */
export function rollbackSettlement(repoRoot, stashInfo = null, originalBranch = 'main', targetBranch = 'main') {
  // 1. Abort merge or reset
  try {
    execGitWithBackoff(['merge', '--abort'], { cwd: repoRoot });
  } catch {
    try {
      execGitWithBackoff(['reset', '--merge'], { cwd: repoRoot });
    } catch {}
  }

  // 2. Return to original branch if we left it for the target branch
  if (originalBranch && originalBranch !== targetBranch) {
    try {
      execGitWithBackoff(['checkout', originalBranch], { cwd: repoRoot });
    } catch {}
  }

  // 3. Pop stash if stashed
  if (stashInfo && stashInfo.didStash) {
    try {
      execGitWithBackoff(['stash', 'pop', '--index'], { cwd: repoRoot });
    } catch {
      try {
        execGitWithBackoff(['stash', 'pop'], { cwd: repoRoot });
      } catch {}
    }
  }
}

/**
 * Performs transactional squash settlement of a task branch into main.
 * 
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.actorName
 * @param {string} [params.worktreePath]
 * @param {string} [params.repoRoot=process.cwd()]
 * @param {DatabaseSync} [params.db=getDb()]
 * @param {Array<object>} [params.gateLogs=[]]
 * @param {string} [params.targetBranch='main']
 * @returns {{ success: boolean, phase: string, commit: string, settledSha: string, task: object }}
 */
export function performSquashSettlement(params) {
  const { taskId, actorName, worktreePath, repoRoot = process.cwd(), db = getDb(), gateLogs = [], targetBranch = 'main' } = params;
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  if (task.status !== 'in_progress') throw new Error(`Task ${taskId} is not in_progress (current: ${task.status}).`);
  const git = (args, extra = {}) => execGitWithBackoff(args, { cwd: repoRoot, ...extra });
  const originalTip = git(['rev-parse', 'HEAD']);
  let originalBranch;
  try { originalBranch = git(['symbolic-ref', '--short', 'HEAD']); } catch { originalBranch = originalTip; }
  const originalTarget = git(['rev-parse', '--verify', `refs/heads/${targetBranch}`]);

  if (worktreePath) {
    if (!fs.existsSync(worktreePath)) throw new Error('Task workspace is missing.');
    const branch = execGitWithBackoff(['symbolic-ref', '--short', 'HEAD'], { cwd: worktreePath });
    if (branch !== task.branch_name) throw new Error('Task workspace branch does not match the task.');
    execGitWithBackoff(['add', '-A'], { cwd: worktreePath });
    execGitWithBackoff(['commit', '--allow-empty', '-F', '-'], { cwd: worktreePath, input: `feat(${task.id}): verified implementation` });
  }
  const mergeSim = simulateMergeTree(targetBranch, task.branch_name, repoRoot);
  if (!mergeSim.clean) throw Object.assign(new Error(mergeSim.error || 'Merge conflict detected against trunk.'), { phase: 'MERGE_COLLISION', conflictFiles: mergeSim.conflictFiles });

  const base = git(['merge-base', targetBranch, task.branch_name]);
  const changedFiles = git(['diff', '--no-renames', '--name-only', '-z', base, task.branch_name, '--'], { raw: true }).split('\0').filter(Boolean);
  const secretFindings = scanSecretEntries(changedFiles.map(file => {
    try { return { file, content: git(['show', `${task.branch_name}:${file}`], { raw: true }) }; }
    catch { return { file, content: '' }; }
  }));
  if (secretFindings.length) {
    throw Object.assign(new Error(`Potential secrets detected in task changes: ${secretFindings.map(item => `${item.file} (${item.code})`).join(', ')}.`),
      { phase: 'SECRET_DETECTED', findings: secretFindings });
  }
  ensureRuntimeExcludes(repoRoot);
  const status = git(['status', '--porcelain=v1', '-z', '-uall'], { raw: true });
  const records = status.split('\0').filter(Boolean);
  const dirtyFiles = [];
  for (let i = 0; i < records.length; i++) {
    const entry = records[i];
    dirtyFiles.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && records[i + 1]) dirtyFiles.push(records[++i]);
  }
  const overlap = dirtyFiles.filter(file => changedFiles.some(changed => changed === file || changed.startsWith(file + '/') || file.startsWith(changed + '/')));
  if (overlap.length) throw Object.assign(new Error(`Cannot settle task ${taskId}: Working tree contains uncommitted edits overlapping with task changes: ${overlap.join(', ')}. Please stash or commit them before settlement.`), { phase: 'WORKING_TREE_CONFLICT' });

  let stashSha = null;
  if (status) {
    git(['stash', 'push', '-u', '-m', `vibesync-settle-${taskId}`]);
    stashSha = git(['rev-parse', 'refs/stash']);
    if (git(['status', '--porcelain=v1', '-uall'])) throw new Error(`Workspace could not be safely stashed. Work is preserved in stash ${stashSha}.`);
  }
  let settledSha = null;
  let committedState = false;
  let enteredTarget = originalBranch === targetBranch;
  const warnings = [];
  const restoreDeveloper = () => {
    if (originalBranch !== targetBranch) git(['checkout', originalBranch]);
    if (stashSha) {
      git(['stash', 'apply', '--index', stashSha]);
      // Drop only our own stash, and only if it still occupies the top slot.
      if (git(['rev-parse', 'refs/stash']) === stashSha) git(['stash', 'drop', 'stash@{0}']);
      stashSha = null;
    }
  };
  try {
    if (originalBranch !== targetBranch) git(['checkout', targetBranch]);
    enteredTarget = true;
    git(['merge', '--squash', task.branch_name]);
    const message = formatCommitTrailers({ title: task.title, taskId: task.id, featureId: task.feature_id,
      actorName: actorName || task.assigned_actor || 'unknown-actor', baseCommit: task.base_commit || originalTarget,
      priority: task.priority, labels: task.labels, externalRef: task.external_ref, gates: gateLogs.length ? gateLogs : task.required_gates });
    git(['commit', '--allow-empty', '-F', '-'], { input: message });
    settledSha = git(['rev-parse', 'HEAD']);
    appendGitNote(settledSha, { task: task.id, taskId: task.id, featureId: task.feature_id,
      actor: actorName || task.assigned_actor, actorName: actorName || task.assigned_actor,
      priority: task.priority, labels: task.labels, externalRef: task.external_ref,
      status: 'PASS', gates: gateLogs, settledAt: new Date().toISOString() }, { repoRoot });

    db.exec('BEGIN IMMEDIATE');
    try {
      const updated = db.prepare("UPDATE tasks SET status = 'settled', settled_commit = ?, consecutive_failures = 0, lease_expires_at = NULL, lease_token_hash = NULL, last_heartbeat_at = NULL, progress_fingerprint = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'in_progress'").run(settledSha, task.id);
      if (!updated.changes) throw new Error('Task state changed during settlement.');
      recordSettlementEvent(db, { task_id: task.id, feature_id: task.feature_id,
        actor: actorName || task.assigned_actor || 'system', action: 'task_settled', commit_ref: settledSha,
        evidence_payload: { settledSha, gates: gateLogs, branch: task.branch_name } });
      db.exec('COMMIT');
      committedState = true;
    } catch (err) { try { db.exec('ROLLBACK'); } catch {} throw err; }
    try { checkpointState(db); } catch (err) { warnings.push(`Settlement is recorded locally but its Git checkpoint failed: ${err.message}`); }
    try { restoreDeveloper(); } catch (err) { warnings.push(`Developer work restoration needs attention. Your stash is preserved as ${stashSha || 'the existing Git stash'}: ${err.message}`); }
    if (worktreePath) {
      try {
        execGitWithBackoff(['checkout', '--detach'], { cwd: worktreePath });
        const anchor = path.join(worktreePath, '.vibesync_ACTIVE_TASK.md');
        if (fs.existsSync(anchor)) fs.unlinkSync(anchor);
        try { execGitWithBackoff(['config', '--worktree', '--unset', 'core.hooksPath'], { cwd: worktreePath }); } catch {}
        const hooks = path.join(worktreePath, '.vibesync', 'hooks');
        if (fs.existsSync(hooks)) fs.rmSync(hooks, { recursive: true, force: true });
      } catch (err) { warnings.push(`Task workspace cleanup: ${err.message}`); }
    }
    try { git(['branch', '-D', '--', task.branch_name]); } catch (err) { warnings.push(`Task branch retained: ${err.message}`); }

    const insights = params.discoveredInsights || params.discovered_insights;
    const parkedInsights = [];
    if (Array.isArray(insights) && insights.length > 0) {
      for (const ins of insights) {
        if (!ins || !ins.title) continue;
        try {
          const res = parkInsight({
            title: ins.title,
            category: ins.category || 'architecture_insight',
            targetScope: ins.target_scope || ins.targetScope,
            contextNotes: ins.context_notes || ins.contextNotes || '',
            actorName: actorName || task.assigned_actor || 'system'
          }, db, repoRoot);
          parkedInsights.push(res);
        } catch (e) {
          warnings.push(`Failed to park discovered insight "${ins.title}": ${e.message}`);
        }
      }
    }

    return { success: true, phase: 'SETTLED', commit: settledSha, settledSha, task: getTask(task.id, db), parkedInsights, warnings };
  } catch (err) {
    // Roll back only our own unpublished settlement, never a successfully recorded task.
    if (!committedState) {
      try {
        const currentTarget = git(['rev-parse', `refs/heads/${targetBranch}`]);
        if (currentTarget !== originalTarget && currentTarget !== settledSha) throw new Error('Trunk moved concurrently; automatic rollback stopped.');
        if (enteredTarget) {
          const branch = git(['symbolic-ref', '--short', 'HEAD']);
          if (branch !== targetBranch) throw new Error('Checkout changed concurrently; automatic rollback stopped.');
          git(['reset', '--merge', originalTarget]);
        }
        if (settledSha) {
          try { git(['notes', `--ref=${GIT_NOTES_REF}`, 'remove', settledSha]); } catch {}
        }
        restoreDeveloper();
      } catch (rollbackError) {
        err.message += ` Rollback needs attention: ${rollbackError.message}. Preserved stash: ${stashSha || 'none'}.`;
      }
    }
    throw err;
  }
}

/**
 * Unified judicial pipeline coordinating Stages A -> B -> C -> D -> E:
 * - Stage A: Path Whitelist Guard (guard.mjs)
 * - Stage B: Shift-Left Gate Execution (gatekeeper.mjs)
 * - Stage C: In-Memory Conflict Detection (merge.mjs)
 * - Stage D: Transactional Squash Settlement & Provenance (settle.mjs)
 * - Stage E: Rollback Handling on Error
 * 
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.actorName
 * @param {string} [params.worktreePath]
 * @param {string} [params.repoRoot=process.cwd()]
 * @param {DatabaseSync} [params.db]
 * @returns {Promise<object>|object}
 */
export function verifyAndSettleTask(params, maybeDb, maybeRepoRoot) {
  const taskId = params.taskId;
  const actorName = params.actorName || 'unknown';
  const worktreePath = params.worktreePath || null;
  const repoRoot = params.repoRoot || maybeRepoRoot || process.cwd();
  const db = params.db || maybeDb || getDb();

  const targetBranch = params.targetBranch || getTrunk(repoRoot);
  const task = getTask(taskId, db);
  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }

  if (task.status === 'settled') {
    throw new Error(`Task ${taskId} is already settled.`);
  }

  if (task.status !== 'in_progress') {
    throw new Error(`Task ${taskId} is not in_progress (status: ${task.status}).`);
  }
  if (task.assigned_actor && task.assigned_actor !== actorName) {
    throw Object.assign(new Error(`Task ${taskId} is leased to ${task.assigned_actor}, not ${actorName}.`), { phase: 'LEASE_OWNER_MISMATCH' });
  }
  const lease = db.prepare("SELECT datetime(lease_expires_at) <= datetime('now') AS expired FROM tasks WHERE id = ?").get(taskId);
  if (lease?.expired) throw Object.assign(new Error(`Task ${taskId} lease expired before verification.`), { phase: 'LEASE_EXPIRED' });

  if (worktreePath && !fs.existsSync(worktreePath)) throw new Error('Task workspace is missing. Restore it before verification.');
  const effectiveCwd = worktreePath || repoRoot;
  if (worktreePath) {
    const branch = execGitWithBackoff(['symbolic-ref', '--short', 'HEAD'], { cwd: effectiveCwd });
    if (branch !== task.branch_name) throw new Error('Task workspace is on a different branch. Verification stopped.');
  }

  // ==========================================================================
  // STAGE A: Path Whitelist Guard
  // ==========================================================================
  const scopeCheck = checkScopeBoundary(effectiveCwd, task.allowed_paths, {
    baseCommit: task.base_commit,
    taskBranch: task.branch_name,
    repoRoot
  });

  if (!scopeCheck.valid) {
    const failInfo = recordGateFailure(db, task, scopeCheck.error, {
      actorName,
      repoRoot
    });

    return {
      success: false,
      phase: 'SCOPE_VIOLATION',
      error: scopeCheck.error,
      violations: scopeCheck.violations,
      status: failInfo.status,
      consecutiveFailures: failInfo.consecutiveFailures,
      consecutive_failures: failInfo.consecutive_failures,
      is_blocked: failInfo.is_blocked,
      artifactHash: failInfo.artifactHash
    };
  }

  // ==========================================================================
  // STAGE B: Shift-Left Subprocess Quality Gates
  // ==========================================================================
  const gates = task.required_gates || [];
  const gatesRes = executeGates(gates, {
    cwd: effectiveCwd,
    timeoutMs: params.timeoutMs,
    timeout: params.timeout,
    env: params.env,
    maxBuffer: params.maxBuffer,
    db,
    taskId: task.id,
    actorName,
    repoRoot,
    phase: 'gate'
  });

  if (!gatesRes.success) {
    if (gatesRes.failedGate?.code === 'APPROVAL_REQUIRED') {
      return { success: false, phase: 'APPROVAL_REQUIRED', error: gatesRes.failedGate.error,
        failedGate: gatesRes.failedGate, gatesRun: gatesRes.gatesRun };
    }
    const errorDetails = [
      `Gate Failed: ${gatesRes.failedGate.cmd}`,
      `Exit Code: ${gatesRes.failedGate.exitCode}`,
      gatesRes.failedGate.stdout ? `\n--- STDOUT ---\n${gatesRes.failedGate.stdout}` : '',
      gatesRes.failedGate.stderr ? `\n--- STDERR ---\n${gatesRes.failedGate.stderr}` : '',
      gatesRes.failedGate.error ? `\n--- ERROR ---\n${gatesRes.failedGate.error}` : ''
    ].join('\n');

    const failInfo = recordGateFailure(db, task, errorDetails, {
      actorName,
      repoRoot
    });

    return {
      success: false,
      phase: 'GATE_FAILURE',
      error: errorDetails,
      failedGate: gatesRes.failedGate,
      gatesRun: gatesRes.gatesRun,
      status: failInfo.status,
      consecutiveFailures: failInfo.consecutiveFailures,
      consecutive_failures: failInfo.consecutive_failures,
      is_blocked: failInfo.is_blocked,
      artifactHash: failInfo.artifactHash
    };
  }

  // Gates may generate files. Recheck their final scope before committing anything.
  const finalScope = checkScopeBoundary(effectiveCwd, task.allowed_paths, {
    baseCommit: task.base_commit, taskBranch: task.branch_name, repoRoot
  });
  if (!finalScope.valid) {
    const failure = recordGateFailure(db, task, finalScope.error, { actorName, repoRoot });
    return { success: false, phase: 'SCOPE_VIOLATION', error: finalScope.error, violations: finalScope.violations, artifactHash: failure.artifactHash };
  }

  // ==========================================================================
  // STAGE C: In-Memory Conflict Preflight
  // ==========================================================================
  let mergeSim;
  try {
    mergeSim = simulateMergeTree(targetBranch, task.branch_name, repoRoot);
  } catch (err) {
    const failInfo = recordGateFailure(db, task, `Merge preflight error: ${err.message}`, {
      actorName,
      repoRoot
    });
    return {
      success: false,
      phase: 'PREFLIGHT_ERROR',
      error: err.message,
      conflictFiles: [],
      status: failInfo.status,
      consecutiveFailures: failInfo.consecutiveFailures,
      consecutive_failures: failInfo.consecutive_failures,
      is_blocked: failInfo.is_blocked,
      artifactHash: failInfo.artifactHash
    };
  }

  if (!mergeSim.clean) {
    const failInfo = recordGateFailure(db, task, mergeSim.error, {
      actorName,
      repoRoot
    });

    return {
      success: false,
      phase: 'MERGE_COLLISION',
      error: mergeSim.error,
      conflictFiles: mergeSim.conflictFiles,
      status: failInfo.status,
      consecutiveFailures: failInfo.consecutiveFailures,
      consecutive_failures: failInfo.consecutive_failures,
      is_blocked: failInfo.is_blocked,
      artifactHash: failInfo.artifactHash
    };
  }

  // ==========================================================================
  // STAGE D: Transactional Squash Settlement & Provenance
  // ==========================================================================
  try {
    const settleResult = performSquashSettlement({
      taskId: task.id,
      actorName,
      worktreePath,
      repoRoot,
      db,
      gateLogs: gatesRes.gatesRun,
      targetBranch,
      discoveredInsights: params.discoveredInsights || params.discovered_insights
    });

    // Reset failure counter only upon complete successful settlement
    resetGateFailures(db, task.id, {
      actorName,
      repoRoot,
      gatesRun: gatesRes.gatesRun,
      commitRef: settleResult.settledSha
    });

    return {
      success: true,
      phase: 'SETTLED',
      commit: settleResult.settledSha,
      commitSha: settleResult.settledSha,
      settledSha: settleResult.settledSha,
      gateResults: gatesRes.gatesRun,
      warnings: settleResult.warnings || [],
      parkedInsights: settleResult.parkedInsights || [],
      task: settleResult.task
    };
  } catch (err) {
    // Record the settlement infrastructure failure so the strike counter advances
    // and the audit ledger has a trace. Stage D errors (stash, commit, git failures)
    // would otherwise leave the task stuck in_progress with no forensic evidence.
    let failInfo = null;
    try {
      failInfo = recordGateFailure(db, task, `Settlement infrastructure error: ${err.message}`, {
        actorName,
        repoRoot
      });
    } catch {}
    return {
      success: false,
      phase: err.phase || 'ROLLBACK',
      error: err.message,
      ...(failInfo && {
        status: failInfo.status,
        consecutiveFailures: failInfo.consecutiveFailures,
        consecutive_failures: failInfo.consecutive_failures,
        is_blocked: failInfo.is_blocked,
        artifactHash: failInfo.artifactHash
      })
    };
  }
}
