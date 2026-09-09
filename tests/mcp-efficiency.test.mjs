import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const queuedTests = []; const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queuedTests.push({ n, f });

test('MCP baseline keeps every declared tool, role, and safety section intact', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    const server = createMcpServer({ db, repoRoot: sandbox.dir });
    const handler = server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const tools = (await handler({ method: 'tools/list', params: {} })).tools;
    assert.equal(tools.length, 26);
    for (const tool of tools) assert.match(tool.description, /Purpose:.*When to use:.*When NOT to use:.*Side effects:/s);
    assert.ok(tools.some(tool => tool.name === 'vibesync_verify_and_settle'));
    assert.ok(tools.some(tool => tool.name === 'vibesync_get_lease_rollup'));
  });
});

if (typeof Bun !== 'undefined') { let failed = false; for (const e of queuedTests) { try { await e.f(); } catch (error) { failed = true; console.error(error); } } if (failed) process.exitCode = 1; }
