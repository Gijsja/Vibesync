import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeWorkspace } from '../src/init.mjs';

const runtime = path.resolve('scripts/vibesync.mjs');
test('real stdio runtime supports discovery and exits when its client closes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-stdio-'));
  const client = new Client({ name: 'product-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [runtime, '--repo', root, '--port', '0'], stderr: 'pipe' });
  try {
    initializeWorkspace(root);
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 10);
    const state = await client.callTool({ name: 'vibesync_get_state', arguments: {} });
    assert.equal(JSON.parse(state.content[0].text).workspace.root, root);
    const url = fs.readFileSync(path.join(root, '.vibesync/hud.url'), 'utf8').trim();
    assert.equal((await fetch(url + '/api/state')).status, 200);
    await client.close();
    // SDK close waits for child termination; the listening socket must be gone.
    await assert.rejects(fetch(url + '/api/state', { signal: AbortSignal.timeout(1000) }));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard-only runtime handles SIGTERM and leaves no listening socket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-hud-'));
  initializeWorkspace(root);
  const child = spawn(process.execPath, [runtime, '--repo', root, '--port', '0', '--hud'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  const exited = once(child, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HUD did not start: ' + diagnostics)), 8000);
      child.stderr.on('data', chunk => { diagnostics += chunk; if (diagnostics.includes('listening at')) { clearTimeout(timer); resolve(); } });
      child.once('error', reject);
    });
    const url = fs.readFileSync(path.join(root, '.vibesync/hud.url'), 'utf8').trim();
    assert.equal((await fetch(url)).status, 200);
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, diagnostics);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
