# Efficiency evaluation baseline

This task adds a deterministic harness, not a measurement of paid model behavior. It covers successful settlement, failed-test repair, scope violation, expired lease, and provider handoff. Each fixture records outcome, completion quality, elapsed time, verification attempts, and output-recovery reads.

Run the repeatable baseline with `bun scripts/evaluate-efficiency.mjs` (or `node` where available). Run `bun test tests/efficiency-evals.test.mjs` for the deterministic assertions. Save the JSON output alongside any later comparison; compare the same five scenarios and keep unknown provider token/cost fields `null` unless actual provider evidence is captured.

Real-model runs are separate: record the provider, model/version, prompt, repository revision, timestamps, gate outputs, handoffs, and recovery reads. Do not infer billing from task activity. Do not make prompt-compression changes until a before/after run uses the same scenarios; a worse completion outcome, more retries, or less recoverable diagnostics rejects the candidate.
