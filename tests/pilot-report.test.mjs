import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { generatePilotReport } from '../scripts/generate-pilot-report.mjs';
const queued = []; const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });
test('report never invents an unavailable before/after result', () => {
  const report = generatePilotReport();
  assert.match(report, /no savings or quality claim/i); assert.match(report, /unknown/i);
});
if (typeof Bun !== 'undefined') { let fail = false; for (const e of queued) { try { await e.f(); } catch (err) { fail = true; console.error(err); } } if (fail) process.exitCode = 1; }
