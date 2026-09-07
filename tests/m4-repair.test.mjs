/**
 * tests/m4-repair.test.mjs
 * 
 * Milestone 4 Test Suite: Disaster Recovery & Self-Healing Reconciliation
 * Verifies Features 42–47:
 * - Complete state reconstruction from Git Merkle tree when state.db is deleted
 * - Incubator recovery from orphan branch (vibesync/incubator:incubator.json)
 * - Settled tasks and features recovery from RFC 2822 commit trailers
 * - Event ledger recovery from refs/notes/vibesync
 * - In-flight branch recovery from task/* branches
 * - Standalone CLI execution via scripts/vibesync-repair.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withSandbox } from './harness.mjs';

import { getDb, closeDb } from '../src/db.mjs';
import { createFeature, getFeature } from '../src/features.mjs';
import { createTask, getTask, claimTask } from '../src/tasks.mjs';
import { parkInsight, listIncubatorRecords } from '../src/incubator.mjs';
import { verifyAndSettleTask } from '../src/settle.mjs';
import { repairDatabase } from '../src/repair.mjs';

test('Milestone 4 Suite: Self-Healing Disaster Recovery', async (t) => {

  await t.test('1. Incubator Recovery: restores parked items from orphan branch', async () => {
    await withSandbox(async (sandbox) => {
      const dbPath = path.join(sandbox.dir, '.vibesync', 'state.db');
      let db = getDb(dbPath, sandbox.dir);

      parkInsight({
        id: 'INC-001',
        title: 'Binary WebAssembly Decompression',
        category: 'architecture_insight',
        context_notes: 'Spotted in bundle profiling',
        actor_name: 'gemini-antigravity'
      }, db, sandbox.dir);

      parkInsight({
        id: 'INC-002',
        title: 'IndexedDB Chunk Cache',
        category: 'debt',
        context_notes: 'Need to cache background tiles',
        actor_name: 'openai-codex'
      }, db, sandbox.dir);

      // Verify parked items exist
      assert.equal(listIncubatorRecords('parked', db).length, 2);

      // SIMULATE DISASTER: close and delete state.db
      closeDb(db);
      fs.unlinkSync(dbPath);
      assert.ok(!fs.existsSync(dbPath), 'state.db must be deleted');

      // Reconstruct database
      const summary = repairDatabase(sandbox.dir);
      assert.equal(summary.incubatorCount, 2);

      // Verify restored records
      db = getDb(dbPath, sandbox.dir);
      const restored = listIncubatorRecords('parked', db);
      assert.equal(restored.length, 2);
      const titles = restored.map(r => r.title);
      assert.ok(titles.includes('Binary WebAssembly Decompression'));
      assert.ok(titles.includes('IndexedDB Chunk Cache'));
    });
  });

  await t.test('2. Commit Trailers & Git Notes: restores settled features, tasks and events', async () => {
    await withSandbox(async (sandbox) => {
      const dbPath = path.join(sandbox.dir, '.vibesync', 'state.db');
      let db = getDb(dbPath, sandbox.dir);

      createFeature({
        id: 'FEAT-42',
        title: 'Pixel Deformation System',
        target_milestone: 'v0.5',
        spec_markdown: 'Deformation matrix specification'
      }, db);

      createTask({
        id: 'TASK-42.1',
        feature_id: 'FEAT-42',
        title: 'Deformation Matrix',
        allowed_paths: ['*'],
        required_gates: ['node -e "process.exit(0)"']
      }, db);

      const claimRes = claimTask({
        taskId: 'TASK-42.1',
        actorName: 'gemini-antigravity'
      }, db, sandbox.dir);
      const branchName = claimRes.task.branch_name;

      // Commit task implementation
      sandbox.createBranch(branchName, 'main', true);
      sandbox.commitFile('src/matrix.js', 'export const matrix = [];', 'feat(TASK-42.1): matrix implementation');
      sandbox.checkout('main');


      // Settle task
      const settleRes = verifyAndSettleTask({
        taskId: 'TASK-42.1',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });
      assert.equal(settleRes.success, true);
      const settledSha = settleRes.commitSha;

      // SIMULATE DISASTER: delete state.db
      closeDb(db);
      fs.unlinkSync(dbPath);

      // Run repair
      const summary = repairDatabase(sandbox.dir);
      assert.ok(summary.tasksCount >= 1);
      assert.ok(summary.featuresCount >= 1);
      assert.ok(summary.eventsCount >= 1);

      // Verify state
      db = getDb(dbPath, sandbox.dir);
      const restoredTask = getTask('TASK-42.1', db);
      assert.ok(restoredTask, 'Task must be restored');
      assert.equal(restoredTask.status, 'settled');
      assert.equal(restoredTask.feature_id, 'FEAT-42');
      assert.equal(restoredTask.settled_commit, settledSha);

      const restoredFeature = getFeature('FEAT-42', db);
      assert.ok(restoredFeature, 'Feature must be restored');
      assert.equal(restoredFeature.status, 'ready', 'Recovery must not settle a feature whose holistic gate has never run.');
      assert.equal(restoredFeature.spec_markdown, 'Deformation matrix specification');
    });
  });

  await t.test('3. In-Flight Branch Recovery: restores active task/* branches', async () => {
    await withSandbox(async (sandbox) => {
      const dbPath = path.join(sandbox.dir, '.vibesync', 'state.db');
      let db = getDb(dbPath, sandbox.dir);

      // Create an active in-flight branch directly in Git
      sandbox.createBranch('task/task-88.1', 'main', false);

      // Wipe database
      closeDb(db);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      // Run repair
      const summary = repairDatabase(sandbox.dir);
      assert.ok(summary.tasksCount >= 1);

      db = getDb(dbPath, sandbox.dir);
      const inFlightTask = getTask('TASK-88.1', db);
      assert.ok(inFlightTask, 'In-flight task must be recovered');
      assert.equal(inFlightTask.status, 'in_progress');
      assert.equal(inFlightTask.branch_name, 'task/task-88.1');
    });
  });

  await t.test('4. Standalone CLI: scripts/vibesync-repair.mjs executes successfully', async () => {
    await withSandbox(async (sandbox) => {
      const dbPath = path.join(sandbox.dir, '.vibesync', 'state.db');
      let db = getDb(dbPath, sandbox.dir);

      parkInsight({
        title: 'CLI Repair Test',
        category: 'ux_polish',
        context_notes: 'Verify standalone repair script',
        actor_name: 'human'
      }, db, sandbox.dir);

      closeDb(db);
      fs.unlinkSync(dbPath);

      // Run repair CLI in sandbox cwd
      const scriptPath = path.resolve(process.cwd(), 'scripts', 'vibesync-repair.mjs');
      const proc = spawnSync('node', [scriptPath], {
        cwd: sandbox.dir,
        encoding: 'utf8'
      });

      assert.equal(proc.status, 0, `Repair CLI exited with code ${proc.status}: ${proc.stderr}`);
      assert.ok(proc.stdout.includes('Reconciliation Complete'));
      assert.ok(fs.existsSync(dbPath), 'state.db must be recreated');
    });
  });

});
