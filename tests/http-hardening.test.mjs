import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { startServer } from '../src/server.mjs';

function request(port, route, body, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method,
      headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP boundary rejects hostile requests and preserves literal data', async t => {
  await withSandbox(async sandbox => {
    const db = getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir);
    const instance = await startServer({ port: 0, repoRoot: sandbox.dir, db, quiet: true });
    const { port } = instance;
    try {
      await t.test('blocks foreign origins, null origins, cross-site requests and rebinding', async () => {
        for (const headers of [
          { Origin: 'https://attacker.example' }, { Origin: 'null' },
          { 'Sec-Fetch-Site': 'cross-site' }, { Host: `attacker.example:${port}` }
        ]) {
          const res = await request(port, '/api/hotfix', '{}', headers);
          assert.equal(res.status, 403);
          assert.equal(res.headers['access-control-allow-origin'], undefined);
        }
        const preflight = await request(port, '/api/state', undefined, { Origin: 'https://attacker.example' }, 'OPTIONS');
        assert.equal(preflight.status, 403);
        const read = await request(port, '/api/state', undefined, { Origin: 'https://attacker.example' }, 'GET');
        assert.equal(read.status, 403);
        assert.equal(db.prepare('SELECT count(*) AS n FROM settlement_events').get().n, 0);
      });
      await t.test('returns client errors for malformed, scalar and oversized bodies', async () => {
        for (const body of ['{', 'null', '[]', '42', '"text"']) {
          assert.equal((await request(port, '/api/park', body)).status, 400);
        }
        assert.equal((await request(port, '/api/park', '{}', { 'Content-Type': 'text/plain' })).status, 415);
        assert.equal((await request(port, '/api/park', JSON.stringify({ title: 'é'.repeat(510_000) }))).status, 413);
        assert.equal((await request(port, '/api/state', undefined, {}, 'GET')).status, 200);
      });
      await t.test('hotfix message is literal stdin, including shell substitutions', async () => {
        const message = 'literal $(touch injected-dollar) `touch injected-backtick` "quoted"';
        const res = await request(port, '/api/hotfix', JSON.stringify({ message }), { Origin: `http://127.0.0.1:${port}` });
        assert.equal(res.status, 200, res.text);
        assert.equal(fs.existsSync(path.join(sandbox.dir, 'injected-dollar')), false);
        assert.equal(fs.existsSync(path.join(sandbox.dir, 'injected-backtick')), false);
        assert.equal(execFileSync('git', ['log', '-1', '--format=%B'], { cwd: sandbox.dir, encoding: 'utf8' }).trim(), `hotfix: ${message}`);
        assert.equal((await request(port, '/api/hotfix', '{"message":{}}')).status, 400);
      });
      await t.test('embedded dashboard state cannot close its script element', async () => {
        const title = '$& $` $\' </script><script>globalThis.compromised=true</script>';
        createFeature({ id: 'FEAT-XSS', title, target_milestone: 'v1', spec_markdown: 'Regression fixture' }, db);
        fs.writeFileSync(path.join(sandbox.dir, '.vibesync', 'dashboard.html'), '<script>/*__INITIAL_STATE_PLACEHOLDER__*/</script>');
        const res = await request(port, '/', undefined, {}, 'GET');
        assert.equal(res.status, 200);
        assert.ok(!res.text.includes(title));
        assert.equal((res.text.match(/<\/script>/g) || []).length, 1);
        const json = res.text.match(/window.__INITIAL_STATE__ = (.*);/)[1];
        assert.equal(JSON.parse(json).features.find(f => f.id === 'FEAT-XSS').title, title);
        assert.equal(res.headers['x-frame-options'], 'DENY');
      });
    } finally {
      await instance.close();
    }
  });
});
