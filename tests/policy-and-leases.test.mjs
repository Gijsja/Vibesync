import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, heartbeatTaskLease } from '../src/tasks.mjs';
import { executeGates } from '../src/gatekeeper.mjs';
import { verifyAndSettleTask } from '../src/settle.mjs';
import { previewTask, approveTaskCommand, resolveCommandSpec, identifyModelProfile } from '../src/policy.mjs';
import { redactSensitive, parseDiagnostics } from '../src/commands.mjs';
import { scanSecretEntries } from '../src/secrets.mjs';

test('model-neutral previews expose suitability and hash resolved package behavior', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    fs.writeFileSync(path.join(sandbox.dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    createFeature({ id: 'FEAT-POLICY', title: 'Policy', target_milestone: 'v1', spec_markdown: 'Safe execution' }, db);
    createTask({ id: 'TASK-POLICY', feature_id: 'FEAT-POLICY', title: 'Preview', model_hint: 'local',
      required_gates: [{ type: 'npm-script', script: 'test', network: false }] }, db);
    const local = previewTask({ taskId: 'TASK-POLICY', actorName: 'ollama-qwen' }, db, sandbox.dir);
    const codex = previewTask({ taskId: 'TASK-POLICY', actorName: 'openai-codex' }, db, sandbox.dir);
    assert.equal(local.model.id, 'local');
    assert.equal(local.suitability, 'suitable');
    assert.equal(codex.model.id, 'codex');
    assert.equal(codex.suitability, 'review_recommended');
    const originalHash = local.commands[0].policyHash;
    fs.writeFileSync(path.join(sandbox.dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test && echo changed' } }));
    assert.notEqual(previewTask({ taskId: 'TASK-POLICY', actorName: 'ollama-qwen' }, db, sandbox.dir).commands[0].policyHash, originalHash);
    assert.equal(identifyModelProfile('anthropic-claude').id, 'claude');
    assert.equal(identifyModelProfile('gemini-antigravity').id, 'gemini');
  });
});

test('enforced approvals are hash-bound and unsafe commands consume one approval', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    fs.writeFileSync(path.join(sandbox.dir, '.vibesync/policy.json'), JSON.stringify({ approval_mode: 'enforce', sandbox_mode: 'process' }));
    createFeature({ id: 'FEAT-APPROVE', title: 'Approval', target_milestone: 'v1', spec_markdown: 'Approval' }, db);
    const gate = { type: 'argv', argv: ['node', '-e', 'process.exit(0)'], idempotency: 'unsafe' };
    createTask({ id: 'TASK-APPROVE', feature_id: 'FEAT-APPROVE', title: 'Approve', required_gates: [gate] }, db);
    const blocked = executeGates([gate], { cwd: sandbox.dir, db, taskId: 'TASK-APPROVE', actorName: 'openai-codex', repoRoot: sandbox.dir });
    assert.equal(blocked.failedGate.code, 'APPROVAL_REQUIRED');
    const approved = approveTaskCommand({ taskId: 'TASK-APPROVE', phase: 'gate', index: 0, approvedBy: 'human' }, db, sandbox.dir);
    assert.equal(approved.policyHash, resolveCommandSpec(gate, { cwd: sandbox.dir, phase: 'gate' }).policyHash);
    const passed = executeGates([gate], { cwd: sandbox.dir, db, taskId: 'TASK-APPROVE', actorName: 'openai-codex', repoRoot: sandbox.dir });
    assert.equal(passed.success, true);
    assert.equal(db.prepare('SELECT model_profile FROM gate_runs WHERE task_id = ?').get('TASK-APPROVE').model_profile, 'codex');
    assert.ok(db.prepare('SELECT revoked_at FROM gate_approvals WHERE policy_hash = ?').get(approved.policyHash).revoked_at);
    assert.equal(executeGates([gate], { cwd: sandbox.dir, db, taskId: 'TASK-APPROVE', actorName: 'openai-codex', repoRoot: sandbox.dir }).failedGate.code, 'APPROVAL_REQUIRED');
  });
});

test('lease heartbeats are owner-token bound and adapt cadence for local models', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-LEASE', title: 'Lease', target_milestone: 'v1', spec_markdown: 'Lease' }, db);
    createTask({ id: 'TASK-LEASE', feature_id: 'FEAT-LEASE', title: 'Local work' }, db);
    const claim = claimTask({ taskId: 'TASK-LEASE', actorName: 'local-ollama-qwen' }, db, sandbox.dir);
    assert.equal(claim.modelProfile, 'local');
    assert.equal(claim.heartbeatMinutes, 3);
    const beat = heartbeatTaskLease({ taskId: 'TASK-LEASE', actorName: 'local-ollama-qwen', leaseToken: claim.leaseToken, progressFingerprint: 'diff-a' }, db);
    assert.equal(beat.task.progress_fingerprint, 'diff-a');
    assert.throws(() => heartbeatTaskLease({ taskId: 'TASK-LEASE', actorName: 'local-ollama-qwen', leaseToken: 'wrong' }, db), /rejected/);
  });
});

test('diagnostics, log redaction, and secret scanning avoid returning secret material', () => {
  assert.deepEqual(parseDiagnostics('', 'src/a.js:12:4: error broken')[0], { file: 'src/a.js', line: 12, column: 4, severity: 'error', message: 'broken' });
  assert.doesNotMatch(redactSensitive('api_key=supersecretvalue'), /supersecretvalue/);
  const findings = scanSecretEntries([{ file: 'config.txt', content: '-----BEGIN ' + 'PRIVATE KEY-----\nsecret' }]);
  assert.deepEqual(findings, [{ file: 'config.txt', code: 'private_key' }]);
});

test('settlement blocks secrets before they reach trunk', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-SECRET', title: 'Secret', target_milestone: 'v1', spec_markdown: 'No secrets' }, db);
    createTask({ id: 'TASK-SECRET', feature_id: 'FEAT-SECRET', title: 'Secret guard', allowed_paths: ['src/**'] }, db);
    const claim = claimTask({ taskId: 'TASK-SECRET', actorName: 'anthropic-claude' }, db, sandbox.dir);
    sandbox.createBranch(claim.task.branch_name, 'main', true);
    sandbox.commitFile('src/key.txt', '-----BEGIN ' + 'PRIVATE KEY-----\nnot-real-test-material\n', 'accidental key');
    sandbox.checkout('main');
    const result = verifyAndSettleTask({ taskId: 'TASK-SECRET', actorName: 'anthropic-claude', repoRoot: sandbox.dir, db });
    assert.equal(result.success, false);
    assert.equal(result.phase, 'SECRET_DETECTED');
    assert.equal(fs.existsSync(path.join(sandbox.dir, 'src/key.txt')), false);
    assert.equal(db.prepare('SELECT consecutive_failures FROM tasks WHERE id = ?').get('TASK-SECRET').consecutive_failures, 1);
  });
});
