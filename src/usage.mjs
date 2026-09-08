/**
 * src/usage.mjs
 *
 * AI Provider Quota & Rolling 5-Hour Usage Engine
 * Computes 5-hour rolling usage %, total usage per provider, active leases,
 * and maintains optional user-configured overrides in .vibesync/usage.json.
 *
 * Also exports task-level efficiency metrics derived from settlement_events
 * and gate_runs using lease-run correlation (computeTaskEfficiency,
 * computeFeatureEfficiency). Provider token/cost fields are nullable and only
 * populated from real provider evidence — never synthesised from activity counts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROVIDERS, getUsageConfigPath } from './config.mjs';
import { getDb } from './db.mjs';

/**
 * Matches an actor string to a known provider definition.
 * 
 * @param {string} actorName 
 * @param {Array<object>} [providers=DEFAULT_PROVIDERS]
 * @returns {object|null}
 */
export function matchProvider(actorName, providers = DEFAULT_PROVIDERS) {
  if (!actorName || typeof actorName !== 'string') return null;
  const lower = actorName.toLowerCase().trim();

  for (const prov of providers) {
    if (prov.aliases.some(alias => lower.includes(alias))) {
      return prov;
    }
  }
  return null;
}

/**
 * Reads user or agent overrides from .vibesync/usage.json if present.
 * 
 * @param {string} [repoRoot=process.cwd()] 
 * @returns {object}
 */
export function readUsageConfigFile(repoRoot = process.cwd()) {
  try {
    const configPath = getUsageConfigPath(repoRoot);
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch {}
  return {};
}

/**
 * Saves or updates usage configuration in .vibesync/usage.json.
 * 
 * @param {object} updates 
 * @param {string} [repoRoot=process.cwd()] 
 * @returns {object}
 */
export function updateProviderUsageConfig(updates, repoRoot = process.cwd()) {
  const current = readUsageConfigFile(repoRoot);
  const next = { ...current, ...updates };

  try {
    const configPath = getUsageConfigPath(repoRoot);
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[VibeSync Usage] Failed to save usage config: ${err.message}\n`);
  }

  return next;
}

/**
 * Computes live 5-hour usage %, total usage, active tasks, and status for each provider.
 * 
 * @param {DatabaseSync} [db=getDb()]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {Array<object>}
 */
export function computeProviderUsage(db = getDb(), repoRoot = process.cwd()) {
  const overrides = readUsageConfigFile(repoRoot);

  // 1. Query settlement_events within 5-hour window
  let events5h = [];
  try {
    events5h = db.prepare(`
      SELECT actor, COUNT(*) as count
      FROM settlement_events
      WHERE timestamp >= datetime('now', '-5 hours')
      GROUP BY actor
    `).all() || [];
  } catch {}

  // 2. Query all-time settlement_events
  let eventsTotal = [];
  try {
    eventsTotal = db.prepare(`
      SELECT actor, COUNT(*) as count
      FROM settlement_events
      GROUP BY actor
    `).all() || [];
  } catch {}

  // 3. Query tasks breakdown by actor & status
  let taskStats = [];
  try {
    taskStats = db.prepare(`
      SELECT assigned_actor, status, COUNT(*) as count
      FROM tasks
      WHERE assigned_actor IS NOT NULL
      GROUP BY assigned_actor, status
    `).all() || [];
  } catch {}

  // 4. Query incubator ideas by actor
  let incubatorStats = [];
  try {
    incubatorStats = db.prepare(`
      SELECT logged_by, COUNT(*) as count
      FROM incubator
      GROUP BY logged_by
    `).all() || [];
  } catch {}

  // Build metrics for each default provider
  return DEFAULT_PROVIDERS.map(prov => {
    const override = overrides[prov.id] || overrides[prov.actorName] || {};

    // Match 5h events
    let used5hDb = 0;
    for (const row of events5h) {
      if (prov.aliases.some(alias => (row.actor || '').toLowerCase().includes(alias))) {
        used5hDb += Number(row.count || 0);
      }
    }

    // Match all-time events
    let totalEventsDb = 0;
    for (const row of eventsTotal) {
      if (prov.aliases.some(alias => (row.actor || '').toLowerCase().includes(alias))) {
        totalEventsDb += Number(row.count || 0);
      }
    }

    // Match tasks
    let activeTasks = 0;
    let settledTasks = 0;
    let blockedTasks = 0;
    let totalTasks = 0;

    for (const row of taskStats) {
      if (prov.aliases.some(alias => (row.assigned_actor || '').toLowerCase().includes(alias))) {
        const count = Number(row.count || 0);
        totalTasks += count;
        if (row.status === 'in_progress') activeTasks += count;
        if (row.status === 'settled') settledTasks += count;
        if (row.status === 'blocked') blockedTasks += count;
      }
    }

    // Match incubator
    let incubatorCount = 0;
    for (const row of incubatorStats) {
      if (prov.aliases.some(alias => (row.logged_by || '').toLowerCase().includes(alias))) {
        incubatorCount += Number(row.count || 0);
      }
    }

    const limit5h = override.limit5h !== undefined ? Number(override.limit5h) : prov.limit5h;
    const baseUsed5h = override.used5h !== undefined ? Number(override.used5h) : (override.baseUsed5h || 0);
    const baseTotal = override.totalUsage !== undefined ? Number(override.totalUsage) : (override.baseTotal || 0);

    const used5h = baseUsed5h + used5hDb;
    const totalUsage = baseTotal + totalEventsDb + totalTasks + incubatorCount;

    const usage5hPct = limit5h > 0
      ? Math.min(100, Math.round((used5h / limit5h) * 100))
      : 0;

    let status = 'normal';
    if (usage5hPct >= 90) {
      status = 'critical';
    } else if (usage5hPct >= 70) {
      status = 'warning';
    }

    return {
      id: prov.id,
      name: prov.name,
      actorName: prov.actorName,
      icon: prov.icon,
      color: prov.color,
      unit: override.unit || prov.unit || 'req',
      used5h,
      limit5h,
      usage5hPct,
      totalUsage,
      activeTasks,
      settledTasks,
      blockedTasks,
      totalTasks,
      incubatorCount,
      status,
      window: '5-hour rolling',
      resetsIn: 'Rolling continuously'
    };
  });
}

/**
 * Computes task-level efficiency metrics for a single task by correlating
 * settlement_events and gate_runs via lease_run_id.
 *
 * Derived values (time_to_settle_ms, verification_attempts, etc.) are present
 * when the underlying events exist. Missing data is null — never zero or fabricated.
 * Provider token/cost fields (tokens_used, cost_usd) are always null unless
 * populated from real provider API evidence in the evidence_payload.
 *
 * @param {string} taskId
 * @param {DatabaseSync} [db=getDb()]
 * @returns {object} Efficiency record for the task.
 */
export function computeTaskEfficiency(taskId, db = getDb()) {
  if (!taskId || typeof taskId !== 'string') throw new Error('taskId is required');

  const task = db.prepare(
    'SELECT id, feature_id, title, status, assigned_actor, created_at, updated_at, lease_run_id, model_hint FROM tasks WHERE id = ?'
  ).get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  // --- Claim and settle timestamps from settlement_events ---
  const claimEvent = db.prepare(
    "SELECT timestamp, actor, lease_run_id FROM settlement_events WHERE task_id = ? AND action = 'task_claimed' ORDER BY id ASC LIMIT 1"
  ).get(taskId);

  const settleEvent = db.prepare(
    "SELECT timestamp, actor, lease_run_id FROM settlement_events WHERE task_id = ? AND action = 'task_settled' ORDER BY id DESC LIMIT 1"
  ).get(taskId);

  const firstClaimedAt = claimEvent?.timestamp ?? null;
  const settledAt = settleEvent?.timestamp ?? null;

  let timeToSettleMs = null;
  if (firstClaimedAt && settledAt) {
    const claimMs = new Date(firstClaimedAt).getTime();
    const settleMs = new Date(settledAt).getTime();
    if (!Number.isNaN(claimMs) && !Number.isNaN(settleMs) && settleMs >= claimMs) {
      timeToSettleMs = settleMs - claimMs;
    }
  }

  // --- Lease-run handoffs: distinct lease_run_ids from settlement_events ---
  const leaseRunRows = db.prepare(
    "SELECT DISTINCT lease_run_id FROM settlement_events WHERE task_id = ? AND lease_run_id IS NOT NULL ORDER BY id ASC"
  ).all(taskId);
  const leaseRunIds = leaseRunRows.map(r => r.lease_run_id);
  const handoffCount = leaseRunIds.length > 1 ? leaseRunIds.length - 1 : 0;

  // --- Gate runs: verification attempts and failures ---
  const gateRuns = db.prepare(
    "SELECT status, phase, gate_index, duration_ms, exit_code, evidence_payload FROM gate_runs WHERE task_id = ? AND phase IN ('gate', 'partial') ORDER BY started_at ASC"
  ).all(taskId);

  const verificationAttempts = gateRuns.filter(r => r.phase === 'gate').length;
  const failedGates = gateRuns.filter(r => r.phase === 'gate' && r.status === 'failed').length;
  const passedGates = gateRuns.filter(r => r.phase === 'gate' && r.status === 'passed').length;
  const partialVerifications = gateRuns.filter(r => r.phase === 'partial').length;

  const totalGateDurationMs = gateRuns.reduce((sum, r) => sum + (r.duration_ms || 0), 0);

  // --- Explicit handoff events recorded ---
  const handoffEvents = db.prepare(
    "SELECT COUNT(*) AS count FROM settlement_events WHERE task_id = ? AND action IN ('lease_handoff_requested', 'ejected_to_human')"
  ).get(taskId)?.count ?? 0;

  // --- Provider tokens/cost: only from real provider evidence, always null otherwise ---
  let tokensUsed = null;
  let costUsd = null;
  for (const run of gateRuns) {
    try {
      const ev = run.evidence_payload ? JSON.parse(run.evidence_payload) : null;
      if (ev?.tokens_used !== undefined && ev.tokens_used !== null) {
        tokensUsed = (tokensUsed ?? 0) + Number(ev.tokens_used);
      }
      if (ev?.cost_usd !== undefined && ev.cost_usd !== null) {
        costUsd = (costUsd ?? 0) + Number(ev.cost_usd);
      }
    } catch { /* malformed payload — skip */ }
  }

  return {
    task_id: task.id,
    feature_id: task.feature_id,
    title: task.title,
    status: task.status,
    actor: task.assigned_actor ?? null,
    model_hint: task.model_hint ?? null,
    // Timing — null when not yet claimed or not yet settled
    first_claimed_at: firstClaimedAt,
    settled_at: settledAt,
    time_to_settle_ms: timeToSettleMs,
    // Gate evidence
    verification_attempts: verificationAttempts,
    failed_gates: failedGates,
    passed_gates: passedGates,
    partial_verifications: partialVerifications,
    total_gate_duration_ms: totalGateDurationMs || null,
    // Lease runs / handoffs
    lease_run_ids: leaseRunIds,
    handoff_count: handoffCount,
    explicit_handoff_events: handoffEvents,
    // Provider billing — only from real provider evidence
    tokens_used: tokensUsed,
    cost_usd: costUsd
  };
}

/**
 * Computes efficiency metrics for every task in a feature, in order.
 *
 * @param {string} featureId
 * @param {DatabaseSync} [db=getDb()]
 * @returns {Array<object>}
 */
export function computeFeatureEfficiency(featureId, db = getDb()) {
  if (!featureId || typeof featureId !== 'string') throw new Error('featureId is required');
  const tasks = db.prepare(
    "SELECT id FROM tasks WHERE feature_id = ? ORDER BY created_at ASC, id ASC"
  ).all(featureId);
  return tasks.map(t => computeTaskEfficiency(t.id, db));
}
