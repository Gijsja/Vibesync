/**
 * src/repair.mjs
 * 
 * VibeSync Self-Healing State Reconstruction Engine
 * Milestone 4: Disaster Recovery (Features 42–47)
 */

import { readStateCheckpoint, restoreStateCheckpoint } from './durability.mjs';
import { getDb, initSchema } from './db.mjs';
import { execGitWithBackoff } from './incubator.mjs';
import { getDbPath, INCUBATOR_BRANCH, GIT_NOTES_REF } from './config.mjs';
import { getGitNote } from './settle.mjs';

/**
 * Reconstructs the entire relational SQLite database from Git Merkle history,
 * commit trailers, Git notes, and the orphan incubator branch.
 * 
 * @param {string} [repoRoot=process.cwd()]
 * @param {DatabaseSync} [customDb]
 * @returns {{ featuresCount: number, tasksCount: number, incubatorCount: number, eventsCount: number, dbPath: string }}
 */
export function repairDatabase(repoRoot = process.cwd(), customDb = null) {
  const checkpoint = readStateCheckpoint(repoRoot);
  const db = customDb || getDb(getDbPath(repoRoot), repoRoot);
  initSchema(db);
  if (checkpoint) return { ...restoreStateCheckpoint(db, repoRoot, checkpoint), dbPath: getDbPath(repoRoot) };

  let restoredFeatures = 0;
  let restoredTasks = 0;
  let restoredIncubator = 0;
  let restoredEvents = 0;

  // ==========================================================================
  // 1. Rebuild Incubator from Orphan Branch
  // ==========================================================================
  try {
    const raw = execGitWithBackoff(`git show ${INCUBATOR_BRANCH}:incubator.json`, { cwd: repoRoot });
    if (raw && raw.trim()) {
      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO incubator (
            id, title, category, target_scope, context_notes, logged_by, status, merged_into_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
        `);

        for (const item of items) {
          if (!item || !item.id || !item.title) continue;
          stmt.run(
            item.id,
            item.title,
            item.category || 'speculative_feature',
            item.target_scope || null,
            item.context_notes || '',
            item.logged_by || 'unknown',
            item.status || 'parked',
            item.merged_into_id || null,
            item.created_at || null
          );
          restoredIncubator++;
        }
      }
    }
  } catch (err) {
    // Branch may not exist yet or incubator.json empty
  }

  // ==========================================================================
  // 2. Scan Git Log on 'main' for Settled Task Trailers
  // ==========================================================================
  const delimiter = '---VIBESYNC_DELIM_REPAIR---';
  let logOutput = '';
  try {
    logOutput = execGitWithBackoff(`git log main --format="%H%n%B${delimiter}"`, { cwd: repoRoot });
  } catch (err) {
    // If 'main' doesn't exist, try HEAD
    try {
      logOutput = execGitWithBackoff(`git log -n 100 --format="%H%n%B${delimiter}"`, { cwd: repoRoot });
    } catch {}
  }

  if (logOutput) {
    const blocks = logOutput.split(delimiter).map(b => b.trim()).filter(Boolean);

    const insertFeatureStmt = db.prepare(`
      INSERT OR IGNORE INTO features (
        id, title, target_milestone, status, priority, labels, external_ref, spec_markdown, settled_commit, created_at, settled_at
      ) VALUES (?, ?, 'reconstructed', 'settled', ?, ?, ?, 'Reconstructed from Git commit history', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const insertTaskStmt = db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, feature_id, title, status, priority, labels, external_ref, assigned_actor, branch_name, base_commit, settled_commit,
        consecutive_failures, updated_at
      ) VALUES (?, ?, ?, 'settled', ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
    `);

    const insertEventStmt = db.prepare(`
      INSERT INTO settlement_events (
        task_id, feature_id, actor, action, commit_ref, evidence_payload, timestamp
      ) VALUES (?, ?, ?, 'repaired_from_git', ?, ?, CURRENT_TIMESTAMP)
    `);

    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim());
      const commitSha = lines[0];

      const taskIdMatch = block.match(/Task-Id:\s*([^\n\r]+)/i);
      const featureIdMatch = block.match(/Feature-Id:\s*([^\n\r]+)/i);
      const actorMatch = block.match(/Agent-Actor:\s*([^\n\r]+)/i);
      const baseCommitMatch = block.match(/Base-Commit:\s*([^\n\r]+)/i);
      const gateMatch = block.match(/Gate-Verification:\s*([^\n\r]+)/i);
      const priorityMatch = block.match(/Priority:\s*([^\n\r]+)/i);
      const labelsMatch = block.match(/Labels:\s*([^\n\r]+)/i);
      const extRefMatch = block.match(/External-Ref:\s*([^\n\r]+)/i);

      if (taskIdMatch && featureIdMatch) {
        const taskId = taskIdMatch[1].trim();
        const featureId = featureIdMatch[1].trim();
        const actor = actorMatch ? actorMatch[1].trim() : 'unknown-agent';
        const baseCommit = baseCommitMatch ? baseCommitMatch[1].trim() : commitSha.slice(0, 7);
        const titleMatch = lines[1] && !lines[1].startsWith('feat:') ? lines[1] : `Reconstructed ${taskId}`;
        const branchName = `task/${taskId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

        let priority = priorityMatch ? priorityMatch[1].trim().toLowerCase() : 'medium';
        if (!['urgent', 'high', 'medium', 'low'].includes(priority)) priority = 'medium';

        let labels = [];
        if (labelsMatch) {
          const rawL = labelsMatch[1].trim();
          if (rawL.startsWith('[')) {
            try { labels = JSON.parse(rawL); } catch {}
          } else {
            labels = rawL.split(',').map(s => s.trim()).filter(Boolean);
          }
        }

        let externalRef = extRefMatch ? extRefMatch[1].trim() : null;

        // Check git notes payload if available for richer metadata
        let notePayload = null;
        try {
          notePayload = getGitNote(commitSha, { repoRoot, ref: GIT_NOTES_REF });
        } catch {}

        if (notePayload) {
          if (notePayload.priority && ['urgent', 'high', 'medium', 'low'].includes(notePayload.priority)) {
            priority = notePayload.priority;
          }
          if (Array.isArray(notePayload.labels)) {
            labels = notePayload.labels;
          }
          if (notePayload.external_ref || notePayload.externalRef) {
            externalRef = notePayload.external_ref || notePayload.externalRef;
          }
        }

        const labelsJson = JSON.stringify(labels);

        // Ensure parent feature exists
        const featureRes = insertFeatureStmt.run(featureId, `Feature ${featureId}`, priority, labelsJson, externalRef, commitSha);
        if (featureRes.changes > 0) restoredFeatures++;

        // Restore task
        insertTaskStmt.run(taskId, featureId, titleMatch, priority, labelsJson, externalRef, actor, branchName, baseCommit, commitSha);
        restoredTasks++;

        if (!notePayload) {
          notePayload = {
            taskId,
            featureId,
            actor,
            baseCommit,
            priority,
            labels,
            externalRef,
            gateVerification: gateMatch ? gateMatch[1].trim() : 'PASS'
          };
        }

        insertEventStmt.run(
          taskId,
          featureId,
          actor,
          commitSha,
          JSON.stringify(notePayload)
        );
        restoredEvents++;
      }
    }
  }

  // ==========================================================================
  // 3. Scan for In-Flight Task Branches (task/*)
  // ==========================================================================
  try {
    const rawBranches = execGitWithBackoff("git branch --list 'task/*'", { cwd: repoRoot });
    if (rawBranches) {
      const branchNames = rawBranches
        .split('\n')
        .map(b => b.replace(/^\*?\s+/, '').trim())
        .filter(Boolean);

      db.prepare(`
        INSERT OR IGNORE INTO features (
          id, title, target_milestone, status, spec_markdown, created_at
        ) VALUES ('FEAT-IN-FLIGHT', 'In-Flight Feature Workspace', 'unassigned', 'in_progress', 'Placeholder for discovered in-flight task branches', CURRENT_TIMESTAMP)
      `).run();

      const insertInFlightStmt = db.prepare(`
        INSERT OR IGNORE INTO tasks (
          id, feature_id, title, status, assigned_actor, branch_name, base_commit
        ) VALUES (?, ?, ?, 'in_progress', 'agent', ?, ?)
      `);

      for (const branch of branchNames) {
        const rawId = branch.replace(/^task\//i, '').toUpperCase();
        let baseCommit = '0000000';
        try {
          baseCommit = execGitWithBackoff(`git merge-base main ${branch}`, { cwd: repoRoot });
        } catch {}

        const res = insertInFlightStmt.run(
          rawId,
          'FEAT-IN-FLIGHT',
          `In-flight task from branch ${branch}`,
          branch,
          baseCommit
        );
        if (res.changes > 0) {
          restoredTasks++;
        }
      }

    }
  } catch {}

  return {
    featuresCount: restoredFeatures,
    tasksCount: restoredTasks,
    incubatorCount: restoredIncubator,
    eventsCount: restoredEvents,
    dbPath: getDbPath(repoRoot),
    recoveryMode: 'legacy'
  };
}
