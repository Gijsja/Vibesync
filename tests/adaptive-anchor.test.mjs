import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, hydrateActiveTaskAnchor } from '../src/tasks.mjs';

const queued = [];
const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });

test('Active task anchor is clean on zero failures and injects triage on gate failure', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-ANCHOR', title: 'Anchor Test Feature', target_milestone: 'v1', spec_markdown: 'Anchor Spec' }, db);
    createTask({ id: 'TASK-A1', feature_id: 'FEAT-ANCHOR', title: 'Task Clean', allowed_paths: ['src/**'], required_gates: ['npm test'] }, db);

    const wt1 = path.join(sandbox.dir, 'worktrees/clean');
    const claim1 = claimTask({ taskId: 'TASK-A1', actorName: 'gemini-coder', worktreePath: wt1 }, db, sandbox.dir);
    const content1 = fs.readFileSync(claim1.activeTaskAnchorPath, 'utf8');

    assert.ok(!content1.includes('Verification Failure Triage'), 'Clean task should not have triage section');
    assert.ok(content1.includes('Operational Guidance (High-Context Reasoning)'), 'Gemini actor receives reasoning guidance');
    assert.ok(content1.includes('Critical Invariants'), 'Critical invariants must be present');

    // Now test failure triage
    createTask({ id: 'TASK-A2', feature_id: 'FEAT-ANCHOR', title: 'Task Failed', allowed_paths: ['src/**'], required_gates: ['npm test'] }, db);
    db.prepare("UPDATE tasks SET consecutive_failures = 1 WHERE id = 'TASK-A2'").run();
    db.prepare(`
      INSERT INTO gate_runs (id, task_id, feature_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, summary, started_at, finished_at)
      VALUES ('gr-fail', 'TASK-A2', 'FEAT-ANCHOR', 'gate', 0, 'hash', 'gemini-coder', 'hosted', 'failed', 1, 420, 'SyntaxError: unexpected token in file.mjs', datetime('now'), datetime('now'))
    `).run();

    const wt2 = path.join(sandbox.dir, 'worktrees/failed');
    const claim2 = claimTask({ taskId: 'TASK-A2', actorName: 'gemini-coder', worktreePath: wt2 }, db, sandbox.dir);
    const content2 = fs.readFileSync(claim2.activeTaskAnchorPath, 'utf8');

    assert.ok(content2.includes('Verification Failure Triage'), 'Failed task must include triage section');
    assert.ok(content2.includes('Strike 1/3'), 'Must report strike 1 of 3');
    assert.ok(content2.includes('SyntaxError: unexpected token in file.mjs'), 'Must include gate summary');
    assert.ok(content2.includes('vibesync_partial_verify'), 'Must suggest partial verify');
  });
});

test('Active task anchor adapts operational guidance for local and codex model profiles', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-PROFILES', title: 'Profiles Test Feature', target_milestone: 'v1', spec_markdown: 'Profiles Spec' }, db);
    createTask({ id: 'TASK-LOCAL', feature_id: 'FEAT-PROFILES', title: 'Local Task', allowed_paths: ['src/**'], required_gates: ['npm test'] }, db);
    createTask({ id: 'TASK-CODEX', feature_id: 'FEAT-PROFILES', title: 'Codex Task', allowed_paths: ['src/**'], required_gates: ['npm test'] }, db);

    const wtLocal = path.join(sandbox.dir, 'worktrees/local');
    const claimLocal = claimTask({ taskId: 'TASK-LOCAL', actorName: 'ollama-qwen-coder', worktreePath: wtLocal }, db, sandbox.dir);
    const contentLocal = fs.readFileSync(claimLocal.activeTaskAnchorPath, 'utf8');

    assert.ok(contentLocal.includes('Operational Guidance (Local Model)'), 'Local actor receives local model guidance');
    assert.ok(contentLocal.includes('every 3 minutes'), 'Mentions 3-minute heartbeat cadence');

    const wtCodex = path.join(sandbox.dir, 'worktrees/codex');
    const claimCodex = claimTask({ taskId: 'TASK-CODEX', actorName: 'openai-codex', worktreePath: wtCodex }, db, sandbox.dir);
    const contentCodex = fs.readFileSync(claimCodex.activeTaskAnchorPath, 'utf8');

    assert.ok(contentCodex.includes('Operational Guidance (Implementation & Test)'), 'Codex actor receives implementation guidance');
  });
});

test('Blocked task anchor indicates tripped circuit breaker and human takeover requirement', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-BLOCKED', title: 'Blocked Feature', target_milestone: 'v1', spec_markdown: 'Blocked Spec' }, db);
    createTask({ id: 'TASK-BLK', feature_id: 'FEAT-BLOCKED', title: 'Blocked Task', allowed_paths: ['src/**'], required_gates: ['npm test'] }, db);

    db.prepare("UPDATE tasks SET status = 'blocked', consecutive_failures = 3 WHERE id = 'TASK-BLK'").run();

    const wt = path.join(sandbox.dir, 'worktrees/blocked');
    const blockedTask = db.prepare("SELECT * FROM tasks WHERE id = 'TASK-BLK'").get();
    const feature = db.prepare("SELECT * FROM features WHERE id = 'FEAT-BLOCKED'").get();
    const anchorPath = hydrateActiveTaskAnchor(wt, blockedTask, feature, null, null, db);
    const content = fs.readFileSync(anchorPath, 'utf8');

    assert.ok(content.includes('Circuit Breaker Tripped'), 'Must indicate circuit breaker is tripped');
    assert.ok(content.includes('vibesync --eject TASK-BLK'), 'Must reference human takeover');
  });
});

if (typeof Bun !== 'undefined') {
  let fail = false;
  for (const e of queued) {
    try {
      await e.f();
    } catch (err) {
      fail = true;
      console.error(err);
    }
  }
  if (fail) process.exitCode = 1;
}
