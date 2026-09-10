import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature, updateFeature, getFeature } from '../src/features.mjs';
import { prepareSandboxedCommand, resolveCommandSpec } from '../src/policy.mjs';

test('updateFeature correctly updates and serializes array holistic_gate_cmd', async () => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir);
    createFeature({
      id: 'FEAT-TEST-UPDATE',
      title: 'Update Test',
      target_milestone: 'v1',
      spec_markdown: 'Test spec',
      holistic_gate_cmd: null
    }, db);

    // Update with array command
    const updatedArray = updateFeature('FEAT-TEST-UPDATE', {
      holistic_gate_cmd: ['git', 'diff', '--check']
    }, db);
    assert.deepEqual(updatedArray.holistic_gate_cmd, ['git', 'diff', '--check']);

    // Retrieve again to verify SQLite persistence & deserialization
    const retrievedArray = getFeature('FEAT-TEST-UPDATE', db);
    assert.deepEqual(retrievedArray.holistic_gate_cmd, ['git', 'diff', '--check']);

    // Update with structured object command
    const structuredGate = {
      type: 'argv',
      argv: ['git', 'diff', '--check'],
      idempotency: 'safe',
      network: false,
      write_paths: []
    };
    const updatedObject = updateFeature('FEAT-TEST-UPDATE', {
      holistic_gate_cmd: structuredGate
    }, db);
    assert.deepEqual(updatedObject.holistic_gate_cmd, structuredGate);

    const retrievedObject = getFeature('FEAT-TEST-UPDATE', db);
    assert.deepEqual(retrievedObject.holistic_gate_cmd, structuredGate);
  });
});

test('prepareSandboxedCommand formats TRUSTED_LOCAL_REQUIRED error with actual actor name', async () => {
  await withSandbox(async sandbox => {
    const policyPath = path.join(sandbox.dir, '.vibesync/policy.json');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify({
      version: 2,
      approval_mode: 'audit',
      sandbox_mode: 'process',
      network_default: false,
      allow_legacy_commands: true,
      trusted_local: { actors: ['authorized-actor'] }
    }, null, 2) + '\n');

    const spec = resolveCommandSpec({ type: 'argv', argv: ['node', '-e', 'process.exit(0)'] });
    const rogueActor = 'unauthorized-bot';

    assert.throws(
      () => prepareSandboxedCommand(spec, sandbox.dir, sandbox.dir, ['*'], { actorName: rogueActor }),
      (err) => {
        assert.equal(err.code, 'TRUSTED_LOCAL_REQUIRED');
        assert.ok(
          err.message.includes(`Process sandbox requires an explicit trusted_local exception for actor '${rogueActor}'.`),
          `Expected message to contain interpolated actor name, got: ${err.message}`
        );
        assert.ok(!err.message.includes('+ actorName +'), 'Must not contain un-interpolated template literal string');
        return true;
      }
    );
  });
});
