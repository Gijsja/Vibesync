#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../src/db.mjs';
import { startServer } from '../src/server.mjs';
import { runMcpServer } from '../src/mcp.mjs';
import { waitForOperations, recoverInterruptedOperations } from '../src/operations.mjs';
import { initializeWorkspace } from '../src/init.mjs';
import { getAgentInstructions, generateHandoffCard, performHumanTakeover, findAttentionTask } from '../src/handoff.mjs';
import { computeAttentionQueue, formatAttentionQueue } from '../src/telemetry.mjs';
import { provisionFastPathTask } from '../src/fastpath.mjs';
import { listTasks } from '../src/tasks.mjs';
import { inspectBaselineReadiness } from '../src/workspace.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' }, port: { type: 'string' },
      hud: { type: 'boolean' }, init: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      'mcp-role': { type: 'string', default: 'worker' },
      'agent-instructions': { type: 'boolean' },
      instructions: { type: 'boolean' },
      handoff: { type: 'boolean' },
      eject: { type: 'boolean' },
      queue: { type: 'boolean' },
      status: { type: 'boolean' },
      overview: { type: 'boolean' },
      tasks: { type: 'boolean' },
      run: { type: 'string' },
      actor: { type: 'string' },
      task: { type: 'string' }
    }
  });
  if (values.help) {
    process.stdout.write('VibeSync — local coordination for AI pair programming\n\nUsage: vibesync [--repo PATH] [--port PORT] [--hud] [--init] [--mcp-role worker|admin]\n                [--queue] [--status] [--tasks] [--handoff [TASK_ID]] [--eject [TASK_ID]] [--run "PROMPT"]\n                [--agent-instructions]\n\nCommands & Shortcuts:\n  run "PROMPT"          Frictionless fast-path task creation and worktree provisioning\n  --queue               Display the triaged human attention queue\n  --status, --overview  Display unified operational status (queue, baseline, leases, ready tasks)\n  --tasks               Display available ready and active tasks\n  --handoff [TASK_ID]   Display a one-screen human handoff card for active or specified task\n  --eject [TASK_ID]     Eject an active agent task to human operator with a fresh lease\n  --agent-instructions  Print constrained operating guidelines for AI coding agents\n\nServer Options:\n  --hud                 Run the dashboard without an MCP stdio connection\n  --init                Initialize the selected repository and exit\n  --mcp-role            Expose worker tools (default) or human administrative tools\n  --repo                Repository root (defaults to current directory)\n  --port                Preferred dashboard port (default 4040; 0 selects a free port)\n  -h, --help            Show this help message\n\nWithout --hud, stdout is reserved for MCP JSON-RPC.\n');
    return;
  }
  if (values['agent-instructions'] || values.instructions) {
    process.stdout.write(getAgentInstructions() + '\n');
    return;
  }
  const repoRoot = path.resolve(values.repo || process.cwd());
  if (values.init) {
    initializeWorkspace(repoRoot);
    process.stderr.write(`[VibeSync] Initialized ${repoRoot}\n`);
    return;
  }

  const isQueue = values.queue || positionals[0] === 'queue';
  if (isQueue) {
    const db = getDb(null, repoRoot);
    try {
      const q = computeAttentionQueue(db, repoRoot);
      process.stdout.write(formatAttentionQueue(q) + '\n');
    } finally {
      closeDb(db);
    }
    return;
  }

  const isStatus = values.status || values.overview || positionals[0] === 'status' || positionals[0] === 'overview';
  if (isStatus) {
    const db = getDb(null, repoRoot);
    try {
      const q = computeAttentionQueue(db, repoRoot);
      const activeTasks = db.prepare("SELECT id, title, assigned_actor, lease_expires_at, worktree_path FROM tasks WHERE status = 'in_progress'").all();
      const readyTasks = listTasks(db, { status: 'ready' }).filter(t => !t.superseded_by_task_id);
      const baseline = inspectBaselineReadiness(repoRoot);

      let out = formatAttentionQueue(q) + '\n\n';
      out += '================================================================================\n';
      out += 'REPOSITORY BASELINE & WORKSPACE STATUS\n';
      out += '================================================================================\n';
      if (baseline.clean) {
        out += '  Baseline: Clean (committed HEAD matches working tree)\n';
      } else {
        out += `  Baseline: WARNING (${baseline.uncommitted_files.length} uncommitted file(s))\n`;
        for (const f of baseline.uncommitted_files.slice(0, 5)) {
          out += `    - ${f}\n`;
        }
      }
      out += `  Active Leases: ${activeTasks.length}\n`;
      for (const t of activeTasks) {
        out += `    ⚡ [${t.id}] ${t.title} (Actor: ${t.assigned_actor || 'unknown'}, Expires: ${t.lease_expires_at || 'unknown'})\n`;
      }
      out += `  Ready Tasks: ${readyTasks.length} claimable\n`;
      for (const t of readyTasks.slice(0, 5)) {
        out += `    👉 [${t.id}] ${t.title} (${t.feature_id})\n`;
      }
      if (readyTasks.length > 5) {
        out += `    ... and ${readyTasks.length - 5} more (run "vibesync --tasks" for full list)\n`;
      }
      out += '================================================================================\n';
      process.stdout.write(out);
    } finally {
      closeDb(db);
    }
    return;
  }

  const isTasks = values.tasks || positionals[0] === 'tasks';
  if (isTasks) {
    const db = getDb(null, repoRoot);
    try {
      const readyTasks = listTasks(db, { status: 'ready' }).filter(t => !t.superseded_by_task_id);
      const activeTasks = db.prepare("SELECT id, title, assigned_actor, lease_expires_at, worktree_path FROM tasks WHERE status = 'in_progress'").all();

      let out = '================================================================================\n';
      out += 'VIBESYNC TASK QUEUE\n';
      out += '================================================================================\n';
      out += `Active Tasks: ${activeTasks.length}\n`;
      for (const t of activeTasks) {
        out += `  ⚡ [${t.id}] ${t.title}\n`;
        out += `     Actor: ${t.assigned_actor || 'unknown'} | Expires: ${t.lease_expires_at || 'unknown'}\n`;
      }
      out += `\nReady Tasks: ${readyTasks.length} claimable\n`;
      for (const t of readyTasks) {
        const gatesCount = Array.isArray(t.required_gates) ? t.required_gates.length : 0;
        out += `  👉 [${t.id}] ${t.title}\n`;
        out += `     Feature: ${t.feature_id} | Priority: ${t.priority} | Gates: ${gatesCount}\n`;
        out += `     Allowed: ${(t.allowed_paths || []).join(', ') || '*'}\n`;
      }
      out += '================================================================================\n';
      process.stdout.write(out);
    } finally {
      closeDb(db);
    }
    return;
  }

  const runPrompt = values.run || (positionals[0] === 'run' ? positionals.slice(1).join(' ') : null);
  if (runPrompt) {
    const db = getDb(null, repoRoot);
    try {
      const result = provisionFastPathTask({
        prompt: runPrompt,
        actor: values.actor || 'human',
        repoRoot,
        db
      });
      process.stdout.write(`[VibeSync Fast-Path] Provisioned task ${result.taskId} in isolated worktree.\n` +
        `  Feature:  ${result.featureId}\n` +
        `  Title:    ${result.title}\n` +
        `  Actor:    ${result.actor}\n` +
        `  Gate:     ${result.gate}\n` +
        `  Worktree: ${result.worktreePath}\n` +
        `  Branch:   ${result.branch}\n\n` +
        `👉 Next Steps:\n` +
        `  1. Implement changes in: ${result.worktreePath}\n` +
        `  2. Check status: vibesync --handoff ${result.taskId}\n` +
        `  3. Settle via HUD (vibesync --hud) or MCP\n`);
    } finally {
      closeDb(db);
    }
    return;
  }

  const isHandoff = values.handoff || positionals[0] === 'handoff';
  if (isHandoff) {
    const db = getDb(null, repoRoot);
    try {
      const targetTaskId = values.task || (positionals[0] === 'handoff' ? positionals[1] : positionals[0]) || null;
      const card = generateHandoffCard({ taskId: targetTaskId, db, repoRoot });
      process.stdout.write(card + '\n');
    } finally {
      closeDb(db);
    }
    return;
  }
  const isEject = values.eject || positionals[0] === 'eject';
  if (isEject) {
    let targetTaskId = values.task || (positionals[0] === 'eject' ? positionals[1] : positionals[0]) || null;
    const db = getDb(null, repoRoot);
    try {
      if (!targetTaskId) {
        const attentionTask = findAttentionTask(db);
        if (attentionTask) targetTaskId = attentionTask.id;
      }
      if (!targetTaskId) {
        throw new Error('--eject requires a task ID (e.g. vibesync --eject TASK-01) or an active task in repository');
      }
      performHumanTakeover(targetTaskId, db, repoRoot);
      process.stdout.write(`[VibeSync] Task ${targetTaskId} successfully ejected to human operator.\n  Assigned Actor: human\n  Circuit Breaker: Reset (0 failures)\n  Lease: Fresh 45-minute lease granted\n`);
    } finally {
      closeDb(db);
    }
    return;
  }
  const port = values.port === undefined ? 4040 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  if (!['worker', 'admin'].includes(values['mcp-role'])) throw new Error('--mcp-role must be worker or admin');
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
      mcpInstance = await runMcpServer({ db, repoRoot, role: values['mcp-role'], onUpdate: hudInstance.broadcastState });
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
