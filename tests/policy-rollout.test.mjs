import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { initializeWorkspace } from '../src/init.mjs';
import { getExecutionPolicy, previewPolicyMigration, migratePolicy, detectSandboxCapabilities, resolveCommandSpec } from '../src/policy.mjs';

test('missing-version projects remain compatible until explicit migration', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    assert.equal(getExecutionPolicy(sandbox.dir).version, 1);
    assert.equal(getExecutionPolicy(sandbox.dir).approval_mode, 'audit');
    createFeature({ id: 'FEAT-MIGRATE', title: 'Migrate', target_milestone: 'v1', spec_markdown: 'Policy' }, db);
    createTask({ id: 'TASK-MIGRATE', feature_id: 'FEAT-MIGRATE', title: 'Migrate', required_gates: [
      'node --version', { type: 'argv', argv: ['node', '--version'] }
    ] }, db);
    const first = previewPolicyMigration(sandbox.dir, db);
    assert.deepEqual(previewPolicyMigration(sandbox.dir, db), first);
    assert.equal(first.legacy_commands.length, 1);
    assert.equal(first.approvals_needed.length, 1);
    assert.equal(fs.existsSync(path.join(sandbox.dir, '.vibesync/policy.json')), false);
    assert.throws(() => migratePolicy(sandbox.dir, db, { apply: true }), /confirmedBy/);
    const applied = migratePolicy(sandbox.dir, db, { apply: true, confirmedBy: 'human-admin' });
    assert.equal(applied.applied, true);
    assert.equal(getExecutionPolicy(sandbox.dir).version, 2);
    assert.equal(getExecutionPolicy(sandbox.dir).allow_legacy_commands, false);
  });
});

test('new workspace initialization writes fail-closed version 2 without replacing existing policy', async () => {
  await withSandbox(async sandbox => {
    const result = initializeWorkspace(sandbox.dir);
    const policy = JSON.parse(fs.readFileSync(result.policyPath, 'utf8'));
    assert.deepEqual(policy, { version: 2, approval_mode: 'enforce', sandbox_mode: 'required', network_default: false, allow_legacy_commands: false, trusted_local: { actors: [] } });
    fs.writeFileSync(result.policyPath, JSON.stringify({ version: 1, approval_mode: 'audit' }));
    initializeWorkspace(sandbox.dir);
    assert.equal(JSON.parse(fs.readFileSync(result.policyPath, 'utf8')).version, 1);
  });
});

test('policy version participates in approval hashes and capability reporting is explicit', () => {
  const command = { type: 'argv', argv: ['node', '--version'] };
  assert.notEqual(resolveCommandSpec(command, { policyVersion: 1 }).policyHash, resolveCommandSpec(command, { policyVersion: 2 }).policyHash);
  const capabilities = detectSandboxCapabilities();
  assert.equal(capabilities.platform, process.platform);
  assert.equal(capabilities.modes.process, true);
  assert.equal(capabilities.modes.required, capabilities.bubblewrap);
});

test('malformed or invalid policy fails closed instead of reverting to compatibility defaults', async () => {
  await withSandbox(async sandbox => {
    const policyPath = path.join(sandbox.dir, '.vibesync/policy.json');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, '{broken');
    assert.throws(() => getExecutionPolicy(sandbox.dir), error => error.code === 'POLICY_INVALID');
    fs.writeFileSync(policyPath, JSON.stringify({ version: 2, approval_mode: 'anything' }));
    assert.throws(() => getExecutionPolicy(sandbox.dir), error => error.code === 'POLICY_INVALID');
  });
});
