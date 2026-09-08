import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb, closeDb, saveArtifact, readArtifact, recordSettlementEvent, withTransaction } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { parkInsight, promoteIncubatorItem } from '../src/incubator.mjs';
import { startTask } from '../src/workspace.mjs';
import { repairDatabase } from '../src/repair.mjs';
import { STATE_TABLES, readStateCheckpoint } from '../src/durability.mjs';

test('Git checkpoint restores exact contracts, leases, promotion links, events and artifacts', async () => {
  await withSandbox(async sandbox => {
    const dbPath = path.join(sandbox.dir, '.vibesync/state.db');
    let db = getDb(dbPath, sandbox.dir);
    const head = sandbox.execGit('git rev-parse HEAD');
    createFeature({ id: 'FEAT-DURABLE', title: 'Exact contract', target_milestone: 'v2', spec_markdown: 'Preserve every field', holistic_gate_cmd: 'git diff --check', labels: ['recovery'] }, db);
    createTask({ id: 'TASK-DURABLE', feature_id: 'FEAT-DURABLE', title: 'Unfinished work', allowed_paths: ['src/**'], required_gates: ['git diff --check'] }, db);
    startTask({ taskId: 'TASK-DURABLE', actorName: 'human' }, db, sandbox.dir);
    parkInsight({ id: 'INC-DURABLE', title: 'Preserve idea', category: 'debt', context_notes: 'Original rationale', logged_by: 'human' }, db, sandbox.dir);
    promoteIncubatorItem({ id: 'INC-DURABLE', featureId: 'FEAT-DURABLE' }, db, sandbox.dir);
    const hash = saveArtifact('diagnostic output\n', sandbox.dir);
    recordSettlementEvent(db, { task_id: 'TASK-DURABLE', feature_id: 'FEAT-DURABLE', actor: 'human', action: 'gate_failed', commit_ref: head, artifact_hash: hash });
    const before = Object.fromEntries(STATE_TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    assert.equal(sandbox.execGit('git rev-parse HEAD'), head, 'Checkpoint must not alter trunk');
    closeDb(db);
    fs.unlinkSync(dbPath);
    fs.rmSync(path.join(sandbox.dir, '.vibesync/artifacts'), { recursive: true, force: true });
    const summary = repairDatabase(sandbox.dir);
    assert.equal(summary.recoveryMode, 'checkpoint');
    db = getDb(dbPath, sandbox.dir);
    for (const table of STATE_TABLES) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table], table);
    assert.equal(readArtifact(hash, sandbox.dir), 'diagnostic output\n');
    repairDatabase(sandbox.dir, db);
    for (const table of STATE_TABLES) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table], `${table} repeated recovery`);
  });
});

test('rolled-back database transactions never become durable checkpoints', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-KEEP', title: 'Keep', target_milestone: 'v1', spec_markdown: 'Valid' }, db);
    const before = readStateCheckpoint(sandbox.dir).commit;
    assert.throws(() => withTransaction(db, () => {
      createFeature({ id: 'FEAT-ROLLBACK', title: 'Rollback', target_milestone: 'v1', spec_markdown: 'Invalid' }, db);
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(readStateCheckpoint(sandbox.dir).commit, before);
  });
});

test('repair CLI replaces a corrupt database and preserves its original bytes in a backup', async () => {
  await withSandbox(async sandbox => {
    const { spawnSync } = await import('node:child_process');
    const dbPath = path.join(sandbox.dir, '.vibesync/state.db');
    const db = getDb(dbPath, sandbox.dir);
    createFeature({ id: 'FEAT-CORRUPT', title: 'Recover me', target_milestone: 'v1', spec_markdown: 'Original contract' }, db);
    closeDb(db);
    fs.writeFileSync(dbPath, 'corrupted database bytes');
    const result = spawnSync(process.execPath, [path.resolve('scripts/vibesync-repair.mjs'), '--repo', sandbox.dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /checkpoint/);
    const restored = getDb(dbPath, sandbox.dir);
    assert.equal(restored.prepare('SELECT title FROM features WHERE id = ?').get('FEAT-CORRUPT').title, 'Recover me');
    closeDb(restored);
    const backupRoot = path.join(sandbox.dir, '.vibesync/backups');
    const backup = fs.readdirSync(backupRoot)[0];
    assert.equal(fs.readFileSync(path.join(backupRoot, backup, 'state.db'), 'utf8'), 'corrupted database bytes');
  });
});
