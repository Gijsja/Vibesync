import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeCommand, displayCommand } from './commands.mjs';
import { checkpointState } from './durability.mjs';

export const MODEL_PROFILES = Object.freeze({
  // stagnantWarningBeats: unchanged heartbeats before entering "warning" state
  // stagnantGraceBeats:   additional beats after warning before "grace" state
  // stagnantExpiryBeats:  additional beats after grace before automatic expiry
  // Gemini and Claude allow longer reasoning intervals before stagnation is flagged.
  // Codex uses a shorter implementation-oriented cadence.
  // Local models send frequent liveness checks but have a longer progress window.
  gemini: { id: 'gemini', execution: 'hosted', strengths: ['planning', 'large-context'], heartbeatMinutes: 10, leaseMinutes: 45, resourceClass: 'standard', maxConcurrentGates: 2, stagnantWarningBeats: 3, stagnantGraceBeats: 2, stagnantExpiryBeats: 2 },
  claude:  { id: 'claude', execution: 'hosted', strengths: ['review', 'reasoning'], heartbeatMinutes: 10, leaseMinutes: 45, resourceClass: 'standard', maxConcurrentGates: 2, stagnantWarningBeats: 3, stagnantGraceBeats: 2, stagnantExpiryBeats: 2 },
  codex:   { id: 'codex', execution: 'hosted', strengths: ['implementation', 'testing'], heartbeatMinutes: 8, leaseMinutes: 45, resourceClass: 'standard', maxConcurrentGates: 2, stagnantWarningBeats: 2, stagnantGraceBeats: 1, stagnantExpiryBeats: 2 },
  local:   { id: 'local', execution: 'local', strengths: ['private', 'offline', 'low-cost'], heartbeatMinutes: 3, leaseMinutes: 60, resourceClass: 'constrained', maxConcurrentGates: 1, stagnantWarningBeats: 4, stagnantGraceBeats: 3, stagnantExpiryBeats: 3 },
  generic: { id: 'generic', execution: 'unknown', strengths: [], heartbeatMinutes: 8, leaseMinutes: 45, resourceClass: 'standard', maxConcurrentGates: 2, stagnantWarningBeats: 2, stagnantGraceBeats: 2, stagnantExpiryBeats: 2 }
});

export const DEFAULT_RESOURCE_POLICY = Object.freeze({
  max_concurrent_gates: 4,
  max_concurrent_gates_per_actor: 2,
  timeout_ceiling_ms: 3600000,
  output_limit_bytes: 10 * 1024 * 1024,
  retry_after_ms: 1000
});

export function identifyModelProfile(actorName = '') {
  const actor = String(actorName).toLowerCase();
  if (/gemini|antigravity/.test(actor)) return MODEL_PROFILES.gemini;
  if (/claude|anthropic/.test(actor)) return MODEL_PROFILES.claude;
  if (/codex|openai/.test(actor)) return MODEL_PROFILES.codex;
  if (/local|ollama|lmstudio|llama|mistral|qwen|deepseek/.test(actor)) return MODEL_PROFILES.local;
  return MODEL_PROFILES.generic;
}

export function getExecutionPolicy(repoRoot = process.cwd()) {
  const defaults = {
    version: 1,
    approval_mode: 'audit',
    sandbox_mode: 'process',
    network_default: false,
    allow_legacy_commands: true,
    redact_logs: true,
    resource_policy: DEFAULT_RESOURCE_POLICY,
    adapters: {}
  };
  const policyPath = path.join(repoRoot, '.vibesync', 'policy.json');
  try {
    const configured = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const resource = { ...DEFAULT_RESOURCE_POLICY, ...(configured.resource_policy || {}) };
    for (const [key, value] of Object.entries(resource)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`resource_policy.${key} must be a positive integer.`);
    }
    if (resource.max_concurrent_gates > 64 || resource.max_concurrent_gates_per_actor > 64) throw new Error('Gate concurrency limits cannot exceed 64.');
    if (resource.timeout_ceiling_ms > 3600000) throw new Error('Gate timeout ceiling cannot exceed 3600000ms.');
    if (resource.output_limit_bytes > 100 * 1024 * 1024) throw new Error('Gate output limit cannot exceed 104857600 bytes.');
    const adapters = configured.adapters && typeof configured.adapters === 'object' && !Array.isArray(configured.adapters) ? configured.adapters : {};
    const policy = { ...defaults, ...configured, resource_policy: resource, adapters };
    if (!['audit', 'enforce'].includes(policy.approval_mode)) throw new Error('approval_mode must be audit or enforce.');
    if (!['process', 'auto', 'required'].includes(policy.sandbox_mode)) throw new Error('sandbox_mode must be process, auto, or required.');
    return policy;
  } catch {
    return defaults;
  }
}

function stringList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.includes('\0'))) {
    throw new Error(`${name} must be an array of NUL-free strings.`);
  }
  return [...value];
}

export function resolveCommandSpec(command, { cwd = process.cwd(), phase = 'gate' } = {}) {
  let type = 'legacy';
  let argv;
  let args = [];
  let script = null;
  let legacy = true;
  let timeoutMs = null;
  let network = false;
  let writePaths = [];
  let idempotency = 'safe';

  if (command && typeof command === 'object' && !Array.isArray(command)) {
    legacy = false;
    type = command.type || 'argv';
    args = stringList(command.args, 'gate args');
    timeoutMs = command.timeout_ms ?? null;
    network = command.network === true;
    writePaths = stringList(command.write_paths, 'write_paths');
    if (writePaths.some(item => path.isAbsolute(item) || item.replace(/\\/g, '/').split('/').includes('..'))) {
      throw new Error('write_paths must contain repository-relative paths without traversal segments.');
    }
    idempotency = command.idempotency || 'safe';
    if (!['safe', 'unsafe'].includes(idempotency)) throw new Error('idempotency must be "safe" or "unsafe".');
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)) throw new Error('timeout_ms must be between 1 and 3600000.');
    if (type === 'argv') argv = normalizeCommand(command.argv || command.command);
    else if (type === 'node-test') argv = ['node', '--test', ...args];
    else if (type === 'pytest') argv = ['python', '-m', 'pytest', ...args];
    else if (type === 'make') {
      if (typeof command.target !== 'string' || !/^[A-Za-z0-9_.:/-]+$/.test(command.target)) throw new Error('make gates require a safe target.');
      argv = ['make', command.target, ...args];
    } else if (type === 'npm-script') {
      script = command.script;
      if (typeof script !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(script)) throw new Error('npm-script gates require a safe script name.');
      argv = ['npm', 'run', script, ...(args.length ? ['--', ...args] : [])];
    } else throw new Error(`Unknown structured command type: ${type}.`);
  } else {
    argv = normalizeCommand(command);
  }

  let resolvedScript = null;
  if (type === 'npm-script') {
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts || {};
      resolvedScript = { pre: scripts[`pre${script}`] || null, main: scripts[script] || null, post: scripts[`post${script}`] || null };
    } catch {}
  }
  let resolvedExecutable = null;
  const candidates = argv[0].includes(path.sep)
    ? [path.resolve(cwd, argv[0])]
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, argv[0]));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); resolvedExecutable = fs.realpathSync(candidate); break; } catch {}
  }
  const canonical = {
    policy_version: 1,
    phase,
    type,
    argv,
    resolved_executable: resolvedExecutable,
    resolved_script: resolvedScript,
    timeout_ms: timeoutMs,
    network,
    write_paths: writePaths,
    idempotency
  };
  const policyHash = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { ...canonical, policyHash, legacy, display: displayCommand(argv) };
}

export function commandApproval(spec, db, repoRoot = process.cwd()) {
  const policy = getExecutionPolicy(repoRoot);
  const row = db?.prepare('SELECT * FROM gate_approvals WHERE policy_hash = ? AND revoked_at IS NULL').get(spec.policyHash);
  const approved = Boolean(row);
  const legacyAllowed = !spec.legacy || policy.allow_legacy_commands !== false;
  const runnable = legacyAllowed && (approved || (policy.approval_mode !== 'enforce' && spec.idempotency !== 'unsafe'));
  return {
    approved,
    runnable,
    mode: policy.approval_mode,
    warning: !legacyAllowed ? 'Legacy commands are disabled by project policy.' : (approved ? null : (runnable ? `Command ${spec.policyHash.slice(0, 12)} is unapproved; audit mode allowed execution.` : `Command ${spec.policyHash.slice(0, 12)} requires administrator approval.`)),
    approval: row || null
  };
}

let bubblewrapAvailable;
function hasBubblewrap() {
  if (bubblewrapAvailable !== undefined) return bubblewrapAvailable;
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', 'true'], { stdio: 'ignore' });
  bubblewrapAvailable = probe.status === 0;
  return bubblewrapAvailable;
}

function bubblewrapWriteRoots(cwd, writePaths) {
  const scopes = Array.isArray(writePaths) && writePaths.length ? writePaths : ['*'];
  if (scopes.some(item => item === '*' || item === '**')) return [path.resolve(cwd)];
  const roots = new Set();
  for (const item of scopes) {
    const normalized = item.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error('Sandbox write paths must be repository-relative and traversal-free.');
    }
    const segments = normalized.split('/');
    const literal = [];
    for (const segment of segments) {
      if (/[*?{}()[\]]/.test(segment)) break;
      literal.push(segment);
    }
    let candidate = path.resolve(cwd, literal.join('/'));
    while (!fs.existsSync(candidate) && candidate !== path.resolve(cwd)) candidate = path.dirname(candidate);
    if (!candidate.startsWith(path.resolve(cwd) + path.sep) && candidate !== path.resolve(cwd)) {
      throw new Error('Sandbox write path resolved outside the workspace.');
    }
    roots.add(candidate);
  }
  return [...roots].sort((a, b) => a.length - b.length);
}

export function prepareSandboxedCommand(spec, cwd, repoRoot = process.cwd(), allowedWritePaths = ['*']) {
  const policy = getExecutionPolicy(repoRoot);
  if (policy.sandbox_mode === 'process') {
    return { argv: spec.argv, sandbox: 'process', warning: spec.network ? 'Network access was declared but is not isolated in process sandbox mode.' : 'Process sandbox sanitizes environment and limits time/output; OS filesystem and network isolation are not active.' };
  }
  if (!hasBubblewrap()) {
    if (policy.sandbox_mode === 'required') throw Object.assign(new Error('Bubblewrap sandbox is required by policy but unavailable on this host.'), { code: 'SANDBOX_UNAVAILABLE', phase: 'SANDBOX_UNAVAILABLE' });
    return { argv: spec.argv, sandbox: 'process', warning: 'Bubblewrap unavailable; using hardened process mode.' };
  }
  const writeRoots = bubblewrapWriteRoots(cwd, spec.write_paths?.length ? spec.write_paths : allowedWritePaths);
  const argv = ['bwrap', '--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--ro-bind', cwd, cwd];
  for (const writeRoot of writeRoots) argv.push('--bind', writeRoot, writeRoot);
  argv.push('--chdir', cwd);
  const resolvedCwd = path.resolve(cwd);
  if (resolvedCwd !== '/tmp' && !resolvedCwd.startsWith('/tmp/')) argv.push('--tmpfs', '/tmp');
  for (const protectedName of ['.git', '.vibesync']) {
    const protectedPath = path.join(cwd, protectedName);
    if (fs.existsSync(protectedPath)) argv.push('--ro-bind', protectedPath, protectedPath);
  }
  if (!spec.network) argv.push('--unshare-net');
  argv.push('--', ...spec.argv);
  return { argv, sandbox: spec.network ? 'bubblewrap-networked' : 'bubblewrap-no-network', writeRoots, warning: null };
}

export function requireCommandApproval(spec, db, repoRoot = process.cwd()) {
  const approval = commandApproval(spec, db, repoRoot);
  if (!approval.runnable) {
    throw Object.assign(new Error(approval.warning), { code: 'APPROVAL_REQUIRED', phase: 'APPROVAL_REQUIRED', policyHash: spec.policyHash });
  }
  return approval;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function commandsForTask(task, feature, phase) {
  if (phase === 'setup') return parseJson(task.setup, []);
  if (phase === 'feature') return feature?.holistic_gate_cmd ? [parseJson(feature.holistic_gate_cmd, feature.holistic_gate_cmd)] : [];
  return parseJson(task.required_gates, []);
}

export function approveTaskCommand({ taskId, phase = 'gate', index = 0, approvedBy }, db, repoRoot = process.cwd()) {
  if (!approvedBy) throw new Error('approvedBy is required.');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const feature = db.prepare('SELECT * FROM features WHERE id = ?').get(task.feature_id);
  const command = commandsForTask(task, feature, phase)[index];
  if (command === undefined) throw new Error(`No ${phase} command exists at index ${index}.`);
  const cwd = task.worktree_path || repoRoot;
  const spec = resolveCommandSpec(command, { cwd, phase });
  db.prepare(`INSERT INTO gate_approvals (policy_hash, task_id, phase, command_json, approved_by, approved_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(policy_hash) DO UPDATE SET approved_by = excluded.approved_by, approved_at = CURRENT_TIMESTAMP, revoked_at = NULL`)
    .run(spec.policyHash, taskId, phase, JSON.stringify(spec), approvedBy);
  checkpointState(db);
  return { success: true, taskId, phase, index, policyHash: spec.policyHash, approvedBy };
}

export function approveFeatureCommand({ featureId, approvedBy }, db, repoRoot = process.cwd()) {
  if (!approvedBy) throw new Error('approvedBy is required.');
  const feature = db.prepare('SELECT * FROM features WHERE id = ?').get(featureId);
  if (!feature) throw new Error(`Feature ${featureId} not found.`);
  const command = parseJson(feature.holistic_gate_cmd, feature.holistic_gate_cmd);
  if (!command) throw new Error(`Feature ${featureId} has no holistic gate.`);
  const spec = resolveCommandSpec(command, { cwd: repoRoot, phase: 'feature' });
  db.prepare(`INSERT INTO gate_approvals (policy_hash, feature_id, phase, command_json, approved_by, approved_at, revoked_at)
    VALUES (?, ?, 'feature', ?, ?, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(policy_hash) DO UPDATE SET approved_by = excluded.approved_by, approved_at = CURRENT_TIMESTAMP, revoked_at = NULL`)
    .run(spec.policyHash, featureId, JSON.stringify(spec), approvedBy);
  checkpointState(db);
  return { success: true, featureId, policyHash: spec.policyHash, approvedBy };
}

export function previewFeature({ featureId, actorName = 'unknown' }, db, repoRoot = process.cwd()) {
  const feature = db.prepare('SELECT * FROM features WHERE id = ?').get(featureId);
  if (!feature) throw new Error(`Feature ${featureId} not found.`);
  const command = parseJson(feature.holistic_gate_cmd, feature.holistic_gate_cmd);
  if (!command) return { feature: { id: feature.id, title: feature.title }, model: identifyModelProfile(actorName), commands: [], approval_required: 0, policy: getExecutionPolicy(repoRoot) };
  const spec = resolveCommandSpec(command, { cwd: repoRoot, phase: 'feature' });
  const approval = commandApproval(spec, db, repoRoot);
  return { feature: { id: feature.id, title: feature.title }, model: identifyModelProfile(actorName), commands: [{ phase: 'feature', index: 0, ...spec, approval }], approval_required: approval.runnable ? 0 : 1, policy: getExecutionPolicy(repoRoot) };
}

export function previewTask({ taskId, actorName = 'unknown' }, db, repoRoot = process.cwd()) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const feature = db.prepare('SELECT * FROM features WHERE id = ?').get(task.feature_id);
  const cwd = task.worktree_path || repoRoot;
  const phases = ['setup', 'gate'];
  if (feature?.holistic_gate_cmd) phases.push('feature');
  const commands = phases.flatMap(phase => commandsForTask(task, feature, phase).map((command, index) => {
    const spec = resolveCommandSpec(command, { cwd, phase });
    const approval = commandApproval(spec, db, repoRoot);
    const history = db.prepare('SELECT AVG(duration_ms) AS average_ms, COUNT(*) AS runs FROM gate_runs WHERE policy_hash = ?').get(spec.policyHash);
    return { phase, index, ...spec, approval, estimated_ms: Math.round(history?.average_ms || 0), prior_runs: history?.runs || 0 };
  }));
  const model = identifyModelProfile(actorName);
  return {
    task: { id: task.id, feature_id: task.feature_id, title: task.title, status: task.status, allowed_paths: parseJson(task.allowed_paths, []), model_hint: task.model_hint || null },
    model,
    suitability: task.model_hint && task.model_hint !== model.id ? 'review_recommended' : 'suitable',
    commands,
    approval_required: commands.filter(item => !item.approval.runnable).length,
    estimated_verification_ms: commands.reduce((total, item) => total + item.estimated_ms, 0),
    policy: getExecutionPolicy(repoRoot)
  };
}
