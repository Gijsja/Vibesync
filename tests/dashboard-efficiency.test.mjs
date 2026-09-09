import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { getPayload } from '../src/server.mjs';
const queuedTests = []; const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queuedTests.push({ n, f });

test('dashboard state exposes nullable task efficiency evidence by feature', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-DASH', title: 'Dash', target_milestone: 'v1', spec_markdown: 'x' }, db);
    createTask({ id: 'TASK-DASH', feature_id: 'FEAT-DASH', title: 'Dash task', allowed_paths: ['x'], required_gates: [] }, db);
    const payload = getPayload(db, sandbox.dir);
    assert.equal(payload.featureEfficiency['FEAT-DASH'][0].task_id, 'TASK-DASH');
    assert.equal(payload.featureEfficiency['FEAT-DASH'][0].tokens_used, null);
  });
});
if (typeof Bun !== 'undefined') { let failed = false; for (const e of queuedTests) { try { await e.f(); } catch (error) { failed = true; console.error(error); } } if (failed) process.exitCode = 1; }
