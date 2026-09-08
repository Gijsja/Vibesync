import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withSandbox, execGit } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature, settleFeature } from '../src/features.mjs';
import { createTask, claimTask, heartbeatTaskLease, checkAndExpireLeases, getTask } from '../src/tasks.mjs';
import { executeGates } from '../src/gatekeeper.mjs';
import { captureWorkspaceState } from '../src/guard.mjs';
import { resolveCommandSpec, prepareSandboxedCommand, detectSandboxCapabilities } from '../src/policy.mjs';
import { buildLeaseRollup } from '../src/audit.mjs';
import { AdapterProcess, getAdapterStatus, collectAdapterResult } from '../src/adapters.mjs';
import { acquireGateSlot, cleanAbandonedGateSlots, getSlotStatus } from '../src/scheduler.mjs';
import { startTask } from '../src/workspace.mjs';
import { verifyAndSettleTask } from '../src/settle.mjs';
import { startServer } from '../src/server.mjs';

const dbFor = sandbox => sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
const writePolicy = (root, policy) => {
  fs.mkdirSync(path.join(root, '.vibesync'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vibesync', 'policy.json'), JSON.stringify(policy));
};
const legacyPolicy = root => writePolicy(root, { version: 1 });

async function waitForExit(runId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = getAdapterStatus(runId);
    if (state.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('adapter did not exit');
}

test('gate write accounting rejects Git ref metadata mutation even when HEAD is unchanged', async () => {
  await withSandbox(async sandbox => {
    const db = dbFor(sandbox);
    legacyPolicy(sandbox.dir);
    const head = execGit('git rev-parse HEAD', sandbox.dir);
    const before = captureWorkspaceState(sandbox.dir);
    const result = executeGates([{ type: 'argv', argv: ['git', 'tag', 'hostile-gate-tag'] }], {
      cwd: sandbox.dir, repoRoot: sandbox.dir, db, actorName: 'openai-codex', allowedPaths: ['*']
    });
    assert.equal(result.success, false);
    assert.equal(result.failedGate.code, 'WRITE_SCOPE_VIOLATION');
    assert.ok(result.failedGate.writeScope.violations.includes('.git/metadata'));
    assert.equal(execGit('git rev-parse HEAD', sandbox.dir), head);
    assert.notEqual(captureWorkspaceState(sandbox.dir).gitMetadata, before.gitMetadata);
  });
});

test('sandbox write roots reject symlinks that resolve outside the workspace', async () => {
  await withSandbox(async sandbox => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-outside-'));
    try {
      fs.symlinkSync(outside, path.join(sandbox.dir, 'linked-outside'));
      writePolicy(sandbox.dir, { version: 2 });
      const spec = resolveCommandSpec({ type: 'argv', argv: ['node', '-e', 'process.exit(0)'], write_paths: ['linked-outside/result.txt'] }, {
        cwd: sandbox.dir, policyVersion: 2
      });
      assert.throws(() => prepareSandboxedCommand(spec, sandbox.dir, sandbox.dir), error => error.code === 'WRITE_SCOPE_SYMLINK');
      assert.equal(fs.existsSync(path.join(outside, 'result.txt')), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('network isolation is explicit and fails closed with platform capability reporting', async t => {
  const capabilities = detectSandboxCapabilities();
  assert.equal(capabilities.platform, process.platform);
  assert.equal(capabilities.modes.required, capabilities.requiredSandboxSupported);
  if (!capabilities.bubblewrap) {
    assert.match(capabilities.warning, /unavailable/i);
    return t.skip('Bubblewrap is unavailable on this platform; required mode is covered by fail-closed policy tests.');
  }
  await withSandbox(async sandbox => {
    writePolicy(sandbox.dir, { version: 2 });
    const offline = resolveCommandSpec({ type: 'argv', argv: ['node', '-e', 'process.exit(0)'] }, { cwd: sandbox.dir, policyVersion: 2 });
    const declared = resolveCommandSpec({ type: 'argv', argv: ['node', '-e', 'process.exit(0)'], network: true }, { cwd: sandbox.dir, policyVersion: 2 });
    assert.ok(prepareSandboxedCommand(offline, sandbox.dir, sandbox.dir).argv.includes('--unshare-net'));
    assert.equal(prepareSandboxedCommand(declared, sandbox.dir, sandbox.dir).argv.includes('--unshare-net'), false);
  });
});

test('expiry wins safely over stale heartbeats and a later human handoff', async () => {
  await withSandbox(async sandbox => {
    const db = dbFor(sandbox);
    createFeature({ id: 'FEAT-RACE', title: 'Race', target_milestone: 'v1', spec_markdown: 'Atomic leases' }, db);
    createTask({ id: 'TASK-RACE', feature_id: 'FEAT-RACE', title: 'Race task' }, db);
    const old = claimTask({ taskId: 'TASK-RACE', actorName: 'openai-codex' }, db, sandbox.dir);
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-5 minutes') WHERE id = ?").run('TASK-RACE');
    assert.equal(checkAndExpireLeases(db), 1);
    const human = claimTask({ taskId: 'TASK-RACE', actorName: 'human' }, db, sandbox.dir);
    assert.throws(() => heartbeatTaskLease({ taskId: 'TASK-RACE', actorName: 'openai-codex', leaseToken: old.leaseToken, repoRoot: sandbox.dir }, db), /rejected/);
    assert.equal(getTask('TASK-RACE', db).assigned_actor, 'human');
    assert.notEqual(human.leaseRunId, old.leaseRunId);
  });
});

test('hostile audit content is redacted and HTML-escaped without leaking lease tokens', async () => {
  await withSandbox(async sandbox => {
    const db = dbFor(sandbox);
    createFeature({ id: 'FEAT-XSS', title: '<img src=x onerror=alert(1)>', target_milestone: 'v1', spec_markdown: 'Audit safely' }, db);
    createTask({ id: 'TASK-XSS', feature_id: 'FEAT-XSS', title: '<script>alert(1)</script>' }, db);
    const claim = claimTask({ taskId: 'TASK-XSS', actorName: 'local-qwen' }, db, sandbox.dir);
    db.prepare('UPDATE settlement_events SET evidence_payload = ? WHERE lease_run_id = ?').run(
      JSON.stringify({ message: '<svg onload=alert(1)>', api_key: 'highly-sensitive-value' }), claim.leaseRunId);
    const encoded = JSON.stringify(buildLeaseRollup(claim.leaseRunId, db));
    assert.doesNotMatch(encoded, /<script|<svg|<img/);
    assert.match(encoded, /&lt;script&gt;/);
    assert.doesNotMatch(encoded, /highly-sensitive-value/);
    assert.doesNotMatch(encoded, new RegExp(claim.leaseToken));
  });
});

test('provider crashes are bounded, redacted, and collectable', async () => {
  await withSandbox(async sandbox => {
    const adapter = new AdapterProcess('gemini', { executable: process.execPath,
      argv_template: ['-e', "process.stderr.write('api_key=crash-secret-value');process.exit(17)"] });
    const run = adapter.start({ task: { id: 'TASK-CRASH', title: 'Crash' }, worktreePath: sandbox.dir,
      actorName: 'gemini-adapter', repoRoot: sandbox.dir });
    await waitForExit(run.runId);
    const result = collectAdapterResult(run.runId);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 17);
    assert.doesNotMatch(result.stderr, /crash-secret-value/);
    assert.ok(result.stderr.length <= 1024 * 1024);
  });
});

test('resource slots recover both dead owners and over-age live-owner records', async () => {
  await withSandbox(async sandbox => {
    const db = dbFor(sandbox);
    db.prepare("INSERT INTO gate_slots (id, actor, phase, pid, started_at) VALUES ('dead-owner', 'local-qwen', 'gate', 2147483647, datetime('now', '-1 hour'))").run();
    db.prepare("INSERT INTO gate_slots (id, actor, phase, pid, started_at) VALUES ('old-live-owner', 'openai-codex', 'gate', ?, datetime('now', '-1 hour'))").run(process.pid);
    assert.equal(cleanAbandonedGateSlots(db, 1000), 2);
    assert.deepEqual(getSlotStatus(db), []);
    assert.equal(acquireGateSlot(db, 'local-qwen', 'TASK-NEXT', 'gate').acquired, true);
  });
});

test('full hardened workflow preserves setup, task, feature, and hotfix invariants', async () => {
  await withSandbox(async sandbox => {
    const db = dbFor(sandbox);
    legacyPolicy(sandbox.dir);
    const holistic = { type: 'argv', argv: ['node', '-e', "require('fs').accessSync('src/implementation.txt')"] };
    createFeature({ id: 'FEAT-FULL', title: 'Full pipeline', target_milestone: 'v1', spec_markdown: 'All stages', holistic_gate_cmd: holistic }, db);
    createTask({ id: 'TASK-FULL', feature_id: 'FEAT-FULL', title: 'Implement pipeline', allowed_paths: ['src/**'],
      setup: [{ type: 'argv', argv: ['node', '-e', "require('fs').mkdirSync('src',{recursive:true});require('fs').writeFileSync('src/setup.txt','ready')"], write_paths: ['src/setup.txt'] }],
      required_gates: [{ type: 'argv', argv: ['node', '-e', "require('fs').accessSync('src/setup.txt');require('fs').accessSync('src/implementation.txt')"] }] }, db);
    const started = startTask({ taskId: 'TASK-FULL', actorName: 'openai-codex' }, db, sandbox.dir);
    fs.writeFileSync(path.join(started.worktreePath, 'src', 'implementation.txt'), 'implemented\n');
    execGit('git add src', started.worktreePath);
    execGit('git commit -m "feat: implement full pipeline"', started.worktreePath);
    const settled = verifyAndSettleTask({ taskId: 'TASK-FULL', actorName: 'openai-codex', worktreePath: started.worktreePath, repoRoot: sandbox.dir }, db, sandbox.dir);
    assert.equal(settled.phase, 'SETTLED');
    assert.equal(settleFeature({ featureId: 'FEAT-FULL', actorName: 'human' }, db, sandbox.dir).success, true);

    const server = await startServer({ port: 0, db, repoRoot: sandbox.dir, quiet: true });
    try {
      const expectedHead = execGit('git rev-parse HEAD', sandbox.dir);
      fs.writeFileSync(path.join(sandbox.dir, 'HOTFIX.md'), 'reviewed hotfix\n');
      const response = await fetch(`http://127.0.0.1:${server.port}/api/hotfix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` },
        body: JSON.stringify({ message: 'pipeline invariant', expectedHead })
      });
      assert.equal(response.status, 200);
      const hotfix = await response.json();
      assert.equal(hotfix.success, true);
      assert.equal(execGit('git log -1 --format=%s', sandbox.dir), 'hotfix: pipeline invariant');
      assert.ok(db.prepare("SELECT 1 FROM settlement_events WHERE actor = 'human' AND action = 'task_settled'").get());
    } finally {
      await server.close();
    }
  });
});
