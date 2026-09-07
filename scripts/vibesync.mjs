#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../src/db.mjs';
import { startServer } from '../src/server.mjs';
import { runMcpServer } from '../src/mcp.mjs';
import { waitForOperations, recoverInterruptedOperations } from '../src/operations.mjs';
import { initializeWorkspace } from '../src/init.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, port: { type: 'string' },
    hud: { type: 'boolean' }, init: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) {
    process.stdout.write('VibeSync — local coordination for AI pair programming\n\nUsage: vibesync [--repo PATH] [--port PORT] [--hud] [--init]\n\n  --hud   Run the dashboard without an MCP stdio connection\n  --init  Initialize the selected repository and exit\n  --repo  Repository root (defaults to current directory)\n  --port  Preferred dashboard port (default 4040; 0 selects a free port)\n\nWithout --hud, stdout is reserved for MCP JSON-RPC.\n');
    return;
  }
  const repoRoot = path.resolve(values.repo || process.cwd());
  if (values.init) {
    initializeWorkspace(repoRoot);
    process.stderr.write(`[VibeSync] Initialized ${repoRoot}\n`);
    return;
  }
  const port = values.port === undefined ? 4040 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  const db = getDb(null, repoRoot);
  recoverInterruptedOperations(db);
  let hudInstance;
  let mcpInstance;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await waitForOperations();
    if (mcpInstance) await mcpInstance.server.close();
    if (hudInstance) await hudInstance.close();
    closeDb(db);
  };
  process.once('SIGINT', () => shutdown().catch(console.error));
  process.once('SIGTERM', () => shutdown().catch(console.error));
  try {
    hudInstance = await startServer({ repoRoot, db, port });
    if (!values.hud) {
      mcpInstance = await runMcpServer({ db, repoRoot, onUpdate: hudInstance.broadcastState });
      mcpInstance.transport.onclose = () => shutdown().catch(console.error);
      process.stderr.write('[VibeSync] Stdio MCP ready.\n');
    }
  } catch (err) {
    await shutdown();
    throw err;
  }
}
main().catch(err => {
  process.stderr.write(`[VibeSync] ${err.message}\n`);
  process.exitCode = 1;
});
