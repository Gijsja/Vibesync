/**
 * src/gatekeeper.mjs
 * 
 * VibeSync Shift-Left Gatekeeper & 3-Strike Circuit Breaker
 * Milestone 2: Git Judicial Harness (Features 16–19)
 */

import { getDb, recordSettlementEvent, saveArtifact } from './db.mjs';
import { getTask } from './tasks.mjs';
import { checkScopeBoundary, captureWorkspaceState, validateWorkspaceWriteDelta } from './guard.mjs';
import { execGitWithBackoff } from './incubator.mjs';
import { MAX_FAILURES } from './config.mjs';
import { runCommand } from './commands.mjs';
import { randomUUID } from 'node:crypto';
import { resolveCommandSpec, requireCommandApproval, identifyModelProfile, getExecutionPolicy, prepareSandboxedCommand } from './policy.mjs';
import { acquireGateSlot, releaseGateSlot } from './scheduler.mjs';

/**
 * Resolves current Git HEAD commit SHA safely.
 * 
 * @param {string} [repoRoot=process.cwd()]
 * @returns {string}
 */
export function getGitHead(repoRoot = process.cwd()) {
  try {
    return execGitWithBackoff(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  } catch {
    return '0000000';
  }
}

/**
 * Executes a single gate command within a target directory via isolated subprocess.
 * Asserts real OS exit code 0.
 * 
 * @param {string} cmd - Shell command string (e.g. "npm test")
 * @param {string|object} [cwdOrOptions=process.cwd()] - Working directory or options object
 * @param {object} [options={}] - Additional options (timeout, env, maxBuffer)
 * @returns {{ success: boolean, cmd: string, exitCode: number, stdout: string, stderr: string, error?: string }}
 */
export function runGateCommand(cmd, cwdOrOptions = process.cwd(), options = {}) {
  let cwd = process.cwd();
  let opts = {};

  if (typeof cwdOrOptions === 'object' && cwdOrOptions !== null) {
    opts = cwdOrOptions;
    cwd = opts.cwd || process.cwd();
  } else {
    cwd = cwdOrOptions || process.cwd();
    opts = options || {};
  }

  const timeout = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : (typeof opts.timeout === 'number' ? opts.timeout : 300000);
  const maxBuffer = opts.maxBuffer || 10 * 1024 * 1024;
  const env = opts.env || {};

  return runCommand(cmd, { cwd, timeoutMs: timeout, maxBuffer, env,
    redactLogs: opts.redactLogs, inheritSensitiveEnv: opts.inheritSensitiveEnv });
}

// Aliases for runGateCommand
export const executeGateCommand = runGateCommand;
export const executeGate = runGateCommand;

/**
 * Sequentially executes an array of required gate commands with fail-fast (shift-left) behavior.
 * Halts immediately upon first non-zero exit code.
 * 
 * @param {string[]|string} gates - Array of shell commands or JSON string
 * @param {string|object} [cwdOrOptions=process.cwd()]
 * @param {object} [maybeOptions={}]
 * @returns {{ success: boolean, pass: boolean, gatesRun: Array<{ cmd: string, exitCode: number, status: string }>, failedGate?: object, errorPayload?: object }}
 */
export function executeGates(gates, cwdOrOptions = process.cwd(), maybeOptions = {}) {
  let cwd = process.cwd();
  let opts = {};

  if (typeof cwdOrOptions === 'object' && cwdOrOptions !== null) {
    opts = cwdOrOptions;
    cwd = opts.cwd || process.cwd();
  } else {
    cwd = cwdOrOptions || process.cwd();
    opts = maybeOptions || {};
  }

  let gatesList = gates;
  if (typeof gatesList === 'string') {
    try {
      gatesList = JSON.parse(gatesList);
    } catch {
      gatesList = [gatesList];
    }
  }
  if (!Array.isArray(gatesList)) {
    gatesList = [];
  }

  const gatesRun = [];
  const phase = opts.phase || 'gate';
  const policy = getExecutionPolicy(opts.repoRoot || cwd);
  let slot = null;
  if (opts.db && gatesList.length) {
    slot = acquireGateSlot(opts.db, opts.actorName || 'unknown', opts.taskId || null, phase, policy.resource_policy);
    if (!slot.acquired) {
      const failedGate = { cmd: null, argv: [], exitCode: null, summary: slot.reason, error: slot.reason, code: 'GATE_CAPACITY' };
      return { success: false, pass: false, gatesRun, failedGate, queuePosition: slot.queuePosition,
        activeLimits: slot.activeLimits, retryAfterMs: policy.resource_policy.retry_after_ms,
        errorPayload: { code: 'GATE_CAPACITY', failure: slot.reason } };
    }
  }

  try {
  for (let gateIndex = 0; gateIndex < gatesList.length; gateIndex++) {
    const gate = gatesList[gateIndex];
    let spec;
    let approval;
    try {
      spec = resolveCommandSpec(gate, { cwd, phase: phase === 'partial' ? 'gate' : phase, policyVersion: policy.version });
      if (phase === 'partial' && (spec.legacy || spec.idempotency !== 'safe')) {
        throw Object.assign(new Error('Partial verification requires structured commands declared idempotency: safe.'), { code: 'PARTIAL_GATE_UNSAFE' });
      }
      approval = opts.db ? requireCommandApproval(spec, opts.db, opts.repoRoot || cwd) : { approved: false, runnable: true, mode: 'untracked', warning: null };
    } catch (error) {
      const failedGate = { cmd: typeof gate === 'string' ? gate : JSON.stringify(gate), argv: [], exitCode: 1, summary: error.message, error: error.message, code: error.code, policyHash: error.policyHash };
      return { success: false, pass: false, gatesRun, failedGate, errorPayload: { cmd: failedGate.cmd, exitCode: 1, failure: error.message, error: error.message, code: error.code } };
    }
    let sandbox;
    try { sandbox = prepareSandboxedCommand(spec, cwd, opts.repoRoot || cwd, opts.allowedPaths || ['*'], { actorName: opts.actorName || 'unknown' }); }
    catch (error) {
      const failedGate = { cmd: spec.display, argv: spec.argv, exitCode: 1, summary: error.message, error: error.message, code: error.code, policyHash: spec.policyHash };
      return { success: false, pass: false, gatesRun, failedGate, errorPayload: { cmd: failedGate.cmd, exitCode: 1, failure: error.message, error: error.message, code: error.code } };
    }
    let beforeState;
    try { beforeState = captureWorkspaceState(cwd); }
    catch (error) {
      const failedGate = { cmd: spec.display, argv: spec.argv, exitCode: 1, summary: error.message, error: error.message, code: 'WRITE_SCOPE_SNAPSHOT_FAILED', policyHash: spec.policyHash };
      return { success: false, pass: false, gatesRun, failedGate, errorPayload: { cmd: failedGate.cmd, exitCode: 1, failure: error.message, error: error.message, code: failedGate.code } };
    }
    const started = Date.now();
    const modelProfile = identifyModelProfile(opts.actorName);
    const profileMaxBuffer = modelProfile.resourceClass === 'constrained' ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
    const requestedTimeout = spec.timeout_ms || opts.timeoutMs || opts.timeout || policy.resource_policy.timeout_ceiling_ms;
    const timeoutMs = Math.min(requestedTimeout, policy.resource_policy.timeout_ceiling_ms);
    const maxBuffer = Math.min(opts.maxBuffer || profileMaxBuffer, profileMaxBuffer, policy.resource_policy.output_limit_bytes);
    const res = runGateCommand(sandbox.argv, cwd, { ...opts, maxBuffer, timeoutMs,
      redactLogs: policy.redact_logs !== false });
    const durationMs = Date.now() - started;
    let writeScope;
    try {
      writeScope = validateWorkspaceWriteDelta(beforeState, captureWorkspaceState(cwd), opts.allowedPaths || ['*'], spec.write_paths);
    } catch (error) {
      writeScope = { valid: false, writes: [], violations: [], error: `Unable to verify gate write scope: ${error.message}` };
    }
    if (!writeScope.valid) {
      res.success = false;
      res.exitCode = res.exitCode || 1;
      res.error = writeScope.error;
      res.summary = writeScope.error;
      res.code = 'WRITE_SCOPE_VIOLATION';
      res.writeScope = writeScope;
    }
    let artifactHash = null;
    if (opts.db && opts.taskId) {
      const leaseRunId = opts.db.prepare('SELECT lease_run_id FROM tasks WHERE id = ?').get(opts.taskId)?.lease_run_id || null;
      const runEvidence = JSON.stringify({ sandbox: sandbox.sandbox, approval: approval.approved ? 'approved' : approval.mode,
        writes: writeScope.writes, declared_write_paths: writeScope.declaredWritePaths, diagnostics: res.diagnostics });
      if (!res.success) artifactHash = saveArtifact(JSON.stringify({ stdout: res.stdout, stderr: res.stderr, diagnostics: res.diagnostics, writeScope }, null, 2), opts.repoRoot || cwd);
      opts.db.prepare(`INSERT INTO gate_runs (id, task_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, summary, artifact_hash, lease_run_id, evidence_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), opts.taskId, phase, gateIndex, spec.policyHash, opts.actorName || 'unknown', modelProfile.id,
          res.success ? 'passed' : 'failed', res.exitCode, durationMs, res.summary || null, artifactHash, leaseRunId, runEvidence);
      if (spec.idempotency === 'unsafe' && approval.approved) {
        opts.db.prepare('UPDATE gate_approvals SET revoked_at = CURRENT_TIMESTAMP WHERE policy_hash = ?').run(spec.policyHash);
      }
    }
    if (!res.success) {
      const failedGate = { cmd: res.cmd, argv: res.argv, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr,
        summary: res.summary, diagnostics: res.diagnostics, error: res.error, code: res.code, writeScope: res.writeScope, policyHash: spec.policyHash, artifactHash };
      return {
        success: false,
        pass: false,
        gatesRun,
        failedGate,
        errorPayload: {
          cmd: res.cmd,
          exitCode: res.exitCode,
          failure: res.summary,
          error: res.error
        }
      };
    }
    gatesRun.push({ cmd: gate, argv: spec.argv, policyHash: spec.policyHash, approval: approval.approved ? 'approved' : approval.mode,
      sandbox: sandbox.sandbox, warning: approval.warning || sandbox.warning, exitCode: 0, status: 'PASS', durationMs,
      writes: writeScope.writes, declaredWritePaths: writeScope.declaredWritePaths, diagnostics: res.diagnostics, stdout: res.stdout, stderr: res.stderr });
  }

  return {
    success: true,
    pass: true,
    gatesRun,
    activeLimits: slot?.activeLimits || null
  };
  } finally {
    if (slot?.slotId) releaseGateSlot(opts.db, slot.slotId);
  }
}

// Aliases for executeGates
export const executeAllGates = executeGates;

/** Run a safe subset of a task's declared gates without settling or changing ownership. */
export function executePartialVerification({ taskId, actorName, indices = null, repoRoot = process.cwd() }, db = getDb()) {
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  if (task.status !== 'in_progress' || task.assigned_actor !== actorName) {
    throw Object.assign(new Error(`Task ${taskId} is not actively leased to ${actorName}.`), { code: 'LEASE_OWNER_MISMATCH' });
  }
  const lease = db.prepare("SELECT datetime(lease_expires_at) <= datetime('now') AS expired FROM tasks WHERE id = ?").get(taskId);
  if (lease?.expired) throw Object.assign(new Error(`Task ${taskId} lease expired.`), { code: 'LEASE_EXPIRED' });
  const allGates = task.required_gates || [];
  const selectedIndices = indices === null ? allGates.map((_, index) => index) : indices;
  if (!Array.isArray(selectedIndices) || selectedIndices.some(index => !Number.isInteger(index) || index < 0 || index >= allGates.length)) {
    throw new Error('indices must identify existing task gates.');
  }
  const gates = selectedIndices.map(index => allGates[index]);
  const result = executeGates(gates, { cwd: task.worktree_path || repoRoot, db, taskId, actorName, repoRoot,
    allowedPaths: task.allowed_paths, phase: 'partial' });
  return { ...result, phase: result.success ? 'PARTIAL_GATES_PASSED' : (result.failedGate?.code || 'PARTIAL_GATE_FAILURE'),
    taskId, indices: selectedIndices, ownershipChanged: false, settled: false };
}

/**
 * Records a gate, scope, or collision failure: updates failure counters,
 * evaluates the 3-strike circuit breaker, offloads logs, and records settlement events.
 * 
 * @param {DatabaseSync} db - SQLite database handle
 * @param {string|object} taskIdOrTask - Task ID or task record
 * @param {string|object} errorDetails - Failure trace or structured log
 * @param {object} [options={}]
 * @param {string} [options.actorName='unknown']
 * @param {string} [options.repoRoot=process.cwd()]
 * @param {string} [options.commitRef]
 * @returns {{ success: false, status: string, consecutive_failures: number, consecutiveFailures: number, is_blocked: boolean, isTripped: boolean, artifactHash: string, error: string }}
 */
export function recordGateFailure(db, taskIdOrTask, errorDetails, options = {}) {
  const {
    actorName = 'unknown',
    repoRoot = process.cwd(),
    commitRef = null
  } = options;

  let taskId;
  let task;

  if (typeof taskIdOrTask === 'object' && taskIdOrTask !== null) {
    taskId = taskIdOrTask.id;
    task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || taskIdOrTask;
  } else {
    taskId = taskIdOrTask;
    task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  }

  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }

  const maxFailures = task.max_failures || MAX_FAILURES;
  const failures = (task.consecutive_failures || 0) + 1;
  const isBlocked = failures >= maxFailures;
  const nextStatus = isBlocked ? 'blocked' : (task.status === 'blocked' ? 'blocked' : 'in_progress');

  // Format error payload and offload to artifacts
  const payloadText = typeof errorDetails === 'string'
    ? errorDetails
    : JSON.stringify(errorDetails, null, 2);

  const artifactHash = saveArtifact(payloadText, repoRoot);
  const headSha = commitRef || getGitHead(repoRoot);

  // Update task in database
  db.prepare(`
    UPDATE tasks
    SET status = ?,
        consecutive_failures = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextStatus, failures, taskId);

  // Record audit ledger event
  recordSettlementEvent(db, {
    task_id: taskId,
    feature_id: task.feature_id,
    actor: actorName || task.assigned_actor || 'unknown',
    action: isBlocked ? 'circuit_breaker_tripped' : 'gate_failed',
    commit_ref: headSha,
    artifact_hash: artifactHash,
    evidence_payload: {
      failures,
      max_failures: maxFailures,
      is_blocked: isBlocked,
      error_summary: payloadText.slice(0, 500)
    }
  });

  return {
    success: false,
    status: nextStatus,
    consecutive_failures: failures,
    consecutiveFailures: failures,
    is_blocked: isBlocked,
    isTripped: isBlocked,
    artifactHash,
    error: payloadText
  };
}

// Alias for recordGateFailure
export const handleGateFailure = recordGateFailure;

/**
 * Resets gate failure counter upon successful verification.
 * 
 * @param {DatabaseSync} db
 * @param {string} taskId
 * @param {object} [options={}]
 * @param {string} [options.actorName]
 * @param {string} [options.commitRef]
 * @param {string} [options.repoRoot=process.cwd()]
 * @param {Array<object>} [options.gatesRun=[]]
 */
export function resetGateFailures(db, taskId, options = {}) {
  const {
    actorName = null,
    commitRef = null,
    repoRoot = process.cwd(),
    gatesRun = []
  } = options;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;

  db.prepare(`
    UPDATE tasks
    SET consecutive_failures = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(taskId);

  const headSha = commitRef || getGitHead(repoRoot);

  recordSettlementEvent(db, {
    task_id: taskId,
    feature_id: task.feature_id,
    actor: actorName || task.assigned_actor || 'system',
    action: 'gate_passed',
    commit_ref: headSha,
    artifact_hash: gatesRun.length ? saveArtifact(JSON.stringify(gatesRun, null, 2), repoRoot) : null,
    evidence_payload: {
      gates_run: gatesRun
    }
  });
}

/**
 * High-level gate execution wrapper for tasks: runs required gates and tracks failures/resets in DB.
 * 
 * Supports signatures:
 * - executeRequiredGates(taskId, gates, cwd, options)
 * - executeRequiredGates(gates, cwd, options)
 * 
 * @param {string|Array<string>} taskIdOrGates
 * @param {Array<string>|string} [gatesOrCwd]
 * @param {string|object} [cwdOrOptions]
 * @param {object} [maybeOptions={}]
 * @returns {{ success: boolean, pass: boolean, gatesRun: any[], failedGate?: any, error?: string, status?: string, consecutiveFailures?: number, artifactHash?: string }}
 */
export function executeRequiredGates(taskIdOrGates, gatesOrCwd, cwdOrOptions, maybeOptions = {}) {
  let taskId = null;
  let gates = [];
  let cwd = process.cwd();
  let options = {};

  if (typeof taskIdOrGates === 'string' && (taskIdOrGates.startsWith('TASK-') || !Array.isArray(gatesOrCwd))) {
    taskId = taskIdOrGates;
    gates = gatesOrCwd;
    if (typeof cwdOrOptions === 'object' && cwdOrOptions !== null) {
      options = cwdOrOptions;
      cwd = options.cwd || process.cwd();
    } else {
      cwd = cwdOrOptions || process.cwd();
      options = maybeOptions || {};
    }
  } else {
    gates = taskIdOrGates;
    if (typeof gatesOrCwd === 'object' && gatesOrCwd !== null) {
      options = gatesOrCwd;
      cwd = options.cwd || process.cwd();
    } else {
      cwd = gatesOrCwd || process.cwd();
      options = cwdOrOptions || {};
    }
  }

  const db = options.db || getDb();
  const repoRoot = options.repoRoot || process.cwd();
  const actorName = options.actorName || 'unknown';

  const res = executeGates(gates, cwd, options);

  if (!res.success) {
    const errorDetails = [
      `Gate Failed: ${res.failedGate.cmd}`,
      `Exit Code: ${res.failedGate.exitCode}`,
      res.failedGate.stdout ? `\n--- STDOUT ---\n${res.failedGate.stdout}` : '',
      res.failedGate.stderr ? `\n--- STDERR ---\n${res.failedGate.stderr}` : '',
      res.failedGate.error ? `\n--- ERROR ---\n${res.failedGate.error}` : ''
    ].join('\n');

    let failInfo = null;
    if (taskId) {
      failInfo = recordGateFailure(db, taskId, errorDetails, {
        actorName,
        repoRoot
      });
    }

    return {
      success: false,
      pass: false,
      phase: res.failedGate?.code === 'WRITE_SCOPE_VIOLATION' ? 'WRITE_SCOPE_VIOLATION' : 'GATE_FAILURE',
      failedGate: res.failedGate,
      gatesRun: res.gatesRun,
      error: errorDetails,
      status: failInfo?.status,
      consecutive_failures: failInfo?.consecutive_failures,
      consecutiveFailures: failInfo?.consecutiveFailures,
      is_blocked: failInfo?.is_blocked,
      artifactHash: failInfo?.artifactHash
    };
  }

  if (taskId) {
    resetGateFailures(db, taskId, {
      actorName,
      repoRoot,
      gatesRun: res.gatesRun
    });
  }

  return {
    success: true,
    pass: true,
    phase: 'GATES_PASSED',
    gatesRun: res.gatesRun
  };
}

/**
 * Orchestrates complete Gatekeeper verification: Path Guard check + Shift-Left Subprocess Gates.
 * 
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} [params.cwd]
 * @param {string} [params.repoRoot=process.cwd()]
 * @param {string} [params.actorName]
 * @param {boolean} [params.skipGuard=false]
 * @param {DatabaseSync} [db]
 * @returns {{ success: boolean, phase: string, gatesRun?: any[], error?: any, status?: string, failures?: number, consecutiveFailures?: number, artifactHash?: string, violations?: string[] }}
 */
export function executeGatekeeper(params, db = getDb()) {
  const {
    taskId,
    cwd,
    repoRoot = process.cwd(),
    actorName = 'unknown',
    skipGuard = false,
    timeoutMs,
    timeout,
    env,
    maxBuffer
  } = params;

  const task = getTask(taskId, db);
  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }

  if (task.status !== 'in_progress') {
    throw new Error(`Task ${taskId} is not in_progress (status: ${task.status}).`);
  }

  const targetDir = cwd || repoRoot;

  // 1. Path Whitelist Guard
  if (!skipGuard) {
    const scopeCheck = checkScopeBoundary(targetDir, task.allowed_paths, {
      baseCommit: task.base_commit,
      repoRoot
    });

    if (!scopeCheck.valid) {
      const failInfo = recordGateFailure(db, taskId, scopeCheck.error, {
        actorName,
        repoRoot
      });

      return {
        success: false,
        phase: 'SCOPE_VIOLATION',
        error: scopeCheck.error,
        violations: scopeCheck.violations,
        status: failInfo.status,
        failures: failInfo.consecutive_failures,
        consecutiveFailures: failInfo.consecutiveFailures,
        artifactHash: failInfo.artifactHash
      };
    }
  }

  // 2. Shift-Left Gate Execution
  const gatesResult = executeGates(task.required_gates, {
    cwd: targetDir,
    timeoutMs,
    timeout,
    env,
    maxBuffer,
    db,
    taskId,
    actorName,
    repoRoot,
    allowedPaths: task.allowed_paths,
    phase: 'gate'
  });

  if (!gatesResult.success) {
    if (gatesResult.failedGate?.code === 'APPROVAL_REQUIRED') {
      return { success: false, phase: 'APPROVAL_REQUIRED', error: gatesResult.failedGate.error,
        failedGate: gatesResult.failedGate, gatesRun: gatesResult.gatesRun };
    }
    const errorDetails = [
      `Gate Failed: ${gatesResult.failedGate.cmd}`,
      `Exit Code: ${gatesResult.failedGate.exitCode}`,
      gatesResult.failedGate.stdout ? `\n--- STDOUT ---\n${gatesResult.failedGate.stdout}` : '',
      gatesResult.failedGate.stderr ? `\n--- STDERR ---\n${gatesResult.failedGate.stderr}` : '',
      gatesResult.failedGate.error ? `\n--- ERROR ---\n${gatesResult.failedGate.error}` : ''
    ].join('\n');

    const failInfo = recordGateFailure(db, taskId, errorDetails, {
      actorName,
      repoRoot
    });

    return {
      success: false,
      phase: gatesResult.failedGate?.code === 'WRITE_SCOPE_VIOLATION' ? 'WRITE_SCOPE_VIOLATION' : 'GATE_FAILURE',
      error: errorDetails,
      violations: gatesResult.failedGate?.writeScope?.violations,
      failedGate: gatesResult.failedGate,
      status: failInfo.status,
      failures: failInfo.consecutive_failures,
      consecutiveFailures: failInfo.consecutiveFailures,
      artifactHash: failInfo.artifactHash
    };
  }

  // 3. Verification Success
  resetGateFailures(db, taskId, {
    actorName,
    repoRoot,
    gatesRun: gatesResult.gatesRun
  });

  return {
    success: true,
    phase: 'GATES_PASSED',
    gatesRun: gatesResult.gatesRun
  };
}
