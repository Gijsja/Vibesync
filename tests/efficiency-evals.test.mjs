import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBaselineReport, evaluateScenario } from '../scripts/evaluate-efficiency.mjs';

const queuedTests = [];
const test = typeof Bun === 'undefined' ? nodeTest : (name, run) => queuedTests.push({ name, run });

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/efficiency/scenarios.json', import.meta.url), 'utf8'));

test('baseline includes the five reproducible lifecycle scenarios', () => {
  const report = createBaselineReport(fixture.scenarios);
  assert.equal(report.kind, 'deterministic-harness');
  assert.deepEqual(report.scenarios.map(item => item.id), ['successful_settlement', 'failed_test_repair', 'scope_violation', 'expired_lease', 'provider_handoff']);
});

test('failed repair records a retry and output recovery reads', () => {
  const report = createBaselineReport(fixture.scenarios);
  const repair = report.scenarios.find(item => item.id === 'failed_test_repair');
  assert.equal(repair.retries, 1); assert.equal(repair.failed_attempts, 1); assert.equal(repair.output_recovery_reads, 1);
});

test('unknown provider metrics stay unknown rather than becoming activity estimates', () => {
  const result = evaluateScenario(fixture.scenarios[0]);
  assert.equal(result.provider_tokens, null); assert.equal(result.provider_cost_usd, null);
});

test('a report rejects an incomplete evaluation suite', () => {
  assert.throws(() => createBaselineReport(fixture.scenarios.slice(0, 4)), /provider_handoff/);
});

if (typeof Bun !== 'undefined') {
  let failed = false;
  for (const { name, run } of queuedTests) {
    try { await run(); }
    catch (error) { failed = true; console.error('not ok - ' + name, error); }
  }
  if (failed) process.exitCode = 1;
}
