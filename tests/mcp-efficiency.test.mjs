import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, supersedeTask } from '../src/tasks.mjs';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const queuedTests = []; const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queuedTests.push({ n, f });

test('MCP baseline keeps every declared tool, role, and safety section intact', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    const server = createMcpServer({ db, repoRoot: sandbox.dir });
    const handler = server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const tools = (await handler({ method: 'tools/list', params: {} })).tools;
    assert.equal(tools.length, 27);
    for (const tool of tools) assert.match(tool.description, /Purpose:.*When to use:.*When NOT to use:.*Side effects:/s);
    assert.ok(tools.some(tool => tool.name === 'vibesync_verify_and_settle'));
    assert.ok(tools.some(tool => tool.name === 'vibesync_get_lease_rollup'));
    assert.ok(tools.some(tool => tool.name === 'vibesync_get_active_task'));
    for (const name of ['vibesync_get_task_detail', 'vibesync_preview_task', 'vibesync_claim_task', 'vibesync_heartbeat_task', 'vibesync_partial_verify', 'vibesync_verify_and_settle']) {
      const tool = tools.find(entry => entry.name === name);
      assert.equal(tool.inputSchema.properties.detail.default, 'compact');
      assert.deepEqual(tool.inputSchema.properties.detail.enum, ['compact', 'full']);
    }
  });
});

test('worker compact responses are materially smaller while full detail retains contracts', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-01', title: 'Compact protocol', target_milestone: 'M1', spec_markdown: 'Acceptance criteria: '.repeat(180) }, db);
    createTask({ id: 'TASK-01.1', feature_id: 'FEAT-01', title: 'Return concise task data', allowed_paths: ['src/mcp.mjs'], required_gates: [{ type: 'node-test', args: ['tests/mcp-efficiency.test.mjs'], idempotency: 'safe' }] }, db);
    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const call = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const compact = await call({ method: 'tools/call', params: { name: 'vibesync_get_task_detail', arguments: { task_id: 'TASK-01.1' } } });
    const full = await call({ method: 'tools/call', params: { name: 'vibesync_get_task_detail', arguments: { task_id: 'TASK-01.1', detail: 'full' } } });
    const compactPayload = JSON.parse(compact.content[0].text);
    const fullPayload = JSON.parse(full.content[0].text);
    assert.equal(compactPayload.task_id, 'TASK-01.1');
    assert.equal(compactPayload.next_action, 'Preview this task, then claim it when its approvals are ready.');
    assert.equal(compactPayload.feature.acceptance_criteria_truncated, true);
    assert.equal(fullPayload.task.id, 'TASK-01.1');
    assert.equal(fullPayload.feature.id, 'FEAT-01');
    assert.ok(compact.content[0].text.length < full.content[0].text.length / 2);

    const ready = await call({ method: 'tools/call', params: { name: 'vibesync_list_ready_tasks', arguments: {} } });
    const readyTask = JSON.parse(ready.content[0].text).tasks[0];
    assert.equal(readyTask.gate_count, 1);
    assert.equal('required_gates' in readyTask, false);
  });
});

test('worker ready queue omits superseded tasks', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-01', title: 'Replacement task', target_milestone: 'M1', spec_markdown: 'Only claimable tasks appear.' }, db);
    createTask({ id: 'TASK-01.1', feature_id: 'FEAT-01', title: 'Original work', allowed_paths: ['src/mcp.mjs'], required_gates: [] }, db);
    createTask({ id: 'TASK-01.2', feature_id: 'FEAT-01', title: 'Replacement work', allowed_paths: ['src/mcp.mjs'], required_gates: [] }, db);
    createTask({ id: 'TASK-01.3', feature_id: 'FEAT-01', title: 'Claimable work', allowed_paths: ['src/mcp.mjs'], required_gates: [] }, db);
    db.prepare("UPDATE tasks SET status = 'settled', settled_commit = 'abc123' WHERE id = 'TASK-01.2'").run();
    supersedeTask({ taskId: 'TASK-01.1', replacementTaskId: 'TASK-01.2', actorName: 'human' }, db);

    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const call = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const ready = JSON.parse((await call({ method: 'tools/call', params: { name: 'vibesync_list_ready_tasks', arguments: {} } })).content[0].text);
    assert.deepEqual(ready.tasks.map(task => task.task_id), ['TASK-01.3']);
  });
});

test('active task lookup is concise and never exposes a lease token', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-01', title: 'Lease recovery', target_milestone: 'M1', spec_markdown: 'Recover without secrets.' }, db);
    createTask({ id: 'TASK-01.1', feature_id: 'FEAT-01', title: 'Active task', allowed_paths: ['src/**'], required_gates: [] }, db);
    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const call = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const inactive = await call({ method: 'tools/call', params: { name: 'vibesync_get_active_task', arguments: { actor_name: 'openai-codex' } } });
    assert.deepEqual(JSON.parse(inactive.content[0].text), { active: false, next_action: 'List ready tasks.' });

    db.prepare("UPDATE tasks SET status = 'in_progress', assigned_actor = 'openai-codex', worktree_path = '/tmp/task', lease_expires_at = datetime('now', '+45 minutes'), lease_run_id = 'lease-run' WHERE id = 'TASK-01.1'").run();
    const active = await call({ method: 'tools/call', params: { name: 'vibesync_get_active_task', arguments: { actor_name: 'openai-codex' } } });
    const payload = JSON.parse(active.content[0].text);
    assert.equal(payload.active, true);
    assert.equal(payload.task_id, 'TASK-01.1');
    assert.equal(payload.lease.token_available, false);
    assert.equal(JSON.stringify(payload).includes('lease_token'), false);

    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 minute') WHERE id = 'TASK-01.1'").run();
    const expired = await call({ method: 'tools/call', params: { name: 'vibesync_get_active_task', arguments: { actor_name: 'openai-codex' } } });
    const expiredPayload = JSON.parse(expired.content[0].text);
    assert.equal(expiredPayload.active, false);
    assert.equal(expiredPayload.expired, true);
    assert.match(expiredPayload.next_action, /Do not continue work/);
  });
});

if (typeof Bun !== 'undefined') { let failed = false; for (const e of queuedTests) { try { await e.f(); } catch (error) { failed = true; console.error(error); } } if (failed) process.exitCode = 1; }
