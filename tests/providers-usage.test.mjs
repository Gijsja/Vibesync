/**
 * tests/providers-usage.test.mjs
 * 
 * Verification suite for AI Provider Quota & 5-Hour Usage Engine
 * Verifies:
 * - Provider recognition (Gemini, Codex, Claude, DeepSeek)
 * - Dynamic 5-hour rolling usage % and total usage calculation
 * - User-configured usage/limit overrides via .vibesync/usage.json & POST /api/usage
 * - Dashboard HTML rendering with Claude agent badge, filter, and usage cards
 * - Integration with tasks and settlement events
 */

import test from './bun-node-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox, VibeSyncHttpClient } from './harness.mjs';
import { getDb, recordSettlementEvent } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask } from '../src/tasks.mjs';
import { parkInsight } from '../src/incubator.mjs';
import { startServer } from '../src/server.mjs';
import {
  matchProvider,
  computeProviderUsage,
  updateProviderUsageConfig,
  readUsageConfigFile
} from '../src/usage.mjs';

test('AI Provider Quota & 5-Hour Usage Suite', async (t) => {

  await t.test('1. Provider matching logic recognizes Gemini, Codex, Claude, and DeepSeek', () => {
    assert.equal(matchProvider('gemini-antigravity')?.id, 'gemini');
    assert.equal(matchProvider('Google Antigravity Agent')?.id, 'gemini');
    assert.equal(matchProvider('gemini')?.id, 'gemini');

    assert.equal(matchProvider('openai-codex')?.id, 'codex');
    assert.equal(matchProvider('codex')?.id, 'codex');

    assert.equal(matchProvider('anthropic-claude')?.id, 'claude');
    assert.equal(matchProvider('Claude-3-5-Sonnet')?.id, 'claude');
    assert.equal(matchProvider('claude')?.id, 'claude');

    assert.equal(matchProvider('deepseek-coder')?.id, 'deepseek');
    assert.equal(matchProvider('ollama-qwen')?.id, 'local');
    assert.equal(matchProvider('human'), null);
    assert.equal(matchProvider('system'), null);
  });

  await t.test('2. computeProviderUsage calculates 5h % and total metrics from SQLite events', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      createFeature({
        id: 'FEAT-USG',
        title: 'Usage Testing Feature',
        target_milestone: 'v1.0',
        spec_markdown: 'Contract for testing usage metrics'
      }, db);

      createTask({
        id: 'TASK-USG.1',
        feature_id: 'FEAT-USG',
        title: 'Claude Leased Task',
        allowed_paths: ['*']
      }, db);

      // Claim task for Claude
      claimTask({
        taskId: 'TASK-USG.1',
        actorName: 'anthropic-claude'
      }, db, sandbox.dir);

      // Record additional events for Claude
      recordSettlementEvent(db, {
        task_id: 'TASK-USG.1',
        actor: 'anthropic-claude',
        action: 'gate_passed',
        commit_ref: 'c1a2d3e'
      });

      // Park an incubator idea logged by Claude
      parkInsight({
        id: 'INC-CLAUDE-1',
        title: 'Anthropic Prompt Caching',
        category: 'architecture_insight',
        context_notes: 'Optimized cache breakpoints',
        logged_by: 'anthropic-claude'
      }, db, sandbox.dir);

      // Also record event for Gemini
      recordSettlementEvent(db, {
        task_id: 'TASK-USG.1',
        actor: 'gemini-antigravity',
        action: 'task_settled',
        commit_ref: 'g4m5n6o'
      });

      const usage = computeProviderUsage(db, sandbox.dir);
      assert.ok(Array.isArray(usage));

      const claude = usage.find(p => p.id === 'claude');
      assert.ok(claude, 'Claude provider must be present in usage metrics');
      assert.equal(claude.actorName, 'anthropic-claude');
      assert.equal(claude.activeTasks, 1);
      assert.ok(claude.used5h >= 3, `Claude used5h expected >= 3, got ${claude.used5h}`);
      assert.ok(claude.totalUsage >= 3, `Claude totalUsage expected >= 3, got ${claude.totalUsage}`);
      assert.equal(claude.usage5hPct, Math.round((claude.used5h / claude.limit5h) * 100));

      const gemini = usage.find(p => p.id === 'gemini');
      assert.ok(gemini);
      assert.ok(gemini.totalUsage >= 1);

      const codex = usage.find(p => p.id === 'codex');
      assert.ok(codex);
      assert.equal(codex.activeTasks, 0);
    });
  });

  await t.test('3. updateProviderUsageConfig persists custom quotas and updates status thresholds', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      // Set Claude to 85% usage (warning status)
      updateProviderUsageConfig({
        claude: {
          used5h: 85,
          limit5h: 100,
          totalUsage: 450
        }
      }, sandbox.dir);

      const usage = computeProviderUsage(db, sandbox.dir);
      const claude = usage.find(p => p.id === 'claude');
      assert.equal(claude.used5h, 85);
      assert.equal(claude.usage5hPct, 85);
      assert.equal(claude.status, 'warning');

      // Set Codex to 95% usage (critical status)
      updateProviderUsageConfig({
        codex: {
          used5h: 95,
          limit5h: 100
        }
      }, sandbox.dir);

      const usage2 = computeProviderUsage(db, sandbox.dir);
      const codex = usage2.find(p => p.id === 'codex');
      assert.equal(codex.usage5hPct, 95);
      assert.equal(codex.status, 'critical');
    });
  });

  await t.test('4. HTTP Server provides /api/state with providers and serves dashboard with Claude', async () => {
    await withSandbox(async (sandbox) => {
      const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);

      // Copy actual dashboard into sandbox
      const mainDashboard = fs.readFileSync(path.resolve(process.cwd(), '.vibesync', 'dashboard.html'), 'utf8');
      const dashDir = path.join(sandbox.dir, '.vibesync');
      fs.mkdirSync(dashDir, { recursive: true });
      fs.writeFileSync(path.join(dashDir, 'dashboard.html'), mainDashboard, 'utf8');

      const serverInstance = await startServer({
        port: 4180,
        host: '127.0.0.1',
        repoRoot: sandbox.dir,
        db,
        quiet: true
      });

      try {
        const client = new VibeSyncHttpClient(serverInstance.port);

        // 4a. GET /api/state
        const stateRes = await client.getState();
        assert.ok(Array.isArray(stateRes.providers), 'stateRes.providers must be an array');
        const providerIds = stateRes.providers.map(p => p.id);
        assert.ok(providerIds.includes('gemini'), 'Gemini must be in providers');
        assert.ok(providerIds.includes('codex'), 'Codex must be in providers');
        assert.ok(providerIds.includes('claude'), 'Claude must be in providers');

        // 4b. GET / dashboard HTML
        const htmlRes = await client.getHudHtml();
        assert.equal(htmlRes.status, 200);
        assert.ok(htmlRes.html.includes('agent-indicator claude'), 'Dashboard must contain Claude agent indicator style');
        assert.ok(htmlRes.html.includes('🟣 Claude'), 'Dashboard must contain Claude badge and filter');
        assert.ok(htmlRes.html.includes('providers-section'), 'Dashboard must contain AI Provider Quota section');
        assert.ok(htmlRes.html.includes('providers-compact-section'), 'Dashboard must contain compact provider quota section');
        assert.ok(htmlRes.html.includes('scratchpad-section'), 'Dashboard must contain scratchpad idea section in main');
        assert.ok(htmlRes.html.includes('scratch-title'), 'Dashboard must contain scratchpad input title');
        assert.ok(htmlRes.html.includes('submitScratchpadIdea'), 'Dashboard must contain submitScratchpadIdea function');
        assert.ok(htmlRes.html.includes('agent-room-section'), 'Dashboard must contain pixel agent room section');
        assert.ok(htmlRes.html.includes('agent-room-canvas'), 'Dashboard must contain agent room canvas');
        assert.ok(htmlRes.html.includes('AgentRoomEngine'), 'Dashboard must contain AgentRoomEngine implementation');
        assert.ok(htmlRes.html.includes('agent-thoughts-modal'), 'Dashboard must contain agent thoughts modal');
        assert.ok(htmlRes.html.includes('openAgentThoughtsModal'), 'Dashboard must contain openAgentThoughtsModal function');
        assert.ok(htmlRes.html.includes('getAgentLatestThought'), 'Dashboard must contain getAgentLatestThought evaluation function');
        assert.ok(htmlRes.html.includes('providers-root'), 'Dashboard must contain providers root element');

        // 4c. POST /api/usage
        const usageUpdateRes = await fetch(`http://127.0.0.1:${serverInstance.port}/api/usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'claude',
            used5h: 42,
            limit5h: 100,
            totalUsage: 210
          })
        });
        assert.equal(usageUpdateRes.status, 200);
        const usageData = await usageUpdateRes.json();
        assert.equal(usageData.success, true);
        const updatedClaude = usageData.providers.find(p => p.id === 'claude');
        assert.equal(updatedClaude.used5h, 42);
        assert.equal(updatedClaude.usage5hPct, 42);

        // 4d. POST /api/tasks with assigned_actor = 'anthropic-claude'
        createFeature({
          id: 'FEAT-CLAUDE',
          title: 'Claude Pair Programming Feature',
          target_milestone: 'v1.0',
          spec_markdown: 'Feature for Claude'
        }, db);

        const taskRes = await fetch(`http://127.0.0.1:${serverInstance.port}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'TASK-CLAUDE.1',
            feature_id: 'FEAT-CLAUDE',
            title: 'Claude Implementation Task',
            allowed_paths: ['*'],
            required_gates: ['node -e "process.exit(0)"'],
            assigned_actor: 'anthropic-claude'
          })
        });
        assert.equal(taskRes.status, 200);
        const taskData = await taskRes.json();
        assert.equal(taskData.task.assigned_actor, 'anthropic-claude');
        assert.equal(db.prepare('SELECT assigned_actor FROM tasks WHERE id = ?').get('TASK-CLAUDE.1').assigned_actor, 'anthropic-claude');

      } finally {
        await serverInstance.close();
      }
    });
  });

});
