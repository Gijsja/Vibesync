import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, releaseTaskLease } from '../src/tasks.mjs';
import { executeGates } from '../src/gatekeeper.mjs';
import { buildLeaseRollup, listLeaseRollups } from '../src/audit.mjs';
import { startServer } from '../src/server.mjs';

test('lease rollups deterministically correlate events, gates, writes, and approvals', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-AUDIT', title: 'Audit feature', target_milestone: 'v1', spec_markdown: 'Trace leases' }, db);
    const gate = { type: 'argv', argv: ['node', '-e', "require('fs').writeFileSync('report.txt','ok')"], write_paths: ['report.txt'] };
    createTask({ id: 'TASK-AUDIT', feature_id: 'FEAT-AUDIT', title: 'Audit task', allowed_paths: ['*'], required_gates: [gate] }, db);
    const first = claimTask({ taskId: 'TASK-AUDIT', actorName: 'openai-codex' }, db, sandbox.dir);
    const run = executeGates([gate], { cwd: sandbox.dir, db, taskId: 'TASK-AUDIT', actorName: 'openai-codex', repoRoot: sandbox.dir, allowedPaths: ['*'] });
    assert.equal(run.success, true);
    releaseTaskLease('TASK-AUDIT', db);

    const rollup = buildLeaseRollup(first.leaseRunId, db);
    assert.deepEqual(buildLeaseRollup(first.leaseRunId, db), rollup);
    assert.equal(rollup.task.actor, 'openai-codex');
    assert.deepEqual(rollup.files, ['report.txt']);
    assert.equal(rollup.commands.length, 1);
    assert.ok(rollup.events.some(event => event.action === 'task_claimed'));
    assert.ok(rollup.events.some(event => event.action === 'lease_released'));
    assert.doesNotMatch(JSON.stringify(rollup), new RegExp(first.leaseToken));
    assert.doesNotMatch(JSON.stringify(rollup), /lease_token_hash/);

    fs.unlinkSync(path.join(sandbox.dir, 'report.txt'));
    const second = claimTask({ taskId: 'TASK-AUDIT', actorName: 'anthropic-claude' }, db, sandbox.dir);
    executeGates([{ type: 'argv', argv: ['node', '-e', 'process.exit(0)'] }], { cwd: sandbox.dir, db, taskId: 'TASK-AUDIT', actorName: 'anthropic-claude', repoRoot: sandbox.dir });
    assert.notEqual(second.leaseRunId, first.leaseRunId);
    assert.equal(buildLeaseRollup(first.leaseRunId, db).commands.length, 1);
    assert.equal(buildLeaseRollup(second.leaseRunId, db).commands.length, 1);
    assert.equal(listLeaseRollups({ taskId: 'TASK-AUDIT' }, db).length, 2);
  });
});

test('rollups redact sensitive output and remain available over loopback HTTP', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-AUDIT-HTTP', title: 'Audit HTTP', target_milestone: 'v1', spec_markdown: 'Read-only rollup' }, db);
    createTask({ id: 'TASK-AUDIT-HTTP', feature_id: 'FEAT-AUDIT-HTTP', title: 'Audit HTTP' }, db);
    const claim = claimTask({ taskId: 'TASK-AUDIT-HTTP', actorName: 'local-qwen' }, db, sandbox.dir);
    const secret = 'api_' + 'key=highly-sensitive-test-value';
    db.prepare('UPDATE settlement_events SET evidence_payload = ? WHERE lease_run_id = ?').run(JSON.stringify({ message: secret }), claim.leaseRunId);
    assert.doesNotMatch(JSON.stringify(buildLeaseRollup(claim.leaseRunId, db)), /highly-sensitive-test-value/);

    const server = await startServer({ port: 0, db, repoRoot: sandbox.dir, quiet: true });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/leases/${claim.leaseRunId}/rollup`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).lease_run_id, claim.leaseRunId);
    } finally { await server.close(); }
  });
});
