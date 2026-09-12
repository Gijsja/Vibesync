import test from './bun-node-test.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { startServer } from '../src/server.mjs';
import { startTask } from '../src/workspace.mjs';

function request(port, route, body, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      headers: { ...headers }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('HTTP Server exposes /api/queue, /api/handoff, and /api/tasks/:id/eject', async t => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    createFeature({ id: 'FEAT-API', title: 'API Feature', target_milestone: 'v1', spec_markdown: 'Spec' }, db);
    createTask({ id: 'TASK-API-1', feature_id: 'FEAT-API', title: 'API Task 1', allowed_paths: ['src/**'], required_gates: ['git diff --check'] }, db);

    const instance = await startServer({ port: 0, repoRoot: sandbox.dir, db, quiet: true });
    const { port } = instance;

    try {
      await t.test('GET /api/queue returns valid attention queue summary', async () => {
        const res = await request(port, '/api/queue', undefined, {}, 'GET');
        assert.equal(res.status, 200);
        const data = JSON.parse(res.text);
        assert.ok(data.summary);
        assert.equal(typeof data.summary.total, 'number');
        assert.equal(typeof data.summary.decisionsCount, 'number');
        assert.equal(typeof data.summary.reviewsCount, 'number');
        assert.equal(typeof data.summary.blockedCount, 'number');
        assert.equal(typeof data.summary.inProgressCount, 'number');
      });

      await t.test('GET /api/handoff returns handoff card JSON and text', async () => {
        const jsonRes = await request(port, '/api/handoff/TASK-API-1', undefined, {}, 'GET');
        assert.equal(jsonRes.status, 200);
        const card = JSON.parse(jsonRes.text);
        assert.equal(card.task.id, 'TASK-API-1');
        assert.equal(card.feature.id, 'FEAT-API');
        assert.ok(card.nextAction);

        const textRes = await request(port, '/api/handoff/TASK-API-1?format=text', undefined, {}, 'GET');
        assert.equal(textRes.status, 200);
        assert.match(textRes.text, /VIBESYNC HUMAN HANDOFF CARD/);
        assert.match(textRes.text, /TASK-API-1/);
      });

      await t.test('GET /api/handoff with invalid task returns 404', async () => {
        const res = await request(port, '/api/handoff/TASK-NONEXISTENT', undefined, {}, 'GET');
        assert.equal(res.status, 404);
      });

      await t.test('POST /api/tasks/:id/eject successfully ejects an active task', async () => {
        // Start task to give it an active lease
        startTask({ taskId: 'TASK-API-1', actorName: 'openai-codex' }, db, sandbox.dir);

        const ejectRes = await request(port, '/api/tasks/TASK-API-1/eject', '{}', {
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`
        }, 'POST');

        assert.equal(ejectRes.status, 200);
        const data = JSON.parse(ejectRes.text);
        assert.equal(data.success, true);
        assert.equal(data.task.assigned_actor, 'human');
        assert.equal(data.task.status, 'in_progress');
        assert.equal(data.task.lease_token_hash, undefined);
      });

      await t.test('GET /assets/hud/* serves browser-native ES modules', async () => {
        const cssRes = await request(port, '/assets/hud/css/tokens.css', undefined, {}, 'GET');
        assert.equal(cssRes.status, 200);
        assert.match(cssRes.headers['content-type'], /text\/css/);
        assert.match(cssRes.text, /--font-sans/);

        const jsRes = await request(port, '/assets/hud/js/store.js', undefined, {}, 'GET');
        assert.equal(jsRes.status, 200);
        assert.match(jsRes.headers['content-type'], /text\/javascript/);
        assert.match(jsRes.text, /class HudStore/);
      });
    } finally {
      await instance.close();
    }
  });
});
