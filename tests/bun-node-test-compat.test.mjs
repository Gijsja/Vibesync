import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommandSpec } from '../src/policy.mjs';
const queued = []; const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });

test('legacy node --test becomes Bun test rather than Bun --test', () => {
  const spec = resolveCommandSpec(['node', '--test', 'tests/example.test.mjs']);
  if (typeof Bun !== 'undefined') assert.deepEqual(spec.argv.slice(1), ['test', 'tests/example.test.mjs']);
  else assert.deepEqual(spec.argv, ['node', '--test', 'tests/example.test.mjs']);
});
if (typeof Bun !== 'undefined') { let fail = false; for (const e of queued) { try { await e.f(); } catch (err) { fail = true; console.error(err); } } if (fail) process.exitCode = 1; }
