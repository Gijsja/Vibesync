import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { createMcpServer, PROMPT_DEFINITIONS } from '../src/mcp.mjs';
import { ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const queued = [];
const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });

test('MCP server declares prompts capability and lists all standard prompts', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });

    assert.ok(server._capabilities.prompts, 'Server must declare prompts capability');

    const listHandler = server._requestHandlers.get(ListPromptsRequestSchema.shape.method.value);
    assert.ok(listHandler, 'ListPromptsRequestSchema handler must be registered');

    const result = await listHandler({ method: 'prompts/list', params: {} });
    assert.ok(Array.isArray(result.prompts));
    assert.equal(result.prompts.length, 4);

    const names = result.prompts.map(p => p.name);
    assert.ok(names.includes('vibesync_claim_and_start_task'));
    assert.ok(names.includes('vibesync_pre_settlement_audit'));
    assert.ok(names.includes('vibesync_triage_circuit_breaker'));
    assert.ok(names.includes('vibesync_park_insight'));
  });
});

test('MCP server gets vibesync_claim_and_start_task prompt with ready tasks or specific task', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-P1', title: 'Feature 1', target_milestone: 'v1', spec_markdown: 'Feature 1 Spec' }, db);
    createTask({ id: 'TASK-P1', feature_id: 'FEAT-P1', title: 'Task 1', allowed_paths: ['src/**'], required_gates: ['npm test'] }, db);

    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const getHandler = server._requestHandlers.get(GetPromptRequestSchema.shape.method.value);

    // 1. Without specific task_id (lists ready tasks)
    const promptWithoutId = await getHandler({
      method: 'prompts/get',
      params: { name: 'vibesync_claim_and_start_task', arguments: {} }
    });
    assert.ok(promptWithoutId.description);
    assert.ok(promptWithoutId.messages[0].content.text.includes('Currently Ready Tasks'));
    assert.ok(promptWithoutId.messages[0].content.text.includes('TASK-P1'));

    // 2. With specific task_id
    const promptWithId = await getHandler({
      method: 'prompts/get',
      params: { name: 'vibesync_claim_and_start_task', arguments: { task_id: 'TASK-P1', actor_name: 'test-agent' } }
    });
    assert.ok(promptWithId.messages[0].content.text.includes('Target Task: TASK-P1'));
    assert.ok(promptWithId.messages[0].content.text.includes('vibesync_claim_task({ taskId: "TASK-P1", actorName: "test-agent" })'));
  });
});

test('MCP server gets vibesync_pre_settlement_audit prompt with task verification checks', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-AUDIT', title: 'Audit Feature', target_milestone: 'v1', spec_markdown: 'Audit Spec' }, db);
    createTask({ id: 'TASK-AUDIT', feature_id: 'FEAT-AUDIT', title: 'Audit Task', allowed_paths: ['src/core/**'], required_gates: ['npm test'] }, db);

    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const getHandler = server._requestHandlers.get(GetPromptRequestSchema.shape.method.value);

    const prompt = await getHandler({
      method: 'prompts/get',
      params: { name: 'vibesync_pre_settlement_audit', arguments: { task_id: 'TASK-AUDIT' } }
    });

    assert.ok(prompt.messages[0].content.text.includes('Pre-Settlement Audit Checklist for TASK-AUDIT'));
    assert.ok(prompt.messages[0].content.text.includes('src/core/**'));
    assert.ok(prompt.messages[0].content.text.includes('vibesync_verify_and_settle'));
  });
});

test('MCP server gets vibesync_triage_circuit_breaker prompt with gate failure details', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-TRIAGE', title: 'Triage Feature', target_milestone: 'v1', spec_markdown: 'Triage Spec' }, db);
    createTask({ id: 'TASK-TRIAGE', feature_id: 'FEAT-TRIAGE', title: 'Triage Task', allowed_paths: ['src/**'], required_gates: ['npm test'] }, db);

    db.prepare("UPDATE tasks SET consecutive_failures = 2 WHERE id = 'TASK-TRIAGE'").run();
    db.prepare(`
      INSERT INTO gate_runs (id, task_id, feature_id, phase, gate_index, policy_hash, actor, model_profile, status, exit_code, duration_ms, summary, started_at, finished_at)
      VALUES ('gr-1', 'TASK-TRIAGE', 'FEAT-TRIAGE', 'gate', 0, 'hash', 'gemini-coder', 'hosted', 'failed', 1, 350, 'AssertionError in test suite', datetime('now'), datetime('now'))
    `).run();

    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const getHandler = server._requestHandlers.get(GetPromptRequestSchema.shape.method.value);

    const prompt = await getHandler({
      method: 'prompts/get',
      params: { name: 'vibesync_triage_circuit_breaker', arguments: { task_id: 'TASK-TRIAGE' } }
    });

    assert.ok(prompt.messages[0].content.text.includes('Circuit Breaker & Failure Triage for TASK-TRIAGE'));
    assert.ok(prompt.messages[0].content.text.includes('2/3 failure strikes'));
    assert.ok(prompt.messages[0].content.text.includes('AssertionError in test suite'));
    assert.ok(prompt.messages[0].content.text.includes('STRIKES RECORDED'));
  });
});

test('MCP server gets vibesync_park_insight prompt and handles unknown prompt errors', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const getHandler = server._requestHandlers.get(GetPromptRequestSchema.shape.method.value);

    const prompt = await getHandler({
      method: 'prompts/get',
      params: { name: 'vibesync_park_insight', arguments: { discovery_summary: 'Refactor database connection pool' } }
    });
    assert.ok(prompt.messages[0].content.text.includes('Refactor database connection pool'));
    assert.ok(prompt.messages[0].content.text.includes('vibesync_park_insight'));

    await assert.rejects(
      async () => getHandler({ method: 'prompts/get', params: { name: 'unknown_prompt', arguments: {} } }),
      /Prompt unknown_prompt not found/
    );
  });
});

if (typeof Bun !== 'undefined') {
  let fail = false;
  for (const e of queued) {
    try {
      await e.f();
    } catch (err) {
      fail = true;
      console.error(err);
    }
  }
  if (fail) process.exitCode = 1;
}
