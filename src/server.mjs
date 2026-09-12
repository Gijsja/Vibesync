/**
 * src/server.mjs
 * 
 * VibeSync In-Process HTTP & SSE Ambient HUD Server
 * Milestone 3: Stdio MCP Server & Ambient HUD (Features 35–41)
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bundledDashboardPath } from './init.mjs';
import { startTask, getTrunk } from './workspace.mjs';
import { featureInput, taskInput } from './input.mjs';
import { beginOperation, listOperations, assertWorkspaceIdle } from './operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, recordSettlementEvent, readArtifact, checkpointState } from './db.mjs';
import { listTasks, ejectTaskToHuman, createTask, updateTask, supersedeTask, releaseTaskLease, heartbeatTaskLease, checkAndExpireLeases } from './tasks.mjs';
import { listFeatures, createFeature } from './features.mjs';
import { listIncubatorRecords, parkInsight, execGitWithBackoff, promoteIncubatorItem, discardIncubatorItem, getIncubatorItem, mergeIncubatorItems, promoteMultipleIncubatorItems, getConventions } from './incubator.mjs';
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTP_HOST,
  getHudUrlPath,
  getDashboardPath
} from './config.mjs';
import { computeProviderUsage, computeFeatureEfficiency, updateProviderUsageConfig } from './usage.mjs';
import { previewTask, previewFeature, approveTaskCommand } from './policy.mjs';
import { scanSecretEntries } from './secrets.mjs';
import { cleanAbandonedGateSlots } from './scheduler.mjs';
import { buildLeaseRollup, listLeaseRollups } from './audit.mjs';
import { computeAgentTelemetry, computeAttentionQueue } from './telemetry.mjs';
import { generateHandoffCard, performHumanTakeover } from './handoff.mjs';

const mermaidAssetsRoot = fileURLToPath(new URL('./assets/mermaid', import.meta.url));
const workflowAssetPath = fileURLToPath(new URL('./workflow.mjs', import.meta.url));
const hudAssetsRoot = fileURLToPath(new URL('./hud', import.meta.url));

function scanChangedWorkspaceSecrets(repoRoot) {
  const files = execGitWithBackoff(['ls-files', '-m', '-o', '--exclude-standard', '-z'], { cwd: repoRoot, raw: true }).split('\0').filter(Boolean);
  const entries = [];
  for (const file of files) {
    const target = path.resolve(repoRoot, file);
    if (!(target === repoRoot || target.startsWith(repoRoot + path.sep))) continue;
    try {
      if (fs.lstatSync(target).isFile()) entries.push({ file, content: fs.readFileSync(target, 'utf8') });
    } catch {}
  }
  return scanSecretEntries(entries);
}

/**
 * Synthesizes dynamic multi-agent teamwork list from tasks and assigned actors.
 *
 * @param {Array} [tasks=[]]
 * @param {Array|object} [providers=[]]
 * @param {Array} [events=[]]
 * @returns {Array<object>}
 */
export function synthesizeAgents(tasks = [], providers = [], events = [], db = null, repoRoot = process.cwd()) {
  const roleDefs = [
    {
      id: 'team-lead',
      name: '👑 Team Lead',
      role: 'Team Lead',
      deskSlot: 0,
      color: '#06b6d4',
      darkColor: '#0e7490',
      keywords: ['lead', 'orchestrator', 'gemini', 'antigravity']
    },
    {
      id: 'implementer',
      name: '💻 Implementer',
      role: 'Implementer',
      deskSlot: 1,
      color: '#10b981',
      darkColor: '#047857',
      keywords: ['implement', 'coder', 'dev', 'worker', 'codex', 'openai']
    },
    {
      id: 'reviewer',
      name: '🔍 Reviewer',
      role: 'Reviewer',
      deskSlot: 2,
      color: '#c084fc',
      darkColor: '#7e22ce',
      keywords: ['review', 'audit', 'claude', 'anthropic', 'qa', 'verifier', 'gatekeeper']
    },
    {
      id: 'judge',
      name: '⚖️ Judge',
      role: 'Judge',
      deskSlot: 3,
      color: '#f59e0b',
      darkColor: '#b45309',
      keywords: ['judge', 'judicial', 'settle', 'human', 'gate']
    }
  ];

  const agents = roleDefs.map(def => ({
    id: def.id,
    name: def.name,
    role: def.role,
    actorName: '',
    color: def.color,
    darkColor: def.darkColor,
    state: 'idle',
    deskSlot: def.deskSlot,
    activeTask: null,
    hazardBeacon: false
  }));

  for (const t of tasks) {
    if (!t) continue;
    const actor = (t.assigned_actor || '').toLowerCase();
    const isBlocked = t.status === 'blocked' || (Number(t.consecutive_failures) >= 3);
    const isVerifying = t.status === 'review' || t.status === 'verifying' || Boolean(t.verifying);
    const isWorking = t.status === 'in_progress';

    if (!isBlocked && !isVerifying && !isWorking) continue;

    let targetIndex = -1;
    for (let i = 0; i < roleDefs.length; i++) {
      const def = roleDefs[i];
      if (def.keywords.some(k => actor.includes(k)) || actor === def.id || actor === def.role.toLowerCase()) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex === -1 && isVerifying) {
      targetIndex = 2; // Reviewer
    }
    if (targetIndex === -1) {
      if (agents[1].activeTask === null) targetIndex = 1; // Implementer
      else {
        targetIndex = agents.findIndex(a => a.activeTask === null);
        if (targetIndex === -1) targetIndex = 1;
      }
    }

    const ag = agents[targetIndex];
    if (ag.activeTask && isBlocked && ag.state !== 'blocked') {
      // Allow blocked state to override working
    } else if (ag.activeTask) {
      continue;
    }

    ag.actorName = t.assigned_actor || ag.actorName || ag.id;
    if (t.assigned_actor && !ag.name.includes('[')) {
      if (actor.includes('codex')) ag.name = '💻 Implementer [Codex]';
      else if (actor.includes('gemini')) ag.name = '👑 Team Lead [Gemini]';
      else if (actor.includes('claude')) ag.name = '🔍 Reviewer [Claude]';
      else if (actor.includes('human')) ag.name = '⚖️ Judge [Human]';
      else if (t.assigned_actor && t.assigned_actor !== ag.id) ag.name = `${roleDefs[targetIndex].name} [${t.assigned_actor}]`;
    }

    if (isBlocked) {
      ag.state = 'blocked';
      ag.hazardBeacon = true;
    } else if (isVerifying) {
      ag.state = 'verifying';
      ag.hazardBeacon = false;
    } else if (isWorking) {
      ag.state = 'working';
      ag.hazardBeacon = false;
    }

    ag.activeTask = {
      id: t.id,
      title: t.title || '',
      branch: t.branch_name || `task/${t.id.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      status: t.status,
      priority: t.priority || 'medium',
      labels: t.labels || [],
      externalRef: t.external_ref || null,
      consecutiveFailures: Number(t.consecutive_failures) || 0
    };

    ag.telemetry = db ? computeAgentTelemetry(t, db, repoRoot) : {
      confidence: isBlocked ? 'low' : (isWorking ? 'high' : 'medium'),
      evidence: isBlocked ? 'Circuit breaker tripped.' : (isWorking ? 'Active worktree lease.' : 'Awaiting assignment.'),
      uncertainty: isBlocked ? 'Requires human intervention.' : 'None.'
    };

    ag.dialogue = [
      `🎯 ${ag.telemetry.evidence}`,
      `⚡ Confidence: ${ag.telemetry.confidence.toUpperCase()} | Risk: ${ag.telemetry.uncertainty}`,
      `👉 ${isBlocked ? 'Circuit breaker tripped! Take over: vibesync --eject ' + t.id : 'Active branch: ' + ag.activeTask.branch}`
    ];
  }

  const provList = Array.isArray(providers) ? providers : Object.values(providers || {});
  for (const p of provList) {
    if (p && (p.status === 'warning' || p.status === 'critical')) {
      const ag = agents.find(a => (a.actorName && a.actorName.includes(p.id)) || a.id.includes(p.id));
      if (ag && ag.state === 'idle') {
        ag.state = 'cooldown';
      }
    }
  }

  return agents;
}

/**
 * Builds the complete system state payload for HUD rendering and SSE streams.
 * 
 * @param {DatabaseSync} [db=getDb()]
 * @param {string} [repoRoot=process.cwd()]
 * @returns {object}
 */
export function getPayload(db = getDb(), repoRoot = process.cwd()) {
  let gitHead = 'detached';
  try {
    gitHead = execGitWithBackoff(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  } catch {}

  const features = listFeatures(db) || [];
  const operations = listOperations(db);
  if (!operations.some(op => op.status === 'running')) checkAndExpireLeases(db);
  const tasks = (listTasks({}, db) || []).map(task => ({ ...task, verifying: operations.some(op => op.status === 'running' && op.kind === 'task' && op.target_id === task.id) }));
  const incubator = listIncubatorRecords('parked', db) || [];
  const providers = computeProviderUsage(db, repoRoot);
  const gateRuns = db.prepare('SELECT * FROM gate_runs ORDER BY started_at DESC LIMIT 50').all();
  const gateApprovals = db.prepare('SELECT policy_hash, task_id, feature_id, phase, approved_by, approved_at, revoked_at FROM gate_approvals ORDER BY approved_at DESC LIMIT 50').all();
  const leaseRollups = listLeaseRollups({ limit: 25 }, db);

  const events = db.prepare(`
    SELECT * FROM settlement_events
    ORDER BY id DESC
    LIMIT 25
  `).all() || [];
  const featureEfficiency = Object.fromEntries(features.map(feature => [feature.id, computeFeatureEfficiency(feature.id, db)]));

  const agents = synthesizeAgents(tasks, providers, events, db, repoRoot);
  const conventions = getConventions(db) || [];
  const attentionQueue = computeAttentionQueue(db, repoRoot);

  return {
    gitHead,
    operations,
    workspace: { root: fs.realpathSync(repoRoot), name: path.basename(repoRoot) },
    features,
    tasks,
    incubator,
    conventions,
    events,
    featureEfficiency,
    gateRuns,
    gateApprovals,
    leaseRollups,
    providers,
    agents,
    attentionQueue
  };
}

/**
 * Checks if a VibeSync server is already running and responsive on a host/port.
 * 
 * @param {string} host 
 * @param {number} port 
 * @param {number} [timeoutMs=1500] 
 * @returns {Promise<boolean>}
 */
export function probeExistingVibeSync(host, port, timeoutMs = 1500, repoRoot = null) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/state`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 2_000_000) { req.destroy(); resolve(false); }
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && Array.isArray(parsed.features) && Array.isArray(parsed.tasks)) {
            return resolve(!repoRoot || parsed.workspace?.root === fs.realpathSync(repoRoot));
          }
        } catch {}
        resolve(false);
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Starts the in-process HTTP and Server-Sent Events (SSE) server with resilient port negotiation.
 * 
 * @param {object} [options={}]
 * @param {number} [options.port=DEFAULT_HTTP_PORT]
 * @param {string} [options.host=DEFAULT_HTTP_HOST]
 * @param {string} [options.repoRoot=process.cwd()]
 * @param {DatabaseSync} [options.db=getDb()]
 * @param {boolean} [options.quiet=false]
 * @returns {Promise<{ server: http.Server|null, port: number, host: string, isCompanion: boolean, broadcastState: Function, close: Function }>}
 */
export async function startServer(options = {}) {
  const targetPort = options.port !== undefined ? options.port : DEFAULT_HTTP_PORT;
  const host = options.host || DEFAULT_HTTP_HOST;
  const repoRoot = options.repoRoot || process.cwd();
  const db = options.db || getDb(null, repoRoot);
  cleanAbandonedGateSlots(db);
  const quiet = Boolean(options.quiet);

  const clients = new Set();
  let lastMessage = '';
  let stateTimer;

  function broadcastState(force = true) {
    if (force) checkpointState(db);
    if (clients.size === 0) return;
    try {
      const payload = getPayload(db, repoRoot);
      const message = `data: ${JSON.stringify(payload)}\n\n`;
      if (!force && message === lastMessage) return;
      lastMessage = message;
      for (const res of clients) {
        try {
          if (res.writableLength > 1_000_000) {
            clients.delete(res);
            res.destroy();
          } else res.write(message);
        } catch {
          clients.delete(res);
        }
      }
    } catch (err) {
      if (!quiet) process.stderr.write(`[VibeSync Server] broadcastState error: ${err.message}\n`);
    }
  }

  function requestError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
  }

  async function readBodyJson(req) {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw requestError(415, 'Content-Type must be application/json');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        req.resume();
        throw requestError(413, 'Payload too large');
      }
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw requestError(400, 'Invalid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw requestError(400, 'JSON body must be an object');
    }
    return body;
  }

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    let pathname = '';
    try {
      // Pin authority to the actual listener, including when an ephemeral port is used.
      // Host validation also prevents DNS rebinding from exposing the local API.
      const port = httpServer.address().port;
      const hosts = new Set([`${host}:${port}`]);
      if (host === '127.0.0.1' || host === 'localhost') {
        hosts.add(`127.0.0.1:${port}`);
        hosts.add(`localhost:${port}`);
      }
      if (!hosts.has(req.headers.host)) throw requestError(403, 'Untrusted Host');
      const origin = `http://${req.headers.host}`;
      if ((req.headers.origin && req.headers.origin !== origin) ||
          req.headers['sec-fetch-site'] === 'cross-site') {
        throw requestError(403, 'Cross-origin requests are not allowed');
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(req.url, origin);
      } catch {
        throw requestError(400, 'Invalid request URL');
      }
      if (parsedUrl.origin !== origin) throw requestError(403, 'Untrusted request URL');
      pathname = parsedUrl.pathname;
      if (req.method === 'POST') assertWorkspaceIdle(db);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, POST, OPTIONS' });
        return res.end();
      }

      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

      // Bundled browser-only assets. Resolve every request below the Mermaid
      // distribution root so the dashboard works without a CDN, while never
      // exposing arbitrary package files or filesystem paths.
      if (pathname === '/assets/vibesync-workflow.mjs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return fs.createReadStream(workflowAssetPath).pipe(res);
      }
      if (pathname.startsWith('/assets/mermaid/') && req.method === 'GET') {
        let relativePath;
        try { relativePath = decodeURIComponent(pathname.slice('/assets/mermaid/'.length)); } catch { throw requestError(404, 'Asset not found'); }
        if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath) || !relativePath.endsWith('.mjs')) throw requestError(404, 'Asset not found');
        const candidate = path.resolve(mermaidAssetsRoot, relativePath);
        const root = fs.realpathSync(mermaidAssetsRoot);
        let realCandidate;
        try { realCandidate = fs.realpathSync(candidate); } catch { throw requestError(404, 'Asset not found'); }
        if (!realCandidate.startsWith(root + path.sep) || !fs.statSync(realCandidate).isFile()) throw requestError(404, 'Asset not found');
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return fs.createReadStream(realCandidate).pipe(res);
      }

      if (pathname.startsWith('/assets/hud/') && req.method === 'GET') {
        let relativePath;
        try { relativePath = decodeURIComponent(pathname.slice('/assets/hud/'.length)); } catch { throw requestError(404, 'Asset not found'); }
        if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) throw requestError(404, 'Asset not found');
        const allowedExts = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };
        const ext = path.extname(relativePath).toLowerCase();
        if (!allowedExts[ext]) throw requestError(404, 'Asset not found');
        const candidate = path.resolve(hudAssetsRoot, relativePath);
        const root = fs.realpathSync(hudAssetsRoot);
        let realCandidate;
        try { realCandidate = fs.realpathSync(candidate); } catch { throw requestError(404, 'Asset not found'); }
        if (!realCandidate.startsWith(root + path.sep) || !fs.statSync(realCandidate).isFile()) throw requestError(404, 'Asset not found');
        res.writeHead(200, { 'Content-Type': allowedExts[ext] });
        return fs.createReadStream(realCandidate).pipe(res);
      }

      // 1. Static Dashboard serving
      if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        const localDashboardPath = getDashboardPath(repoRoot);
        const dashboardPath = fs.existsSync(localDashboardPath) ? localDashboardPath : bundledDashboardPath;
        if (fs.existsSync(dashboardPath)) {
          let content = fs.readFileSync(dashboardPath, 'utf8');
          try {
            const payload = getPayload(db, repoRoot);
            content = content.replace('/*__INITIAL_STATE_PLACEHOLDER__*/', () => `window.__INITIAL_STATE__ = ${JSON.stringify(payload).replace(/</g, '\\u003c')};`);
          } catch {}
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(content);
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<!DOCTYPE html><html><body><h1>VibeSync Control Deck</h1><p>Dashboard HTML not found at the configured location</p></body></html>');
        }
      }

      // 2. State Snapshot API
      if (pathname === '/api/state' && req.method === 'GET') {
        const payload = getPayload(db, repoRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload, null, 2));
      }

      // Attention Queue API
      if (pathname === '/api/queue' && req.method === 'GET') {
        const queue = computeAttentionQueue(db, repoRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(queue, null, 2));
      }

      // Human Handoff Card API
      const handoffMatch = pathname.match(/^\/api\/handoff(?:\/([A-Za-z0-9-_]+))?$/);
      if (handoffMatch && req.method === 'GET') {
        const taskId = handoffMatch[1] || parsedUrl.searchParams.get('taskId') || null;
        const format = parsedUrl.searchParams.get('format') || 'json';
        try {
          const card = generateHandoffCard({ taskId, db, repoRoot, format });
          if (format === 'markdown' || format === 'text') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(card);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(card, null, 2));
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      }

      const leaseRollupMatch = pathname.match(/^\/api\/leases\/([A-Za-z0-9-]+)\/rollup$/);
      if (leaseRollupMatch && req.method === 'GET') {
        const rollup = buildLeaseRollup(leaseRollupMatch[1], db);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(rollup, null, 2));
      }

      // 3. Server-Sent Events (SSE) Stream
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        // Send initial state immediately
        const payload = getPayload(db, repoRoot);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);

        clients.add(res);

        req.on('close', () => {
          clients.delete(res);
        });
        return;
      }

      // 4. POST /api/eject or POST /api/tasks/:id/eject -> Eject agent lease to human
      const taskEjectMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9-_]+)\/eject$/);
      if ((pathname === '/api/eject' || taskEjectMatch) && req.method === 'POST') {
        let taskId = taskEjectMatch ? taskEjectMatch[1] : null;
        if (!taskId || (req.headers['content-type'] && req.headers['content-type'].includes('application/json'))) {
          try {
            const body = await readBodyJson(req);
            if (body && body.taskId) taskId = body.taskId;
          } catch (e) {
            if (!taskId) throw e;
          }
        }
        if (!taskId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing required field: taskId' }));
        }

        const updatedTask = performHumanTakeover(taskId, db, repoRoot);
        broadcastState();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, task: updatedTask }));
      }

      // 5. POST /api/park -> Park off-task idea into incubator
      if (pathname === '/api/park' && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (!body.title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing required field: title' }));
        }

        const result = parkInsight({
          id: body.id,
          title: body.title,
          category: body.category || 'speculative_feature',
          target_scope: body.target_scope || body.targetScope,
          context_notes: body.context_notes || body.notes || '',
          logged_by: body.logged_by || 'human'
        }, db, repoRoot);

        broadcastState();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          id: result.id,
          coalesced: Boolean(result.coalesced),
          commitSha: result.commitSha
        }));
      }

      if (pathname === '/api/hotfix/preview' && req.method === 'GET') {
        const branch = execGitWithBackoff(['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
        const trunk = getTrunk(repoRoot);
        const head = execGitWithBackoff(['rev-parse', 'HEAD'], { cwd: repoRoot });
        const status = execGitWithBackoff(['status', '--short', '-uall'], { cwd: repoRoot });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const secretFindings = scanChangedWorkspaceSecrets(repoRoot);
        return res.end(JSON.stringify({ branch, trunk, head, status, secretFindings, canCommit: branch === trunk && secretFindings.length === 0 }));
      }

      // 6. POST /api/hotfix -> Emergency hotfix commit direct to main
      if (pathname === '/api/hotfix' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const message = body.message ?? 'emergency hotfix';
        if (typeof message !== 'string' || !message.trim() || message.length > 10_000 || message.includes('\0')) {
          throw requestError(400, 'message must be a non-empty string of at most 10000 characters');
        }

        const currentBranch = execGitWithBackoff(['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
        if (currentBranch !== getTrunk(repoRoot)) throw requestError(409, 'Switch the repository to its trunk branch before making a hotfix.');
        if (body.expectedHead && body.expectedHead !== execGitWithBackoff(['rev-parse', 'HEAD'], { cwd: repoRoot })) throw requestError(409, 'Trunk changed since preview. Reopen the hotfix preview.');
        const secretFindings = scanChangedWorkspaceSecrets(repoRoot);
        if (secretFindings.length) throw requestError(409, `Potential secrets detected; hotfix was not staged: ${secretFindings.map(item => `${item.file} (${item.code})`).join(', ')}.`);
        try {
          execGitWithBackoff(['add', '-A'], { cwd: repoRoot });
          execGitWithBackoff(['commit', '--allow-empty', '-F', '-'], { cwd: repoRoot, input: `hotfix: ${message}` });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Git commit failed: ${e.message}` }));
        }

        let settledSha = 'HEAD';
        try {
          settledSha = execGitWithBackoff(['rev-parse', 'HEAD'], { cwd: repoRoot });
        } catch {}

        recordSettlementEvent(db, {
          actor: 'human',
          action: 'task_settled',
          commit_ref: settledSha,
          evidence_payload: { message, hotfix: true }
        });

        broadcastState();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, commitSha: settledSha }));
      }

      // 7. POST /api/features -> Create or register a new feature contract
      if ((pathname === '/api/features' || pathname === '/api/features/create') && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (!body.id || !body.title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing required fields: id and title' }));
        }

        if (body.incubator_id) {
          const idea = getIncubatorItem(body.incubator_id, db);
          if (!idea || idea.status !== 'parked') throw requestError(409, 'This idea is no longer parked.');
        }

        const feature = createFeature(featureInput(body), db);

        if (body.incubator_id) promoteIncubatorItem({ id: body.incubator_id, featureId: feature.id }, db, repoRoot);
        broadcastState();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, feature }));
      }

      // 8. POST /api/tasks -> Create or register a new task
      if ((pathname === '/api/tasks' || pathname === '/api/tasks/create') && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (!body.id || !body.feature_id || !body.title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing required fields: id, feature_id, and title' }));
        }

        const input = taskInput(body);
        const parent = db.prepare('SELECT status FROM features WHERE id = ?').get(input.feature_id);
        if (!parent) throw requestError(404, 'Parent feature not found.');
        if (parent.status === 'settled') throw requestError(409, 'Cannot add tasks to a settled feature.');
        const task = createTask(input, db);

        if (body.assigned_actor) {
          updateTask(task.id, { assigned_actor: body.assigned_actor }, db);
          task.assigned_actor = body.assigned_actor;
        }

        broadcastState();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, task }));
      }

      if ((pathname === '/api/tasks/verify' || pathname === '/api/features/settle') && req.method === 'POST') {
        const body = await readBodyJson(req);
        const kind = pathname === '/api/tasks/verify' ? 'task' : 'feature';
        const targetId = kind === 'task' ? body.taskId : body.featureId;
        const table = kind === 'task' ? 'tasks' : 'features';
        const target = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(targetId);
        if (!target) throw requestError(404, `${kind} not found.`);
        if (kind === 'task' && target.status !== 'in_progress') throw requestError(409, 'Start the task before verification.');
        if (target.status === 'settled') throw requestError(409, 'Already settled.');
        const operation = beginOperation(kind, targetId, body.actorName || target.assigned_actor || 'human', db, repoRoot, broadcastState);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, operationId: operation.id }));
      }

      // Lifecycle controls use persisted IDs, never interpolated shell commands.
      if (pathname === '/api/tasks/preview' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const result = previewTask({ taskId: body.taskId, actorName: body.actorName || 'unknown' }, db, repoRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      if (pathname === '/api/tasks/approve' && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (typeof body.taskId !== 'string' || !body.taskId.trim()) {
          throw requestError(400, 'taskId must be a non-empty string.');
        }
        if (!['setup', 'gate', 'feature'].includes(body.phase)) {
          throw requestError(400, 'phase must be setup, gate, or feature.');
        }
        if (!Number.isInteger(body.index) || body.index < 0) {
          throw requestError(400, 'index must be a non-negative integer.');
        }
        if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(body.taskId)) {
          throw requestError(404, `Task ${body.taskId} not found.`);
        }

        // The loopback HUD is the human administration surface. Never accept an
        // actor supplied by browser input for this authority-bearing mutation.
        const preview = previewTask({ taskId: body.taskId, actorName: 'human' }, db, repoRoot);
        const command = preview.commands.find(item => item.phase === body.phase && item.index === body.index);
        if (!command) throw requestError(400, `No ${body.phase} command exists at index ${body.index}.`);

        const result = approveTaskCommand({
          taskId: body.taskId,
          phase: body.phase,
          index: body.index,
          approvedBy: 'human'
        }, db, repoRoot);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ...result,
          command: { phase: command.phase, index: command.index, display: command.display, policyHash: command.policyHash }
        }));
      }
      if (pathname === '/api/features/preview' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const result = previewFeature({ featureId: body.featureId, actorName: body.actorName || 'unknown' }, db, repoRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      if (pathname === '/api/tasks/claim' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const result = startTask({ taskId: body.taskId, actorName: body.actorName || 'human' }, db, repoRoot);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      if (pathname === '/api/tasks/heartbeat' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const result = heartbeatTaskLease({ taskId: body.taskId, actorName: body.actorName, leaseToken: body.leaseToken, worktreePath: body.worktreePath, repoRoot }, db);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      if (pathname === '/api/tasks/release' && req.method === 'POST') {
        const body = await readBodyJson(req);
        releaseTaskLease(body.taskId, db);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      }
      if (pathname === '/api/tasks/supersede' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const task = supersedeTask({
          taskId: body.taskId,
          replacementTaskId: body.replacementTaskId,
          actorName: body.actorName || 'human'
        }, db);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, task }));
      }
      if (pathname === '/api/incubator/discard' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const result = discardIncubatorItem({ id: body.id }, db, repoRoot);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, ...result }));
      }
      if (pathname === '/api/incubator/merge' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const sourceIds = body.source_ids || body.sourceIds;
        if (!sourceIds || !Array.isArray(sourceIds) || sourceIds.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'sourceIds (or source_ids) must be a non-empty array' }));
        }
        const result = mergeIncubatorItems({
          sourceIds,
          targetId: body.target_id || body.targetId,
          mergedTitle: body.merged_title || body.mergedTitle,
          mergedNotes: body.merged_notes || body.mergedNotes,
          category: body.category,
          actorName: body.actorName || body.actor_name || 'human'
        }, db, repoRoot);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          targetId: result.targetId,
          target_id: result.targetId,
          merged_id: result.targetId,
          mergedCount: result.mergedCount,
          commitSha: result.commitSha
        }));
      }
      if (pathname === '/api/incubator/promote-batch' && req.method === 'POST') {
        const body = await readBodyJson(req);
        const ids = body.incubator_ids || body.ids;
        const featureId = body.feature_id || body.featureId;
        if (!ids || !Array.isArray(ids) || ids.length === 0 || !featureId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing required fields: ids (or incubator_ids array) and featureId (or feature_id)' }));
        }
        // If feature doesn't exist but feature_title provided, create it automatically
        let feature = db.prepare('SELECT id FROM features WHERE id = ?').get(featureId);
        if (!feature && (body.feature_title || body.title)) {
          createFeature({
            id: featureId,
            title: body.feature_title || body.title,
            target_milestone: body.target_milestone || body.milestone || 'backlog',
            spec_markdown: body.spec_markdown || 'Promoted from incubator'
          }, db);
          feature = { id: featureId };
        }
        const result = promoteMultipleIncubatorItems({
          ids,
          featureId,
          actorName: body.actorName || body.actor_name || 'human'
        }, db, repoRoot);
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          feature: { id: featureId },
          promoted_ids: result.promotedIds,
          commit_sha: result.commitSha,
          ...result
        }));
      }

      // Logs are linked by artifact hash in the ledger, not by task ID in filenames.
      if (pathname === '/api/logs' && req.method === 'GET') {
        const taskId = parsedUrl.searchParams.get('taskId');
        const events = taskId
          ? db.prepare('SELECT * FROM settlement_events WHERE task_id = ? ORDER BY id DESC LIMIT 25').all(taskId)
          : db.prepare('SELECT * FROM settlement_events ORDER BY id DESC LIMIT 25').all();
        const logs = [];
        const seen = new Set();
        for (const event of events) {
          if (!event.artifact_hash || seen.has(event.artifact_hash)) continue;
          seen.add(event.artifact_hash);
          const content = readArtifact(event.artifact_hash, repoRoot);
          if (content !== null) logs.push({ file: `${event.artifact_hash}.log`, content: content.slice(0, 100_000) });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ taskId, logs, events }));
      }

      // 10. POST /api/usage -> Update provider usage / quotas
      if (pathname === '/api/usage' && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (body.provider) {
          updateProviderUsageConfig({ [body.provider]: body }, repoRoot);
        } else if (body && typeof body === 'object') {
          updateProviderUsageConfig(body, repoRoot);
        }
        broadcastState();
        const updated = computeProviderUsage(db, repoRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, providers: updated }));
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Endpoint not found: ${pathname}` }));

    } catch (err) {
      if (!err.statusCode && /UNIQUE constraint failed/.test(err.message)) { err.statusCode = 409; err.message = 'That ID already exists. Choose another ID.'; }
      if (!quiet) process.stderr.write(`[VibeSync Server] Request error [${pathname}]: ${err.stack || err.message}\n`);
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.statusCode ? err.message : 'Internal server error' }));
      } else {
        res.end();
      }
    }
  });

  // Attempt to listen on ports with resilient fallback
  let listenPort = targetPort;
  let attempts = 0;

  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    try {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(listenPort, host, () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      });

      stateTimer = setInterval(() => broadcastState(false), 1000);
      stateTimer.unref();

      // Successfully bound
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;

      // Save HUD url
      try {
        const hudUrlPath = getHudUrlPath(repoRoot);
        const hudDir = path.dirname(hudUrlPath);
        if (!fs.existsSync(hudDir)) fs.mkdirSync(hudDir, { recursive: true });
        fs.writeFileSync(hudUrlPath, `http://${host}:${actualPort}\n`, 'utf8');
      } catch {}

      if (!quiet) {
        process.stderr.write(`[VibeSync] Ambient Control HUD listening at http://${host}:${actualPort}\n`);
      }

      return {
        server: httpServer,
        port: actualPort,
        host,
        isCompanion: false,
        broadcastState,
        close: () => new Promise((resolve) => {
          for (const c of clients) {
            try { c.end(); } catch {}
          }
          clients.clear();
          clearInterval(stateTimer);
          httpServer.closeAllConnections();
          httpServer.close(() => resolve());
        })
      };

    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        // Probe if the running service is a sibling VibeSync instance
        const isVibeSync = await probeExistingVibeSync(host, listenPort, 1500, repoRoot);
        if (isVibeSync) {
          if (!quiet) {
            process.stderr.write(`[VibeSync] Sibling Control HUD detected active at http://${host}:${listenPort}; operating as companion process.\n`);
          }
          try {
            const hudUrlPath = getHudUrlPath(repoRoot);
            fs.writeFileSync(hudUrlPath, `http://${host}:${listenPort}\n`, 'utf8');
          } catch {}

          return {
            server: null,
            port: listenPort,
            host,
            isCompanion: true,
            broadcastState: () => {},
            close: () => Promise.resolve()
          };
        }

        // Otherwise try next port
        listenPort++;
        attempts++;
      } else {
        throw err;
      }
    }
  }

  // If all preferred ports exhausted, bind port 0 (OS random free port)
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, host, () => {
      httpServer.removeListener('error', reject);
      stateTimer = setInterval(() => broadcastState(false), 1000);
      stateTimer.unref();
      const addr = httpServer.address();
      const actualPort = addr.port;
      try {
        fs.writeFileSync(getHudUrlPath(repoRoot), `http://${host}:${actualPort}\n`, 'utf8');
      } catch {}

      return resolve({
        server: httpServer,
        port: actualPort,
        host,
        isCompanion: false,
        broadcastState,
        close: () => new Promise((res) => {
          for (const c of clients) {
            try { c.end(); } catch {}
          }
          clients.clear();
          clearInterval(stateTimer);
          httpServer.closeAllConnections();
          httpServer.close(() => res());
        })
      });
    });
  });
}
