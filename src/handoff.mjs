/**
 * src/handoff.mjs
 * 
 * VibeSync Human-Centered Handoff Card & AI Agent Instructions Engine
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.mjs';
import { getTask, ejectTaskToHuman, listTasks } from './tasks.mjs';
import { getFeature } from './features.mjs';
import { inspectBranchDrift, getTrunk } from './workspace.mjs';
import { execGitWithBackoff } from './incubator.mjs';

/**
 * Formats a gate specification into a readable command string.
 */
export function formatGateCommand(g) {
  if (typeof g === 'string') return g;
  if (!g || typeof g !== 'object') return String(g);
  if (g.cmd) return g.cmd;
  if (g.argv && Array.isArray(g.argv)) return g.argv.join(' ');
  if (g.script) return `npm run ${g.script}`;
  if (g.type === 'node-test') return `node --test ${(g.args || []).join(' ')}`.trim();
  if (g.type === 'npm-script') return `npm run ${g.script || ''} ${(g.args || []).join(' ')}`.trim();
  if (g.type === 'pytest') return `pytest ${(g.args || []).join(' ')}`.trim();
  if (g.type === 'make') return `make ${g.target || ''} ${(g.args || []).join(' ')}`.trim();
  return JSON.stringify(g);
}

/**
 * Returns structured, actionable operating guidelines for AI coding agents
 * participating in a VibeSync repository.
 * 
 * @returns {string}
 */
export function getAgentInstructions() {
  return `# VibeSync AI Agent Operating Instructions

VibeSync coordinates concurrent AI pair programming via isolated Git worktrees,
renewable leases, and shift-left judicial verification gates. When connected as an
autonomous agent, follow these disciplined rules of engagement:

## 1. Role & MCP Surface
- You are connected to the **Worker** MCP surface (\`vibesync_claim_task\`,
  \`vibesync_heartbeat_task\`, \`vibesync_partial_verify\`, \`vibesync_verify_and_settle\`,
  \`vibesync_park_insight\`).
- Human administrative actions (task creation, policy approval, feature settlement,
  disaster repair) are reserved for the **Admin** surface. Never attempt to impersonate
  human administrative permissions.

## 2. The 5 Constrained Rules of Engagement
1. **Claim Narrowly**:
   - Inspect available tasks with \`vibesync_list_ready_tasks\` and \`vibesync_preview_task\`.
   - Ensure the task's \`allowed_paths\`, \`required_gates\`, and model suitability match
     your capabilities before claiming.
   - Claim with \`vibesync_claim_task\` using your assigned actor name.
2. **Work Exclusively in the Managed Worktree**:
   - Never modify trunk directly or write outside the managed worktree returned by
     \`vibesync_claim_task\` (\`.vibesync/worktrees/<task-id>\`).
   - Edits must remain strictly within the task contract's \`allowed_paths\` and command \`write_paths\`.
3. **Heartbeat Regularly**:
   - Tasks carry a renewable lease (default: 45 minutes).
   - If work takes more than a few minutes, call \`vibesync_heartbeat_task\` with your private
     lease token to prevent lease expiry and automatic recovery.
4. **Evidence-Based Verification**:
   - Before attempting final settlement, use \`vibesync_partial_verify\` to run safe,
     idempotent gates for early feedback.
   - Settle work using \`vibesync_verify_and_settle\`. All declared gates must pass with real
     exit code 0.
   - Never forge or fake completion; verification is executed by real subprocesses in the worktree.
5. **Hard Security & Scope Boundaries**:
   - Gate rejections, scope violations, and circuit-breaker locks are non-negotiable
     architectural boundaries, not suggestions.
   - If 3 consecutive verification failures occur, the circuit breaker locks the task
     (\`status: 'blocked'\`). Do not attempt to loop or bypass it; stop and request human intervention.
6. **Park Off-Task Discoveries**:
   - If you encounter unrelated tech debt, architectural insights, or future ideas while
     working, do NOT expand your scope. Call \`vibesync_park_insight\` to park it in the
     incubator without polluting trunk.

## 3. Standard Operational Protocol
1. \`vibesync_preview_task({ taskId, actorName })\` -> inspect requirements, drift, and approvals
2. \`vibesync_claim_task({ taskId, actorName })\` -> provisions worktree and returns private lease token
3. Implement code edits strictly within \`worktree_path\`
4. \`vibesync_heartbeat_task({ taskId, actorName, leaseToken })\` -> renew lease during ongoing work
5. \`vibesync_partial_verify({ taskId, actorName, leaseToken })\` -> early safe gate verification
6. \`vibesync_verify_and_settle({ taskId, actorName, leaseToken, commitMessage })\` -> final squash merge into trunk

## 4. Human Handoff & Escalation
- If blocked by policy or test failures, leave clear terminal logs and uncommitted files intact.
- The human operator can inspect progress using \`vibesync --handoff\` or take over directly
  via \`vibesync --eject <task-id>\`.
`;
}

/**
 * Finds the most operationally relevant task for a human handoff.
 * 
 * Priority order:
 * 1. In-progress task (active lease)
 * 2. Blocked task (circuit breaker tripped)
 * 3. Review / verifying task
 * 4. Most recently updated task
 * 
 * @param {DatabaseSync} db 
 * @returns {object|null}
 */
export function findAttentionTask(db = getDb()) {
  const inProgress = db.prepare("SELECT id FROM tasks WHERE status = 'in_progress' ORDER BY updated_at DESC LIMIT 1").get();
  if (inProgress) return getTask(inProgress.id, db);

  const blocked = db.prepare("SELECT id FROM tasks WHERE status = 'blocked' ORDER BY updated_at DESC LIMIT 1").get();
  if (blocked) return getTask(blocked.id, db);

  const review = db.prepare("SELECT id FROM tasks WHERE status = 'review' ORDER BY updated_at DESC LIMIT 1").get();
  if (review) return getTask(review.id, db);

  const recent = db.prepare("SELECT id FROM tasks ORDER BY updated_at DESC LIMIT 1").get();
  if (recent) return getTask(recent.id, db);

  return null;
}

/**
 * Inspects what files have changed in a task worktree.
 * 
 * @param {string} worktreePath 
 * @param {string} [baseCommit] 
 * @returns {{ modified: string[], untracked: string[], diffstat: string }}
 */
export function inspectWorktreeChanges(worktreePath, baseCommit = 'HEAD') {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { modified: [], untracked: [], diffstat: 'Worktree directory not active.' };
  }

  let modified = [];
  let untracked = [];
  let diffstat = '';

  try {
    const status = execGitWithBackoff(['status', '--porcelain'], { cwd: worktreePath });
    for (const line of status.split(/\r?\n/).filter(Boolean)) {
      const code = line.slice(0, 2).trim();
      const file = line.slice(2).trim();
      if (code === '??') {
        untracked.push(file);
      } else {
        modified.push(file);
      }
    }
  } catch {}

  try {
    diffstat = execGitWithBackoff(['diff', '--stat', baseCommit || 'HEAD'], { cwd: worktreePath }).trim();
    if (!diffstat) {
      diffstat = execGitWithBackoff(['diff', '--stat'], { cwd: worktreePath }).trim() || 'No uncommitted diff detected.';
    }
  } catch {
    diffstat = 'Diff unavailable.';
  }

  return { modified, untracked, diffstat };
}

/**
 * Formats a single human handoff card for a task.
 * 
 * @param {object} options
 * @param {string} [options.taskId]
 * @param {DatabaseSync} [options.db]
 * @param {string} [options.repoRoot]
 * @param {string} [options.format='text'] - 'text' | 'json' | 'markdown'
 * @returns {string|object}
 */
export function generateHandoffCard(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const db = options.db || getDb(null, repoRoot);
  const taskId = options.taskId;

  let task = null;
  if (taskId) {
    task = getTask(taskId, db);
    if (!task) throw new Error(`Task ${taskId} not found.`);
  } else {
    task = findAttentionTask(db);
  }

  if (!task) {
    if (options.format === 'json') {
      return { status: 'empty', message: 'No tasks found in repository.' };
    }
    return [
      '================================================================================',
      'VIBESYNC HUMAN HANDOFF CARD',
      '================================================================================',
      'Status: No active or pending tasks in repository.',
      '',
      'All tasks are settled or the workspace has not registered any task units yet.',
      '  - Run "vibesync --hud" to access the control deck.',
      '  - Run "vibesync --agent-instructions" to view AI agent guidelines.',
      '================================================================================'
    ].join('\n');
  }

  const feature = task.feature_id ? getFeature(task.feature_id, db) : null;

  // 1. Determine Attention Category
  let attentionCategory = '📋 READY / FYI';
  let attentionSubtitle = 'Task is ready for claim.';
  if (task.status === 'blocked' || task.consecutive_failures >= 3) {
    attentionCategory = '⏸️ BLOCKED';
    attentionSubtitle = `Circuit breaker tripped (${task.consecutive_failures}/${task.max_failures} failures). Human intervention required.`;
  } else if (task.status === 'review' || task.status === 'verifying') {
    attentionCategory = '🔍 NEEDS REVIEW';
    attentionSubtitle = 'Verification gates passed; ready for feature settlement or final review.';
  } else if (task.status === 'in_progress') {
    attentionCategory = '⚡ IN PROGRESS';
    attentionSubtitle = `Active lease owned by actor "${task.assigned_actor || 'unknown'}".`;
  } else if (task.status === 'settled') {
    attentionCategory = '✅ SETTLED';
    attentionSubtitle = `Settled and squash-merged into trunk at ${task.settled_commit || 'HEAD'}.`;
  }

  // 2. Lease Information
  let leaseRemainingStr = 'No active lease';
  let leaseRemainingSeconds = null;
  if (task.status === 'in_progress' && task.lease_expires_at) {
    const expiresMs = new Date(task.lease_expires_at.replace(' ', 'T') + 'Z').getTime();
    leaseRemainingSeconds = Math.max(0, Math.round((expiresMs - Date.now()) / 1000));
    const remainingMin = Math.round((expiresMs - Date.now()) / (60 * 1000));
    leaseRemainingStr = remainingMin > 0 ? `${remainingMin}m remaining (Expires: ${task.lease_expires_at})` : `EXPIRED at ${task.lease_expires_at}`;
  }

  // 3. Worktree & Changes
  const branchName = task.branch_name || `task/${task.id.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const defaultWorktreePath = path.join(repoRoot, '.vibesync', 'worktrees', branchName.slice(5));
  const worktreePath = task.worktree_path || (fs.existsSync(defaultWorktreePath) ? defaultWorktreePath : null);
  const changes = inspectWorktreeChanges(worktreePath, task.base_commit);

  // 4. Branch Drift
  const drift = worktreePath ? inspectBranchDrift(worktreePath, repoRoot) : null;

  // 5. Recent Gate Runs
  const gateRuns = db.prepare(`
    SELECT phase, gate_index, status, exit_code, duration_ms, summary, started_at
    FROM gate_runs
    WHERE task_id = ?
    ORDER BY started_at DESC
    LIMIT 3
  `).all(task.id) || [];

  // 6. Action Requested
  let nextAction = '';
  if (task.status === 'blocked') {
    nextAction = `Inspect gate failure logs via "vibesync --hud" or take over the task:\n     vibesync --eject ${task.id}`;
  } else if (task.status === 'in_progress') {
    if (task.assigned_actor === 'human') {
      nextAction = `You currently own this lease. Implement inside worktree:\n     cd ${worktreePath || '.'}\n     Run "npm test" and settle via HUD when ready.`;
    } else {
      nextAction = `Agent "${task.assigned_actor}" is working. To take over immediately:\n     vibesync --eject ${task.id}`;
    }
  } else if (task.status === 'review') {
    nextAction = `Review verification artifacts and settle feature contract via HUD.`;
  } else if (task.status === 'settled') {
    nextAction = `Task complete. Check remaining sibling tasks for feature "${task.feature_id}".`;
  } else {
    nextAction = `Ready to be claimed. Start work via HUD or connected worker MCP client.`;
  }

  if (options.format === 'json') {
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      attentionCategory,
      attentionSubtitle,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        assigned_actor: task.assigned_actor,
        priority: task.priority,
        allowed_paths: task.allowed_paths,
        required_gates: task.required_gates,
        consecutive_failures: task.consecutive_failures,
        max_failures: task.max_failures
      },
      feature: feature ? { id: feature.id, title: feature.title, spec_markdown: feature.spec_markdown } : null,
      priority: task.priority,
      actor: task.assigned_actor,
      lease: { remaining: leaseRemainingStr, generation: task.lease_generation, runId: task.lease_run_id },
      leaseRemainingSeconds,
      worktreePath,
      requiredGates: task.required_gates,
      gateRuns,
      changes: {
        worktreePath,
        modifiedFiles: changes.modified,
        untrackedFiles: changes.untracked,
        diffstat: changes.diffstat,
        modified: changes.modified,
        untracked: changes.untracked
      },
      drift: drift ? { behindTrunk: drift.behind_trunk, aheadTrunk: drift.ahead_trunk, canMergeCleanly: drift.can_merge_cleanly, behind_trunk: drift.behind_trunk, warning: drift.warning } : null,
      evidence: {
        requiredGates: task.required_gates,
        recentRuns: gateRuns
      },
      risks: {
        consecutiveFailures: task.consecutive_failures,
        maxFailures: task.max_failures,
        driftWarning: drift?.warning || null
      },
      rollback: {
        branch: branchName,
        baseCommit: task.base_commit,
        worktreePath
      },
      nextAction
    };
  }

  const lines = [
    '================================================================================',
    'VIBESYNC HUMAN HANDOFF CARD',
    '================================================================================',
    `[ ${attentionCategory} ] ${task.id}: ${task.title}`,
    `Subtitle:       ${attentionSubtitle}`,
    `Feature:        ${feature ? `${feature.id} (${feature.title})` : task.feature_id || 'None'}`,
    `Priority:       ${task.priority || 'medium'} | Model Hint: ${task.model_hint || 'any'}`,
    `Assigned Actor: ${task.assigned_actor || 'unassigned'}`,
    `Status:         ${task.status}`,
    `Lease:          ${leaseRemainingStr} (Gen: ${task.lease_generation || 0}, RunId: ${task.lease_run_id ? task.lease_run_id.slice(0, 8) + '...' : 'none'})`,
    '',
    'WHAT CHANGED:',
    `  Worktree:     ${worktreePath || 'Not provisioned'}`,
    `  Modified:     ${changes.modified.length > 0 ? changes.modified.join(', ') : 'None'}`,
    `  Untracked:    ${changes.untracked.length > 0 ? changes.untracked.join(', ') : 'None'}`,
    `  Diffstat:     ${changes.diffstat.split('\n')[0] || 'No uncommitted diff'}`,
    '',
    'WHY (CONTRACT GOAL):',
    `  Task Goal:    ${task.title}`,
    `  Scope Globs:  ${Array.isArray(task.allowed_paths) ? task.allowed_paths.join(', ') : task.allowed_paths || '*'}`,
    ...(feature?.spec_markdown ? [`  Feature Spec: ${feature.spec_markdown.trim().split('\n')[0].slice(0, 100)}...`] : []),
    '',
    'EVIDENCE (GATES & VERIFICATION):',
    `  Required:     ${Array.isArray(task.required_gates) && task.required_gates.length > 0 ? task.required_gates.map(formatGateCommand).join('; ') : 'None defined'}`,
    ...(gateRuns.length > 0
      ? gateRuns.map(run => `  Gate Log:     [${run.status.toUpperCase()}] exit ${run.exit_code ?? 0} (${run.duration_ms}ms) - ${run.summary || 'gate run'}`)
      : ['  Gate Log:     No recent gate runs recorded.']),
    '',
    'RISKS & UNCERTAINTIES:',
    `  Failures:     ${task.consecutive_failures} / ${task.max_failures} strikes`,
    `  Branch Drift: ${drift ? (drift.behind_trunk === 0 ? 'Clean (0 behind trunk)' : drift.warning || 'Drift detected') : 'No worktree drift inspected'}`,
    '',
    'ROLLBACK / RECOVERY:',
    `  Branch:       ${branchName}`,
    `  Base Commit:  ${task.base_commit || 'HEAD'}`,
    `  Worktree Dir: ${worktreePath || 'N/A'}`,
    '',
    'NEXT ACTION REQUESTED:',
    `  👉 ${nextAction}`,
    '================================================================================'
  ];

  return lines.join('\n');
}

/**
 * Performs an immediate human eject and takeover of a task.
 * 
 * @param {string} taskId 
 * @param {DatabaseSync} [db] 
 * @param {string} [repoRoot] 
 * @returns {object}
 */
export function performHumanTakeover(taskId, db = getDb(), repoRoot = process.cwd()) {
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  return ejectTaskToHuman(taskId, db, repoRoot);
}
