/**
 * tests/m1-state-engine.test.mjs
 * 
 * Comprehensive Unit Test Suite for Milestone 1: 3-Tier State Engine & Persistence
 */

import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import {
  getDb,
  closeDb,
  initSchema,
  withTransaction,
  saveArtifact,
  readArtifact,
  recordSettlementEvent
} from '../src/db.mjs';

import {
  createFeature,
  getFeature,
  listFeatures,
  updateFeature,
  settleFeature
} from '../src/features.mjs';

import {
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  claimTask,
  releaseTaskLease,
  checkAndExpireLeases,
  hydrateActiveTaskAnchor
} from '../src/tasks.mjs';

import {
  parkInsight,
  getIncubatorItems,
  getIncubatorItem,
  promoteIncubatorItem,
  discardIncubatorItem,
  syncIncubatorToOrphanBranch,
  readIncubatorFromOrphanBranch,
  generateNextIncubatorId,
  validateIncubatorCategory,
  validateIncubatorStatus,
  execGitWithBackoff
} from '../src/incubator.mjs';

function createSandbox() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-m1-test-'));

  execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "VibeSync Test Runner"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "test@vibesync.local"', { cwd: tmpDir, stdio: 'ignore' });

  const gitignore = `.vibesync/*.db\n.vibesync/*.db-wal\n.vibesync/*.db-shm\n.vibesync/artifacts/\n.vibesync_ACTIVE_TASK.md\n`;
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), gitignore, 'utf8');
  execSync('git add .gitignore && git commit -m "chore: initial repository baseline"', { cwd: tmpDir, stdio: 'ignore' });

  const dbDir = path.join(tmpDir, '.vibesync');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'state.db');

  const db = getDb(dbPath, tmpDir);
  initSchema(db);

  return { tmpDir, db, dbPath };
}

describe('Milestone 1 State Engine Unit Tests', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    closeDb(sandbox.db);
    fs.rmSync(sandbox.tmpDir, { recursive: true, force: true });
  });

  it('1. PRAGMAs: enforces WAL mode, foreign keys, and busy timeout', () => {
    const { db } = sandbox;
    const jm = db.prepare('PRAGMA journal_mode;').get();
    assert.equal(jm.journal_mode, 'wal');

    const fk = db.prepare('PRAGMA foreign_keys;').get();
    assert.equal(fk.foreign_keys, 1);

    const bt = db.prepare('PRAGMA busy_timeout;').get();
    assert.equal(bt.timeout, 5000);
  });

  it('2. Schema: initializes core tables, operation ledger, and query indices', () => {
    const { db } = sandbox;
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;
    `).all().map(r => r.name);
    assert.deepEqual(tables, ['features', 'incubator', 'operations', 'settlement_events', 'tasks']);

    const indices = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name;
    `).all().map(r => r.name);
    assert.deepEqual(indices, [
      'idx_features_status',
      'idx_incubator_status',
      'idx_one_running_operation',
      'idx_settlement_feature',
      'idx_settlement_task',
      'idx_settlement_timestamp',
      'idx_tasks_feature',
      'idx_tasks_status'
    ]);
  });

  it('3. CHECK Constraints: rejects invalid category, status, and action enums', () => {
    const { db } = sandbox;

    // Invalid incubator category
    assert.throws(() => {
      db.prepare(`
        INSERT INTO incubator (id, title, category, context_notes, logged_by)
        VALUES ('INC-BAD', 'Title', 'invalid_category', 'Notes', 'human')
      `).run();
    }, /CHECK constraint failed/);

    // Invalid feature status
    assert.throws(() => {
      db.prepare(`
        INSERT INTO features (id, title, target_milestone, status, spec_markdown)
        VALUES ('FEAT-BAD', 'Title', 'v1.0', 'bad_status', 'Spec')
      `).run();
    }, /CHECK constraint failed/);

    // Invalid task status
    assert.throws(() => {
      db.prepare(`
        INSERT INTO tasks (id, feature_id, title, status)
        VALUES ('TASK-BAD', 'FEAT-BAD', 'Title', 'invalid_status')
      `).run();
    }, /CHECK constraint failed/);

    // Invalid event action
    assert.throws(() => {
      db.prepare(`
        INSERT INTO settlement_events (actor, action, commit_ref)
        VALUES ('human', 'invalid_action', '0000000')
      `).run();
    }, /CHECK constraint failed/);
  });

  it('4. Foreign Keys & Cascades: cascades task deletion and sets null on target deletion', () => {
    const { db } = sandbox;
    createFeature({
      id: 'FEAT-FK',
      title: 'Parent Feature',
      target_milestone: 'v1.0',
      spec_markdown: '# Contract Spec'
    }, db);

    // Task referencing non-existent feature fails
    assert.throws(() => {
      createTask({
        id: 'TASK-ORPHAN',
        feature_id: 'NON_EXISTENT_FEAT',
        title: 'Orphan Task'
      }, db);
    }, /FOREIGN KEY constraint failed/);

    // Valid child tasks
    createTask({
      id: 'TASK-FK-1',
      feature_id: 'FEAT-FK',
      title: 'Child Task 1'
    }, db);
    createTask({
      id: 'TASK-FK-2',
      feature_id: 'FEAT-FK',
      title: 'Child Task 2'
    }, db);

    const countBefore = db.prepare('SELECT count(*) as c FROM tasks WHERE feature_id = ?').get('FEAT-FK');
    assert.equal(countBefore.c, 2);

    // Deleting parent feature cascades to child tasks
    db.prepare('DELETE FROM features WHERE id = ?').run('FEAT-FK');
    const countAfter = db.prepare('SELECT count(*) as c FROM tasks WHERE feature_id = ?').get('FEAT-FK');
    assert.equal(countAfter.c, 0);

    // Set null on promoted feature deletion
    createFeature({
      id: 'FEAT-PROM',
      title: 'Promoted Feature',
      target_milestone: 'v1.0',
      spec_markdown: '# Promoted Spec'
    }, db);

    db.prepare(`
      INSERT INTO incubator (id, title, category, context_notes, logged_by, status, promoted_feature_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('INC-PROM', 'Idea', 'debt', 'Notes', 'human', 'promoted', 'FEAT-PROM');

    db.prepare('DELETE FROM features WHERE id = ?').run('FEAT-PROM');
    const incItem = db.prepare('SELECT * FROM incubator WHERE id = ?').get('INC-PROM');
    assert.equal(incItem.promoted_feature_id, null);
    assert.equal(incItem.status, 'promoted');
  });

  it('5. Artifact Offloader: writes 12-char SHA-256 log and reads back accurately', () => {
    const { tmpDir } = sandbox;
    const logContent = 'AssertionError [ERR_ASSERTION]: Expected 0 to equal 1\n    at test.js:42:10';
    const hash = saveArtifact(logContent, tmpDir);

    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 12);

    const restored = readArtifact(hash, tmpDir);
    assert.equal(restored, logContent);

    // Non-existent hash returns null
    assert.equal(readArtifact('nonexistent12', tmpDir), null);
  });

  it('6. withTransaction: commits on success and rolls back on exception', () => {
    const { db } = sandbox;
    db.prepare('CREATE TABLE txn_test (val TEXT);').run();

    withTransaction(db, () => {
      db.prepare('INSERT INTO txn_test VALUES (?)').run('committed_val');
    });
    assert.equal(db.prepare('SELECT count(*) as c FROM txn_test').get().c, 1);

    assert.throws(() => {
      withTransaction(db, () => {
        db.prepare('INSERT INTO txn_test VALUES (?)').run('aborted_val');
        throw new Error('forced rollback');
      });
    }, /forced rollback/);

    assert.equal(db.prepare('SELECT count(*) as c FROM txn_test').get().c, 1);
  });

  it('7. Features Management: contract creation, retrieval, filtering, and updates', () => {
    const { db } = sandbox;
    const created = createFeature({
      id: 'FEAT-6A',
      title: 'Scene Background Art & Parallax',
      target_milestone: 'v0.3',
      spec_markdown: '### Frozen Specifications\n- Allowed boundaries\n- Interfaces',
      holistic_gate_cmd: 'echo "gate passed"'
    }, db);

    assert.equal(created.id, 'FEAT-6A');
    assert.equal(created.status, 'ready');

    const fetched = getFeature('FEAT-6A', db);
    assert.equal(fetched.title, 'Scene Background Art & Parallax');

    const readyList = listFeatures(db, { status: 'ready' });
    assert.equal(readyList.length, 1);

    const updated = updateFeature('FEAT-6A', { title: 'Updated Title' }, db);
    assert.equal(updated.title, 'Updated Title');
  });

  it('8. Feature Settlement: aborts when child tasks remain unsettled', () => {
    const { db, tmpDir } = sandbox;
    createFeature({ id: 'FEAT-ST', title: 'Feature Settlement Test', target_milestone: 'v1.0', spec_markdown: 'Spec' }, db);
    createTask({ id: 'TASK-ST.1', feature_id: 'FEAT-ST', title: 'Task 1', status: 'ready' }, db);
    createTask({ id: 'TASK-ST.2', feature_id: 'FEAT-ST', title: 'Task 2', status: 'in_progress' }, db);

    assert.throws(() => {
      settleFeature({ featureId: 'FEAT-ST', actorName: 'human' }, db, tmpDir);
    }, /Cannot settle feature FEAT-ST: 2 child task\(s\) remain unsettled/);
  });

  it('9. Feature Settlement: holistic gate execution (pass and fail)', () => {
    const { db, tmpDir } = sandbox;

    // Passing gate
    createFeature({
      id: 'FEAT-PASS',
      title: 'Passing Gate Feature',
      target_milestone: 'v1.0',
      spec_markdown: 'Spec',
      holistic_gate_cmd: 'node -e "process.exit(0)"'
    }, db);
    createTask({ id: 'TASK-P1', feature_id: 'FEAT-PASS', title: 'Task P1', status: 'settled' }, db);

    const passRes = settleFeature({ featureId: 'FEAT-PASS', actorName: 'human' }, db, tmpDir);
    assert.equal(passRes.success, true);
    const settledFeat = getFeature('FEAT-PASS', db);
    assert.equal(settledFeat.status, 'settled');
    assert.ok(settledFeat.settled_commit);
    assert.ok(settledFeat.settled_at);

    // Failing gate
    createFeature({
      id: 'FEAT-FAIL',
      title: 'Failing Gate Feature',
      target_milestone: 'v1.0',
      spec_markdown: 'Spec',
      holistic_gate_cmd: 'node -e "process.exit(1)"'
    }, db);
    createTask({ id: 'TASK-F1', feature_id: 'FEAT-FAIL', title: 'Task F1', status: 'settled' }, db);

    assert.throws(() => {
      settleFeature({ featureId: 'FEAT-FAIL', actorName: 'human' }, db, tmpDir);
    }, /Holistic feature gate failed/);
  });

  it('10. Task Lifecycle & Leasing: atomic lease, TTL setting, and double-lease rejection', () => {
    const { db, tmpDir } = sandbox;
    createFeature({ id: 'FEAT-1', title: 'Feature 1', target_milestone: 'v1.0', spec_markdown: 'Spec' }, db);
    createTask({
      id: 'TASK-1.1',
      feature_id: 'FEAT-1',
      title: 'Setup Parser',
      allowed_paths: ['packages/shared/**'],
      required_gates: ['node -v']
    }, db);

    const worktreePath = path.join(tmpDir, 'worktrees/antigravity');
    const claimRes = claimTask({
      taskId: 'TASK-1.1',
      actorName: 'gemini-antigravity',
      worktreePath
    }, db, tmpDir);

    assert.equal(claimRes.success, true);
    assert.equal(claimRes.task.status, 'in_progress');
    assert.equal(claimRes.task.assigned_actor, 'gemini-antigravity');
    assert.equal(claimRes.task.branch_name, 'task/task-1-1');
    assert.ok(claimRes.task.lease_expires_at);

    // Double-lease rejection
    assert.throws(() => {
      claimTask({
        taskId: 'TASK-1.1',
        actorName: 'openai-codex',
        worktreePath: path.join(tmpDir, 'worktrees/codex')
      }, db, tmpDir);
    }, /Task TASK-1.1 is currently in_progress/);

    // Settled claim rejection
    db.prepare("UPDATE tasks SET status = 'settled' WHERE id = 'TASK-1.1'").run();
    assert.throws(() => {
      claimTask({ taskId: 'TASK-1.1', actorName: 'human' }, db, tmpDir);
    }, /Task TASK-1.1 is already settled/);
  });

  it('11. Lease TTL Expiry: expired task auto-unlocks to ready', () => {
    const { db, tmpDir } = sandbox;
    createFeature({ id: 'FEAT-1', title: 'F1', target_milestone: 'v1.0', spec_markdown: 'M' }, db);
    createTask({ id: 'TASK-TTL', feature_id: 'FEAT-1', title: 'TTL Task' }, db);

    claimTask({ taskId: 'TASK-TTL', actorName: 'gemini-antigravity' }, db, tmpDir);

    // Backdate lease expiration by 5 minutes
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-5 minutes') WHERE id = 'TASK-TTL'").run();

    const expiredCount = checkAndExpireLeases(db);
    assert.equal(expiredCount, 1);

    const task = getTask('TASK-TTL', db);
    assert.equal(task.status, 'ready');
    assert.equal(task.assigned_actor, null);
    assert.equal(task.lease_expires_at, null);

    // Re-claim succeeds cleanly
    const reclaim = claimTask({ taskId: 'TASK-TTL', actorName: 'openai-codex' }, db, tmpDir);
    assert.equal(reclaim.task.assigned_actor, 'openai-codex');
  });

  it('12. Context Anchor Hydration: generates .vibesync_ACTIVE_TASK.md with full contract', () => {
    const { db, tmpDir } = sandbox;
    createFeature({
      id: 'FEAT-6A',
      title: 'Scene Background Art',
      target_milestone: 'v0.3',
      spec_markdown: 'Frozen Spec'
    }, db);
    createTask({
      id: 'TASK-6A.1',
      feature_id: 'FEAT-6A',
      title: 'ProjectDocument Migration',
      allowed_paths: ['packages/shared/**', 'packages/engine/**'],
      required_gates: ['node -v', 'git --version']
    }, db);

    const worktreePath = path.join(tmpDir, 'worktrees/antigravity');
    const claim = claimTask({
      taskId: 'TASK-6A.1',
      actorName: 'gemini-antigravity',
      worktreePath
    }, db, tmpDir);

    assert.ok(claim.activeTaskAnchorPath);
    assert.ok(fs.existsSync(claim.activeTaskAnchorPath));

    const content = fs.readFileSync(claim.activeTaskAnchorPath, 'utf8');
    assert.match(content, /ACTIVE TASK: TASK-6A\.1 - ProjectDocument Migration/);
    assert.match(content, /FEAT-6A/);
    assert.match(content, /v0\.3/);
    assert.match(content, /gemini-antigravity/);
    assert.match(content, /task\/task-6a-1/);
    assert.match(content, /packages\/shared\/\*\*/);
    assert.match(content, /node -v/);
    assert.match(content, /Critical Invariants/);
  });

  it('13. Incubator ID Auto-Generation & Validation', () => {
    const { db } = sandbox;
    assert.equal(generateNextIncubatorId(db), 'INC-001');

    db.prepare(`
      INSERT INTO incubator (id, title, category, context_notes, logged_by)
      VALUES ('INC-001', 'T1', 'debt', 'N', 'human')
    `).run();
    assert.equal(generateNextIncubatorId(db), 'INC-002');

    // Validation helpers
    assert.doesNotThrow(() => validateIncubatorCategory('architecture_insight'));
    assert.throws(() => validateIncubatorCategory('invalid_cat'), /Invalid incubator category/);
    assert.doesNotThrow(() => validateIncubatorStatus('parked'));
    assert.throws(() => validateIncubatorStatus('invalid_status'), /Invalid incubator status/);
  });

  it('14. Incubator CRUD & Promotion/Discard Transitions', () => {
    const { db, tmpDir } = sandbox;
    createFeature({ id: 'FEAT-INCP', title: 'Target Feat', target_milestone: 'v1.0', spec_markdown: 'S' }, db);

    const p1 = parkInsight({
      title: 'Insight 1',
      category: 'architecture_insight',
      contextNotes: 'Note 1',
      actorName: 'gemini-antigravity'
    }, db, tmpDir);
    assert.equal(p1.id, 'INC-001');

    const p2 = parkInsight({
      title: 'Insight 2',
      category: 'ux_polish',
      contextNotes: 'Note 2',
      actorName: 'openai-codex'
    }, db, tmpDir);
    assert.equal(p2.id, 'INC-002');

    const items = getIncubatorItems(db);
    assert.equal(items.length, 2);

    // Promote p1 to FEAT-INCP
    const promRes = promoteIncubatorItem({ id: 'INC-001', featureId: 'FEAT-INCP' }, db, tmpDir);
    assert.equal(promRes.item.status, 'promoted');
    assert.equal(promRes.item.promoted_feature_id, 'FEAT-INCP');

    // Promotion to non-existent feature fails
    assert.throws(() => {
      promoteIncubatorItem({ id: 'INC-002', featureId: 'NON_EXISTENT' }, db, tmpDir);
    }, /Target feature "NON_EXISTENT" does not exist/);

    // Discard p2
    const discRes = discardIncubatorItem({ id: 'INC-002' }, db, tmpDir);
    assert.equal(discRes.item.status, 'discarded');

    // Parked items count is now 0
    const parkedItems = getIncubatorItems(db, { status: 'parked' });
    assert.equal(parkedItems.length, 0);
  });

  it('15. Orphan Branch Sync: writes incubator records with zero footprint on main', () => {
    const { db, tmpDir } = sandbox;
    const initialMainSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    parkInsight({
      id: 'INC-001',
      title: 'Decoupled Sound Buffer',
      category: 'architecture_insight',
      contextNotes: 'Observed during frame loop review',
      actorName: 'openai-codex'
    }, db, tmpDir);

    const commitSha = syncIncubatorToOrphanBranch(db, tmpDir);
    assert.ok(commitSha);

    // Verify orphan branch exists and contains incubator.json
    const records = readIncubatorFromOrphanBranch(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'INC-001');

    // Verify main branch HEAD is completely untouched
    const currentMainSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.equal(currentMainSha, initialMainSha);

    // Verify git status on main is completely clean
    const status = execSync('git status --porcelain', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.equal(status, '');

    // Verify git log main does not contain orphan commit
    const logMain = execSync('git log main --oneline', { cwd: tmpDir, encoding: 'utf8' });
    assert(!logMain.includes(commitSha));

    // Verify disconnected orphan branch tree (no shared commits with main)
    assert.throws(() => {
      execSync('git merge-base main vibesync/incubator', { cwd: tmpDir, stdio: 'pipe' });
    });
  });

  it('16. Empty Incubator Serialization: commits empty array to orphan branch', () => {
    const { db, tmpDir } = sandbox;
    // With 0 parked items
    const commitSha = syncIncubatorToOrphanBranch(db, tmpDir);
    assert.ok(commitSha);

    const records = readIncubatorFromOrphanBranch(tmpDir);
    assert.deepEqual(records, []);
  });

  it('17. Event Ledger: records chronological mutations with complete forensic metadata', () => {
    const { db, tmpDir } = sandbox;
    createFeature({ id: 'FEAT-EVT', title: 'Feature Evt', target_milestone: 'v1.0', spec_markdown: 'Spec' }, db);
    createTask({ id: 'TASK-EVT', feature_id: 'FEAT-EVT', title: 'Task Evt' }, db);
    claimTask({ taskId: 'TASK-EVT', actorName: 'gemini-antigravity' }, db, tmpDir);
    releaseTaskLease('TASK-EVT', db);

    const events = db.prepare('SELECT * FROM settlement_events ORDER BY id ASC').all();
    assert.equal(events.length, 3);
    assert.equal(events[0].action, 'feature_created');
    assert.equal(events[1].action, 'task_claimed');
    assert.equal(events[2].action, 'lease_released');
  });

  it('18. Lock Contention Backoff: retries and succeeds when lock is removed', () => {
    const { tmpDir } = sandbox;
    const lockFile = path.join(tmpDir, '.git/refs/heads/vibesync/incubator.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, 'lock');

    // Remove lock after 300ms in background
    setTimeout(() => {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }, 300);

    const output = execGitWithBackoff('git rev-parse --is-inside-work-tree', { cwd: tmpDir });
    assert.equal(output, 'true');
  });
});
