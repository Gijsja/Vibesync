import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { getDb, closeDb } from '../src/db.mjs';
import {
  parkInsight,
  mergeIncubatorItems,
  promoteMultipleIncubatorItems,
  getConventions,
  getIncubatorItem,
  getIncubatorItems,
  readIncubatorFromOrphanBranch
} from '../src/incubator.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask } from '../src/tasks.mjs';
import { verifyAndSettleTask } from '../src/settle.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { startServer } from '../src/server.mjs';
import { repairDatabase } from '../src/repair.mjs';

function createTestSandbox() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-inc-arch-'));

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

  return { tmpDir, db, dbPath };
}

describe('Incubator Architecture & Lean Operations', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createTestSandbox();
  });

  afterEach(() => {
    closeDb(sandbox.db);
    fs.rmSync(sandbox.tmpDir, { recursive: true, force: true });
  });

  it('1. Coalescing / Deduplication: merges repeat observations into existing parked record', () => {
    const { db, tmpDir } = sandbox;

    const first = parkInsight({
      title: 'Missing Composite Index on Tasks',
      category: 'architecture_insight',
      target_scope: 'src/db.mjs',
      context_notes: 'Initial observation: query on status and feature_id is slow.',
      actorName: 'gemini-antigravity'
    }, db, tmpDir);

    assert.equal(first.id, 'INC-001');
    assert.equal(first.coalesced, false);

    // Second agent observes the exact same issue mid-task
    const second = parkInsight({
      title: 'Missing Composite Index on Tasks Table',
      category: 'architecture_insight',
      target_scope: 'src/db.mjs',
      context_notes: 'Second observation: noticed high latency in getPayload query.',
      actorName: 'openai-codex'
    }, db, tmpDir);

    // Should coalesce into INC-001 without creating INC-002
    assert.equal(second.id, 'INC-001');
    assert.equal(second.coalesced, true);

    const parked = getIncubatorItems(db, { status: 'parked' });
    assert.equal(parked.length, 1, 'Only 1 record should exist, no duplicate ticket bloat');
    assert.ok(parked[0].context_notes.includes('Initial observation'));
    assert.ok(parked[0].context_notes.includes('Second observation'));
    assert.ok(parked[0].context_notes.includes('openai-codex'));
  });

  it('2. Structured Conventions: manages operational rules without .md files', () => {
    const { db, tmpDir } = sandbox;

    parkInsight({
      title: 'Headless Chromium Requires --user-data-dir on Linux',
      category: 'convention',
      target_scope: 'scripts/render.mjs',
      context_notes: 'When taking headless screenshots inside container, pass --user-data-dir to prevent profile creation error.',
      actorName: 'gemini-antigravity'
    }, db, tmpDir);

    const conventions = getConventions(db);
    assert.equal(conventions.length, 1);
    assert.equal(conventions[0].title, 'Headless Chromium Requires --user-data-dir on Linux');
    assert.equal(conventions[0].target_scope, 'scripts/render.mjs');

    // Create a task and verify claimTask returns structured conventions in memory
    createFeature({ id: 'FEAT-CV', title: 'Convention Test', target_milestone: 'v1.0', spec_markdown: 'Spec' }, db);
    createTask({ id: 'TASK-CV.1', feature_id: 'FEAT-CV', title: 'Task with convention', allowed_paths: ['*'] }, db);

    const directConventions = getConventions(db);
    assert.ok(directConventions[0].context_notes.includes('--user-data-dir'));
  });

  it('3. Merge Insights: consolidates multiple ideas into a single record', () => {
    const { db, tmpDir } = sandbox;

    const i1 = parkInsight({
      id: 'INC-010',
      title: 'IndexedDB binary cache for assets',
      category: 'architecture_insight',
      context_notes: 'Notes 1',
      actorName: 'codex',
      allowCoalesce: false
    }, db, tmpDir);

    const i2 = parkInsight({
      id: 'INC-011',
      title: 'Memory leak in asset disposal',
      category: 'debt',
      context_notes: 'Notes 2',
      actorName: 'claude',
      allowCoalesce: false
    }, db, tmpDir);

    const mergeResult = mergeIncubatorItems({
      sourceIds: ['INC-010', 'INC-011'],
      mergedTitle: 'Unified Asset Cache & Memory Management',
      mergedNotes: 'Consolidated strategy for asset storage and disposal.',
      actorName: 'human'
    }, db, tmpDir);

    assert.ok(mergeResult.targetId);
    assert.equal(mergeResult.mergedCount, 2);

    // Source items must be marked as merged
    const item1 = getIncubatorItem('INC-010', db);
    const item2 = getIncubatorItem('INC-011', db);
    assert.equal(item1.status, 'merged');
    assert.equal(item1.merged_into_id, mergeResult.targetId);
    assert.equal(item2.status, 'merged');
    assert.equal(item2.merged_into_id, mergeResult.targetId);

    // Target item is active and parked
    const target = getIncubatorItem(mergeResult.targetId, db);
    assert.equal(target.status, 'parked');
    assert.equal(target.title, 'Unified Asset Cache & Memory Management');

    // Only 1 item remains in active parked queue
    const active = getIncubatorItems(db, { status: 'parked' });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, mergeResult.targetId);
  });

  it('4. Batch Promotion: promotes multiple incubator ideas to a single Feature Contract', () => {
    const { db, tmpDir } = sandbox;

    createFeature({ id: 'FEAT-BATCH', title: 'Unified Feature', target_milestone: 'v1.0', spec_markdown: 'Spec' }, db);

    parkInsight({ id: 'INC-A', title: 'Part A', category: 'debt', context_notes: 'A', actorName: 'human', allowCoalesce: false }, db, tmpDir);
    parkInsight({ id: 'INC-B', title: 'Part B', category: 'debt', context_notes: 'B', actorName: 'human', allowCoalesce: false }, db, tmpDir);

    const res = promoteMultipleIncubatorItems({
      ids: ['INC-A', 'INC-B'],
      featureId: 'FEAT-BATCH',
      actorName: 'human'
    }, db, tmpDir);

    assert.equal(res.promotedIds.length, 2);
    assert.equal(res.featureId, 'FEAT-BATCH');

    const itemA = getIncubatorItem('INC-A', db);
    const itemB = getIncubatorItem('INC-B', db);
    assert.equal(itemA.status, 'promoted');
    assert.equal(itemA.promoted_feature_id, 'FEAT-BATCH');
    assert.equal(itemB.status, 'promoted');
    assert.equal(itemB.promoted_feature_id, 'FEAT-BATCH');

    // Active parked items count is 0
    assert.equal(getIncubatorItems(db, { status: 'parked' }).length, 0);
  });

  it('5. Pre-Settlement Insight Ingestion: parks insights during verifyAndSettleTask', () => {
    const { db, tmpDir } = sandbox;

    createFeature({ id: 'FEAT-SETTLE', title: 'Settle Feat', target_milestone: 'v1.0', spec_markdown: 'Spec' }, db);
    createTask({
      id: 'TASK-SETTLE.1',
      feature_id: 'FEAT-SETTLE',
      title: 'Settle Task',
      allowed_paths: ['*'],
      required_gates: []
    }, db);

    // Claim task
    const claim = claimTask({ taskId: 'TASK-SETTLE.1', actorName: 'gemini-antigravity' }, db, tmpDir);

    // Create task branch and modify a file
    execSync(`git checkout -b "${claim.task.branch_name}"`, { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'work.txt'), 'done\n', 'utf8');
    execSync('git add work.txt && git commit -m "work complete"', { cwd: tmpDir });
    execSync('git checkout main', { cwd: tmpDir });

    // Verify and settle with discovered insights
    const result = verifyAndSettleTask({
      taskId: 'TASK-SETTLE.1',
      actorName: 'gemini-antigravity',
      discovered_insights: [
        {
          title: 'Latent Race Condition in Worktree Detach',
          category: 'debt',
          context_notes: 'Discovered during worktree teardown analysis.',
          target_scope: 'src/settle.mjs'
        }
      ],
      repoRoot: tmpDir,
      db
    });

    assert.equal(result.success, true);
    assert.equal(result.phase, 'SETTLED');
    assert.ok(Array.isArray(result.parkedInsights));
    assert.equal(result.parkedInsights.length, 1);
    assert.equal(result.parkedInsights[0].coalesced, false);

    // Verify insight was stored in database
    const parked = getIncubatorItems(db, { status: 'parked' });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].title, 'Latent Race Condition in Worktree Detach');
    assert.equal(parked[0].target_scope, 'src/settle.mjs');
    assert.equal(parked[0].category, 'debt');
  });

  it('6. HTTP REST Endpoints: supports merge and batch promote over API', async () => {
    const { db, tmpDir } = sandbox;

    parkInsight({ id: 'INC-API-1', title: 'API Item 1', category: 'architecture_insight', actorName: 'tester', allowCoalesce: false }, db, tmpDir);
    parkInsight({ id: 'INC-API-2', title: 'API Item 2', category: 'debt', actorName: 'tester', allowCoalesce: false }, db, tmpDir);

    const server = await startServer({ repoRoot: tmpDir, port: 0, db, quiet: true });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // Test POST /api/incubator/merge
      const mergeRes = await fetch(`${baseUrl}/api/incubator/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_ids: ['INC-API-1', 'INC-API-2'],
          merged_title: 'Consolidated API Item',
          category: 'architecture_insight',
          actorName: 'api-tester'
        })
      });
      assert.equal(mergeRes.status, 200);
      const mergeData = await mergeRes.json();
      assert.equal(mergeData.success, true);
      assert.ok(mergeData.merged_id);

      // Test POST /api/incubator/promote-batch
      const promoteRes = await fetch(`${baseUrl}/api/incubator/promote-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incubator_ids: [mergeData.merged_id],
          feature_id: 'FEAT-BATCH-API',
          feature_title: 'Batch Promoted Feature via API',
          target_milestone: 'v2.0',
          actorName: 'api-tester'
        })
      });
      assert.equal(promoteRes.status, 200);
      const promoteData = await promoteRes.json();
      assert.equal(promoteData.success, true);
      assert.equal(promoteData.feature.id, 'FEAT-BATCH-API');
    } finally {
      await server.close();
    }
  });

  it('7. Disaster Recovery: reconstructs target_scope and conventions from orphan branch', () => {
    const { db, tmpDir } = sandbox;

    parkInsight({
      id: 'INC-REC',
      title: 'Convention with target scope',
      category: 'convention',
      target_scope: 'src/config.mjs',
      context_notes: 'Must keep timeouts under 5000ms',
      actorName: 'human',
      allowCoalesce: false
    }, db, tmpDir);

    // Ensure branch has the record
    const records = readIncubatorFromOrphanBranch(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].target_scope, 'src/config.mjs');

    // Wipe incubator table
    db.exec('DELETE FROM incubator');
    assert.equal(getIncubatorItems(db).length, 0);

    // Reconstruct via repairDatabase
    const stats = repairDatabase(tmpDir, db);
    assert.ok(stats.incubatorCount >= 1);

    const restored = getIncubatorItem('INC-REC', db);
    assert.ok(restored);
    assert.equal(restored.title, 'Convention with target scope');
    assert.equal(restored.category, 'convention');
    assert.equal(restored.target_scope, 'src/config.mjs');
  });
});
