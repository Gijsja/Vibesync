import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, getTask } from '../src/tasks.mjs';
import { AdapterProcess, resolveAdapter, routeTask, getAdapterStatus, cancelAdapterRun, collectAdapterResult, handoffAdapterRun } from '../src/adapters.mjs';

const waitForExit = async runId => {
  for (let index = 0; index < 100; index++) {
    const state = getAdapterStatus(runId);
    if (state.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('adapter did not exit');
};

test('adapter process passes redacted context by file without shell interpolation', async () => {
  await withSandbox(async sandbox => {
    const marker = path.join(sandbox.dir, 'injected-marker');
    const adapter = new AdapterProcess('codex', { executable: process.execPath,
      argv_template: ['-e', "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(c.task.title)", '{context_file}'] });
    const state = adapter.start({ task: { id: 'TASK-CTX', title: `literal; touch ${marker}`, leaseToken: 'must-not-persist' },
      worktreePath: sandbox.dir, actorName: 'openai-codex', repoRoot: sandbox.dir });
    await waitForExit(state.runId);
    const contextPath = path.join(sandbox.dir, '.vibesync', 'adapter-runs', state.runId, 'context.json');
    const context = fs.readFileSync(contextPath, 'utf8');
    assert.doesNotMatch(context, /must-not-persist/);
    assert.equal(fs.statSync(contextPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(marker), false);
    const result = collectAdapterResult(state.runId);
    assert.match(result.stdout, /literal; touch/);
    assert.equal(fs.existsSync(path.dirname(contextPath)), false);
  });
});

test('routing is deterministic across Gemini, Claude, Codex, and local configurations', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    const adapterConfig = id => ({ executable: process.execPath, argv_template: ['-e', `process.stdout.write('${id}')`], priority: id === 'codex' ? 1 : 10 });
    fs.writeFileSync(path.join(sandbox.dir, '.vibesync/policy.json'), JSON.stringify({ adapters: {
      gemini: adapterConfig('gemini'), claude: adapterConfig('claude'), codex: adapterConfig('codex'), local: adapterConfig('local')
    } }));
    assert.equal(resolveAdapter('local', sandbox.dir).id, 'local');
    assert.equal(resolveAdapter(null, sandbox.dir).id, 'codex');
    createFeature({ id: 'FEAT-ROUTE', title: 'Route', target_milestone: 'v1', spec_markdown: 'Model routing' }, db);
    createTask({ id: 'TASK-ROUTE', feature_id: 'FEAT-ROUTE', title: 'Route safely', model_hint: 'local' }, db);
    const run = await routeTask({ taskId: 'TASK-ROUTE' }, db, sandbox.dir);
    assert.equal(run.adapter, 'local');
    assert.equal(getTask('TASK-ROUTE', db).assigned_actor, 'local-adapter');
    await waitForExit(run.runId);
    assert.equal(collectAdapterResult(run.runId).stdout, 'local');
  });
});

test('adapter cancellation terminates a running process and reports bounded state', async () => {
  await withSandbox(async sandbox => {
    const adapter = new AdapterProcess('local', { executable: process.execPath,
      argv_template: ['-e', 'setInterval(()=>{},1000)'], timeout_ms: 10000 });
    const run = adapter.start({ task: { id: 'TASK-CANCEL', title: 'Cancel' }, worktreePath: sandbox.dir,
      actorName: 'local-qwen', repoRoot: sandbox.dir });
    assert.equal(getAdapterStatus(run.runId).status, 'running');
    assert.equal(cancelAdapterRun(run.runId).status, 'cancelled');
    await waitForExit(run.runId);
    const result = collectAdapterResult(run.runId);
    assert.equal(result.status, 'cancelled');
  });
});

test('provider handoff terminates the old process before transferring task ownership', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync/state.db'), sandbox.dir));
    fs.writeFileSync(path.join(sandbox.dir, '.vibesync/policy.json'), JSON.stringify({ adapters: {
      codex: { executable: process.execPath, argv_template: ['-e', 'setInterval(()=>{},1000)'] },
      claude: { executable: process.execPath, argv_template: ['-e', "process.stdout.write('handoff-ok')"] }
    } }));
    createFeature({ id: 'FEAT-HANDOFF', title: 'Handoff', target_milestone: 'v1', spec_markdown: 'No overlap' }, db);
    createTask({ id: 'TASK-HANDOFF', feature_id: 'FEAT-HANDOFF', title: 'Handoff', model_hint: 'codex' }, db);
    const first = await routeTask({ taskId: 'TASK-HANDOFF', adapterId: 'codex' }, db, sandbox.dir);
    const second = await handoffAdapterRun(first.runId, 'claude', db, sandbox.dir);
    assert.equal(second.adapter, 'claude');
    assert.equal(getTask('TASK-HANDOFF', db).assigned_actor, 'claude-adapter');
    assert.throws(() => getAdapterStatus(first.runId), /not found/);
    await waitForExit(second.runId);
    assert.equal(collectAdapterResult(second.runId).stdout, 'handoff-ok');
  });
});
