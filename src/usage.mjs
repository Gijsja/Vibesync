/**
 * src/usage.mjs
 * 
 * AI Provider Quota & Rolling 5-Hour Usage Engine
 * Computes 5-hour rolling usage %, total usage per provider, active leases,
 * and maintains optional user-configured overrides in .vibesync/usage.json.
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
