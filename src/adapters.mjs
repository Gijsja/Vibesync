import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getDb, readArtifact, saveArtifact } from './db.mjs';
import { getTask, releaseTaskLease, heartbeatTaskLease } from './tasks.mjs';
import { startTask } from './workspace.mjs';
import { getExecutionPolicy, identifyModelProfile } from './policy.mjs';
import { redactSensitive } from './commands.mjs';

export const ADAPTER_IDS = Object.freeze(['gemini', 'claude', 'codex', 'local']);
const runs = new Map();
const MAX_OUTPUT_PREVIEW_BYTES = 16 * 1024;

function outputPayload(state) {
  return {
    version: 1,
    stderr: redactSensitive(state.stderr),
    stdout: redactSensitive(state.stdout),
    retained_bytes: state.retainedBytes,
    dropped_bytes: state.droppedBytes,
    limit_bytes: state.outputLimitBytes,
    truncated: state.droppedBytes > 0
  };
}

function persistOutput(state, repoRoot) {
  if (state.outputArtifactHash) return state.outputArtifactHash;
  state.outputArtifactHash = saveArtifact(outputPayload(state), repoRoot);
  return state.outputArtifactHash;
}

function removePrivateRunFiles(state) {
  try { fs.rmSync(path.dirname(state.contextFile), { recursive: true, force: true }); } catch {}
}

function appendOutput(state, key, chunk) {
  const bytes = Buffer.from(chunk);
  const remaining = Math.max(0, state.outputLimitBytes - state.retainedBytes);
  const retained = bytes.subarray(0, remaining);
  state[key] += retained.toString();
  state.retainedBytes += retained.length;
  state.droppedBytes += bytes.length - retained.length;
}

function safeConfig(id, raw = {}) {
  if (!ADAPTER_IDS.includes(id)) throw new Error(`Unsupported adapter: ${id}.`);
  if (typeof raw.executable !== 'string' || !raw.executable || raw.executable.includes('\0')) throw new Error(`Adapter ${id} requires a NUL-free executable.`);
  const argv = raw.argv_template || [];
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string' || item.includes('\0'))) throw new Error(`Adapter ${id} argv_template must be an array of NUL-free strings.`);
  const allowedEnv = raw.allowed_env || [];
  if (!Array.isArray(allowedEnv) || allowedEnv.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error(`Adapter ${id} allowed_env contains an invalid name.`);
  const timeoutMs = raw.timeout_ms ?? 3600000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new Error(`Adapter ${id} timeout_ms is invalid.`);
  return { id, executable: raw.executable, argvTemplate: argv, allowedEnv, timeoutMs,
    resourceClass: raw.resource_class || identifyModelProfile(id).resourceClass, priority: Number(raw.priority) || 100,
    probeArgs: Array.isArray(raw.probe_args) ? raw.probe_args : ['--version'] };
}

function sanitized(value) {
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|secret|password|credential|authorization|private.?key/i.test(key))
    .map(([key, item]) => [key, sanitized(item)]));
  return value;
}

function expandArgs(template, values) {
  return template.map(argument => argument.replace(/\{(context_file|worktree|task_id|actor)\}/g, (_, key) => values[key]));
}

export class AdapterProcess {
  constructor(id, config) { this.id = id; this.config = safeConfig(id, config); }

  probe() {
    const result = spawnSync(this.config.executable, this.config.probeArgs, { shell: false, encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8' } });
    return { available: result.status === 0 && !result.error, adapter: this.id,
      version: redactSensitive((result.stdout || result.stderr || '').trim()).slice(0, 500), error: result.error?.message || null };
  }

  start({ task, worktreePath, actorName, context = {}, repoRoot = process.cwd(), supervisorHeartbeat = null, heartbeatEveryMs = null }) {
    const runId = randomUUID();
    const runDir = path.join(repoRoot, '.vibesync', 'adapter-runs', runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const contextFile = path.join(runDir, 'context.json');
    fs.writeFileSync(contextFile, JSON.stringify(sanitized({ version: 1, adapter: this.id, actor: actorName,
      task, worktree_path: worktreePath, heartbeat: { supervised_by: 'vibesync' }, ...context }), null, 2), { mode: 0o600 });
    const values = { context_file: contextFile, worktree: worktreePath, task_id: task.id, actor: actorName };
    const argv = expandArgs(this.config.argvTemplate, values);
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8' };
    for (const name of this.config.allowedEnv) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(this.config.executable, argv, { cwd: worktreePath, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const outputLimitBytes = getExecutionPolicy(repoRoot).resource_policy.output_limit_bytes;
    const state = { runId, adapter: this.id, actorName, taskId: task.id, worktreePath, contextFile, child, repoRoot,
      status: 'running', pid: child.pid || null, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, signal: null,
      stdout: '', stderr: '', outputLimitBytes, retainedBytes: 0, droppedBytes: 0, outputArtifactHash: null, timeout: null, heartbeatTimer: null };
    child.stdout?.on('data', chunk => appendOutput(state, 'stdout', chunk));
    child.stderr?.on('data', chunk => appendOutput(state, 'stderr', chunk));
    child.on('error', error => { state.status = 'failed'; appendOutput(state, 'stderr', Buffer.from(error.message)); state.finishedAt = new Date().toISOString(); persistOutput(state, repoRoot); });
    child.on('close', (code, signal) => { state.exitCode = code; state.signal = signal;
      if (state.status !== 'failed' && state.status !== 'cancelled') state.status = code === 0 ? 'completed' : 'failed';
      state.finishedAt = new Date().toISOString(); clearTimeout(state.timeout); clearInterval(state.heartbeatTimer); persistOutput(state, repoRoot);
      if (state.status === 'cancelled') removePrivateRunFiles(state); });
    state.timeout = setTimeout(() => { state.status = 'failed'; appendOutput(state, 'stderr', Buffer.from(`\nAdapter timed out after ${this.config.timeoutMs}ms`)); child.kill('SIGTERM'); }, this.config.timeoutMs);
    state.timeout.unref?.();
    if (typeof supervisorHeartbeat === 'function' && heartbeatEveryMs) {
      state.heartbeatTimer = setInterval(() => {
        try { supervisorHeartbeat(); }
        catch (error) { state.status = 'failed'; state.stderr = `${state.stderr}\nLease supervision failed: ${redactSensitive(error.message)}`.trim(); child.kill('SIGTERM'); }
      }, heartbeatEveryMs);
      state.heartbeatTimer.unref?.();
    }
    runs.set(runId, state);
    return publicState(state);
  }

  status(runId) { return getAdapterStatus(runId); }
  heartbeat(runId) { return heartbeatAdapter(runId); }
  cancel(runId) { return cancelAdapterRun(runId); }
  collectResult(runId, options) { return collectAdapterResult(runId, options); }
}

function publicState(state) {
  if (!state) return null;
  return { runId: state.runId, adapter: state.adapter, actorName: state.actorName, taskId: state.taskId,
    worktreePath: state.worktreePath, status: state.status, pid: state.pid, startedAt: state.startedAt,
    finishedAt: state.finishedAt, exitCode: state.exitCode, signal: state.signal,
    output: { artifact_hash: state.outputArtifactHash, retained_bytes: state.retainedBytes,
      dropped_bytes: state.droppedBytes, limit_bytes: state.outputLimitBytes, truncated: state.droppedBytes > 0 } };
}

export function resolveAdapter(modelHint, repoRoot = process.cwd(), explicitId = null) {
  const configured = getExecutionPolicy(repoRoot).adapters || {};
  const candidates = Object.entries(configured).filter(([id, config]) => ADAPTER_IDS.includes(id) && config?.enabled !== false)
    .map(([id, config]) => new AdapterProcess(id, config));
  candidates.sort((a, b) => (a.id === (explicitId || modelHint) ? -1 : b.id === (explicitId || modelHint) ? 1 : a.config.priority - b.config.priority || a.id.localeCompare(b.id)));
  const adapter = candidates.find(item => item.probe().available);
  if (!adapter) throw Object.assign(new Error('No configured model adapter is available.'), { code: 'ADAPTER_UNAVAILABLE' });
  return adapter;
}

export async function routeTask({ taskId, adapterId = null, actorName = null, context = {} }, db = getDb(), repoRoot = process.cwd()) {
  const task = getTask(taskId, db);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  if (task.status !== 'ready') throw new Error(`Task ${taskId} is not ready.`);
  const adapter = resolveAdapter(task.model_hint, repoRoot, adapterId);
  const actor = actorName || `${adapter.id}-adapter`;
  const claim = startTask({ taskId, actorName: actor }, db, repoRoot);
  try {
    const state = adapter.start({ task: claim.task, worktreePath: claim.worktreePath, actorName: actor, repoRoot,
      context: { model_profile: adapter.id, resource_class: adapter.config.resourceClass, ...sanitized(context) },
      heartbeatEveryMs: Math.max(1000, claim.heartbeatMinutes * 60 * 1000),
      supervisorHeartbeat: () => heartbeatTaskLease({ taskId, actorName: actor, leaseToken: claim.leaseToken, worktreePath: claim.worktreePath, repoRoot }, db) });
    return { ...state, routedBy: { model_hint: task.model_hint || null, explicit_adapter: adapterId, deterministic: true } };
  } catch (error) {
    try { releaseTaskLease(taskId, db); } catch {}
    throw error;
  }
}

export function getAdapterStatus(runId) {
  const state = runs.get(runId);
  if (!state) throw Object.assign(new Error(`Adapter run ${runId} not found in this supervisor process.`), { code: 'ADAPTER_RUN_NOT_FOUND' });
  return publicState(state);
}

export function heartbeatAdapter(runId) { return getAdapterStatus(runId); }

export function cancelAdapterRun(runId) {
  const state = runs.get(runId);
  if (!state) throw Object.assign(new Error(`Adapter run ${runId} not found.`), { code: 'ADAPTER_RUN_NOT_FOUND' });
  if (state.status === 'running') {
    state.status = 'cancelled';
    state.child.kill('SIGTERM');
    removePrivateRunFiles(state);
  }
  return publicState(state);
}

export function readAdapterOutput(artifactHash, { repoRoot = process.cwd(), offset = 0, limit = MAX_OUTPUT_PREVIEW_BYTES } = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTPUT_PREVIEW_BYTES) throw new Error(`limit must be an integer from 1 to ${MAX_OUTPUT_PREVIEW_BYTES}.`);
  const content = readArtifact(artifactHash, repoRoot);
  if (content === null) throw Object.assign(new Error('Adapter output artifact was not found.'), { code: 'ADAPTER_OUTPUT_NOT_FOUND' });
  const output = JSON.parse(content);
  const text = JSON.stringify(output, null, 2);
  return { artifact_hash: artifactHash, offset, limit, total_bytes: Buffer.byteLength(text), data: text.slice(offset, offset + limit),
    truncated: offset + limit < text.length, retention: { retained_bytes: output.retained_bytes, dropped_bytes: output.dropped_bytes, limit_bytes: output.limit_bytes } };
}

export function collectAdapterResult(runId, { cleanup = true, limit = MAX_OUTPUT_PREVIEW_BYTES } = {}) {
  const state = runs.get(runId);
  if (!state) throw Object.assign(new Error(`Adapter run ${runId} not found.`), { code: 'ADAPTER_RUN_NOT_FOUND' });
  if (state.status === 'running') throw Object.assign(new Error('Adapter run is still active.'), { code: 'ADAPTER_STILL_RUNNING' });
  const artifactHash = persistOutput(state, state.repoRoot);
  const payload = outputPayload(state);
  const result = { ...publicState(state), stdout: payload.stdout.slice(0, MAX_OUTPUT_PREVIEW_BYTES), stderr: payload.stderr.slice(0, MAX_OUTPUT_PREVIEW_BYTES),
    output: readAdapterOutput(artifactHash, { repoRoot: state.repoRoot, limit }) };
  if (cleanup) {
    removePrivateRunFiles(state);
    runs.delete(runId);
  }
  return result;
}

export async function handoffAdapterRun(runId, newAdapterId, db = getDb(), repoRoot = process.cwd()) {
  if (!ADAPTER_IDS.includes(newAdapterId)) throw new Error('handoff requires a supported destination adapter id.');
  const state = runs.get(runId);
  if (!state) throw Object.assign(new Error(`Adapter run ${runId} not found.`), { code: 'ADAPTER_RUN_NOT_FOUND' });
  if (state.status === 'running') {
    await new Promise((resolve, reject) => {
      if (state.finishedAt) return resolve();
      const timer = setTimeout(() => reject(Object.assign(new Error('Old adapter did not terminate; handoff stopped to prevent overlapping ownership.'), { code: 'HANDOFF_STOP_TIMEOUT' })), 5000);
      state.child.once('exit', () => { clearTimeout(timer); resolve(); });
      cancelAdapterRun(runId);
    });
  }
  const task = getTask(state.taskId, db);
  if (!task || task.status !== 'in_progress' || task.assigned_actor !== state.actorName) {
    throw Object.assign(new Error('Task ownership changed before adapter handoff.'), { code: 'LEASE_OWNER_MISMATCH' });
  }
  releaseTaskLease(state.taskId, db);
  const prior = collectAdapterResult(runId);
  return routeTask({ taskId: state.taskId, adapterId: newAdapterId,
    context: { handoff: { previous_adapter: prior.adapter, previous_status: prior.status, previous_run_id: prior.runId } } }, db, repoRoot);
}
