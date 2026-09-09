/**
 * tests/lease-evidence.test.mjs
 *
 * Phase 1: Evidence-based lease renewal — acceptance tests.
 *
 * Covers:
 *  - Stale token cannot renew a reassigned lease
 *  - Fake caller-supplied fingerprint cannot manufacture progress
 *  - Staged, unstaged, committed, untracked, and gate-run progress is detected
 *  - Repeated unchanged heartbeats enter stagnant → warning → grace → expiry
 *  - Progress during grace restores an active lease
 *  - Expiry and concurrent renewal cannot both win
 *  - Recovery preserves lease-health state
 *  - Gemini, Claude, Codex, and local profiles receive intended thresholds
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox, execGit } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, heartbeatTaskLease, releaseTaskLease, checkAndExpireLeases, ejectTaskToHuman } from '../src/tasks.mjs';
import { computeWorkspaceFingerprint } from '../src/fingerprint.mjs';
import { MODEL_PROFILES } from '../src/policy.mjs';
import { readStateCheckpoint, restoreStateCheckpoint } from '../src/durability.mjs';
import { initSchema } from '../src/db.mjs';
import { DatabaseSync } from '../src/db.mjs';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeDb(sandboxDir) {
  const dbPath = path.join(sandboxDir, '.vibesync', 'state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return getDb(dbPath, sandboxDir);
}

function seedFeatureTask(db, sandboxDir, overrides = {}) {
  createFeature({ id: 'FEAT-EV', title: 'Evidence', target_milestone: 'v1', spec_markdown: 'Evidence' }, db);
  createTask({ id: 'TASK-EV', feature_id: 'FEAT-EV', title: 'Evidence task', ...overrides }, db);
}

// Drain stagnant beats until the given health level is reached (or exceeded).
// Returns the last heartbeat result.
function drainBeats(n, taskId, actorName, leaseToken, db, sandboxDir) {
  let last;
  for (let i = 0; i < n; i++) {
    try {
      last = heartbeatTaskLease({ taskId, actorName, leaseToken, repoRoot: sandboxDir }, db);
    } catch (err) {
      return { threw: err };
    }
  }
  return last;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test('model profiles have the intended stagnation thresholds', () => {
  assert.equal(MODEL_PROFILES.gemini.stagnantWarningBeats, 3);
  assert.equal(MODEL_PROFILES.gemini.stagnantGraceBeats, 2);
  assert.equal(MODEL_PROFILES.gemini.stagnantExpiryBeats, 2);

  assert.equal(MODEL_PROFILES.claude.stagnantWarningBeats, 3);
  assert.equal(MODEL_PROFILES.claude.stagnantGraceBeats, 2);
  assert.equal(MODEL_PROFILES.claude.stagnantExpiryBeats, 2);

  // Codex: shorter cadence
  assert.equal(MODEL_PROFILES.codex.stagnantWarningBeats, 2);
  assert.equal(MODEL_PROFILES.codex.stagnantGraceBeats, 1);
  assert.equal(MODEL_PROFILES.codex.stagnantExpiryBeats, 2);

  // Local: longer progress window
  assert.equal(MODEL_PROFILES.local.stagnantWarningBeats, 4);
  assert.equal(MODEL_PROFILES.local.stagnantGraceBeats, 3);
  assert.equal(MODEL_PROFILES.local.stagnantExpiryBeats, 3);
});

test('stale token cannot renew a reassigned lease', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    const claim1 = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);
    const staleToken = claim1.leaseToken;

    // Expire the first lease by backdating it.
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-10 minutes') WHERE id = ?").run('TASK-EV');
    checkAndExpireLeases(db);

    // Claim again — new actor, new token.
    claimTask({ taskId: 'TASK-EV', actorName: 'anthropic-claude' }, db, sandbox.dir);

    // The stale token must be rejected.
    assert.throws(
      () => heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: staleToken, repoRoot: sandbox.dir }, db),
      /rejected/
    );
  });
});

test('caller-supplied fake fingerprint cannot manufacture progress', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    // First beat: always active (was null).
    const beat1 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(beat1.leaseHealth, 'active');

    // Second beat: no file changes, fingerprint repeats → stagnant.
    const beat2 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.ok(['stagnant', 'warning', 'grace'].includes(beat2.leaseHealth));
    assert.equal(beat2.fingerprintChanged, false);
    assert.equal(beat2.stagnantHeartbeatCount, 1);

    // Even if the caller somehow still passes a "progressFingerprint" (deprecated),
    // the server ignores it — stagnation count must NOT reset.
    const beat3 = heartbeatTaskLease({
      taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir,
      // @ts-ignore — intentional deprecated field to ensure it is ignored
      progressFingerprint: 'fake-hash-abc123'
    }, db);
    assert.equal(beat3.fingerprintChanged, false, 'Fake caller fingerprint must not reset stagnation');
    assert.equal(beat3.stagnantHeartbeatCount, 2);
  });
});

test('staged changes are detected as progress', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);
    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    // First beat: always active.
    heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);

    // Second beat: no changes → stagnant.
    const b2 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b2.fingerprintChanged, false);

    // Stage a new file.
    fs.writeFileSync(path.join(sandbox.dir, 'staged.txt'), 'staged content');
    execGit('git add staged.txt', sandbox.dir);

    // Third beat: staged diff changed → progress.
    const b3 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b3.leaseHealth, 'active');
    assert.equal(b3.fingerprintChanged, true);
    assert.equal(b3.stagnantHeartbeatCount, 0);
  });
});

test('unstaged file edits are detected as progress', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    // Create and commit a baseline file first.
    sandbox.commitFile('src/hello.txt', 'initial', 'baseline');

    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);
    heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);

    const b2 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b2.fingerprintChanged, false);

    // Modify a tracked file without staging.
    fs.writeFileSync(path.join(sandbox.dir, 'src/hello.txt'), 'modified but not staged');

    const b3 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b3.fingerprintChanged, true);
    assert.equal(b3.leaseHealth, 'active');
  });
});

test('committed changes are detected as progress', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);
    heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    const b2 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b2.fingerprintChanged, false);

    // Commit a new file — HEAD changes.
    sandbox.commitFile('committed.txt', 'committed content', 'add committed');

    const b3 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b3.fingerprintChanged, true);
    assert.equal(b3.leaseHealth, 'active');
  });
});

test('untracked new files are detected as progress', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);
    heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    const b2 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b2.fingerprintChanged, false);

    // Create an untracked file (not staged or committed).
    fs.writeFileSync(path.join(sandbox.dir, 'untracked_new.txt'), 'untracked');

    const b3 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b3.fingerprintChanged, true, 'Untracked file creation must be detected');
    assert.equal(b3.leaseHealth, 'active');
  });
});

test('successful gate run is detected as progress', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);
    const { randomUUID } = await import('node:crypto');

    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);
    heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    const b2 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b2.fingerprintChanged, false);

    // Insert a gate_run record — simulates a completed gate execution.
    const runId = randomUUID();
    db.prepare(`
      INSERT INTO gate_runs (id, task_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, finished_at)
      VALUES (?, ?, 'gate', 0, 'hash123', 'openai-codex', 'codex', 'passed', 0, 5000, CURRENT_TIMESTAMP)
    `).run(runId, 'TASK-EV');

    const b3 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b3.fingerprintChanged, true, 'A new gate_run must be detected as progress');
    assert.equal(b3.leaseHealth, 'active');
  });
});

test('repeated unchanged heartbeats progress through stagnant → warning → grace → expiry for codex', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    // Codex thresholds: warn=2, grace=1, expiry=2 → total stagnant before expiry = 2+1+2 = 5
    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    // Beat 1: active (was null).
    const b1 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b1.leaseHealth, 'active');
    assert.equal(b1.stagnantHeartbeatCount, 0);

    // Beat 2: stagnant_count=1 < warnAt(2) → stagnant.
    const b2 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b2.leaseHealth, 'stagnant');
    assert.equal(b2.stagnantHeartbeatCount, 1);

    // Beat 3: stagnant_count=2 >= warnAt(2) < graceAt(3) → warning.
    const b3 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b3.leaseHealth, 'warning');
    assert.equal(b3.stagnantHeartbeatCount, 2);

    // lease_warning_at should now be set.
    const row = db.prepare('SELECT lease_warning_at FROM tasks WHERE id = ?').get('TASK-EV');
    assert.ok(row.lease_warning_at, 'lease_warning_at must be set when entering warning state');

    // Beat 4: stagnant_count=3 >= graceAt(3) < expiryAt(5) → grace.
    const b4 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b4.leaseHealth, 'grace');
    assert.equal(b4.stagnantHeartbeatCount, 3);
    const rowGrace = db.prepare('SELECT lease_grace_at FROM tasks WHERE id = ?').get('TASK-EV');
    assert.ok(rowGrace.lease_grace_at, 'lease_grace_at must be set when entering grace state');

    // Beat 5: stagnant_count=4 >= graceAt(3) < expiryAt(5) → grace (still within expiry window).
    const b5 = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(b5.leaseHealth, 'grace');
    assert.equal(b5.stagnantHeartbeatCount, 4);

    // Beat 6: stagnant_count=5 >= expiryAt(5) → expired, lease atomically released.
    assert.throws(
      () => heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db),
      err => err.code === 'LEASE_EXPIRED'
    );

    // Task must now be 'ready'.
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get('TASK-EV');
    assert.equal(task.status, 'ready');

    // Verify the lease_expired audit event was recorded.
    const event = db.prepare("SELECT action FROM settlement_events WHERE task_id = ? AND action = 'lease_expired' ORDER BY id DESC LIMIT 1").get('TASK-EV');
    assert.ok(event, 'lease_expired event must be recorded');
  });
});

test('progress during grace restores an active lease', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    // Codex: warn=2, grace=1 → enter grace after beat 4.
    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    // Drive to grace state (beats: active, stagnant, warning, grace).
    drainBeats(4, 'TASK-EV', 'openai-codex', claim.leaseToken, db, sandbox.dir);
    const inGrace = db.prepare("SELECT lease_grace_at FROM tasks WHERE id = ?").get('TASK-EV');
    assert.ok(inGrace.lease_grace_at, 'Must be in grace state');

    // Now make real progress.
    fs.writeFileSync(path.join(sandbox.dir, 'recovery.txt'), 'progress during grace');

    const recovery = heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
    assert.equal(recovery.leaseHealth, 'active');
    assert.equal(recovery.fingerprintChanged, true);
    assert.equal(recovery.stagnantHeartbeatCount, 0);

    // Grace and warning markers must be cleared.
    const cleared = db.prepare('SELECT lease_warning_at, lease_grace_at FROM tasks WHERE id = ?').get('TASK-EV');
    assert.equal(cleared.lease_warning_at, null);
    assert.equal(cleared.lease_grace_at, null);
  });
});

test('expiry and concurrent renewal cannot both win', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    // Drive to the expiry threshold (6 total beats: 1 active + 5 stagnant = expired on beat 6).
    drainBeats(5, 'TASK-EV', 'openai-codex', claim.leaseToken, db, sandbox.dir);

    // Concurrently attempt two expiry beats — only one should win.
    let errorCount = 0;
    let successCount = 0;
    for (let i = 0; i < 2; i++) {
      try {
        heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);
        successCount++;
      } catch (err) {
        if (err.code === 'LEASE_EXPIRED' || err.code === 'LEASE_STALE') errorCount++;
        else throw err;
      }
    }
    // At most one winner — the second attempt must fail because the lease is already released.
    assert.ok(errorCount >= 1, 'At least one concurrent renewal must fail when lease expires');
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get('TASK-EV');
    assert.equal(task.status, 'ready');
  });
});

test('lease_expired event does not contain raw lease token', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);
    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    // Drive to expiry.
    drainBeats(5, 'TASK-EV', 'openai-codex', claim.leaseToken, db, sandbox.dir);
    try { heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db); } catch {}

    const events = db.prepare("SELECT evidence_payload FROM settlement_events WHERE task_id = ? AND action LIKE 'lease_%'").all('TASK-EV');
    for (const ev of events) {
      const payload = typeof ev.evidence_payload === 'string' ? ev.evidence_payload : '';
      assert.ok(!payload.includes(claim.leaseToken), 'Raw lease token must never appear in audit events');
    }
  });
});

test('ejectTaskToHuman records lease_handoff_requested event', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);
    claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);
    ejectTaskToHuman('TASK-EV', db, sandbox.dir);

    const event = db.prepare("SELECT action FROM settlement_events WHERE task_id = ? AND action = 'lease_handoff_requested' ORDER BY id DESC LIMIT 1").get('TASK-EV');
    assert.ok(event, 'lease_handoff_requested event must be recorded');

    const task = db.prepare('SELECT handoff_requested_at FROM tasks WHERE id = ?').get('TASK-EV');
    assert.ok(task.handoff_requested_at, 'handoff_requested_at must be set after eject');
  });
});

test('claimTask provides a stable lease_run_id distinct from the secret token', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);
    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    assert.ok(typeof claim.leaseRunId === 'string' && claim.leaseRunId.length > 0, 'leaseRunId must be a non-empty string');
    assert.notEqual(claim.leaseRunId, claim.leaseToken, 'leaseRunId must be different from the secret token');

    // Verify it is stored in the DB.
    const row = db.prepare('SELECT lease_run_id FROM tasks WHERE id = ?').get('TASK-EV');
    assert.equal(row.lease_run_id, claim.leaseRunId);
  });
});

test('lease_run_id is preserved in heartbeat audit events', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);
    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    heartbeatTaskLease({ taskId: 'TASK-EV', actorName: 'openai-codex', leaseToken: claim.leaseToken, repoRoot: sandbox.dir }, db);

    const event = db.prepare("SELECT evidence_payload FROM settlement_events WHERE task_id = ? AND action LIKE 'lease_%' ORDER BY id DESC LIMIT 1").get('TASK-EV');
    const payload = JSON.parse(event.evidence_payload);
    assert.equal(payload.lease_run_id, claim.leaseRunId);
    assert.ok(!event.evidence_payload.includes(claim.leaseToken), 'Raw lease token must not appear in audit');
  });
});

test('checkAndExpireLeases records lease_expired (not lease_released) for TTL expiry', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);
    claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);

    // Backdate the expiry.
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-5 minutes') WHERE id = ?").run('TASK-EV');
    const released = checkAndExpireLeases(db);
    assert.equal(released, 1);

    const event = db.prepare("SELECT action FROM settlement_events WHERE task_id = ? AND action = 'lease_expired'").get('TASK-EV');
    assert.ok(event, 'TTL expiry must record a lease_expired event, not lease_released');
  });
});

test('recovery preserves lease-health state across checkpoint/restore', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    seedFeatureTask(db, sandbox.dir);

    const claim = claimTask({ taskId: 'TASK-EV', actorName: 'openai-codex' }, db, sandbox.dir);
    // Drive to warning state.
    drainBeats(3, 'TASK-EV', 'openai-codex', claim.leaseToken, db, sandbox.dir);

    const taskBefore = db.prepare('SELECT stagnant_heartbeat_count, lease_warning_at, lease_run_id FROM tasks WHERE id = ?').get('TASK-EV');
    assert.ok(taskBefore.stagnant_heartbeat_count >= 2);
    assert.ok(taskBefore.lease_warning_at);
    assert.ok(taskBefore.lease_run_id);

    // Read the checkpoint.
    const checkpoint = readStateCheckpoint(sandbox.dir);
    assert.ok(checkpoint, 'A checkpoint must have been written');

    // Restore into a fresh in-memory DB.
    const freshDb = new DatabaseSync(':memory:');
    freshDb.exec('PRAGMA foreign_keys = ON;');
    initSchema(freshDb);
    restoreStateCheckpoint(freshDb, sandbox.dir, checkpoint);

    const taskAfter = freshDb.prepare('SELECT stagnant_heartbeat_count, lease_warning_at, lease_run_id FROM tasks WHERE id = ?').get('TASK-EV');
    assert.equal(taskAfter.stagnant_heartbeat_count, taskBefore.stagnant_heartbeat_count);
    assert.equal(taskAfter.lease_warning_at, taskBefore.lease_warning_at);
    assert.equal(taskAfter.lease_run_id, taskBefore.lease_run_id);
    freshDb.close();
  });
});

test('computeWorkspaceFingerprint produces different values for different worktree states', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));

    const fp1 = computeWorkspaceFingerprint(sandbox.dir, sandbox.dir, db, null);
    assert.ok(typeof fp1 === 'string' && fp1.length === 64, 'Fingerprint must be 64-char hex');

    // Add a file and verify fingerprint changes.
    fs.writeFileSync(path.join(sandbox.dir, 'new_file.txt'), 'content A');
    const fp2 = computeWorkspaceFingerprint(sandbox.dir, sandbox.dir, db, null);
    assert.notEqual(fp1, fp2, 'Adding a file must change the fingerprint');

    // Modify the file.
    fs.writeFileSync(path.join(sandbox.dir, 'new_file.txt'), 'content B');
    const fp3 = computeWorkspaceFingerprint(sandbox.dir, sandbox.dir, db, null);
    assert.notEqual(fp2, fp3, 'Modifying a file must change the fingerprint');
  });
});

test('fingerprint is stable when nothing changes', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(makeDb(sandbox.dir));
    sandbox.commitFile('stable.txt', 'stable content', 'baseline');

    const fp1 = computeWorkspaceFingerprint(sandbox.dir, sandbox.dir, db, null);
    const fp2 = computeWorkspaceFingerprint(sandbox.dir, sandbox.dir, db, null);
    assert.equal(fp1, fp2, 'Fingerprint must be deterministic when nothing changes');
  });
});
