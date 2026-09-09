import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const queued = []; const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });

test('compact summary and single-operation reads avoid the full ledger', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    db.prepare("INSERT INTO operations (id, kind, target_id, actor, status, owner_pid) VALUES ('op-1', 'task', 'TASK-1', 'codex', 'completed', 1)").run();
    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'admin' });
    const list = server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    assert.ok((await list({ method: 'tools/list', params: {} })).tools.some(t => t.name === 'vibesync_get_summary'));
    const call = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const summary = await call({ method: 'tools/call', params: { name: 'vibesync_get_summary', arguments: {} } });
    assert.ok(JSON.parse(summary.content[0].text).taskCounts);
    const operation = await call({ method: 'tools/call', params: { name: 'vibesync_get_operation', arguments: { operation_id: 'op-1' } } });
    assert.equal(JSON.parse(operation.content[0].text).id, 'op-1');
  });
});
if (typeof Bun !== 'undefined') { let fail = false; for (const e of queued) { try { await e.f(); } catch (err) { fail = true; console.error(err); } } if (fail) process.exitCode = 1; }
