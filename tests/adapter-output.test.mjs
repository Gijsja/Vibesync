import nodeTest from 'node:test';
const queuedTests = [];
const test = typeof Bun === 'undefined' ? nodeTest : (name, run) => queuedTests.push({ name, run });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { AdapterProcess, cancelAdapterRun, collectAdapterResult, getAdapterStatus, readAdapterOutput } from '../src/adapters.mjs';

async function waitForExit(runId) {
  for (let index = 0; index < 100; index++) {
    const state = getAdapterStatus(runId);
    if (state.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('adapter did not exit');
}

test('adapter output is redacted, persisted privately, and retrieved in bounded chunks', async () => {
  await withSandbox(async sandbox => {
    const adapter = new AdapterProcess('local', { executable: process.execPath,
      argv_template: ['-e', "process.stderr.write(' secret=split-' + 'value-1234567890123456');process.stdout.write('x'.repeat(1024 * 1024 + 32), () => process.exit(1))"] });
    const run = adapter.start({ task: { id: 'TASK-OUTPUT', title: 'Output' }, worktreePath: sandbox.dir, actorName: 'local', repoRoot: sandbox.dir });
    await waitForExit(run.runId);
    const collected = collectAdapterResult(run.runId, { cleanup: false, limit: 512 });
    assert.equal(collected.status, 'failed');
    assert.ok(collected.output.artifact_hash);
    assert.ok(collected.output.retention.retained_bytes > 1024 * 1024);
    assert.equal(collected.output.truncated, true);
    const artifact = path.join(sandbox.dir, '.vibesync', 'artifacts', `${collected.output.artifact_hash}.log`);
    assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
    const full = readAdapterOutput(collected.output.artifact_hash, { repoRoot: sandbox.dir, offset: 0, limit: 16 * 1024 });
    assert.match(full.data, /REDACTED/);
    assert.doesNotMatch(full.data, /value-1234567890123456/);
  });
});

test('adapter output discloses cap overflow and cancellation clears private context', async () => {
  await withSandbox(async sandbox => {
    fs.mkdirSync(path.join(sandbox.dir, '.vibesync'), { recursive: true });
    fs.writeFileSync(path.join(sandbox.dir, '.vibesync', 'policy.json'), JSON.stringify({ resource_policy: { output_limit_bytes: 32 } }));
    const adapter = new AdapterProcess('local', { executable: process.execPath, argv_template: ['-e', "process.stdout.write('a'.repeat(128));setInterval(()=>{},1000)"] });
    const run = adapter.start({ task: { id: 'TASK-CANCEL', title: 'Cancel' }, worktreePath: sandbox.dir, actorName: 'local', repoRoot: sandbox.dir });
    const contextDirectory = path.join(sandbox.dir, '.vibesync', 'adapter-runs', run.runId);
    await new Promise(resolve => setTimeout(resolve, 50));
    cancelAdapterRun(run.runId);
    const state = await waitForExit(run.runId);
    assert.equal(state.output.dropped_bytes > 0, true);
    assert.equal(fs.existsSync(contextDirectory), false);
  });
});

if (typeof Bun !== 'undefined') {
  let failed = false;
  for (const { name, run } of queuedTests) {
    try { await run(); }
    catch (error) { failed = true; console.error(`not ok - ${name}`, error); }
  }
  if (failed) process.exitCode = 1;
}
