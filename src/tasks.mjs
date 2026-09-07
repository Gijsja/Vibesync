/**
 * src/tasks.mjs
 * 
 * VibeSync Tasks Management, Atomic Leasing, and Active Anchor Hydration
 * Milestone 1: 3-Tier State Engine & Persistence
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb, recordSettlementEvent, checkpointState } from './db.mjs';
import { getFeature } from './features.mjs';
import { execGitWithBackoff } from './incubator.mjs';
import { TASK_STATUSES, PRIORITY_LEVELS } from './config.mjs';

/**
 * Validates task identifier syntax.
 * 
 * @param {string} id 
 * @returns {boolean}
 */
export function isValidTaskId(id) {
  return typeof id === 'string' && /^TASK-[A-Za-z0-9_.-]+$/.test(id);
}

/**
 * Deserializes task record fields from SQLite JSON strings.
 * 
 * @param {object|null} row 
 * @returns {object|null}
 */
function deserializeTask(row) {
  if (!row) return null;
  return {
    ...row,
    allowed_paths: typeof row.allowed_paths === 'string' ? JSON.parse(row.allowed_paths) : row.allowed_paths,
    required_gates: typeof row.required_gates === 'string' ? JSON.parse(row.required_gates) : row.required_gates,
    labels: typeof row.labels === 'string' ? JSON.parse(row.labels) : (row.labels || [])
  };
}

/**
 * Creates and registers a new task bound to a parent feature.
 * 
 * @param {object} params
 * @param {string} params.id - e.g. 'TASK-01.1'
 * @param {string} params.feature_id - Foreign key to features table
 * @param {string} params.title - Actionable task summary
 * @param {string} [params.status='ready'] - 'backlog' | 'ready' | 'in_progress' | 'review' | 'settled' | 'blocked'
 * @param {string} [params.priority='medium'] - 'urgent' | 'high' | 'medium' | 'low'
 * @param {Array<string>} [params.labels=[]] - Labels or tags
 * @param {string|null} [params.external_ref=null] - External issue tracking reference (e.g. 'GH-42', 'LIN-101')
 * @param {Array<string>} [params.allowed_paths=['*']]
 * @param {Array<string>} [params.required_gates=[]]
 * @param {number} [params.max_failures=3]
 * @param {DatabaseSync} [db]
 * @returns {object} Created task record
 */
export function createTask(params, db = getDb()) {
  const {
    id,
    feature_id,
    title,
    status = 'ready',
    priority = 'medium',
    labels = [],
    external_ref = null,
    allowed_paths = ['*'],
    required_gates = [],
    max_failures = 3
  } = params;

  if (!id || !feature_id || !title) {
    throw new Error('Missing required task parameters: id, feature_id, title.');
  }

  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`Invalid task status: "${status}". Must be one of: ${TASK_STATUSES.join(', ')}`);
  }

  if (!PRIORITY_LEVELS.includes(priority)) {
    throw new Error(`Invalid task priority: "${priority}". Must be one of: ${PRIORITY_LEVELS.join(', ')}`);
  }

  const allowedPathsJson = Array.isArray(allowed_paths) ? JSON.stringify(allowed_paths) : allowed_paths;
  const requiredGatesJson = Array.isArray(required_gates) ? JSON.stringify(required_gates) : required_gates;
  const labelsJson = Array.isArray(labels) ? JSON.stringify(labels) : (typeof labels === 'string' ? labels : '[]');

  const stmt = db.prepare(`
    INSERT INTO tasks (id, feature_id, title, status, priority, labels, external_ref, allowed_paths, required_gates, max_failures)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, feature_id, title, status, priority, labelsJson, external_ref, allowedPathsJson, requiredGatesJson, max_failures);

  checkpointState(db);
  return getTask(id, db);
}

/**
 * Retrieves a task record by ID.
 * 
 * @param {string} id 
 * @param {DatabaseSync} [db] 
 * @returns {object|null}
 */
export function getTask(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return deserializeTask(row);
}

/**
 * Lists tasks matching optional filtering criteria.
 * 
 * @param {DatabaseSync} [db] 
 * @param {object} [filter={}] 
 * @param {string} [filter.feature_id] 
 * @param {string} [filter.status] 
 * @param {string} [filter.priority] 
 * @param {string} [filter.assigned_actor] 
 * @param {string} [filter.external_ref] 
 * @returns {Array<object>}
 */
export function listTasks(dbOrFilter = getDb(), maybeFilter = {}) {
  let db = dbOrFilter;
  let filter = maybeFilter;
  if (dbOrFilter && typeof dbOrFilter.prepare !== 'function') {
    filter = dbOrFilter;
    db = (maybeFilter && typeof maybeFilter.prepare === 'function') ? maybeFilter : getDb();
  }
  let query = 'SELECT * FROM tasks';
  const conditions = [];
  const args = [];

  if (filter.feature_id) {
    conditions.push('feature_id = ?');
    args.push(filter.feature_id);
  }
  if (filter.status) {
    conditions.push('status = ?');
    args.push(filter.status);
  }
  if (filter.priority) {
    conditions.push('priority = ?');
    args.push(filter.priority);
  }
  if (filter.assigned_actor) {
    conditions.push('assigned_actor = ?');
    args.push(filter.assigned_actor);
  }
  if (filter.external_ref) {
    conditions.push('external_ref = ?');
    args.push(filter.external_ref);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at ASC';

  const rows = db.prepare(query).all(...args);
  return rows.map(deserializeTask);
}

/**
 * Updates task status and attributes.
 * 
 * @param {string} id 
 * @param {string} newStatus 
 * @param {string|null} [actor=null] 
 * @param {DatabaseSync} [db] 
 * @returns {object}
 */
export function updateTaskStatus(id, newStatus, actor = null, db = getDb()) {
  const task = getTask(id, db);
  if (!task) throw new Error(`Task ${id} not found.`);
  if (newStatus === 'settled') throw new Error('Use verifyAndSettleTask to settle a task after its gates pass.');
  if (task.status === 'settled' || task.status === 'blocked') throw new Error(`Task ${id} is ${task.status}; use its explicit lifecycle action.`);
  if (!TASK_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid task status: "${newStatus}". Must be one of: ${TASK_STATUSES.join(', ')}`);
  }

  db.prepare(`
    UPDATE tasks
    SET status = ?,
        assigned_actor = COALESCE(?, assigned_actor),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newStatus, actor, id);

  checkpointState(db);
  return getTask(id, db);
}

/**
 * Updates an existing task contract with arbitrary allowed fields.
 * 
 * @param {string} id 
 * @param {object} updates 
 * @param {DatabaseSync} [db] 
 * @returns {object} Updated task record
 */
export function updateTask(id, updates, db = getDb()) {
  const task = getTask(id, db);
  if (!task) throw new Error(`Task ${id} not found.`);

  if (task.status === 'settled') throw new Error(`Task ${id} is settled and immutable.`);
  if (updates.status !== undefined) throw new Error('Use explicit task lifecycle actions to change status.');
  if ((updates.allowed_paths !== undefined || updates.required_gates !== undefined) && !['ready', 'backlog'].includes(task.status)) throw new Error('Release the task before editing its scope or gates.');

  const allowedFields = [
    'title',
    'priority',
    'labels',
    'external_ref',
    'allowed_paths',
    'required_gates',
  ];

  const setClauses = [];
  const args = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      if (key === 'priority') {
        if (!PRIORITY_LEVELS.includes(value)) {
          throw new Error(`Invalid task priority: "${value}". Must be one of: ${PRIORITY_LEVELS.join(', ')}`);
        }
        setClauses.push(`${key} = ?`);
        args.push(value);
      } else if (key === 'status') {
        if (!TASK_STATUSES.includes(value)) {
          throw new Error(`Invalid task status: "${value}". Must be one of: ${TASK_STATUSES.join(', ')}`);
        }
        setClauses.push(`${key} = ?`);
        args.push(value);
      } else if (key === 'labels' || key === 'allowed_paths' || key === 'required_gates') {
        setClauses.push(`${key} = ?`);
        args.push(Array.isArray(value) ? JSON.stringify(value) : value);
      } else {
        setClauses.push(`${key} = ?`);
        args.push(value);
      }
    }
  }

  if (setClauses.length === 0) return task;

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  args.push(id);

  db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...args);
  checkpointState(db);
  return getTask(id, db);
}

/**
 * Generates an ephemeral context anchor in the leased worktree.
 * 
 * @param {string} worktreePath 
 * @param {object} task 
 * @param {object} feature 
 * @returns {string|null} Path to generated anchor file
 */
export function hydrateActiveTaskAnchor(worktreePath, task, feature) {
  if (!worktreePath) return null;
  fs.mkdirSync(worktreePath, { recursive: true });

  const allowedList = task.allowed_paths && task.allowed_paths.length > 0
    ? task.allowed_paths.map(p => `- \`${p}\``).join('\n')
    : '- `*` (All workspace paths allowed)';

  const gatesList = task.required_gates && task.required_gates.length > 0
    ? task.required_gates.map(g => `- \`${g}\``).join('\n')
    : '- None (Immediate settlement allowed)';

  const labelsText = Array.isArray(task.labels) && task.labels.length > 0
    ? task.labels.join(', ')
    : 'none';

  const content = `# ACTIVE TASK: ${task.id} - ${task.title}

**Parent Feature:** ${feature ? `${feature.id} (${feature.title})` : task.feature_id}  
**Target Milestone:** ${feature?.target_milestone || 'N/A'}  
**Priority:** ${task.priority || 'medium'}  
**Labels:** ${labelsText}  
**External Ref:** ${task.external_ref || 'none'}  
**Assigned Actor:** ${task.assigned_actor || 'unassigned'}  
**Branch:** ${task.branch_name || 'N/A'}  
**Base Commit:** ${task.base_commit || 'N/A'}  
**Lease Expires:** ${task.lease_expires_at || 'N/A'}  

## Feature Acceptance Criteria
${feature?.spec_markdown || 'No feature specification recorded.'}

## Feature Completion Gate
${feature?.holistic_gate_cmd || 'No holistic gate recorded.'}

## Allowed Scopes (Path Whitelist)
${allowedList}

## Mandatory Verification Gates
${gatesList}

## Critical Invariants
1. **Path Containment:** Do not modify files outside of designated allowed scopes. Any modification to unapproved files immediately halts verification with a \`SCOPE_VIOLATION\`.
2. **Shift-Left Verification:** All required gates must execute in an independent subprocess and exit with code 0 before code is settled.
3. **Quarantine Off-Task Discoveries:** If off-task bugs, refactors, or insights are discovered mid-task, do NOT touch out-of-scope code. Call \`vibesync_park_insight\` to park them in the Incubator.
4. **Ephemeral State:** This anchor file is managed exclusively by VibeSync and removed upon settlement. Do not commit or edit this file directly.
`;

  const anchorPath = path.join(worktreePath, '.vibesync_ACTIVE_TASK.md');
  fs.writeFileSync(anchorPath, content, 'utf8');
  try {
    const excludePath = execGitWithBackoff(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: worktreePath });
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    const missing = ['.vibesync_ACTIVE_TASK.md', '.vibesync/worktrees/'].filter(line => !existing.split('\n').includes(line));
    if (missing.length) fs.appendFileSync(excludePath, '\n' + missing.join('\n') + '\n');
  } catch { /* Plain directories can still receive an anchor before Git setup. */ }
  return anchorPath;
}

/**
 * Atomically claims a task for an agent actor.
 * 
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.actorName
 * @param {string} [params.worktreePath]
 * @param {DatabaseSync} [db]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ success: boolean, activeTaskAnchorPath: string|null, task: object }}
 */
export function claimTask(params, db = getDb(), repoRoot = process.cwd()) {
  repoRoot = params.repoRoot || repoRoot;
  const { taskId, actorName, worktreePath } = params;
  if (!taskId || !actorName) {
    throw new Error('Missing required claim parameters: taskId, actorName.');
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }

  // 1. Rejection on Settled Task
  if (task.status === 'settled') {
    throw new Error(`Task ${taskId} is already settled.`);
  }

  // 2. Rejection on Blocked Task (Circuit Breaker)
  if (task.status === 'blocked' && actorName !== 'human') {
    throw new Error(`Task ${taskId} is currently blocked by circuit breaker. Requires human intervention.`);
  }

  // 3. Double-Lease Rejection with TTL Check
  if (task.status === 'in_progress') {
    const expiredCheck = db.prepare(`
      SELECT (datetime(lease_expires_at) <= datetime('now')) AS is_expired
      FROM tasks WHERE id = ?
    `).get(taskId);

    if (!expiredCheck || !expiredCheck.is_expired) {
      throw new Error(`Task ${taskId} is currently in_progress (Owner: ${task.assigned_actor}, expires: ${task.lease_expires_at}).`);
    }
  }

  // 4. Branch Name & Base Commit
  const branchName = `task/${taskId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  let baseCommit = '0000000';
  try {
    baseCommit = execGitWithBackoff('git rev-parse --short HEAD', { cwd: repoRoot });
  } catch {}

  // 5. Atomic Lease Execution (45-min TTL)
  const updateRes = db.prepare(`
    UPDATE tasks
    SET status = 'in_progress',
        consecutive_failures = CASE WHEN status = 'blocked' AND ? = 'human' THEN 0 ELSE consecutive_failures END,
        assigned_actor = ?,
        branch_name = ?,
        base_commit = ?,
        lease_expires_at = datetime('now', '+45 minutes'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND (status != 'in_progress' OR datetime(lease_expires_at) <= datetime('now'))
      AND status != 'settled'
      AND (status != 'blocked' OR ? = 'human')
  `).run(actorName, actorName, branchName, baseCommit, taskId, actorName);

  if (updateRes.changes === 0) {
    throw new Error(`Task ${taskId} is currently in_progress (concurrently claimed).`);
  }

  const updatedTask = getTask(taskId, db);

  // 6. Context Anchor Hydration
  let activeTaskAnchorPath = null;
  if (worktreePath) {
    const feature = getFeature(task.feature_id, db);
    activeTaskAnchorPath = hydrateActiveTaskAnchor(worktreePath, updatedTask, feature);
  }

  // 7. Audit Ledger Event
  recordSettlementEvent(db, {
    task_id: taskId,
    feature_id: task.feature_id,
    actor: actorName,
    action: 'task_claimed',
    commit_ref: baseCommit,
    evidence_payload: {
      branch_name: branchName,
      lease_expires_at: updatedTask.lease_expires_at
    }
  });

  return {
    success: true,
    activeTaskAnchorPath,
    task: updatedTask
  };
}

/**
 * Releases a task lease back to 'ready'.
 * 
 * @param {string} taskId 
 * @param {DatabaseSync} [db] 
 */
export function releaseTaskLease(taskId, db = getDb()) {
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  const result = db.prepare(`
    UPDATE tasks
    SET status = 'ready',
        assigned_actor = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'in_progress'
  `).run(taskId);
  if (result.changes === 0) throw new Error(`Task ${taskId} is not in_progress; lease cannot be released.`);

  recordSettlementEvent(db, {
    task_id: taskId,
    feature_id: task.feature_id,
    actor: task.assigned_actor || 'system',
    action: 'lease_released',
    commit_ref: 'HEAD',
    evidence_payload: { reason: 'manual_release' }
  });
}

/**
 * Scans for expired leases and unlocks them back to 'ready'.
 * 
 * @param {DatabaseSync} [db] 
 * @returns {number} Count of expired tasks unlocked
 */
export function checkAndExpireLeases(db = getDb()) {
  const expired = db.prepare("SELECT * FROM tasks WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at) <= datetime('now')").all();
  let released = 0;
  for (const task of expired) {
    const result = db.prepare("UPDATE tasks SET status = 'ready', assigned_actor = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'in_progress' AND assigned_actor IS ? AND lease_expires_at IS ? AND datetime(lease_expires_at) <= datetime('now')").run(task.id, task.assigned_actor, task.lease_expires_at);
    if (!result.changes) continue;
    released++;
    recordSettlementEvent(db, { task_id: task.id, feature_id: task.feature_id, actor: 'system', action: 'lease_released', commit_ref: 'HEAD',
      evidence_payload: { reason: 'lease_ttl_expired', previous_actor: task.assigned_actor, expired_at: task.lease_expires_at } });
  }
  return released;
}

/**
 * Reassigns an in-progress or claimed task to human operator.
 * 
 * @param {string} taskId 
 * @param {DatabaseSync} [db] 
 * @param {string} [repoRoot=process.cwd()]
 * @returns {object} Updated task record
 */
export function ejectTaskToHuman(taskId, db = getDb(), repoRoot = process.cwd()) {
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  if (task.status === 'settled') throw new Error(`Cannot eject settled task ${taskId}.`);

  db.prepare(`
    UPDATE tasks
    SET assigned_actor = 'human',
        lease_expires_at = CASE WHEN status = 'in_progress' THEN datetime('now', '+45 minutes') ELSE lease_expires_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(taskId);

  let commitRef = 'HEAD';
  try {
    commitRef = execGitWithBackoff('git rev-parse --short HEAD', { cwd: repoRoot });
  } catch {}

  recordSettlementEvent(db, {
    task_id: taskId,
    feature_id: task.feature_id,
    actor: 'human',
    action: 'ejected_to_human',
    commit_ref: commitRef,
    evidence_payload: {
      previous_actor: task.assigned_actor,
      ejected_at: new Date().toISOString()
    }
  });

  return getTask(taskId, db);
}

