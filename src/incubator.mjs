/**
 * src/incubator.mjs
 * 
 * VibeSync Incubator & Low-Level Git Merkle Plumbing
 * Milestone 1: 3-Tier State Engine & Persistence
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, recordSettlementEvent, checkpointState } from './db.mjs';
import { INCUBATOR_BRANCH } from './config.mjs';

export const VALID_CATEGORIES = Object.freeze([
  'speculative_feature',
  'architecture_insight',
  'debt',
  'ux_polish',
  'convention'
]);

export const VALID_STATUSES = Object.freeze([
  'parked',
  'promoted',
  'discarded',
  'merged'
]);

/**
 * Resolves author and committer fallbacks without changing the repository a
 * command addresses. In particular, a sibling `.git_repo` must never replace
 * the active checkout's `.git` directory: that can make worktree commands
 * operate on an unrelated repository history.
 */
function resolveGitEnv(cwd, extraEnv = {}) {
  const merged = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'VibeSync Engine',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'engine@local',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'VibeSync Engine',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'engine@local',
    ...extraEnv
  };

  return merged;
}

/**
 * Calculates exponential backoff delay with random jitter bounded between minMs and maxMs.
 * 
 * @param {number} attempt - Current retry attempt index (0-based)
 * @param {number} minMs - Minimum delay in milliseconds (default: 200)
 * @param {number} maxMs - Maximum delay in milliseconds (default: 1200)
 * @returns {number} Delay in milliseconds
 */
export function calculateBackoffWithJitter(attempt, minMs = 200, maxMs = 1200) {
  const base = minMs * Math.pow(1.5, attempt);
  const jitter = Math.floor(Math.random() * 200);
  const delay = Math.round(base + jitter);
  return Math.min(maxMs, Math.max(minMs, delay));
}

/**
 * Executes a Git command synchronously with exponential backoff and jitter upon lock contention.
 * 
 * @param {string} cmd - Git command line string
 * @param {object} [options={}] - Execution options
 * @param {string} [options.cwd=process.cwd()] - Working directory
 * @param {string|Buffer} [options.input] - Stdin payload to pipe to process
 * @param {number} [options.maxRetries=5] - Maximum retry attempts upon lock contention
 * @param {object} [options.env={}] - Additional environment variables
 * @returns {string} Trimmed stdout of command
 */
export function execGitWithBackoff(cmd, options = {}) {
  const {
    cwd = process.cwd(),
    input,
    maxRetries = 5,
    env = {}
  } = options;

  const mergedEnv = resolveGitEnv(cwd, env);

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const run = Array.isArray(cmd) ? opts => execFileSync('git', cmd, opts) : opts => execSync(cmd, opts);
      const output = run({
        cwd,
        input,
        encoding: 'utf8',
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return options.raw ? output : output.trim();
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      const isLockContention =
        stderr.includes('.lock') ||
        stderr.includes('Unable to create') ||
        stderr.includes('cannot lock ref');

      if (isLockContention && attempt < maxRetries) {
        const delay = calculateBackoffWithJitter(attempt, 200, 1200);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Validates whether a category string is an allowed incubator category enum.
 * 
 * @param {string} category 
 * @throws {TypeError} if invalid
 */
export function validateIncubatorCategory(category) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new TypeError(
      `Invalid incubator category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }
}

/**
 * Validates whether a status string is an allowed incubator status enum.
 * 
 * @param {string} status 
 * @throws {TypeError} if invalid
 */
export function validateIncubatorStatus(status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new TypeError(
      `Invalid incubator status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`
    );
  }
}

/**
 * Generates the next sequential INC-### identifier from existing database records.
 * 
 * @param {DatabaseSync} [db] - Optional SQLite database handle
 * @returns {string} e.g. 'INC-001', 'INC-042'
 */
export function generateNextIncubatorId(db = getDb()) {
  const rows = db.prepare("SELECT id FROM incubator WHERE id LIKE 'INC-%'").all();
  let maxNum = 0;
  for (const row of rows) {
    const match = row.id.match(/^INC-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `INC-${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * Synchronizes parked incubator records to the detached orphan branch vibesync/incubator.
 * Guarantees 100% zero footprint on main, zero branch switching, and zero working tree mutation.
 * 
 * @param {DatabaseSync} [db] - Optional SQLite database handle
 * @param {string} [repoRoot=process.cwd()] - Path to repository root
 * @returns {string} 40-character commit SHA on vibesync/incubator
 */
export function syncIncubatorToOrphanBranch(db = getDb(), repoRoot = process.cwd()) {
  const records = db.prepare(
    "SELECT * FROM incubator WHERE status = 'parked' ORDER BY created_at ASC, id ASC"
  ).all();

  const payload = JSON.stringify(records, null, 2) + '\n';

  // 1. Write loose blob directly into .git/objects
  const blobSha = execGitWithBackoff(['hash-object', '-w', '--stdin'], {
    cwd: repoRoot,
    input: payload
  });

  // 2. Build Merkle tree referencing incubator.json
  const treeSha = execGitWithBackoff(['mktree'], {
    cwd: repoRoot,
    input: `100644 blob ${blobSha}\tincubator.json\n`
  });

  // 3. Inspect if previous orphan commit exists
  let parentSha = null;
  try {
    const ref = execGitWithBackoff(['rev-parse', '--verify', `refs/heads/${INCUBATOR_BRANCH}`], {
      cwd: repoRoot
    });
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      parentSha = ref;
    }
  } catch {
    parentSha = null;
  }

  // 4. Create commit object — pipe message via stdin to avoid shell interpolation
  const commitMsg = `sync: update parked incubator records (${records.length} items)`;
  const commitTreeArgs = ['commit-tree', treeSha, '-F', '-'];
  if (parentSha) { commitTreeArgs.push('-p', parentSha); }
  const commitSha = execGitWithBackoff(commitTreeArgs, { cwd: repoRoot, input: commitMsg });

  // 5. Update branch ref
  execGitWithBackoff(['update-ref', `refs/heads/${INCUBATOR_BRANCH}`, commitSha], {
    cwd: repoRoot
  });

  return commitSha;
}

/**
 * Searches for an existing parked insight with a matching title or target scope + category
 * to prevent duplicate ticket spam in autonomous mode.
 * 
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.category
 * @param {string} [params.targetScope]
 * @param {DatabaseSync} [db]
 * @returns {object|null}
 */
export function findSimilarParkedInsight(params, db = getDb()) {
  const title = (params.title || '').trim().toLowerCase();
  const category = params.category;
  const targetScope = (params.targetScope || params.target_scope || '').trim().toLowerCase();

  if (!title && !targetScope) return null;

  const parked = db.prepare(
    "SELECT * FROM incubator WHERE status = 'parked' AND category = ?"
  ).all(category);

  if (parked.length === 0) return null;

  // 1. Direct target_scope match if specified
  if (targetScope) {
    const scopeMatch = parked.find(p => (p.target_scope || '').trim().toLowerCase() === targetScope);
    if (scopeMatch) return scopeMatch;
  }

  // 2. Tokenize input title for similarity matching
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const inputTokens = new Set(normalize(title));
  if (inputTokens.size === 0) return null;

  for (const item of parked) {
    const itemTitle = (item.title || '').toLowerCase();
    if (itemTitle === title) return item;

    const itemTokens = new Set(normalize(itemTitle));
    let intersection = 0;
    for (const t of inputTokens) {
      if (itemTokens.has(t)) intersection++;
    }
    const union = new Set([...inputTokens, ...itemTokens]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard >= 0.6) {
      return item;
    }
  }

  return null;
}

/**
 * Parks an off-task thought, architectural finding, tech debt, or UX polish item.
 * Writes to database, records audit event, and mirrors to orphan branch.
 * Includes autonomous coalescing to prevent duplicate ticket bloat.
 * 
 * @param {object} params
 * @param {string} [params.id] - Optional custom ID (e.g. 'INC-042'); auto-generated if omitted
 * @param {string} params.title - Concise title
 * @param {string} params.category - 'speculative_feature' | 'architecture_insight' | 'debt' | 'ux_polish' | 'convention'
 * @param {string} [params.targetScope] - Optional file or module path
 * @param {string} params.contextNotes - Rationale or context description
 * @param {string} params.actorName - Identifier of acting entity
 * @param {boolean} [params.allowCoalesce=true] - Coalesce with existing similar insight
 * @param {DatabaseSync} [db] - Optional SQLite database handle
 * @param {string} [repoRoot=process.cwd()] - Optional repository root path
 * @returns {{ id: string, commitSha: string, coalesced: boolean }}
 */
export function parkInsight(params, db = getDb(), repoRoot = process.cwd()) {
  const title = params.title;
  const category = params.category;
  const contextNotes = params.contextNotes || params.context_notes || params.notes || '';
  const actorName = params.actorName || params.actor_name || params.logged_by;
  const targetScope = params.targetScope || params.target_scope || null;
  const allowCoalesce = params.allowCoalesce !== false && !params.id;

  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new Error('Title is required for parking an incubator insight.');
  }
  validateIncubatorCategory(category);
  if (!actorName || typeof actorName !== 'string' || !actorName.trim()) {
    throw new Error('actorName is required for parking an incubator insight.');
  }

  // Check for coalescing with an existing parked insight to avoid bloat
  if (allowCoalesce) {
    const existing = findSimilarParkedInsight({ title, category, targetScope }, db);
    if (existing) {
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const additionalNote = `\n\n[Coalesced observation ${timestamp} by ${actorName.trim()}]: ${contextNotes || title.trim()}`;
      const updatedNotes = (existing.context_notes || '') + additionalNote;

      db.prepare(`
        UPDATE incubator 
        SET context_notes = ?,
            target_scope = COALESCE(target_scope, ?)
        WHERE id = ?
      `).run(updatedNotes, targetScope ? targetScope.trim() : null, existing.id);

      let currentHead = 'detached';
      try {
        currentHead = execGitWithBackoff(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
      } catch {}

      recordSettlementEvent(db, {
        actor: actorName.trim(),
        action: 'incubator_logged',
        commit_ref: currentHead,
        evidence_payload: { id: existing.id, title: existing.title, category, coalesced: true }
      });

      const commitSha = syncIncubatorToOrphanBranch(db, repoRoot);
      checkpointState(db);
      return { id: existing.id, commitSha, coalesced: true };
    }
  }

  const id = params.id && params.id.trim()
    ? params.id.trim()
    : generateNextIncubatorId(db);

  db.prepare(`
    INSERT INTO incubator (id, title, category, target_scope, context_notes, logged_by, status)
    VALUES (?, ?, ?, ?, ?, ?, 'parked')
  `).run(id, title.trim(), category, targetScope ? targetScope.trim() : null, contextNotes || '', actorName.trim());

  let currentHead = 'detached';
  try {
    currentHead = execGitWithBackoff(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  } catch {}

  recordSettlementEvent(db, {
    actor: actorName.trim(),
    action: 'incubator_logged',
    commit_ref: currentHead,
    evidence_payload: { id, title: title.trim(), category, target_scope: targetScope || null, coalesced: false }
  });

  const commitSha = syncIncubatorToOrphanBranch(db, repoRoot);
  checkpointState(db);
  return { id, commitSha, coalesced: false };
}

/**
 * Retrieves incubator items with optional status filtering.
 * 
 * @param {DatabaseSync} [db]
 * @param {object} [filter]
 * @param {string} [filter.status] - 'parked' | 'promoted' | 'discarded'
 * @returns {Array<object>}
 */
export function getIncubatorItems(db = getDb(), filter = {}) {
  let query = 'SELECT * FROM incubator';
  const params = [];
  const conditions = [];

  if (filter.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.category) {
    conditions.push('category = ?');
    params.push(filter.category);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  return db.prepare(query).all(...params);
}

// Alias for getIncubatorItems
export function listIncubatorRecords(status = 'parked', db = getDb()) {
  return getIncubatorItems(db, status ? { status } : {});
}


/**
 * Retrieves a single incubator item by ID.
 * 
 * @param {string} id
 * @param {DatabaseSync} [db]
 * @returns {object|null}
 */
export function getIncubatorItem(id, db = getDb()) {
  const item = db.prepare('SELECT * FROM incubator WHERE id = ?').get(id);
  return item || null;
}

/**
 * Promotes an incubator item to a formal Feature contract.
 * Updates status, sets promoted_feature_id, and synchronizes orphan branch.
 * 
 * @param {object} params
 * @param {string} params.id - Incubator item ID
 * @param {string} params.featureId - Target Feature ID (must exist in features table)
 * @param {string} [params.actorName='human']
 * @param {DatabaseSync} [db]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ item: object, commitSha: string }}
 */
export function promoteIncubatorItem(params, db = getDb(), repoRoot = process.cwd()) {
  const { id, featureId, actorName = 'human' } = params;
  const item = getIncubatorItem(id, db);
  if (!item) {
    throw new Error(`Incubator item "${id}" not found.`);
  }

  const feature = db.prepare('SELECT id FROM features WHERE id = ?').get(featureId);
  if (!feature) {
    throw new Error(`Cannot promote incubator item "${id}": Target feature "${featureId}" does not exist.`);
  }

  db.prepare(`
    UPDATE incubator 
    SET status = 'promoted', promoted_feature_id = ? 
    WHERE id = ?
  `).run(featureId, id);

  const commitSha = syncIncubatorToOrphanBranch(db, repoRoot);
  const updatedItem = getIncubatorItem(id, db);
  checkpointState(db);
  return { item: updatedItem, commitSha };
}

/**
 * Discards an incubator item.
 * 
 * @param {object} params
 * @param {string} params.id - Incubator item ID
 * @param {string} [params.actorName='human']
 * @param {DatabaseSync} [db]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ item: object, commitSha: string }}
 */
export function discardIncubatorItem(params, db = getDb(), repoRoot = process.cwd()) {
  const { id } = params;
  const item = getIncubatorItem(id, db);
  if (!item) {
    throw new Error(`Incubator item "${id}" not found.`);
  }

  db.prepare(`
    UPDATE incubator 
    SET status = 'discarded', promoted_feature_id = NULL 
    WHERE id = ?
  `).run(id);

  const commitSha = syncIncubatorToOrphanBranch(db, repoRoot);
  const updatedItem = getIncubatorItem(id, db);
  checkpointState(db);
  return { item: updatedItem, commitSha };
}

/**
 * Reads and parses incubator.json from the orphan branch vibesync/incubator.
 * 
 * @param {string} [repoRoot=process.cwd()]
 * @returns {Array<object>|null}
 */
export function readIncubatorFromOrphanBranch(repoRoot = process.cwd()) {
  try {
    const raw = execGitWithBackoff(`git show ${INCUBATOR_BRANCH}:incubator.json`, { cwd: repoRoot });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Merges multiple parked incubator items into a single unified record.
 * Source items are marked with status = 'merged' and merged_into_id set.
 * 
 * @param {object} params
 * @param {string[]} params.sourceIds - Array of incubator IDs to merge (minimum 1)
 * @param {string} [params.targetId] - Optional existing ID to merge into; if omitted, creates a new INC-###
 * @param {string} [params.mergedTitle] - Unified title
 * @param {string} [params.mergedNotes] - Consolidated technical notes
 * @param {string} [params.category] - Category (defaults to target or first source category)
 * @param {string} [params.actorName='human']
 * @param {DatabaseSync} [db]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ targetId: string, mergedCount: number, commitSha: string }}
 */
export function mergeIncubatorItems(params, db = getDb(), repoRoot = process.cwd()) {
  const { sourceIds, actorName = 'human' } = params;
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new Error('sourceIds must be a non-empty array of incubator IDs.');
  }

  const sourceItems = sourceIds.map(id => {
    const item = getIncubatorItem(id, db);
    if (!item) throw new Error(`Incubator item "${id}" not found.`);
    if (item.status !== 'parked') throw new Error(`Incubator item "${id}" is not parked (status: ${item.status}).`);
    return item;
  });

  let targetId = params.targetId;
  let targetItem = null;

  if (targetId) {
    targetItem = getIncubatorItem(targetId, db);
    if (!targetItem) throw new Error(`Target incubator item "${targetId}" not found.`);
    if (targetItem.status !== 'parked') throw new Error(`Target incubator item "${targetId}" is not parked.`);
  } else {
    targetId = generateNextIncubatorId(db);
    const category = params.category || sourceItems[0].category;
    const title = params.mergedTitle || sourceItems.map(s => s.title).slice(0, 2).join(' & ');
    const combinedNotes = params.mergedNotes || sourceItems.map(s => `### From ${s.id} (${s.title})\n${s.context_notes}`).join('\n\n');
    const targetScope = sourceItems.map(s => s.target_scope).filter(Boolean).join(', ') || null;

    db.prepare(`
      INSERT INTO incubator (id, title, category, target_scope, context_notes, logged_by, status)
      VALUES (?, ?, ?, ?, ?, ?, 'parked')
    `).run(targetId, title.trim(), category, targetScope, combinedNotes, actorName.trim());
  }

  // Update notes on target if target was provided and mergedNotes provided
  if (params.targetId && params.mergedNotes) {
    db.prepare(`
      UPDATE incubator 
      SET context_notes = context_notes || '\n\n' || ?
      WHERE id = ?
    `).run(params.mergedNotes, targetId);
  }

  // Mark all sources (except target if target was in sourceIds) as merged
  const idsToMarkMerged = sourceIds.filter(id => id !== targetId);
  for (const sid of idsToMarkMerged) {
    db.prepare(`
      UPDATE incubator
      SET status = 'merged', merged_into_id = ?
      WHERE id = ?
    `).run(targetId, sid);
  }

  let currentHead = 'detached';
  try {
    currentHead = execGitWithBackoff(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  } catch {}

  recordSettlementEvent(db, {
    actor: actorName.trim(),
    action: 'incubator_merged',
    commit_ref: currentHead,
    evidence_payload: { targetId, sourceIds: idsToMarkMerged }
  });

  const commitSha = syncIncubatorToOrphanBranch(db, repoRoot);
  checkpointState(db);
  return { targetId, mergedCount: idsToMarkMerged.length, commitSha };
}

/**
 * Promotes multiple incubator items to a single target Feature contract.
 * 
 * @param {object} params
 * @param {string[]} params.ids - Array of incubator item IDs
 * @param {string} params.featureId - Target Feature ID (e.g. 'FEAT-02')
 * @param {string} [params.actorName='human']
 * @param {DatabaseSync} [db]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{ promotedIds: string[], featureId: string, commitSha: string }}
 */
export function promoteMultipleIncubatorItems(params, db = getDb(), repoRoot = process.cwd()) {
  const { ids, featureId, actorName = 'human' } = params;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids must be a non-empty array of incubator IDs.');
  }

  const feature = db.prepare('SELECT id FROM features WHERE id = ?').get(featureId);
  if (!feature) {
    throw new Error(`Cannot promote incubator items: Target feature "${featureId}" does not exist.`);
  }

  for (const id of ids) {
    const item = getIncubatorItem(id, db);
    if (!item) throw new Error(`Incubator item "${id}" not found.`);
    db.prepare(`
      UPDATE incubator 
      SET status = 'promoted', promoted_feature_id = ? 
      WHERE id = ?
    `).run(featureId, id);
  }

  const commitSha = syncIncubatorToOrphanBranch(db, repoRoot);
  checkpointState(db);
  return { promotedIds: ids, featureId, commitSha };
}

/**
 * Returns all active operational conventions and environment rules stored in the incubator.
 * 
 * @param {DatabaseSync} [db]
 * @returns {Array<object>}
 */
export function getConventions(db = getDb()) {
  return db.prepare(`
    SELECT id, title, target_scope, context_notes, logged_by, created_at
    FROM incubator
    WHERE category = 'convention' AND status = 'parked'
    ORDER BY created_at DESC
  `).all();
}
