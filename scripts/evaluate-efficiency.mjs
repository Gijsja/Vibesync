#!/usr/bin/env node
/** Create a comparable, deterministic evaluation report from scenario fixtures. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['successful_settlement', 'failed_test_repair', 'scope_violation', 'expired_lease', 'provider_handoff'];
const unknown = value => value === undefined ? null : value;

export function evaluateScenario(scenario) {
  const attempts = scenario.verification_attempts || [];
  const retries = Math.max(0, attempts.length - 1);
  const passed = attempts.filter(attempt => attempt.status === 'passed').length;
  const failed = attempts.filter(attempt => attempt.status === 'failed').length;
  return {
    id: scenario.id,
    outcome: scenario.outcome,
    completion_quality: scenario.completion_quality,
    elapsed_ms: unknown(scenario.elapsed_ms),
    verification_attempts: attempts.length,
    retries,
    failed_attempts: failed,
    passed_attempts: passed,
    output_recovery_reads: Number(scenario.output_recovery_reads || 0),
    provider_tokens: unknown(scenario.provider_tokens),
    provider_cost_usd: unknown(scenario.provider_cost_usd),
    deterministic: true
  };
}

export function createBaselineReport(scenarios) {
  const ids = new Set(scenarios.map(scenario => scenario.id));
  const missing = REQUIRED.filter(id => !ids.has(id));
  if (missing.length) throw new Error(`Missing required scenarios: ${missing.join(', ')}`);
  return {
    format: 'vibesync-efficiency-baseline/v1',
    kind: 'deterministic-harness',
    scenarios: scenarios.map(evaluateScenario),
    notes: 'Provider billing is null unless supplied by recorded provider evidence; deterministic fixtures never invent it.'
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = path.resolve(process.argv[2] || 'tests/fixtures/efficiency/scenarios.json');
  const source = JSON.parse(fs.readFileSync(input, 'utf8'));
  process.stdout.write(`${JSON.stringify(createBaselineReport(source.scenarios), null, 2)}\n`);
}
