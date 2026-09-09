import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const queued = []; const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });
test('usage guide explains compact reads and operation follow-up', () => {
  const usage = fs.readFileSync(new URL('../docs/USAGE.md', import.meta.url), 'utf8');
  assert.match(usage, /vibesync_get_summary/); assert.match(usage, /vibesync_get_operation/);
});
if (typeof Bun !== 'undefined') { let fail = false; for (const e of queued) { try { await e.f(); } catch (err) { fail = true; console.error(err); } } if (fail) process.exitCode = 1; }
