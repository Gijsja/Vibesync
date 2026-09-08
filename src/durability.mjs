import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const STATE_REF = 'refs/heads/vibesync/state';
export const STATE_TABLES = ['features', 'tasks', 'incubator', 'settlement_events', 'operations', 'gate_approvals', 'gate_runs', 'gate_slots'];
const roots = new WeakMap();
export function registerStateRoot(db, root) { roots.set(db, root); }
function git(root, args, input) {
  return execFileSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: 'VibeSync Engine', GIT_AUTHOR_EMAIL: 'engine@local', GIT_COMMITTER_NAME: 'VibeSync Engine', GIT_COMMITTER_EMAIL: 'engine@local' },
    stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Durable checkpoints never touch the working tree or index. Compare-and-swap prevents lost updates. */
export function checkpointState(db, explicitRoot) {
  const root = explicitRoot || roots.get(db);
  if (!root || !db.isOpen || db.isTransaction) return null;
  try { git(root, ['rev-parse', '--git-dir']); } catch { return null; }
  for (let attempt = 0; attempt < 5; attempt++) {
    let previous = '';
    try { previous = git(root, ['rev-parse', '--verify', STATE_REF]).trim(); } catch {}
    const tables = {};
    db.exec('SAVEPOINT checkpoint_read');
    try {
      for (const table of STATE_TABLES) tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    } finally { db.exec('RELEASE checkpoint_read'); }
    const entries = [];
    const artifacts = [...new Set([...tables.settlement_events, ...tables.gate_runs].map(event => event.artifact_hash).filter(hash => /^[a-f0-9]{12}$/.test(hash || '')))];
    for (const hash of artifacts) {
      const file = path.join(root, '.vibesync', 'artifacts', `${hash}.log`);
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
      const blob = git(root, ['hash-object', '-w', '--stdin'], fs.readFileSync(file)).trim();
      entries.push(`100644 blob ${blob}\t${hash}.log`);
    }
    const payload = JSON.stringify({ version: 1, tables });
    const blob = git(root, ['hash-object', '-w', '--stdin'], payload).trim();
    entries.push(`100644 blob ${blob}\tstate.json`);
    const tree = git(root, ['mktree'], entries.sort().join('\n') + '\n').trim();
    if (previous) {
      const oldTree = git(root, ['rev-parse', `${previous}^{tree}`]).trim();
      if (tree === oldTree) return previous;
    }
    const commit = git(root, ['commit-tree', tree, ...(previous ? ['-p', previous] : []), '-m', 'VibeSync durable state checkpoint']).trim();
    try {
      git(root, ['update-ref', STATE_REF, commit, previous || '0'.repeat(40)]);
      return commit;
    } catch (err) { if (attempt === 4) throw err; }
  }
}

export function readStateCheckpoint(root) {
  let commit;
  try { commit = git(root, ['rev-parse', '--verify', STATE_REF]).trim(); } catch { return null; }
  const payload = JSON.parse(git(root, ['show', `${commit}:state.json`]));
  if (payload.version !== 1 || !payload.tables || ['features', 'tasks', 'incubator', 'settlement_events', 'operations'].some(table => !Array.isArray(payload.tables[table]))) {
    throw new Error('Unsupported or invalid VibeSync state checkpoint. Existing database was not changed.');
  }
  for (const table of ['gate_approvals', 'gate_runs']) if (!Array.isArray(payload.tables[table])) payload.tables[table] = [];
  const logs = {};
  const hashes = new Set([...payload.tables.settlement_events, ...payload.tables.gate_runs].map(row => row.artifact_hash).filter(hash => /^[a-f0-9]{12}$/.test(hash || '')));
  for (const hash of hashes) {
    try { logs[hash] = git(root, ['show', `${commit}:${hash}.log`]); } catch {}
  }
  return { commit, tables: payload.tables, logs };
}

export function restoreStateCheckpoint(db, root, checkpoint) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['gate_runs', 'gate_approvals', 'operations', 'settlement_events', 'incubator', 'tasks', 'features']) db.exec(`DELETE FROM ${table}`);
    for (const table of STATE_TABLES) {
      const valid = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(col => col.name));
      for (const row of checkpoint.tables[table]) {
        const keys = Object.keys(row);
        if (!keys.length || keys.some(key => !valid.has(key))) throw new Error(`Invalid columns in checkpoint table ${table}.`);
        const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
        db.prepare(sql).run(...keys.map(key => row[key]));
      }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Checkpoint violates relational integrity.');
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  const directory = path.join(root, '.vibesync', 'artifacts');
  fs.mkdirSync(directory, { recursive: true });
  for (const [hash, content] of Object.entries(checkpoint.logs)) {
    const target = path.join(directory, `${hash}.log`);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, { flag: 'w' });
    fs.renameSync(temporary, target);
  }
  return { featuresCount: checkpoint.tables.features.length, tasksCount: checkpoint.tables.tasks.length,
    incubatorCount: checkpoint.tables.incubator.length, eventsCount: checkpoint.tables.settlement_events.length,
    checkpoint: checkpoint.commit, recoveryMode: 'checkpoint' };
}
