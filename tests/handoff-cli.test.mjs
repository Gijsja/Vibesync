import test from './bun-node-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask } from '../src/tasks.mjs';
import { recordGateFailure } from '../src/gatekeeper.mjs';
import { getAgentInstructions, generateHandoffCard, performHumanTakeover, formatGateCommand } from '../src/handoff.mjs';

const runtime = path.resolve('scripts/vibesync.mjs');

test('getAgentInstructions returns structured agent rules and protocol', () => {
  const instructions = getAgentInstructions();
  assert.match(instructions, /VibeSync AI Agent Operating Instructions/);
  assert.match(instructions, /Worker/);
  assert.match(instructions, /Claim Narrowly/);
  assert.match(instructions, /Work Exclusively in the Managed Worktree/);
  assert.match(instructions, /Heartbeat Regularly/);
  assert.match(instructions, /Evidence-Based Verification/);
  assert.match(instructions, /Hard Security & Scope Boundaries/);
  assert.match(instructions, /Park Off-Task Discoveries/);
  assert.match(instructions, /vibesync_preview_task/);
  assert.match(instructions, /vibesync_claim_task/);
  assert.match(instructions, /vibesync_verify_and_settle/);
});

test('formatGateCommand cleanly converts strings, objects, and arrays', () => {
  assert.equal(formatGateCommand('npm test'), 'npm test');
  assert.equal(formatGateCommand({ cmd: 'pytest tests/' }), 'pytest tests/');
  assert.equal(formatGateCommand({ argv: ['node', '--test', 'test.mjs'] }), 'node --test test.mjs');
  assert.equal(formatGateCommand({ script: 'lint' }), 'npm run lint');
  assert.equal(formatGateCommand({ type: 'node-test', args: ['foo.test.mjs'] }), 'node --test foo.test.mjs');
  assert.equal(formatGateCommand({ type: 'pytest', args: ['-k', 'unit'] }), 'pytest -k unit');
});

test('CLI --help documents --handoff, --eject, and --agent-instructions', () => {
  const out = execFileSync(process.execPath, [runtime, '--help'], { encoding: 'utf8' });
  assert.match(out, /--handoff \[TASK_ID\]/);
  assert.match(out, /--eject \[TASK_ID\]/);
  assert.match(out, /--agent-instructions/);
});

test('CLI --agent-instructions prints markdown instructions to stdout', () => {
  const out = execFileSync(process.execPath, [runtime, '--agent-instructions'], { encoding: 'utf8' });
  assert.match(out, /VibeSync AI Agent Operating Instructions/);
  assert.match(out, /The 5 Constrained Rules of Engagement/);
});

test('CLI --instructions alias works identically', () => {
  const out = execFileSync(process.execPath, [runtime, '--instructions'], { encoding: 'utf8' });
  assert.match(out, /VibeSync AI Agent Operating Instructions/);
});

test('generateHandoffCard handles empty workspaces gracefully', async () => {
  await withSandbox(async (sandbox) => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    const card = generateHandoffCard({ db, repoRoot: sandbox.dir });
    assert.match(card, /No active or pending tasks in repository/);

    const json = generateHandoffCard({ db, repoRoot: sandbox.dir, format: 'json' });
    assert.equal(json.status, 'empty');
  });
});

test('generateHandoffCard renders detailed card for active in-progress task', async () => {
  await withSandbox(async (sandbox) => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    createFeature({
      id: 'FEAT-HANDOFF',
      title: 'Handoff Card Verification',
      target_milestone: 'v0.5',
      spec_markdown: 'Verify that one-screen handoff cards summarize operational facts accurately.'
    }, db);

    createTask({
      id: 'TASK-H1',
      feature_id: 'FEAT-HANDOFF',
      title: 'Implement handoff card renderer',
      allowed_paths: ['src/handoff.mjs'],
      required_gates: [{ type: 'node-test', args: ['tests/handoff-cli.test.mjs'] }],
      priority: 'high',
      model_hint: 'claude'
    }, db);

    claimTask({ taskId: 'TASK-H1', actorName: 'claude-coder' }, db, sandbox.dir);

    const card = generateHandoffCard({ taskId: 'TASK-H1', db, repoRoot: sandbox.dir });
    assert.match(card, /VIBESYNC HUMAN HANDOFF CARD/);
    assert.match(card, /\[ ⚡ IN PROGRESS \] TASK-H1: Implement handoff card renderer/);
    assert.match(card, /Feature:\s+FEAT-HANDOFF/);
    assert.match(card, /Assigned Actor:\s+claude-coder/);
    assert.match(card, /Priority:\s+high/);
    assert.match(card, /WHAT CHANGED/);
    assert.match(card, /WHY \(CONTRACT GOAL\)/);
    assert.match(card, /EVIDENCE \(GATES & VERIFICATION\)/);
    assert.match(card, /node --test tests\/handoff-cli\.test\.mjs/);
    assert.match(card, /NEXT ACTION REQUESTED/);
    assert.match(card, /vibesync --eject TASK-H1/);

    const json = generateHandoffCard({ taskId: 'TASK-H1', db, repoRoot: sandbox.dir, format: 'json' });
    assert.equal(json.taskId, 'TASK-H1');
    assert.equal(json.attentionCategory, '⚡ IN PROGRESS');
    assert.equal(json.actor, 'claude-coder');
    assert.equal(json.priority, 'high');
  });
});

test('generateHandoffCard flags blocked tasks with circuit breaker warnings', async () => {
  await withSandbox(async (sandbox) => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-BLOCKED', title: 'Circuit Breaker Test', target_milestone: 'v0.5', spec_markdown: 'Spec' }, db);
    createTask({ id: 'TASK-B1', feature_id: 'FEAT-BLOCKED', title: 'Failing task' }, db);
    claimTask({ taskId: 'TASK-B1', actorName: 'flaky-agent' }, db, sandbox.dir);

    // Trip the circuit breaker
    recordGateFailure(db, 'TASK-B1', { failure: 'gate 1 failed' });
    recordGateFailure(db, 'TASK-B1', { failure: 'gate 2 failed' });
    recordGateFailure(db, 'TASK-B1', { failure: 'gate 3 failed' });

    const card = generateHandoffCard({ taskId: 'TASK-B1', db, repoRoot: sandbox.dir });
    assert.match(card, /\[ ⏸️ BLOCKED \] TASK-B1/);
    assert.match(card, /Circuit breaker tripped/);
    assert.match(card, /Failures:\s+3 \/ 3 strikes/);
    assert.match(card, /vibesync --eject TASK-B1/);
  });
});

test('CLI --handoff and --eject work end-to-end', async () => {
  await withSandbox(async (sandbox) => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-CLI', title: 'CLI E2E Test', target_milestone: 'v0.5', spec_markdown: 'Spec' }, db);
    createTask({ id: 'TASK-CLI', feature_id: 'FEAT-CLI', title: 'CLI task' }, db);
    claimTask({ taskId: 'TASK-CLI', actorName: 'bot-agent' }, db, sandbox.dir);

    // Run --handoff via CLI
    const handoffOut = execFileSync(process.execPath, [runtime, '--repo', sandbox.dir, '--handoff', 'TASK-CLI'], { encoding: 'utf8' });
    assert.match(handoffOut, /\[ ⚡ IN PROGRESS \] TASK-CLI/);
    assert.match(handoffOut, /bot-agent/);

    // Run --eject via CLI
    const ejectOut = execFileSync(process.execPath, [runtime, '--repo', sandbox.dir, '--eject', 'TASK-CLI'], { encoding: 'utf8' });
    assert.match(ejectOut, /successfully ejected to human operator/);
    assert.match(ejectOut, /Assigned Actor: human/);
    assert.match(ejectOut, /Circuit Breaker: Reset/);

    // Verify task state in database
    const updated = db.prepare('SELECT assigned_actor, status, consecutive_failures FROM tasks WHERE id = ?').get('TASK-CLI');
    assert.equal(updated.assigned_actor, 'human');
    assert.equal(updated.consecutive_failures, 0);
  });
});
