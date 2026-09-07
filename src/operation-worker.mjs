import { parentPort, workerData } from 'node:worker_threads';
import { getDb, closeDb } from './db.mjs';
import { getTask } from './tasks.mjs';
import { verifyAndSettleTask } from './settle.mjs';
import { settleFeature } from './features.mjs';
const { kind, targetId, actorName, database, repoRoot } = workerData;
const db = getDb(database, repoRoot);
try {
  let result;
  if (kind === 'task') {
    const task = getTask(targetId, db);
    if (!task) throw new Error(`Task ${targetId} not found.`);
    if (!task.worktree_path) throw new Error('This task has no managed workspace. Release and start it again to provision one.');
    result = verifyAndSettleTask({ taskId: targetId, actorName, worktreePath: task.worktree_path, db, repoRoot });
  } else if (kind === 'feature') {
    result = settleFeature({ featureId: targetId, actorName }, db, repoRoot);
  } else throw new Error('Unknown verification operation.');
  parentPort.postMessage({ result });
} catch (err) {
  parentPort.postMessage({ error: err.message });
} finally {
  closeDb(db);
}
