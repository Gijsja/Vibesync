/**
 * tests/m3-mcp-hud.test.mjs
 * 
 * Milestone 3 Test Suite: Stdio MCP Server & Ambient Control HUD
 * Verifies Features 27–41:
 * - MCP tool suite (get_state, claim_task, verify_and_settle, park_insight, settle_feature, repair_state)
 * - In-process HTTP & SSE server with dashboard serving and REST control endpoints
 * - Resilient port negotiation (companion fallback and auto port hunting on EADDRINUSE)
 * - Real-time SSE broadcasting upon state mutations
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  withSandbox,
  VibeSyncHttpClient,
  VibeSyncSseClient,
  occupyPort,
  waitForPortFree
} from './harness.mjs';

import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { startServer } from '../src/server.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('Milestone 3 Suite: Stdio MCP Server & Ambient Control HUD', async (t) => {

  await t.test('1. MCP Tool Declarations: registers all 6 judicial tools', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
      const server = createMcpServer({ db, repoRoot: sandbox.dir });

      const listHandler = server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
      assert.ok(listHandler, 'ListTools handler must be registered');

      const response = await listHandler({ method: 'tools/list', params: {} });
      const toolNames = response.tools.map(t => t.name);

      assert.ok(toolNames.includes('vibesync_get_state'));
      assert.ok(toolNames.includes('vibesync_claim_task'));
      assert.ok(toolNames.includes('vibesync_verify_and_settle'));
      assert.ok(toolNames.includes('vibesync_park_insight'));
      assert.ok(toolNames.includes('vibesync_merge_insights'));
      assert.ok(toolNames.includes('vibesync_settle_feature'));
      assert.ok(toolNames.includes('vibesync_repair_state'));
      assert.equal(toolNames.length, 10);
      assert.ok(toolNames.includes('vibesync_create_feature'));
      assert.ok(toolNames.includes('vibesync_create_task'));
      assert.ok(toolNames.includes('vibesync_release_task'));
    });
  });

  await t.test('2. MCP Tool Execution: vibesync_get_state, claim_task, park_insight', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      createFeature({
        id: 'FEAT-01',
        title: 'Core Engine Scaffold',
        target_milestone: 'v1.0',
        spec_markdown: 'Baseline engine specification'
      }, db);

      createTask({
        id: 'TASK-01.1',
        feature_id: 'FEAT-01',
        title: 'Zod Schemas',
        allowed_paths: ['*'],
        required_gates: ['node -e "process.exit(0)"']
      }, db);

      let updateTriggered = false;
      const server = createMcpServer({
        db,
        repoRoot: sandbox.dir,
        onUpdate: () => { updateTriggered = true; }
      });

      const callHandler = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
      assert.ok(callHandler, 'CallTool handler must be registered');

      // 2a. Call vibesync_get_state
      const stateRes = await callHandler({
        method: 'tools/call',
        params: { name: 'vibesync_get_state', arguments: {} }
      });
      assert.ok(!stateRes.isError);
      const stateData = JSON.parse(stateRes.content[0].text);
      assert.equal(stateData.features.length, 1);
      assert.equal(stateData.tasks.length, 1);
      assert.equal(stateData.features[0].id, 'FEAT-01');

      // 2b. Call vibesync_claim_task
      const claimRes = await callHandler({
        method: 'tools/call',
        params: {
          name: 'vibesync_claim_task',
          arguments: {
            task_id: 'TASK-01.1',
            actor_name: 'gemini-antigravity',
            worktree_path: sandbox.dir
          }
        }
      });
      assert.ok(!claimRes.isError);
      assert.ok(updateTriggered, 'onUpdate callback should be fired upon task claim');
      const claimData = JSON.parse(claimRes.content[0].text);
      assert.equal(claimData.success, true);
      assert.equal(claimData.task.status, 'in_progress');
      assert.equal(claimData.task.assigned_actor, 'gemini-antigravity');

      // 2c. Call vibesync_park_insight
      updateTriggered = false;
      const parkRes = await callHandler({
        method: 'tools/call',
        params: {
          name: 'vibesync_park_insight',
          arguments: {
            title: 'Refactor Canvas Renderer',
            category: 'architecture_insight',
            context_notes: 'Spotted potential performance spike in continuous sorting',
            actor_name: 'gemini-antigravity'
          }
        }
      });
      assert.ok(!parkRes.isError, `parkRes must not be an error: ${parkRes.content?.[0]?.text}`);
      assert.ok(updateTriggered, 'onUpdate callback should be fired upon parking insight');
      const parkData = JSON.parse(parkRes.content[0].text);
      assert.equal(parkData.success, true);
      assert.ok(parkData.id.startsWith('INC-'));
    });
  });

  await t.test('3. MCP Tool Execution: vibesync_verify_and_settle & vibesync_settle_feature', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      createFeature({
        id: 'FEAT-02',
        title: 'Walk-Behind Masks',
        target_milestone: 'v0.3',
        spec_markdown: 'Continuous Y-sorting specification'
      }, db);

      createTask({
        id: 'TASK-02.1',
        feature_id: 'FEAT-02',
        title: 'Schema v6',
        allowed_paths: ['*'],
        required_gates: ['node -e "process.exit(0)"']
      }, db);

      const server = createMcpServer({ db, repoRoot: sandbox.dir });
      const callHandler = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);

      // Claim task to get canonical branch name
      const claimRes = await callHandler({
        method: 'tools/call',
        params: {
          name: 'vibesync_claim_task',
          arguments: {
            task_id: 'TASK-02.1',
            actor_name: 'openai-codex'
          }
        }
      });
      assert.ok(!claimRes.isError);
      const claimData = JSON.parse(claimRes.content[0].text);
      const branchName = claimData.task.branch_name;

      // Claim creates a real isolated worktree; implement there and settle via MCP.
      assert.ok(claimData.task.worktree_path);
      fs.mkdirSync(path.join(claimData.task.worktree_path, 'src'), { recursive: true });
      fs.writeFileSync(path.join(claimData.task.worktree_path, 'src/schema.txt'), 'v6 schema');

      // Verify and settle task
      const verifyRes = await callHandler({
        method: 'tools/call',
        params: {
          name: 'vibesync_verify_and_settle',
          arguments: {
            task_id: 'TASK-02.1',
            actor_name: 'openai-codex'
          }
        }
      });
      assert.ok(!verifyRes.isError, `verifyRes error: ${verifyRes.content?.[0]?.text}`);
      const verifyData = JSON.parse(verifyRes.content[0].text);
      assert.equal(verifyData.success, true);
      assert.equal(verifyData.phase, 'SETTLED');

      // Now settle parent feature
      const featRes = await callHandler({
        method: 'tools/call',
        params: {
          name: 'vibesync_settle_feature',
          arguments: {
            feature_id: 'FEAT-02',
            actor_name: 'openai-codex'
          }
        }
      });
      assert.ok(!featRes.isError, `featRes error: ${featRes.content?.[0]?.text}`);
      const featData = JSON.parse(featRes.content[0].text);
      assert.equal(featData.success, true);
      assert.equal(featData.featureId, 'FEAT-02');
    });
  });

  await t.test('4. In-Process HTTP Server: serves dashboard and state endpoints', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      createFeature({
        id: 'FEAT-10',
        title: 'HUD Integration Test',
        target_milestone: 'v1.0',
        spec_markdown: 'Validates HTTP endpoints'
      }, db);

      createTask({
        id: 'TASK-10.1',
        feature_id: 'FEAT-10',
        title: 'Test Dashboard',
        status: 'in_progress',
        allowed_paths: ['*']
      }, db);

      // Create dummy dashboard in sandbox
      const dashDir = path.join(sandbox.dir, '.vibesync');
      fs.mkdirSync(dashDir, { recursive: true });
      fs.writeFileSync(path.join(dashDir, 'dashboard.html'), '<!DOCTYPE html><html><body>Test HUD</body></html>');

      const serverInstance = await startServer({
        port: 4140,
        host: '127.0.0.1',
        repoRoot: sandbox.dir,
        db,
        quiet: true
      });

      try {
        const client = new VibeSyncHttpClient(serverInstance.port);

        // 4a. Verify GET /
        const indexRes = await client.getHudHtml();
        assert.equal(indexRes.status, 200);
        assert.ok(indexRes.html.includes('Test HUD'));

        // 4b. Verify GET /api/state
        const stateRes = await client.getState();
        assert.equal(stateRes.features.length, 1);
        assert.equal(stateRes.tasks.length, 1);
        assert.equal(stateRes.features[0].id, 'FEAT-10');

        // 4c. Verify POST /api/park
        const parkRes = await client.parkIdea({
          title: 'HTTP Insight',
          category: 'ux_polish',
          notes: 'Testing park endpoint via HTTP'
        });
        assert.equal(parkRes.success, true);
        assert.ok(parkRes.id.startsWith('INC-'));

        // 4d. Verify POST /api/eject
        const ejectRes = await client.ejectTask('TASK-10.1');
        assert.equal(ejectRes.success, true);
        assert.equal(ejectRes.task.assigned_actor, 'human');

        // 4e. Verify POST /api/hotfix
        const hotfixRes = await client.hotfix('urgent documentation fix');
        assert.equal(hotfixRes.success, true);
        assert.ok(hotfixRes.commitSha);

      } finally {
        await serverInstance.close();
      }
    });
  });

  await t.test('5. Real-Time SSE Stream: broadcasts state updates', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      const serverInstance = await startServer({
        port: 4150,
        host: '127.0.0.1',
        repoRoot: sandbox.dir,
        db,
        quiet: true
      });

      const sseClient = new VibeSyncSseClient(`http://127.0.0.1:${serverInstance.port}/api/events`);
      const httpClient = new VibeSyncHttpClient(serverInstance.port);

      try {
        const initial = await sseClient.connect();
        assert.ok(initial, 'Must receive initial state payload on connect');
        assert.ok(Array.isArray(initial.features));

        // Trigger mutation via HTTP POST
        await httpClient.parkIdea({
          title: 'SSE Triggered Insight',
          category: 'debt',
          notes: 'Verify SSE broadcast on state update'
        });

        // Wait for SSE broadcast
        const broadcast = await sseClient.waitForState(
          (state) => state.incubator.some(i => i.title === 'SSE Triggered Insight'),
          3000
        );

        assert.ok(broadcast, 'SSE client must receive broadcast containing newly parked insight');

      } finally {
        sseClient.close();
        await serverInstance.close();
      }
    });
  });

  await t.test('6. Resilient Port Negotiation: handles sibling VibeSync companion processes', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      // Primary server instance binds port 4160
      const primaryInstance = await startServer({
        port: 4160,
        host: '127.0.0.1',
        repoRoot: sandbox.dir,
        db,
        quiet: true
      });

      assert.equal(primaryInstance.isCompanion, false);
      assert.equal(primaryInstance.port, 4160);

      // Secondary instance (e.g. Codex GUI connecting while Antigravity is active)
      // tries to bind port 4160 as well
      const companionInstance = await startServer({
        port: 4160,
        host: '127.0.0.1',
        repoRoot: sandbox.dir,
        db,
        quiet: true
      });

      try {
        // Must NOT crash! Must identify sibling VibeSync and operate as companion
        assert.equal(companionInstance.isCompanion, true);
        assert.equal(companionInstance.port, 4160);
        assert.equal(companionInstance.server, null);

        // Check that hud.url still points to active server
        const hudUrl = fs.readFileSync(path.join(sandbox.dir, '.vibesync', 'hud.url'), 'utf8').trim();
        assert.equal(hudUrl, 'http://127.0.0.1:4160');

      } finally {
        await companionInstance.close();
        await primaryInstance.close();
      }
    });
  });

  await t.test('7. Resilient Port Negotiation: hunts next free port on unrelated port conflict', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      // Occupy port 4170 with a generic dummy TCP server (NOT VibeSync)
      const socketHold = await occupyPort(4170);

      try {
        // VibeSync attempts to listen on 4170
        const serverInstance = await startServer({
          port: 4170,
          host: '127.0.0.1',
          repoRoot: sandbox.dir,
          db,
          quiet: true
        });

        try {
          // Must auto-negotiate to next port (4171)
          assert.equal(serverInstance.isCompanion, false);
          assert.equal(serverInstance.port, 4171);

          const hudUrl = fs.readFileSync(path.join(sandbox.dir, '.vibesync', 'hud.url'), 'utf8').trim();
          assert.equal(hudUrl, 'http://127.0.0.1:4171');

        } finally {
          await serverInstance.close();
        }

      } finally {
        await socketHold.close();
        await waitForPortFree(4170);
      }
    });
  });

});
