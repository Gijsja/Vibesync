import { checkpointState } from './db.mjs';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

const active = new Set();
export async function waitForOperations() { await Promise.allSettled([...active]); }

export function recoverInterruptedOperations(db) {
  for (const op of db.prepare("SELECT * FROM operations WHERE status = 'running'").all()) {
    try { process.kill(op.owner_pid, 0); } catch (err) {
      if (err.code !== 'ESRCH') continue;
      db.prepare("UPDATE operations SET status = 'failed', result_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify({ success: false, error: 'Verification was interrupted when its process exited. Inspect Git state and task logs before retrying.' }), op.id);
    }
  }
}

export function listOperations(db) {
  return db.prepare('SELECT * FROM operations ORDER BY started_at DESC LIMIT 20').all().map(op => ({
    ...op, result: op.result_json ? JSON.parse(op.result_json) : null
  }));
}

export function assertWorkspaceIdle(db) {
  const active = db.prepare("SELECT id FROM operations WHERE status = 'running'").get();
  if (active) throw Object.assign(new Error('Verification is running. Wait for it to finish before changing the workspace.'), { statusCode: 409 });
}

/** Run blocking Git/gate work away from the HTTP and MCP event loop. */
export function beginOperation(kind, targetId, actorName, db, repoRoot, onUpdate = () => {}) {
  const database = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!database) throw new Error('Background verification requires a file-backed database.');
  const id = randomUUID();
  assertWorkspaceIdle(db);
  try {
    db.prepare("INSERT INTO operations (id, kind, target_id, actor, status, owner_pid) VALUES (?, ?, ?, ?, 'running', ?)").run(id, kind, targetId, actorName, process.pid);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw Object.assign(new Error('Another verification is already running.'), { statusCode: 409 });
    throw err;
  }
  try {
    checkpointState(db);
    onUpdate();
  } catch (error) {
    db.prepare("UPDATE operations SET status = 'failed', result_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify({ success: false, error: error.message }), id);
    throw error;
  }
  const completion = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      const success = !error && result?.success !== false;
      try {
      db.prepare('UPDATE operations SET status = ?, result_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        success ? 'completed' : 'failed', JSON.stringify(error ? { success: false, error: error.message } : result), id
      );
      checkpointState(db);
      onUpdate();
      } catch (persistenceError) {
        reject(persistenceError);
        return;
      }
      if (error) reject(error); else resolve(result);
    };
    try {
      const worker = new Worker(new URL('./operation-worker.mjs', import.meta.url), {
        workerData: { kind, targetId, actorName, database, repoRoot }
      });
      worker.once('message', message => message.error ? finish(null, new Error(message.error)) : finish(message.result));
      worker.once('error', err => finish(null, err));
      worker.once('exit', code => { if (!settled) finish(null, new Error(`Verification worker exited before returning a result (code ${code}).`)); });
    } catch (err) { finish(null, err); }
  });
  // HTTP callers use the operation ledger; MCP callers can await completion.
  active.add(completion);
  completion.then(() => active.delete(completion), () => active.delete(completion));
  return { id, completion };
}
