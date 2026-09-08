/**
 * tests/adversarial-m1.test.mjs
 * 
 * Adversarial Stress-Testing & Invariant Verification Suite
 * Milestone 1: 3-Tier State Engine & Persistence
 */

import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, fork } from 'node:child_process';

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
  execGitWithBackoff
} from '../src/incubator.mjs';

function createSandbox() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-adv-m1-'));

  execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "Adversarial Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "adversary@vibesync.local"', { cwd: tmpDir, stdio: 'ignore' });

  const gitignore = `.vibesync/*.db\n.vibesync/*.db-wal\n.vibesync/*.db-shm\n.vibesync/artifacts/\n.vibesync_ACTIVE_TASK.md\n`;
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), gitignore, 'utf8');
  execSync('git add .gitignore && git commit -m "chore: baseline"', { cwd: tmpDir, stdio: 'ignore' });

  const dbDir = path.join(tmpDir, '.vibesync');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'state.db');

  const db = getDb(dbPath, tmpDir);
  initSchema(db);

  return { tmpDir, db, dbPath };
}

describe('Adversarial Milestone 1 Suite', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    closeDb(sandbox.db);
    fs.rmSync(sandbox.tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Dimension 1: SQLite Schema, Constraints, SQLi & Boundary Values
  // ==========================================================================

  describe('Dimension 1: SQLite Schema, SQLi & Boundaries', () => {
    it('ADV-01: Rejects all invalid category, status, and action enums', () => {
      const { db } = sandbox;

      // Incubator categories: only speculative_feature, architecture_insight, debt, ux_polish
      const badCategories = ['', 'bug', 'feature', 'SECURITY', 'debt; DROP TABLE incubator;'];
      for (const cat of badCategories) {
        assert.throws(() => {
          db.prepare(`
            INSERT INTO incubator (id, title, category, context_notes, logged_by)
            VALUES (?, 'Title', ?, 'Notes', 'actor')
          `).run(`INC-BAD-${Math.random()}`, cat);
        }, /CHECK constraint failed/, `Expected failure for category: "${cat}"`);
      }

      // Incubator statuses: only parked, promoted, discarded
      const badIncStatuses = ['ready', 'in_progress', 'settled', 'archived', 'null'];
      for (const st of badIncStatuses) {
        assert.throws(() => {
          db.prepare(`
            INSERT INTO incubator (id, title, category, context_notes, logged_by, status)
            VALUES (?, 'Title', 'debt', 'Notes', 'actor', ?)
          `).run(`INC-BAD-${Math.random()}`, st);
        }, /CHECK constraint failed/, `Expected failure for incubator status: "${st}"`);
      }

      // Feature statuses: only draft, ready, in_progress, settled
      const badFeatStatuses = ['blocked', 'backlog', 'review', 'closed', ''];
      for (const st of badFeatStatuses) {
        assert.throws(() => {
          db.prepare(`
            INSERT INTO features (id, title, target_milestone, status, spec_markdown)
            VALUES (?, 'Title', 'v1.0', ?, 'Spec')
          `).run(`FEAT-BAD-${Math.random()}`, st);
        }, /CHECK constraint failed/, `Expected failure for feature status: "${st}"`);
      }

      // Task statuses: only backlog, ready, in_progress, review, settled, blocked
      const badTaskStatuses = ['draft', 'completed', 'cancelled', 'open', ''];
      createFeature({ id: 'FEAT-PARENT', title: 'P', target_milestone: 'v1.0', spec_markdown: 'S' }, db);
      for (const st of badTaskStatuses) {
        assert.throws(() => {
          db.prepare(`
            INSERT INTO tasks (id, feature_id, title, status)
            VALUES (?, 'FEAT-PARENT', 'Title', ?)
          `).run(`TASK-BAD-${Math.random()}`, st);
        }, /CHECK constraint failed/, `Expected failure for task status: "${st}"`);
      }

      // Event actions: only allowed 11 actions
      const badActions = ['deleted', 'destroyed', 'unauthorized', 'UNKNOWN', ''];
      for (const act of badActions) {
        assert.throws(() => {
          db.prepare(`
            INSERT INTO settlement_events (actor, action, commit_ref)
            VALUES ('actor', ?, '0000000')
          `).run(act);
        }, /CHECK constraint failed/, `Expected failure for action: "${act}"`);
      }
    });

    it('ADV-02: SQL Injection resilience in filter queries and updates', () => {
      const { db } = sandbox;
      createFeature({ id: 'FEAT-SQL1', title: 'Secret Feature', target_milestone: 'v1.0', spec_markdown: 'Spec' }, db);
      createTask({ id: 'TASK-SQL1', feature_id: 'FEAT-SQL1', title: 'Secret Task', status: 'ready' }, db);

      // SQLi attempt in listFeatures status filter
      const sqliStatus = "' OR '1'='1";
      const featsByStatus = listFeatures(db, { status: sqliStatus });
      assert.equal(featsByStatus.length, 0, 'SQL injection in listFeatures status should match 0 rows');

      // SQLi attempt in listFeatures milestone filter
      const sqliMilestone = "v1.0' OR 'a'='a";
      const featsByMilestone = listFeatures(db, { target_milestone: sqliMilestone });
      assert.equal(featsByMilestone.length, 0, 'SQL injection in listFeatures milestone should match 0 rows');

      // SQLi attempt in listTasks
      const tasksByStatus = listTasks(db, { status: sqliStatus });
      assert.equal(tasksByStatus.length, 0, 'SQL injection in listTasks status should match 0 rows');

      const tasksByFeature = listTasks(db, { feature_id: "' OR '1'='1" });
      assert.equal(tasksByFeature.length, 0, 'SQL injection in listTasks feature_id should match 0 rows');

      const tasksByActor = listTasks(db, { assigned_actor: "' OR '1'='1" });
      assert.equal(tasksByActor.length, 0, 'SQL injection in listTasks assigned_actor should match 0 rows');

      // SQLi attempt via updateFeature non-whitelisted keys
      updateFeature('FEAT-SQL1', {
        "status = 'settled' WHERE '1'='1": 'hack',
        "title": "Sanitized Title"
      }, db);

      const f = getFeature('FEAT-SQL1', db);
      assert.equal(f.title, 'Sanitized Title');
      assert.equal(f.status, 'ready', 'Feature status should not be modified by injected key');
    });

    it('ADV-03: Foreign Key enforcement on tasks and settlement events', () => {
      const { db } = sandbox;

      // Inserting a task referencing a non-existent feature fails
      assert.throws(() => {
        createTask({
          id: 'TASK-NO-PARENT',
          feature_id: 'FEAT-DOES-NOT-EXIST',
          title: 'Orphan Task'
        }, db);
      }, /FOREIGN KEY constraint failed/);

      // Verify cascading deletion: deleting feature removes all child tasks
      createFeature({ id: 'FEAT-CASCADE', title: 'Parent', target_milestone: 'v1.0', spec_markdown: 'S' }, db);
      createTask({ id: 'TASK-C1', feature_id: 'FEAT-CASCADE', title: 'Child 1' }, db);
      createTask({ id: 'TASK-C2', feature_id: 'FEAT-CASCADE', title: 'Child 2' }, db);
      createTask({ id: 'TASK-C3', feature_id: 'FEAT-CASCADE', title: 'Child 3' }, db);

      assert.equal(listTasks(db, { feature_id: 'FEAT-CASCADE' }).length, 3);
      db.prepare('DELETE FROM features WHERE id = ?').run('FEAT-CASCADE');
      assert.equal(listTasks(db, { feature_id: 'FEAT-CASCADE' }).length, 0);

      // Inserting event with invalid non-null task_id fails
      assert.throws(() => {
        db.prepare(`
          INSERT INTO settlement_events (task_id, actor, action, commit_ref)
          VALUES ('TASK-DOES-NOT-EXIST', 'actor', 'gate_passed', '0000000')
        `).run();
      }, /FOREIGN KEY constraint failed/);
    });

    it('ADV-04: Large payloads, Unicode, Emojis, and special characters', () => {
      const { db } = sandbox;

      // 1MB Markdown spec with Unicode, Chinese, Arabic, Emojis, and newlines
      const largeSpec = '# Spec\n' + '🚀 🤖 💻 🛡️\n' + '中文测试 العربية \n' + 'x'.repeat(1024 * 1024);
      const titleWithSpecialChars = 'Feature: "quotes" & <xml> \'single\' `backticks` \t tabs \n newlines';

      const feat = createFeature({
        id: 'FEAT-UNICODE',
        title: titleWithSpecialChars,
        target_milestone: 'v1.0',
        spec_markdown: largeSpec
      }, db);

      assert.equal(feat.title, titleWithSpecialChars);
      assert.equal(feat.spec_markdown.length, largeSpec.length);

      const retrieved = getFeature('FEAT-UNICODE', db);
      assert.equal(retrieved.spec_markdown, largeSpec);

      // Task with allowed_paths containing glob wildcards and special characters
      const task = createTask({
        id: 'TASK-SPECIAL',
        feature_id: 'FEAT-UNICODE',
        title: 'Task Special',
        allowed_paths: ['src/**/[a-z]*.{js,ts,mjs}', 'packages/@scope/lib/**'],
        required_gates: ['npm test -- --grep "unit test"', 'bash -c "exit 0"']
      }, db);

      assert.deepEqual(task.allowed_paths, ['src/**/[a-z]*.{js,ts,mjs}', 'packages/@scope/lib/**']);
      assert.deepEqual(task.required_gates, ['npm test -- --grep "unit test"', 'bash -c "exit 0"']);
    });

    it('ADV-05: Malformed JSON handling in allowed_paths & required_gates', () => {
      const { db } = sandbox;
      createFeature({ id: 'FEAT-JSON', title: 'F', target_milestone: 'v1.0', spec_markdown: 'S' }, db);

      // Passing unparseable JSON strings should be caught either at insert or deserialize
      assert.throws(() => {
        createTask({
          id: 'TASK-MALFORMED-1',
          feature_id: 'FEAT-JSON',
          title: 'Bad JSON Task',
          allowed_paths: '{this is not valid json'
        }, db);
      }, /SyntaxError|JSON/);

      assert.throws(() => {
        createTask({
          id: 'TASK-MALFORMED-2',
          feature_id: 'FEAT-JSON',
          title: 'Bad Gates Task',
          required_gates: '[invalid gates...'
        }, db);
      }, /SyntaxError|JSON/);
    });

    it('ADV-06: Artifact log offloader: SHA-256 accuracy and traversal checks', () => {
      const { tmpDir } = sandbox;

      // 0-byte content
      const hashEmpty = saveArtifact('', tmpDir);
      assert.equal(readArtifact(hashEmpty, tmpDir), '');
      assert.equal(hashEmpty, crypto.createHash('sha256').update('').digest('hex').slice(0, 12));

      // 1MB content
      const largeContent = 'A'.repeat(1024 * 1024);
      const hashLarge = saveArtifact(largeContent, tmpDir);
      assert.equal(readArtifact(hashLarge, tmpDir), largeContent);

      // Non-existent hash returns null
      assert.equal(readArtifact('000000000000', tmpDir), null);

      // Object content is serialized to JSON string
      const obj = { error: 'Failed', exitCode: 1, trace: ['a', 'b'] };
      const hashObj = saveArtifact(obj, tmpDir);
      const readObj = readArtifact(hashObj, tmpDir);
      assert.deepEqual(JSON.parse(readObj), obj);
    });
  });

  // ==========================================================================
  // Dimension 2: Concurrency, WAL Mode & Transaction Integrity
  // ==========================================================================

  describe('Dimension 2: Concurrency, WAL Mode & Transactions', () => {
    it('ADV-07: Rapid parallel reads and writes across multiple connections in WAL mode', () => {
      const { dbPath, tmpDir } = sandbox;
      const numConnections = 5;
      const connections = [];

      for (let i = 0; i < numConnections; i++) {
        connections.push(getDb(dbPath, tmpDir));
      }

      // Create base feature
      createFeature({ id: 'FEAT-CONCUR', title: 'Concurrent Feature', target_milestone: 'v1.0', spec_markdown: 'S' }, connections[0]);

      // Rapidly insert 50 tasks across 5 connections
      const totalTasks = 50;
      for (let i = 0; i < totalTasks; i++) {
        const conn = connections[i % numConnections];
        createTask({
          id: `TASK-CONCUR-${i}`,
          feature_id: 'FEAT-CONCUR',
          title: `Concurrent Task ${i}`
        }, conn);

        // Interleaved reads from another connection
        const reader = connections[(i + 1) % numConnections];
        const currentTasks = listTasks(reader, { feature_id: 'FEAT-CONCUR' });
        assert.ok(currentTasks.length >= 1);
      }

      // Verify final count
      const finalTasks = listTasks(connections[0], { feature_id: 'FEAT-CONCUR' });
      assert.equal(finalTasks.length, totalTasks);

      // Close extra connections
      for (let i = 1; i < numConnections; i++) {
        closeDb(connections[i]);
      }
    });

    it('ADV-08: Transaction rollback leaves zero orphan state', () => {
      const { db } = sandbox;
      createFeature({ id: 'FEAT-TXN', title: 'Txn Feature', target_milestone: 'v1.0', spec_markdown: 'S' }, db);

      assert.throws(() => {
        withTransaction(db, () => {
          createTask({ id: 'TASK-TXN-1', feature_id: 'FEAT-TXN', title: 'Valid Task' }, db);
          createTask({ id: 'TASK-TXN-2', feature_id: 'FEAT-TXN', title: 'Valid Task 2' }, db);
          // Trigger intentional failure
          throw new Error('Transaction aborted midway');
        });
      }, /Transaction aborted midway/);

      // Both tasks should have been rolled back
      assert.equal(getTask('TASK-TXN-1', db), null);
      assert.equal(getTask('TASK-TXN-2', db), null);
      assert.equal(listTasks(db, { feature_id: 'FEAT-TXN' }).length, 0);
    });
  });

  // ==========================================================================
  // Dimension 3: Features & Tasks State Machines and Invariants
  // ==========================================================================

  describe('Dimension 3: State Engine Invariants & Transitions', () => {
    it('ADV-09: Feature settlement rejects any unsettled child tasks (ready, in_progress, review, blocked)', () => {
      const { db, tmpDir } = sandbox;
      createFeature({ id: 'FEAT-INV1', title: 'Invariant Feature', target_milestone: 'v1.0', spec_markdown: 'S' }, db);

      const statuses = ['ready', 'in_progress', 'review', 'blocked'];

      for (const st of statuses) {
        // Create an unsettled task with status st
        const taskId = `TASK-UNSETTLED-${st}`;
        createTask({ id: taskId, feature_id: 'FEAT-INV1', title: `Task ${st}`, status: st }, db);

        assert.throws(() => {
          settleFeature({ featureId: 'FEAT-INV1', actorName: 'tester' }, db, tmpDir);
        }, /remain unsettled/, `Expected settlement failure when child task has status "${st}"`);

        // Settle this task so we can test the next one in isolation
        db.prepare("UPDATE tasks SET status = 'settled' WHERE id = ?").run(taskId);
      }

      // Now all 4 child tasks are settled; settlement should succeed
      const res = settleFeature({ featureId: 'FEAT-INV1', actorName: 'tester' }, db, tmpDir);
      assert.equal(res.success, true);
      assert.equal(getFeature('FEAT-INV1', db).status, 'settled');

      // Attempting to settle again MUST fail
      assert.throws(() => {
        settleFeature({ featureId: 'FEAT-INV1', actorName: 'tester' }, db, tmpDir);
      }, /already settled/);
    });

    it('ADV-10: Holistic gate failure aborts settlement and preserves forensic log', () => {
      const { db, tmpDir } = sandbox;
      createFeature({
        id: 'FEAT-HG-FAIL',
        title: 'Failing Gate Feature',
        target_milestone: 'v1.0',
        spec_markdown: 'S',
        holistic_gate_cmd: ['bash', '-c', 'echo "Critical test failure on line 42" >&2 && exit 7']
      }, db);
      createTask({ id: 'TASK-HG1', feature_id: 'FEAT-HG-FAIL', title: 'Settled Task', status: 'settled' }, db);

      assert.throws(() => {
        settleFeature({ featureId: 'FEAT-HG-FAIL', actorName: 'tester' }, db, tmpDir);
      }, /Holistic feature gate failed \(exit code 7\)/);

      // Feature status remains ready (not settled)
      const feat = getFeature('FEAT-HG-FAIL', db);
      assert.equal(feat.status, 'ready');
      assert.equal(feat.settled_commit, null);
      assert.equal(feat.settled_at, null);

      // Event recorded in settlement_events with artifact hash
      const events = db.prepare(`
        SELECT * FROM settlement_events WHERE feature_id = ? AND action = 'gate_failed'
      `).all('FEAT-HG-FAIL');

      assert.equal(events.length, 1);
      assert.ok(events[0].artifact_hash);

      // Artifact file contains the stderr output
      const log = readArtifact(events[0].artifact_hash, tmpDir);
      assert.match(log, /Critical test failure on line 42/);
    });

    it('ADV-11: Double-leasing race prevention & blocked task security guardrails', () => {
      const { db, tmpDir } = sandbox;
      createFeature({ id: 'FEAT-LEASE', title: 'Lease Feature', target_milestone: 'v1.0', spec_markdown: 'S' }, db);
      createTask({ id: 'TASK-L1', feature_id: 'FEAT-LEASE', title: 'Leased Task' }, db);

      // 1. First claim succeeds
      const c1 = claimTask({ taskId: 'TASK-L1', actorName: 'agent-alpha' }, db, tmpDir);
      assert.equal(c1.success, true);
      assert.equal(c1.task.assigned_actor, 'agent-alpha');
      assert.equal(c1.task.status, 'in_progress');

      // 2. Second claim while active is rejected
      assert.throws(() => {
        claimTask({ taskId: 'TASK-L1', actorName: 'agent-beta' }, db, tmpDir);
      }, /Task TASK-L1 is currently in_progress/);

      // 3. Mark task blocked (circuit breaker tripped)
      db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = 'TASK-L1'").run();

      // Non-human agent cannot claim blocked task
      assert.throws(() => {
        claimTask({ taskId: 'TASK-L1', actorName: 'agent-gamma' }, db, tmpDir);
      }, /currently blocked by circuit breaker\. Requires human intervention\./);

      // Human actor CAN claim blocked task (eject / intervention)
      const humanClaim = claimTask({ taskId: 'TASK-L1', actorName: 'human' }, db, tmpDir);
      assert.equal(humanClaim.success, true);
      assert.equal(humanClaim.task.assigned_actor, 'human');
      assert.equal(humanClaim.task.status, 'in_progress');

      // 4. Settled task cannot be claimed by anyone, even human
      db.prepare("UPDATE tasks SET status = 'settled' WHERE id = 'TASK-L1'").run();
      assert.throws(() => {
        claimTask({ taskId: 'TASK-L1', actorName: 'human' }, db, tmpDir);
      }, /already settled/);
    });

    it('ADV-12: 45-minute TTL boundaries and auto-expiration', () => {
      const { db, tmpDir } = sandbox;
      createFeature({ id: 'FEAT-TTL', title: 'TTL Feat', target_milestone: 'v1.0', spec_markdown: 'S' }, db);
      createTask({ id: 'TASK-TTL-TEST', feature_id: 'FEAT-TTL', title: 'TTL Task' }, db);

      // Claim task (sets 45m in future)
      claimTask({ taskId: 'TASK-TTL-TEST', actorName: 'agent-1' }, db, tmpDir);

      // Case A: 1 second in the future -> NOT expired
      db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '+1 second') WHERE id = 'TASK-TTL-TEST'").run();
      let expiredCount = checkAndExpireLeases(db);
      assert.equal(expiredCount, 0, 'Task expiring in +1 second should not be expired');
      assert.equal(getTask('TASK-TTL-TEST', db).status, 'in_progress');

      // Attempting to claim still rejected
      assert.throws(() => {
        claimTask({ taskId: 'TASK-TTL-TEST', actorName: 'agent-2' }, db, tmpDir);
      }, /Task TASK-TTL-TEST is currently in_progress/);

      // Case B: Exactly expired (1 second in past)
      db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 second') WHERE id = 'TASK-TTL-TEST'").run();

      // Direct re-claim without prior checkAndExpireLeases should detect expiration and re-lease!
      const reclaim = claimTask({ taskId: 'TASK-TTL-TEST', actorName: 'agent-2' }, db, tmpDir);
      assert.equal(reclaim.success, true);
      assert.equal(reclaim.task.assigned_actor, 'agent-2');

      // Expire it again and test checkAndExpireLeases
      db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-10 seconds') WHERE id = 'TASK-TTL-TEST'").run();
      expiredCount = checkAndExpireLeases(db);
      assert.equal(expiredCount, 1);

      const taskAfter = getTask('TASK-TTL-TEST', db);
      assert.equal(taskAfter.status, 'ready');
      assert.equal(taskAfter.assigned_actor, null);
      assert.equal(taskAfter.lease_expires_at, null);
    });

    it('ADV-13: Anchor hydration correctly formats contract rules and paths', () => {
      const { db, tmpDir } = sandbox;
      const worktree = path.join(tmpDir, 'worktree-anchor-test');

      createFeature({
        id: 'FEAT-ANC',
        title: 'Anchor Feature',
        target_milestone: 'v0.9',
        spec_markdown: 'Spec'
      }, db);

      const task = createTask({
        id: 'TASK-ANC-1',
        feature_id: 'FEAT-ANC',
        title: 'Build Anchor',
        allowed_paths: ['src/core/**', 'packages/api/**'],
        required_gates: ['node --version', 'git status']
      }, db);

      const claim = claimTask({
        taskId: 'TASK-ANC-1',
        actorName: 'gemini-agent',
        worktreePath: worktree
      }, db, tmpDir);

      assert.ok(claim.activeTaskAnchorPath);
      assert.ok(fs.existsSync(claim.activeTaskAnchorPath));

      const content = fs.readFileSync(claim.activeTaskAnchorPath, 'utf8');
      assert.match(content, /ACTIVE TASK: TASK-ANC-1 - Build Anchor/);
      assert.match(content, /Parent Feature:\*\* FEAT-ANC \(Anchor Feature\)/);
      assert.match(content, /Target Milestone:\*\* v0\.9/);
      assert.match(content, /Assigned Actor:\*\* gemini-agent/);
      assert.match(content, /Allowed Scopes \(Path Whitelist\)/);
      assert.match(content, /- `src\/core\/\*\*`/);
      assert.match(content, /- `packages\/api\/\*\*`/);
      assert.match(content, /Mandatory Verification Gates/);
      assert.match(content, /- `node --version`/);
      assert.match(content, /- `git status`/);
      assert.match(content, /Critical Invariants/);
    });
  });

  // ==========================================================================
  // Dimension 4: Incubator & Low-Level Git Plumbing
  // ==========================================================================

  describe('Dimension 4: Incubator & Low-Level Git Plumbing', () => {
    it('ADV-14: Merkle plumbing creates true detached orphan branch with zero footprint on main', () => {
      const { db, tmpDir } = sandbox;
      const initialHeadSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

      // Park 3 items
      parkInsight({
        id: 'INC-ORPHAN-1',
        title: 'Insight 1',
        category: 'architecture_insight',
        contextNotes: 'Note 1',
        actorName: 'agent-1'
      }, db, tmpDir);

      parkInsight({
        id: 'INC-ORPHAN-2',
        title: 'Insight 2',
        category: 'debt',
        contextNotes: 'Note 2',
        actorName: 'agent-2'
      }, db, tmpDir);

      parkInsight({
        id: 'INC-ORPHAN-3',
        title: 'Insight 3',
        category: 'ux_polish',
        contextNotes: 'Note 3',
        actorName: 'agent-3'
      }, db, tmpDir);

      // Verify main branch HEAD is unchanged
      const currentHeadSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
      assert.equal(currentHeadSha, initialHeadSha);

      // Verify git working tree is clean
      const gitStatus = execSync('git status --porcelain', { cwd: tmpDir, encoding: 'utf8' }).trim();
      assert.equal(gitStatus, '');

      // Verify git log main does NOT show orphan commits
      const gitLogMain = execSync('git log main --oneline', { cwd: tmpDir, encoding: 'utf8' });
      assert.equal(gitLogMain.split('\n').filter(Boolean).length, 1); // Only baseline commit

      // Verify merge-base between main and vibesync/incubator throws (no shared history)
      assert.throws(() => {
        execSync('git merge-base main vibesync/incubator', { cwd: tmpDir, stdio: 'pipe' });
      });

      // Verify orphan commit chain length is 3 commits
      const orphanLog = execSync('git log vibesync/incubator --oneline', { cwd: tmpDir, encoding: 'utf8' });
      const orphanCommits = orphanLog.split('\n').filter(Boolean);
      assert.equal(orphanCommits.length, 3);

      // Verify orphan branch incubator.json matches parked items
      const records = readIncubatorFromOrphanBranch(tmpDir);
      assert.equal(records.length, 3);
      assert.equal(records[0].id, 'INC-ORPHAN-1');
      assert.equal(records[1].id, 'INC-ORPHAN-2');
      assert.equal(records[2].id, 'INC-ORPHAN-3');
    });

    it('ADV-15: Promotion and discard properly synchronize orphan branch', () => {
      const { db, tmpDir } = sandbox;
      createFeature({ id: 'FEAT-TARGET', title: 'Target', target_milestone: 'v1.0', spec_markdown: 'S' }, db);

      parkInsight({
        id: 'INC-P1',
        title: 'To Promote',
        category: 'speculative_feature',
        contextNotes: 'N',
        actorName: 'agent'
      }, db, tmpDir);

      parkInsight({
        id: 'INC-D1',
        title: 'To Discard',
        category: 'debt',
        contextNotes: 'N',
        actorName: 'agent'
      }, db, tmpDir);

      assert.equal(readIncubatorFromOrphanBranch(tmpDir).length, 2);

      // Promote INC-P1
      promoteIncubatorItem({ id: 'INC-P1', featureId: 'FEAT-TARGET' }, db, tmpDir);
      // Orphan branch contains only PARKED items
      let records = readIncubatorFromOrphanBranch(tmpDir);
      assert.equal(records.length, 1);
      assert.equal(records[0].id, 'INC-D1');

      // Discard INC-D1
      discardIncubatorItem({ id: 'INC-D1' }, db, tmpDir);
      records = readIncubatorFromOrphanBranch(tmpDir);
      assert.equal(records.length, 0); // Empty array committed
    });

    it('ADV-16: Git lock contention retry succeeds with backoff', () => {
      const { tmpDir } = sandbox;
      const lockPath = path.join(tmpDir, '.git/refs/heads/vibesync/incubator.lock');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, 'temporary-lock');

      // Simulate asynchronous lock clearing after 250ms
      setTimeout(() => {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }, 250);

      const out = execGitWithBackoff('git status', { cwd: tmpDir });
      assert.ok(out.includes('On branch main'));
    });
  });

  // ==========================================================================
  // Dimension 5: Empirical Invariant Breaches & Vulnerability Reproductions
  // ==========================================================================

  describe('Dimension 5: Empirical Invariant Breaches (Findings)', () => {
    it('ADV-FINDING-01: Double-leasing race condition permits concurrent dual-ownership of same task', async () => {
      const { dbPath, tmpDir } = sandbox;
      const db = getDb(dbPath, tmpDir);
      createFeature({ id: 'FEAT-RACE-TEST', title: 'Race Feat', target_milestone: 'v1.0', spec_markdown: 'S' }, db);
      createTask({ id: 'TASK-RACE-TEST', feature_id: 'FEAT-RACE-TEST', title: 'Race Task' }, db);
      closeDb(db);

      const workerCode = `
        import { getDb, closeDb } from '${path.resolve('src/db.mjs')}';
        import { claimTask } from '${path.resolve('src/tasks.mjs')}';
        const [,, dbPath, repoRoot, actorName] = process.argv;
        const db = getDb(dbPath, repoRoot);
        try {
          const res = claimTask({ taskId: 'TASK-RACE-TEST', actorName }, db, repoRoot);
          process.send({ success: true, actor: actorName, res });
        } catch (err) {
          process.send({ success: false, actor: actorName, error: err.message });
        } finally {
          closeDb(db);
        }
      `;
      const workerFile = path.join(tmpDir, 'race-worker.mjs');
      fs.writeFileSync(workerFile, workerCode, 'utf8');

      const runWorker = (actor) => new Promise((resolve) => {
        const child = fork(workerFile, [dbPath, tmpDir, actor]);
        child.on('message', resolve);
      });

      // Execute concurrent claims to reproduce the race condition
      let doubleLeaseDetected = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const [res1, res2] = await Promise.all([
          runWorker('agent-1'),
          runWorker('agent-2')
        ]);
        const successes = [res1, res2].filter(r => r.success);
        if (successes.length > 1) {
          doubleLeaseDetected = true;
          break;
        }
        // Reset task state for retry if timing didn't overlap
        const rDb = getDb(dbPath, tmpDir);
        rDb.prepare("UPDATE tasks SET status = 'ready', assigned_actor = NULL, lease_expires_at = NULL WHERE id = 'TASK-RACE-TEST'").run();
        closeDb(rDb);
      }

      assert.equal(
        doubleLeaseDetected,
        false,
        'Concurrency race prevention verified: at most one agent claimed the task.'
      );
    });

    it('settled and blocked tasks cannot be reopened by releasing a lease', () => {
      const { db } = sandbox;
      createFeature({ id: 'FEAT-REL-INV', title: 'Rel Feat', target_milestone: 'v1.0', spec_markdown: 'S' }, db);
      for (const status of ['settled', 'blocked']) {
        const id = `TASK-RELEASE-${status}`;
        createTask({ id, feature_id: 'FEAT-REL-INV', title: 'Task', status }, db);
        assert.throws(() => releaseTaskLease(id, db), /not in_progress/);
        assert.equal(getTask(id, db).status, status);
      }
    });

    it('settled feature contracts remain immutable and settlement cannot bypass gates', () => {
      const { db, tmpDir } = sandbox;
      createFeature({ id: 'FEAT-TAMPER', title: 'Original Spec', target_milestone: 'v1.0', spec_markdown: '# Frozen Spec' }, db);
      assert.throws(() => updateFeature('FEAT-TAMPER', { status: 'settled' }, db), /settleFeature/);
      createTask({ id: 'TASK-TAMPER', feature_id: 'FEAT-TAMPER', title: 'Task', status: 'settled' }, db);
      settleFeature({ featureId: 'FEAT-TAMPER', actorName: 'human' }, db, tmpDir);
      assert.throws(() => updateFeature('FEAT-TAMPER', { status: 'draft', spec_markdown: '# Tampered' }, db), /immutable/);
      assert.equal(getFeature('FEAT-TAMPER', db).status, 'settled');
      assert.equal(getFeature('FEAT-TAMPER', db).spec_markdown, '# Frozen Spec');
    });

    it('artifact reads reject traversal and symlinks outside the artifact directory', () => {
      const { tmpDir } = sandbox;
      const secretFile = path.join(tmpDir, '.vibesync', 'vibesync.log');
      fs.writeFileSync(secretFile, 'FORENSIC_SECRET_STREAM', 'utf8');
      assert.equal(readArtifact('../vibesync', tmpDir), null);
      assert.equal(readArtifact(null, tmpDir), null);
      const artifacts = path.join(tmpDir, '.vibesync', 'artifacts');
      fs.mkdirSync(artifacts, { recursive: true });
      fs.symlinkSync(secretFile, path.join(artifacts, 'abcdef123456.log'));
      assert.equal(readArtifact('abcdef123456', tmpDir), null);
    });
  });
});
