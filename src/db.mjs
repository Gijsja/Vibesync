import { checkpointState, registerStateRoot } from './durability.mjs';
export { checkpointState } from './durability.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  ARTIFACT_HASH_LENGTH,
  getDbPath,
  getArtifactsDir
} from './config.mjs';

const { DatabaseSync } = typeof Bun === 'undefined'
  ? await import('node:sqlite')
  : { DatabaseSync: (await import('bun:sqlite')).Database };

export { DatabaseSync };

/**
 * Safely stringifies a JavaScript object or array for SQLite JSON storage.
 * Handles strings, objects, arrays, and null/undefined values uniformly.
 *
 * @param {any} value
 * @param {string|null} [fallback=null]
 * @returns {string|null}
 */
export function serializeJsonField(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/**
 * Safely parses a SQLite JSON column into its JavaScript representation.
 * Handles objects, strings, and malformed JSON with fallback.
 *
 * @param {any} value
 * @param {any} [fallback=null]
 * @returns {any}
 */
export function deserializeJsonField(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return JSON.parse(value);
  }
  return value;
}

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS incubator (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN (
        'speculative_feature',
        'architecture_insight',
        'debt',
        'ux_polish',
        'convention'
    )),
    target_scope TEXT,
    context_notes TEXT NOT NULL,
    logged_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'parked' CHECK(status IN (
        'parked',
        'promoted',
        'discarded',
        'merged'
    )),
    promoted_feature_id TEXT,
    merged_into_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (promoted_feature_id) REFERENCES features(id) ON DELETE SET NULL,
    FOREIGN KEY (merged_into_id) REFERENCES incubator(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    target_milestone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN (
        'draft',
        'ready',
        'in_progress',
        'settled'
    )),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN (
        'urgent',
        'high',
        'medium',
        'low'
    )),
    labels JSON NOT NULL DEFAULT '[]',
    external_ref TEXT,
    spec_markdown TEXT NOT NULL,
    holistic_gate_cmd TEXT,
    settled_commit TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    settled_at DATETIME
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN (
        'backlog',
        'ready',
        'in_progress',
        'review',
        'settled',
        'blocked'
    )),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN (
        'urgent',
        'high',
        'medium',
        'low'
    )),
    labels JSON NOT NULL DEFAULT '[]',
    external_ref TEXT,
    assigned_actor TEXT,
    branch_name TEXT,
    base_commit TEXT,
    settled_commit TEXT,
    allowed_paths JSON NOT NULL DEFAULT '["*"]',
    required_gates JSON NOT NULL DEFAULT '[]',
    setup JSON NOT NULL DEFAULT '[]',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    max_failures INTEGER NOT NULL DEFAULT 3,
    lease_expires_at DATETIME,
    lease_generation INTEGER NOT NULL DEFAULT 0,
    lease_token_hash TEXT,
    last_heartbeat_at DATETIME,
    progress_fingerprint TEXT,
    last_progress_at DATETIME,
    stagnant_heartbeat_count INTEGER NOT NULL DEFAULT 0,
    lease_warning_at DATETIME,
    lease_grace_at DATETIME,
    handoff_requested_at DATETIME,
    lease_run_id TEXT,
    superseded_by_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
    superseded_at DATETIME,
    superseded_by_actor TEXT,
    model_hint TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settlement_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    feature_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'incubator_logged',
        'incubator_merged',
        'feature_created',
        'task_claimed',
        'gate_failed',
        'gate_passed',
        'circuit_breaker_tripped',
        'task_settled',
        'feature_settled',
        'lease_released',
        'ejected_to_human',
        'repaired_from_git',
        'lease_progress',
        'lease_warning',
        'lease_stagnant',
        'lease_grace',
        'lease_expired',
        'lease_renewed',
        'lease_handoff_requested',
        'task_superseded'
    )),
    commit_ref TEXT NOT NULL,
    artifact_hash TEXT,
    evidence_payload JSON,
    lease_run_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('task', 'feature')),
    target_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
    owner_pid INTEGER NOT NULL,
    result_json TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_running_operation ON operations(status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS gate_approvals (
    policy_hash TEXT PRIMARY KEY,
    task_id TEXT,
    feature_id TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('setup', 'gate', 'feature')),
    command_json JSON NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gate_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    feature_id TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('setup', 'gate', 'feature', 'partial')),
    gate_index INTEGER NOT NULL,
    policy_hash TEXT NOT NULL,
    actor TEXT NOT NULL,
    model_profile TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'blocked')),
    exit_code INTEGER,
    duration_ms INTEGER NOT NULL,
    summary TEXT,
    artifact_hash TEXT,
    lease_run_id TEXT,
    evidence_payload JSON,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_runs_task ON gate_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_gate_runs_hash ON gate_runs(policy_hash);

CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);
CREATE INDEX IF NOT EXISTS idx_incubator_status ON incubator(status);
CREATE INDEX IF NOT EXISTS idx_settlement_timestamp ON settlement_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_settlement_task ON settlement_events(task_id);
CREATE INDEX IF NOT EXISTS idx_settlement_feature ON settlement_events(feature_id);

-- Phase 2: Gate resource scheduling — active gate-execution slots
CREATE TABLE IF NOT EXISTS gate_slots (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    task_id TEXT,
    phase TEXT NOT NULL DEFAULT 'gate',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    pid INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_slots_actor ON gate_slots(actor);
`;

let _activeDb = null;
let _activeDbPath = null;
const closedDbs = new WeakSet();

export function migrateSchema(db) {
  // Ensure incubator table has updated CHECK constraints and columns
  const ddl = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='incubator'").get()?.sql || '';
  const incubatorCols = db.prepare("PRAGMA table_info(incubator)").all().map(c => c.name);
  const legacyUpdatedAt = incubatorCols.includes('updated_at') ? 'updated_at' : 'created_at';
  if (ddl && (!ddl.includes("'convention'") || !ddl.includes("'merged'"))) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS incubator_migrated (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('speculative_feature', 'architecture_insight', 'debt', 'ux_polish', 'convention')),
          target_scope TEXT,
          context_notes TEXT NOT NULL,
          logged_by TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'parked' CHECK(status IN ('parked', 'promoted', 'discarded', 'merged')),
          promoted_feature_id TEXT,
          merged_into_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (promoted_feature_id) REFERENCES features(id) ON DELETE SET NULL,
          FOREIGN KEY (merged_into_id) REFERENCES incubator(id) ON DELETE SET NULL
      );
      INSERT INTO incubator_migrated (
        id, title, category, target_scope, context_notes, logged_by, status, promoted_feature_id, created_at, updated_at
      )
      SELECT 
        id, title, category, NULL, context_notes, logged_by, status, promoted_feature_id, created_at, ${legacyUpdatedAt}
      FROM incubator;
      DROP TABLE incubator;
      ALTER TABLE incubator_migrated RENAME TO incubator;
      CREATE INDEX IF NOT EXISTS idx_incubator_status ON incubator(status);
    `);
  } else {
    if (incubatorCols.length > 0) {
      if (!incubatorCols.includes('target_scope')) {
        db.exec("ALTER TABLE incubator ADD COLUMN target_scope TEXT;");
      }
      if (!incubatorCols.includes('merged_into_id')) {
        db.exec("ALTER TABLE incubator ADD COLUMN merged_into_id TEXT;");
      }
      if (!incubatorCols.includes('updated_at')) {
        db.exec("ALTER TABLE incubator ADD COLUMN updated_at DATETIME;");
        db.exec("UPDATE incubator SET updated_at = created_at WHERE updated_at IS NULL;");
      }
    }
  }

  // Ensure settlement_events table has updated action CHECK constraints (Phase 1 additions)
  const eventsDdl = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='settlement_events'").get()?.sql || '';
  if (eventsDdl && !eventsDdl.includes("'incubator_merged'")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_events_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          feature_id TEXT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN (
              'incubator_logged',
              'incubator_merged',
              'feature_created',
              'task_claimed',
              'gate_failed',
              'gate_passed',
              'circuit_breaker_tripped',
              'task_settled',
              'feature_settled',
              'lease_released',
              'ejected_to_human',
              'repaired_from_git',
              'lease_progress',
              'lease_warning',
              'lease_stagnant',
              'lease_grace',
              'lease_expired',
              'lease_renewed',
              'lease_handoff_requested',
              'task_superseded'
          )),
          commit_ref TEXT NOT NULL,
          artifact_hash TEXT,
          evidence_payload JSON,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE SET NULL
      );
      INSERT INTO settlement_events_migrated SELECT * FROM settlement_events;
      DROP TABLE settlement_events;
      ALTER TABLE settlement_events_migrated RENAME TO settlement_events;
      CREATE INDEX IF NOT EXISTS idx_settlement_timestamp ON settlement_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_settlement_task ON settlement_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_settlement_feature ON settlement_events(feature_id);
    `);
  } else if (eventsDdl && !eventsDdl.includes("'lease_progress'")) {
    // Phase 1 migration: add new lease-health action values to existing databases
    // that already have 'incubator_merged' but not the Phase 1 lease actions.
    db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_events_p1 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          feature_id TEXT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN (
              'incubator_logged',
              'incubator_merged',
              'feature_created',
              'task_claimed',
              'gate_failed',
              'gate_passed',
              'circuit_breaker_tripped',
              'task_settled',
              'feature_settled',
              'lease_released',
              'ejected_to_human',
              'repaired_from_git',
              'lease_progress',
              'lease_warning',
              'lease_stagnant',
              'lease_grace',
              'lease_expired',
              'lease_renewed',
              'lease_handoff_requested',
              'task_superseded'
          )),
          commit_ref TEXT NOT NULL,
          artifact_hash TEXT,
          evidence_payload JSON,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE SET NULL
      );
      INSERT INTO settlement_events_p1 SELECT * FROM settlement_events;
      DROP TABLE settlement_events;
      ALTER TABLE settlement_events_p1 RENAME TO settlement_events;
      CREATE INDEX IF NOT EXISTS idx_settlement_timestamp ON settlement_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_settlement_task ON settlement_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_settlement_feature ON settlement_events(feature_id);
    `);
  }

  // Ensure features table has industry-standard columns
  const featureCols = db.prepare("PRAGMA table_info(features)").all().map(c => c.name);
  if (featureCols.length > 0) {
    if (!featureCols.includes('priority')) {
      db.exec("ALTER TABLE features ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent', 'high', 'medium', 'low'));");
    }
    if (!featureCols.includes('labels')) {
      db.exec("ALTER TABLE features ADD COLUMN labels JSON NOT NULL DEFAULT '[]';");
    }
    if (!featureCols.includes('external_ref')) {
      db.exec("ALTER TABLE features ADD COLUMN external_ref TEXT;");
    }
  }

  // Ensure tasks table has industry-standard columns
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (taskCols.length > 0) {
    if (!taskCols.includes('worktree_path')) db.exec('ALTER TABLE tasks ADD COLUMN worktree_path TEXT;');
    if (!taskCols.includes('priority')) {
      db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent', 'high', 'medium', 'low'));");
    }
    if (!taskCols.includes('labels')) {
      db.exec("ALTER TABLE tasks ADD COLUMN labels JSON NOT NULL DEFAULT '[]';");
    }
    if (!taskCols.includes('external_ref')) {
      db.exec("ALTER TABLE tasks ADD COLUMN external_ref TEXT;");
    }
    if (!taskCols.includes('setup')) {
      db.exec("ALTER TABLE tasks ADD COLUMN setup JSON NOT NULL DEFAULT '[]';");
    }
    if (!taskCols.includes('lease_generation')) db.exec('ALTER TABLE tasks ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;');
    if (!taskCols.includes('lease_token_hash')) db.exec('ALTER TABLE tasks ADD COLUMN lease_token_hash TEXT;');
    if (!taskCols.includes('last_heartbeat_at')) db.exec('ALTER TABLE tasks ADD COLUMN last_heartbeat_at DATETIME;');
    if (!taskCols.includes('progress_fingerprint')) db.exec('ALTER TABLE tasks ADD COLUMN progress_fingerprint TEXT;');
    if (!taskCols.includes('model_hint')) db.exec('ALTER TABLE tasks ADD COLUMN model_hint TEXT;');
    // Phase 1: evidence-based lease-health columns
    if (!taskCols.includes('last_progress_at')) db.exec('ALTER TABLE tasks ADD COLUMN last_progress_at DATETIME;');
    if (!taskCols.includes('stagnant_heartbeat_count')) db.exec('ALTER TABLE tasks ADD COLUMN stagnant_heartbeat_count INTEGER NOT NULL DEFAULT 0;');
    if (!taskCols.includes('lease_warning_at')) db.exec('ALTER TABLE tasks ADD COLUMN lease_warning_at DATETIME;');
    if (!taskCols.includes('lease_grace_at')) db.exec('ALTER TABLE tasks ADD COLUMN lease_grace_at DATETIME;');
    if (!taskCols.includes('handoff_requested_at')) db.exec('ALTER TABLE tasks ADD COLUMN handoff_requested_at DATETIME;');
    if (!taskCols.includes('lease_run_id')) db.exec('ALTER TABLE tasks ADD COLUMN lease_run_id TEXT;');
    if (!taskCols.includes('superseded_by_task_id')) db.exec('ALTER TABLE tasks ADD COLUMN superseded_by_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT;');
    if (!taskCols.includes('superseded_at')) db.exec('ALTER TABLE tasks ADD COLUMN superseded_at DATETIME;');
    if (!taskCols.includes('superseded_by_actor')) db.exec('ALTER TABLE tasks ADD COLUMN superseded_by_actor TEXT;');
  }
  const approvalCols = db.prepare('PRAGMA table_info(gate_approvals)').all().map(c => c.name);
  if (approvalCols.length && !approvalCols.includes('feature_id')) db.exec('ALTER TABLE gate_approvals ADD COLUMN feature_id TEXT REFERENCES features(id) ON DELETE CASCADE;');
  const runCols = db.prepare('PRAGMA table_info(gate_runs)').all().map(c => c.name);
  if (runCols.length && !runCols.includes('feature_id')) db.exec('ALTER TABLE gate_runs ADD COLUMN feature_id TEXT REFERENCES features(id) ON DELETE SET NULL;');
  if (runCols.length && !runCols.includes('lease_run_id')) db.exec('ALTER TABLE gate_runs ADD COLUMN lease_run_id TEXT;');
  if (runCols.length && !runCols.includes('evidence_payload')) db.exec('ALTER TABLE gate_runs ADD COLUMN evidence_payload JSON;');
  const runsDdl = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='gate_runs'").get()?.sql || '';
  if (runsDdl && !runsDdl.includes("'partial'")) {
    db.exec(`
      CREATE TABLE gate_runs_p2 (
        id TEXT PRIMARY KEY, task_id TEXT, feature_id TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('setup', 'gate', 'feature', 'partial')),
        gate_index INTEGER NOT NULL, policy_hash TEXT NOT NULL, actor TEXT NOT NULL,
        model_profile TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'blocked')),
        exit_code INTEGER, duration_ms INTEGER NOT NULL, summary TEXT, artifact_hash TEXT,
        lease_run_id TEXT, evidence_payload JSON,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
        FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE SET NULL
      );
      INSERT INTO gate_runs_p2 (id, task_id, feature_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, summary, artifact_hash, lease_run_id, evidence_payload, started_at, finished_at)
        SELECT id, task_id, feature_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, summary, artifact_hash, lease_run_id, evidence_payload, started_at, finished_at FROM gate_runs;
      DROP TABLE gate_runs;
      ALTER TABLE gate_runs_p2 RENAME TO gate_runs;
      CREATE INDEX IF NOT EXISTS idx_gate_runs_task ON gate_runs(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_gate_runs_hash ON gate_runs(policy_hash);
    `);
  }
  const eventCols = db.prepare('PRAGMA table_info(settlement_events)').all().map(c => c.name);
  if (eventCols.length && !eventCols.includes('lease_run_id')) db.exec('ALTER TABLE settlement_events ADD COLUMN lease_run_id TEXT;');
  if (eventCols.length) db.exec("UPDATE settlement_events SET lease_run_id = json_extract(evidence_payload, '$.lease_run_id') WHERE lease_run_id IS NULL AND json_valid(evidence_payload) AND json_extract(evidence_payload, '$.lease_run_id') IS NOT NULL;");

  const modernEventsDdl = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='settlement_events'").get()?.sql || '';
  if (modernEventsDdl && !modernEventsDdl.includes("'task_superseded'")) {
    db.exec(`
      CREATE TABLE settlement_events_supersession (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          feature_id TEXT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN (
              'incubator_logged', 'incubator_merged', 'feature_created', 'task_claimed',
              'gate_failed', 'gate_passed', 'circuit_breaker_tripped', 'task_settled',
              'feature_settled', 'lease_released', 'ejected_to_human', 'repaired_from_git',
              'lease_progress', 'lease_warning', 'lease_stagnant', 'lease_grace',
              'lease_expired', 'lease_renewed', 'lease_handoff_requested', 'task_superseded'
          )),
          commit_ref TEXT NOT NULL,
          artifact_hash TEXT,
          evidence_payload JSON,
          lease_run_id TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE SET NULL
      );
      INSERT INTO settlement_events_supersession (id, task_id, feature_id, actor, action, commit_ref, artifact_hash, evidence_payload, lease_run_id, timestamp)
        SELECT id, task_id, feature_id, actor, action, commit_ref, artifact_hash, evidence_payload, lease_run_id, timestamp FROM settlement_events;
      DROP TABLE settlement_events;
      ALTER TABLE settlement_events_supersession RENAME TO settlement_events;
      CREATE INDEX IF NOT EXISTS idx_settlement_timestamp ON settlement_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_settlement_task ON settlement_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_settlement_feature ON settlement_events(feature_id);
    `);
  }
}

export function initSchema(db) {
  db.exec(SCHEMA_DDL);
  migrateSchema(db);
}

export function getDb(dbPath, repoRoot = process.cwd()) {
  const resolvedTarget = path.resolve(getDbPath(repoRoot));
  if (!dbPath && _activeDb && _activeDb.isOpen && _activeDbPath === resolvedTarget) {
    return _activeDb;
  }

  const targetPath = dbPath || getDbPath(repoRoot);
  if (targetPath !== ':memory:') {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);

  // Wrap db.prepare to transparently convert arrays and objects into serialized JSON strings
  // to avoid node:sqlite 'Unknown named parameter' errors when binding structured data.
  const originalPrepare = db.prepare.bind(db);
  db.prepare = function (sql) {
    const stmt = originalPrepare(sql);
    const wrapExec = (fn) => {
      return function (...args) {
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0]) && !(args[0] instanceof Uint8Array) && !(args[0] instanceof Buffer)) {
          // Named parameters object: sanitize each property value if it is an object or array
          const sanitized = {};
          for (const [k, v] of Object.entries(args[0])) {
            if (typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !(v instanceof Buffer)) {
              sanitized[k] = JSON.stringify(v);
            } else {
              sanitized[k] = v;
            }
          }
          return fn.call(stmt, sanitized);
        }
        // Positional parameters
        const sanitizedArgs = args.map(arg => {
          if (typeof arg === 'object' && arg !== null && !(arg instanceof Uint8Array) && !(arg instanceof Buffer)) {
            return JSON.stringify(arg);
          }
          return arg;
        });
        return fn.apply(stmt, sanitizedArgs);
      };
    };
    stmt.run = wrapExec(stmt.run);
    stmt.get = wrapExec(stmt.get);
    stmt.all = wrapExec(stmt.all);
    return stmt;
  };

  initSchema(db);
  if (targetPath !== ':memory:') registerStateRoot(db, path.basename(path.dirname(targetPath)) === '.vibesync' ? path.dirname(path.dirname(path.resolve(targetPath))) : repoRoot);

  if (!dbPath) {
    _activeDb = db;
    _activeDbPath = path.resolve(targetPath);
  }
  return db;
}

export function closeDb(db) {
  const target = db || _activeDb;
  if (target && !closedDbs.has(target)) {
    target.close();
    closedDbs.add(target);
  }
  if (target === _activeDb) {
    _activeDb = null;
  }
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    checkpointState(db);
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {}
    throw err;
  }
}

export function saveArtifact(content, repoRoot = process.cwd()) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, ARTIFACT_HASH_LENGTH);
  const artifactsDir = getArtifactsDir(repoRoot);
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(artifactsDir, 0o700);
  const artifactPath = path.join(artifactsDir, `${hash}.log`);
  fs.writeFileSync(artifactPath, text, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(artifactPath, 0o600);
  return hash;
}

export function readArtifact(hash, repoRoot = process.cwd()) {
  if (typeof hash !== 'string' || !new RegExp(`^[a-f0-9]{${ARTIFACT_HASH_LENGTH}}$`).test(hash)) return null;
  const filePath = path.join(getArtifactsDir(repoRoot), `${hash}.log`);
  if (fs.existsSync(filePath)) {
    if (fs.lstatSync(filePath).isSymbolicLink()) return null;
    return fs.readFileSync(filePath, 'utf8');
  }
  return null;
}

export function recordSettlementEvent(db, event) {
  const {
    task_id = null,
    feature_id = null,
    actor,
    action,
    commit_ref,
    artifact_hash = null,
    evidence_payload = null,
    lease_run_id = null
  } = event;

  if (!actor || !action || !commit_ref) {
    throw new Error('recordSettlementEvent: "actor", "action", and "commit_ref" are required.');
  }

  const payloadJson = evidence_payload !== null && evidence_payload !== undefined
    ? (typeof evidence_payload === 'string' ? evidence_payload : JSON.stringify(evidence_payload))
    : null;

  let resolvedLeaseRunId = lease_run_id;
  if (!resolvedLeaseRunId && evidence_payload && typeof evidence_payload === 'object') resolvedLeaseRunId = evidence_payload.lease_run_id || null;
  if (!resolvedLeaseRunId && task_id) resolvedLeaseRunId = db.prepare('SELECT lease_run_id FROM tasks WHERE id = ?').get(task_id)?.lease_run_id || null;
  const stmt = db.prepare(`
    INSERT INTO settlement_events (
      task_id, feature_id, actor, action, commit_ref, artifact_hash, evidence_payload, lease_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    task_id,
    feature_id,
    actor,
    action,
    commit_ref,
    artifact_hash,
    payloadJson,
    resolvedLeaseRunId
  );

  checkpointState(db);
  return Number(result.lastInsertRowid);
}
