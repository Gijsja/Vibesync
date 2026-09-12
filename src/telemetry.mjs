/**
 * src/telemetry.mjs
 * 
 * VibeSync Operational Telemetry & Human Attention Queue Engine
 * Replaces simulated agent dialogue with concrete Confidence, Evidence, and Uncertainty metrics.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.mjs';
import { inspectBranchDrift } from './workspace.mjs';
import { inspectWorktreeChanges } from './handoff.mjs';

/**
 * Computes structured operational telemetry for a task.
 * 
 * @param {object} task 
 * @param {DatabaseSync} [db] 
 * @param {string} [repoRoot] 
 * @returns {{ confidence: 'high'|'medium'|'low', evidence: string, uncertainty: string, raw: object }}
 */
export function computeAgentTelemetry(task, db = getDb(), repoRoot = process.cwd()) {
  if (!task || !task.id) {
    return {
      confidence: 'medium',
      evidence: 'No task assigned.',
      uncertainty: 'Idle; awaiting assignment.',
      raw: {}
    };
  }

  const failures = Number(task.consecutive_failures) || 0;
  const maxFailures = Number(task.max_failures) || 3;
  const isBlocked = task.status === 'blocked' || failures >= maxFailures;

  // 1. Fetch recent gate execution evidence
  const gateRuns = db.prepare(`
    SELECT status, exit_code, duration_ms, summary, started_at
    FROM gate_runs
    WHERE task_id = ?
    ORDER BY started_at DESC
    LIMIT 5
  `).all(task.id) || [];

  const passedRuns = gateRuns.filter(r => r.status === 'passed');
  const failedRuns = gateRuns.filter(r => r.status === 'failed');

  // 2. Check worktree drift and uncommitted changes
  const branchName = task.branch_name || `task/${task.id.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const defaultWorktreePath = path.join(repoRoot, '.vibesync', 'worktrees', branchName.slice(5));
  const worktreePath = task.worktree_path || (fs.existsSync(defaultWorktreePath) ? defaultWorktreePath : null);

  const drift = worktreePath ? inspectBranchDrift(worktreePath, repoRoot) : null;
  const changes = worktreePath ? inspectWorktreeChanges(worktreePath, task.base_commit) : { modified: [], untracked: [], diffstat: '' };

  // 3. Compute Confidence
  let confidence = 'medium';
  if (isBlocked || failedRuns.length > passedRuns.length) {
    confidence = 'low';
  } else if (task.status === 'settled') {
    confidence = 'high';
  } else if (passedRuns.length > 0 && failures === 0 && (!drift || drift.behind_trunk === 0)) {
    confidence = 'high';
  } else if (failures > 0 || (drift && drift.behind_trunk > 0)) {
    confidence = 'medium';
  }

  // 4. Compute Evidence String
  let evidence = '';
  if (task.status === 'settled') {
    evidence = `Squash-merged into trunk at ${task.settled_commit ? task.settled_commit.slice(0, 7) : 'HEAD'}. All gates passed.`;
  } else if (gateRuns.length > 0) {
    const last = gateRuns[0];
    const passCount = passedRuns.length;
    const totalCount = gateRuns.length;
    evidence = `${passCount}/${totalCount} recent gates passed. Latest: [${last.status.toUpperCase()}] exit ${last.exit_code ?? 0} (${last.duration_ms}ms) - ${last.summary || 'gate run'}.`;
  } else {
    const gateCount = Array.isArray(task.required_gates) ? task.required_gates.length : 0;
    evidence = `${gateCount} verification gate(s) configured; awaiting first execution.`;
  }

  // 5. Compute Uncertainty String
  const uncertainties = [];
  if (failures > 0) {
    uncertainties.push(`${failures}/${maxFailures} failure strikes recorded`);
  }
  if (drift && drift.behind_trunk > 0) {
    uncertainties.push(`Branch is ${drift.behind_trunk} commit(s) behind trunk${drift.can_merge_cleanly ? '' : ' (merge conflict risk)'}`);
  }
  if (changes.modified.length > 0 || changes.untracked.length > 0) {
    uncertainties.push(`${changes.modified.length} modified, ${changes.untracked.length} untracked files uncommitted`);
  }
  if (task.status === 'blocked') {
    uncertainties.push('Circuit breaker tripped: requires human review or eject');
  }

  const uncertainty = uncertainties.length > 0 ? uncertainties.join('; ') : 'Scope clean; no drift or failure strikes detected.';

  return {
    confidence,
    evidence,
    uncertainty,
    raw: {
      failures,
      maxFailures,
      passedCount: passedRuns.length,
      failedCount: failedRuns.length,
      driftBehind: drift ? drift.behind_trunk : 0,
      canMergeCleanly: drift ? drift.can_merge_cleanly : true,
      modifiedCount: changes.modified.length,
      untrackedCount: changes.untracked.length
    }
  };
}

/**
 * Computes the triaged Human Attention Queue across all active tasks and features.
 * 
 * Categories:
 * - decisions: Human decision required (approvals, human-assigned active lease, handoff requests)
 * - reviews: Verification passed, awaiting final review or feature settlement
 * - blocked: Circuit breaker tripped, merge collisions
 * - inProgress: Active agent leases currently running
 * - fyi: Recently settled tasks or parked incubator records
 * 
 * @param {DatabaseSync} [db] 
 * @param {string} [repoRoot] 
 * @returns {{ decisions: Array, reviews: Array, blocked: Array, inProgress: Array, fyi: Array, counts: object }}
 */
export function computeAttentionQueue(db = getDb(), repoRoot = process.cwd()) {
  const allTasks = db.prepare(`
    SELECT t.*, f.title AS feature_title
    FROM tasks t
    LEFT JOIN features f ON f.id = t.feature_id
    ORDER BY t.updated_at DESC
  `).all() || [];

  const decisions = [];
  const reviews = [];
  const blocked = [];
  const inProgress = [];
  const fyi = [];

  for (const t of allTasks) {
    const task = {
      ...t,
      allowed_paths: typeof t.allowed_paths === 'string' ? JSON.parse(t.allowed_paths || '[]') : (t.allowed_paths || []),
      required_gates: typeof t.required_gates === 'string' ? JSON.parse(t.required_gates || '[]') : (t.required_gates || []),
      labels: typeof t.labels === 'string' ? JSON.parse(t.labels || '[]') : (t.labels || [])
    };

    const telemetry = computeAgentTelemetry(task, db, repoRoot);
    const item = {
      id: task.id,
      title: task.title,
      featureId: task.feature_id,
      featureTitle: task.feature_title || null,
      status: task.status,
      priority: task.priority || 'medium',
      actor: task.assigned_actor || 'unassigned',
      leaseExpiresAt: task.lease_expires_at || null,
      telemetry
    };

    if (task.status === 'blocked' || Number(task.consecutive_failures) >= Number(task.max_failures || 3)) {
      blocked.push({
        ...item,
        reason: `Circuit breaker tripped (${task.consecutive_failures}/${task.max_failures || 3} failures).`
      });
    } else if (task.status === 'review' || task.status === 'verifying') {
      reviews.push({
        ...item,
        reason: 'Verification gates passed; ready for feature settlement or final review.'
      });
    } else if (task.status === 'in_progress') {
      if (task.assigned_actor === 'human') {
        decisions.push({
          ...item,
          reason: 'Human lease active: awaiting developer implementation or settlement.'
        });
      } else {
        inProgress.push({
          ...item,
          reason: `Agent "${task.assigned_actor}" active worktree lease.`
        });
      }
    } else if (task.status === 'settled') {
      fyi.push({
        ...item,
        reason: `Settled into trunk (${task.settled_commit ? task.settled_commit.slice(0, 7) : 'HEAD'}).`
      });
    }
  }

  const topItem = decisions[0] || blocked[0] || reviews[0] || inProgress[0] || null;
  const topAction = topItem ? {
    category: decisions.includes(topItem) ? 'decision' : blocked.includes(topItem) ? 'blocked' : reviews.includes(topItem) ? 'review' : 'in_progress',
    title: topItem.title,
    action: topItem.reason,
    taskId: topItem.id
  } : null;

  const counts = {
    decisions: decisions.length,
    reviews: reviews.length,
    blocked: blocked.length,
    inProgress: inProgress.length,
    fyi: fyi.length,
    totalNeedsAttention: decisions.length + reviews.length + blocked.length,
    total: decisions.length + reviews.length + blocked.length + inProgress.length + fyi.length,
    decisionsCount: decisions.length,
    reviewsCount: reviews.length,
    blockedCount: blocked.length,
    inProgressCount: inProgress.length,
    fyiCount: fyi.length
  };

  return {
    decisions,
    reviews,
    blocked,
    inProgress,
    fyi,
    topAction,
    counts,
    summary: counts
  };
}

/**
 * Formats the Human Attention Queue into a clean terminal ASCII table/summary.
 * 
 * @param {object} queue 
 * @returns {string}
 */
export function formatAttentionQueue(queue) {
  const lines = [
    '================================================================================',
    'VIBESYNC HUMAN ATTENTION QUEUE',
    '================================================================================',
    `Attention Needed: ${queue.counts.totalNeedsAttention} items ` +
    `([🚨 Decisions: ${queue.counts.decisions}] ` +
    `[🔍 Reviews: ${queue.counts.reviews}] ` +
    `[⏸️ Blocked: ${queue.counts.blocked}] ` +
    `[⚡ In Progress: ${queue.counts.inProgress}])`,
    ''
  ];

  if (queue.counts.totalNeedsAttention === 0 && queue.counts.inProgress === 0) {
    lines.push('  ✨ Calm Operations: No tasks currently require human attention or intervention.');
    lines.push('  Run "vibesync --hud" to view project features or "vibesync run" to start a new task.');
  }

  if (queue.decisions.length > 0) {
    lines.push('🚨 [NEEDS DECISION]');
    for (const item of queue.decisions) {
      lines.push(`  • ${item.id}: ${item.title} (${item.priority}) - Actor: ${item.actor}`);
      lines.push(`    Confidence: ${item.telemetry.confidence.toUpperCase()} | ${item.reason}`);
      lines.push(`    👉 Next: vibesync --handoff ${item.id}`);
    }
    lines.push('');
  }

  if (queue.blocked.length > 0) {
    lines.push('⏸️ [BLOCKED - REQUIRES INTERVENTION]');
    for (const item of queue.blocked) {
      lines.push(`  • ${item.id}: ${item.title} - Strikes: ${item.telemetry.raw.failures}/${item.telemetry.raw.maxFailures}`);
      lines.push(`    Risk: ${item.telemetry.uncertainty}`);
      lines.push(`    👉 Take over: vibesync --eject ${item.id}`);
    }
    lines.push('');
  }

  if (queue.reviews.length > 0) {
    lines.push('🔍 [NEEDS REVIEW / READY TO SETTLE]');
    for (const item of queue.reviews) {
      lines.push(`  • ${item.id}: ${item.title} - Evidence: ${item.telemetry.evidence}`);
      lines.push(`    👉 Inspect: vibesync --handoff ${item.id}`);
    }
    lines.push('');
  }

  if (queue.inProgress.length > 0) {
    lines.push('⚡ [IN PROGRESS]');
    for (const item of queue.inProgress) {
      lines.push(`  • ${item.id}: ${item.title} - Actor: ${item.actor} (Confidence: ${item.telemetry.confidence.toUpperCase()})`);
      lines.push(`    Status: ${item.telemetry.evidence}`);
      lines.push(`    Uncertainty: ${item.telemetry.uncertainty}`);
    }
    lines.push('');
  }

  lines.push('================================================================================');
  return lines.join('\n');
}
