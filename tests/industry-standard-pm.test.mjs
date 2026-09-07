/**
 * tests/industry-standard-pm.test.mjs
 * 
 * Comprehensive Test Suite for Industry-Standard Project Management Schema Enhancements:
 * - Priority levels ('urgent' | 'high' | 'medium' | 'low')
 * - Labels array serialization/deserialization
 * - External issue references (e.g. 'GH-142', 'LIN-89')
 * - Migration safety on legacy databases
 * - Active Anchor Hydration (.vibesync_ACTIVE_TASK.md)
 * - RFC 2822 Git Commit Trailers & Notes
 * - Self-Healing Disaster Recovery (vibesync:repair)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { withSandbox } from './harness.mjs';
import { getDb, closeDb, initSchema, migrateSchema } from '../src/db.mjs';
import { createFeature, getFeature, listFeatures, updateFeature } from '../src/features.mjs';
import { createTask, getTask, listTasks, updateTask, hydrateActiveTaskAnchor, claimTask } from '../src/tasks.mjs';
import { formatCommitTrailers, appendGitNote, verifyAndSettleTask } from '../src/settle.mjs';
import { repairDatabase } from '../src/repair.mjs';
import { getPayload } from '../src/server.mjs';
import { PRIORITY_LEVELS } from '../src/config.mjs';

test('Industry-Standard Project Management Enhancements Suite', async (t) => {

  await t.test('1. DDL Constraints & Migration Safety', async (t) => {
    await t.test('New database schema contains priority, labels, and external_ref columns', () => {
      const memDb = new DatabaseSync(':memory:');
      initSchema(memDb);

      const featureCols = memDb.prepare('PRAGMA table_info(features)').all().map(c => c.name);
      assert.ok(featureCols.includes('priority'), 'features table has priority column');
      assert.ok(featureCols.includes('labels'), 'features table has labels column');
      assert.ok(featureCols.includes('external_ref'), 'features table has external_ref column');

      const taskCols = memDb.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
      assert.ok(taskCols.includes('priority'), 'tasks table has priority column');
      assert.ok(taskCols.includes('labels'), 'tasks table has labels column');
      assert.ok(taskCols.includes('external_ref'), 'tasks table has external_ref column');

      memDb.close();
    });

    await t.test('CHECK constraint enforces valid priority levels on features and tasks', () => {
      const memDb = new DatabaseSync(':memory:');
      initSchema(memDb);

      // Features valid priorities
      for (const p of PRIORITY_LEVELS) {
        memDb.prepare(`
          INSERT INTO features (id, title, target_milestone, status, priority, spec_markdown)
          VALUES (?, 'Title', 'v1.0', 'ready', ?, 'Spec')
        `).run(`FEAT-PRIO-${p}`, p);
      }

      // Feature invalid priority fails CHECK constraint
      assert.throws(() => {
        memDb.prepare(`
          INSERT INTO features (id, title, target_milestone, status, priority, spec_markdown)
          VALUES ('FEAT-INVALID', 'Title', 'v1.0', 'ready', 'super-critical', 'Spec')
        `).run();
      }, /CHECK constraint failed/);

      // Tasks valid priorities
      for (const p of PRIORITY_LEVELS) {
        memDb.prepare(`
          INSERT INTO tasks (id, feature_id, title, status, priority)
          VALUES (?, 'FEAT-PRIO-medium', 'Title', 'ready', ?)
        `).run(`TASK-PRIO-${p}`, p);
      }

      // Task invalid priority fails CHECK constraint
      assert.throws(() => {
        memDb.prepare(`
          INSERT INTO tasks (id, feature_id, title, status, priority)
          VALUES ('TASK-INVALID', 'FEAT-PRIO-medium', 'Title', 'ready', 'whenever')
        `).run();
      }, /CHECK constraint failed/);

      memDb.close();
    });

    await t.test('migrateSchema seamlessly upgrades legacy databases without data loss', () => {
      const legacyDb = new DatabaseSync(':memory:');
      // Create legacy features and tasks tables without priority, labels, external_ref
      legacyDb.exec(`
        CREATE TABLE features (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          target_milestone TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          spec_markdown TEXT NOT NULL,
          holistic_gate_cmd TEXT,
          settled_commit TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          settled_at DATETIME
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          feature_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          assigned_actor TEXT,
          branch_name TEXT,
          base_commit TEXT,
          settled_commit TEXT,
          allowed_paths JSON NOT NULL DEFAULT '["*"]',
          required_gates JSON NOT NULL DEFAULT '[]',
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          max_failures INTEGER NOT NULL DEFAULT 3,
          lease_expires_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Seed pre-existing records
      legacyDb.prepare(`
        INSERT INTO features (id, title, target_milestone, status, spec_markdown)
        VALUES ('FEAT-OLD', 'Legacy Contract', 'v1.0', 'ready', 'Spec')
      `).run();

      legacyDb.prepare(`
        INSERT INTO tasks (id, feature_id, title, status)
        VALUES ('TASK-OLD', 'FEAT-OLD', 'Legacy Task', 'ready')
      `).run();

      // Run migration
      migrateSchema(legacyDb);

      // Verify columns were added
      const feature = legacyDb.prepare('SELECT * FROM features WHERE id = ?').get('FEAT-OLD');
      assert.equal(feature.priority, 'medium');
      assert.equal(feature.labels, '[]');
      assert.equal(feature.external_ref, null);

      const task = legacyDb.prepare('SELECT * FROM tasks WHERE id = ?').get('TASK-OLD');
      assert.equal(task.priority, 'medium');
      assert.equal(task.labels, '[]');
      assert.equal(task.external_ref, null);

      legacyDb.close();
    });
  });

  await t.test('2. Features State Engine Operations', () => {
    const memDb = new DatabaseSync(':memory:');
    initSchema(memDb);

    // 1. Create with defaults
    const f1 = createFeature({
      id: 'FEAT-01',
      title: 'Auth System',
      target_milestone: 'v1.0',
      spec_markdown: 'OAuth2 contract'
    }, memDb);

    assert.equal(f1.priority, 'medium');
    assert.deepEqual(f1.labels, []);
    assert.equal(f1.external_ref, null);

    // 2. Create with custom industry attributes
    const f2 = createFeature({
      id: 'FEAT-02',
      title: 'Billing Integration',
      target_milestone: 'v1.1',
      priority: 'urgent',
      labels: ['stripe', 'payments', 'compliance'],
      external_ref: 'LIN-409',
      spec_markdown: 'PCI compliant checkout'
    }, memDb);

    assert.equal(f2.priority, 'urgent');
    assert.deepEqual(f2.labels, ['stripe', 'payments', 'compliance']);
    assert.equal(f2.external_ref, 'LIN-409');

    // 3. Validation on invalid priority
    assert.throws(() => {
      createFeature({
        id: 'FEAT-03',
        title: 'Bad Priority',
        target_milestone: 'v1.0',
        priority: 'not-a-priority',
        spec_markdown: 'Spec'
      }, memDb);
    }, /Invalid feature priority/);

    // 4. Update priority, labels, and external_ref
    const updated = updateFeature('FEAT-01', {
      priority: 'high',
      labels: ['security', 'auth'],
      external_ref: 'GH-89'
    }, memDb);

    assert.equal(updated.priority, 'high');
    assert.deepEqual(updated.labels, ['security', 'auth']);
    assert.equal(updated.external_ref, 'GH-89');

    // 5. Query filtering by priority
    const urgentFeatures = listFeatures(memDb, { priority: 'urgent' });
    assert.equal(urgentFeatures.length, 1);
    assert.equal(urgentFeatures[0].id, 'FEAT-02');

    const highFeatures = listFeatures(memDb, { priority: 'high' });
    assert.equal(highFeatures.length, 1);
    assert.equal(highFeatures[0].id, 'FEAT-01');

    memDb.close();
  });

  await t.test('3. Tasks State Engine Operations & Anchor Hydration', () => {
    const memDb = new DatabaseSync(':memory:');
    initSchema(memDb);

    createFeature({
      id: 'FEAT-AUTH',
      title: 'Authentication',
      target_milestone: 'v1.0',
      priority: 'high',
      labels: ['auth'],
      spec_markdown: 'Spec'
    }, memDb);

    // 1. Create with defaults
    const t1 = createTask({
      id: 'TASK-AUTH-1',
      feature_id: 'FEAT-AUTH',
      title: 'Create JWT signing key'
    }, memDb);

    assert.equal(t1.priority, 'medium');
    assert.deepEqual(t1.labels, []);
    assert.equal(t1.external_ref, null);

    // 2. Create with custom industry attributes
    const t2 = createTask({
      id: 'TASK-AUTH-2',
      feature_id: 'FEAT-AUTH',
      title: 'Implement token refresh rotation',
      priority: 'urgent',
      labels: ['security', 'jwt', 'backend'],
      external_ref: 'GH-102',
      allowed_paths: ['src/auth/**'],
      required_gates: ['npm test']
    }, memDb);

    assert.equal(t2.priority, 'urgent');
    assert.deepEqual(t2.labels, ['security', 'jwt', 'backend']);
    assert.equal(t2.external_ref, 'GH-102');

    // 3. Validation on invalid priority
    assert.throws(() => {
      createTask({
        id: 'TASK-BAD',
        feature_id: 'FEAT-AUTH',
        title: 'Bad',
        priority: 'blocker'
      }, memDb);
    }, /Invalid task priority/);

    // 4. Update task attributes
    const updated = updateTask('TASK-AUTH-1', {
      priority: 'low',
      labels: ['cleanup'],
      external_ref: 'GH-103'
    }, memDb);

    assert.equal(updated.priority, 'low');
    assert.deepEqual(updated.labels, ['cleanup']);
    assert.equal(updated.external_ref, 'GH-103');

    // 5. Query filtering by priority and external_ref
    const urgentTasks = listTasks(memDb, { priority: 'urgent' });
    assert.equal(urgentTasks.length, 1);
    assert.equal(urgentTasks[0].id, 'TASK-AUTH-2');

    const extTasks = listTasks(memDb, { external_ref: 'GH-102' });
    assert.equal(extTasks.length, 1);
    assert.equal(extTasks[0].id, 'TASK-AUTH-2');

    // 6. Active Anchor Hydration with Priority, Labels, and External Ref
    const tmpDir = path.join(process.cwd(), 'scratch', 'anchor-test-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    const anchorPath = hydrateActiveTaskAnchor(tmpDir, t2, getFeature('FEAT-AUTH', memDb));
    assert.ok(fs.existsSync(anchorPath));

    const content = fs.readFileSync(anchorPath, 'utf8');
    assert.ok(content.includes('**Priority:** urgent'), 'Anchor contains Priority: urgent');
    assert.ok(content.includes('**Labels:** security, jwt, backend'), 'Anchor contains Labels');
    assert.ok(content.includes('**External Ref:** GH-102'), 'Anchor contains External Ref: GH-102');

    fs.rmSync(tmpDir, { recursive: true, force: true });
    memDb.close();
  });

  await t.test('4. RFC 2822 Trailers, Git Notes, and Disaster Recovery', async () => {
    // 1. Commit message trailers
    const trailerMsg = formatCommitTrailers({
      title: 'Fix token leak',
      taskId: 'TASK-SEC-01',
      featureId: 'FEAT-SEC',
      actorName: 'gemini-antigravity',
      baseCommit: 'a1b2c3d',
      priority: 'urgent',
      labels: ['security', 'hotfix'],
      externalRef: 'GH-999',
      gates: ['npm run lint', 'npm test']
    });

    assert.ok(trailerMsg.includes('Priority: urgent'), 'Trailers contain Priority');
    assert.ok(trailerMsg.includes('Labels: security, hotfix'), 'Trailers contain Labels');
    assert.ok(trailerMsg.includes('External-Ref: GH-999'), 'Trailers contain External-Ref');

    // 2. Disaster Recovery Reconstruction
    await withSandbox(async (sandbox) => {
      const { dir: repoRoot } = sandbox;

      // Create dummy file and commit with full trailers
      fs.writeFileSync(path.join(repoRoot, 'service.mjs'), 'export const active = true;\n');
      sandbox.execGit('git add service.mjs');

      const commitWithTrailers = formatCommitTrailers({
        title: 'Implement OAuth callback',
        taskId: 'TASK-RECOVER-1',
        featureId: 'FEAT-RECOVER',
        actorName: 'openai-codex',
        baseCommit: '1111111',
        priority: 'high',
        labels: ['auth', 'backend'],
        externalRef: 'LIN-555',
        gates: ['echo PASS']
      });

      sandbox.execGit(`git commit --allow-empty -m "${commitWithTrailers.replace(/"/g, '\\"')}"`);
      const headSha = sandbox.execGit('git rev-parse HEAD');

      // Attach git notes with structured metadata
      appendGitNote(headSha, {
        taskId: 'TASK-RECOVER-1',
        featureId: 'FEAT-RECOVER',
        actor: 'openai-codex',
        priority: 'high',
        labels: ['auth', 'backend'],
        externalRef: 'LIN-555',
        status: 'PASS'
      }, { repoRoot });

      // Run repair on empty database
      const recoverDb = new DatabaseSync(':memory:');
      const stats = repairDatabase(repoRoot, recoverDb);

      assert.equal(stats.tasksCount, 1);
      assert.equal(stats.featuresCount, 1);

      const recoveredTask = getTask('TASK-RECOVER-1', recoverDb);
      assert.equal(recoveredTask.id, 'TASK-RECOVER-1');
      assert.equal(recoveredTask.priority, 'high');
      assert.deepEqual(recoveredTask.labels, ['auth', 'backend']);
      assert.equal(recoveredTask.external_ref, 'LIN-555');

      const recoveredFeature = getFeature('FEAT-RECOVER', recoverDb);
      assert.equal(recoveredFeature.id, 'FEAT-RECOVER');
      assert.equal(recoveredFeature.priority, 'high');
      assert.deepEqual(recoveredFeature.labels, ['auth', 'backend']);
      assert.equal(recoveredFeature.external_ref, 'LIN-555');

      recoverDb.close();
    });
  });

  await t.test('5. System Payload & Agent ActiveTask Synthesis', () => {
    const memDb = new DatabaseSync(':memory:');
    initSchema(memDb);

    createFeature({
      id: 'FEAT-SYNTH',
      title: 'Real-Time Sync',
      target_milestone: 'v2.0',
      priority: 'high',
      labels: ['websocket', 'hud'],
      external_ref: 'GH-200',
      spec_markdown: 'SSE & WebSocket specs'
    }, memDb);

    createTask({
      id: 'TASK-SYNTH-1',
      feature_id: 'FEAT-SYNTH',
      title: 'Build state streaming endpoint',
      status: 'in_progress',
      priority: 'urgent',
      labels: ['sse', 'api'],
      external_ref: 'GH-201',
      assigned_actor: 'openai-codex'
    }, memDb);

    const payload = getPayload(memDb, process.cwd());

    // Verify features and tasks in payload have all fields
    assert.equal(payload.features.length, 1);
    assert.equal(payload.features[0].priority, 'high');
    assert.deepEqual(payload.features[0].labels, ['websocket', 'hud']);
    assert.equal(payload.features[0].external_ref, 'GH-200');

    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0].priority, 'urgent');
    assert.deepEqual(payload.tasks[0].labels, ['sse', 'api']);
    assert.equal(payload.tasks[0].external_ref, 'GH-201');

    // Verify synthesized agent has enriched activeTask
    const codexAgent = payload.agents.find(a => a.actorName.includes('codex') || a.id === 'implementer');
    assert.ok(codexAgent);
    assert.equal(codexAgent.activeTask.id, 'TASK-SYNTH-1');
    assert.equal(codexAgent.activeTask.priority, 'urgent');
    assert.deepEqual(codexAgent.activeTask.labels, ['sse', 'api']);
    assert.equal(codexAgent.activeTask.externalRef, 'GH-201');

    memDb.close();
  });

});
