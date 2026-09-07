# VibeSync release acceptance — 2026-09-07

The local product is ready for its documented workflow. The existing control-deck
and pixel-room styling is retained. This acceptance covers local trusted projects;
gate commands execute with the user's permissions, as documented in README.md.

| Requirement | Inspected evidence |
| --- | --- |
| R1: relational state, WAL/FKs/CHECK, contracts, leases, orphan incubator | m1-state-engine, adversarial-m1, industry-standard-pm, incubator-lifecycle tests |
| R2: stdio MCP plus resilient live HUD, parking/eject/hotfix | m3-mcp-hud, runtime-lifecycle, product-setup, http-hardening tests; browser connection and incubator checks |
| R3: scope, real gate exits, three strikes, collision simulation, safe squash/trailers/notes | m2-judicial-harness, adversarial-m2, background-verification tests; browser source-to-task-to-feature settlement journey |
| R4: exact recovery and corrupt-database backup | durable-recovery compares every recovered table and artifact, verifies repeated recovery and rolled-back transactions; m4-repair tests |
| R5: full required runner | `npm run test:runner`: 198 passed, zero failures, zero skips, 17 files |
| Pixel room lifecycle and inspector | agent-room-engine: desk leases, verifying rack, blocked beacon, click inspector, truthful log loading; real-browser verifying and settled screenshots |
| Worktree handoff and human recovery | task-workspace tests: full feature context, preserved files, lease renewal, breaker reset |
| Setup and packaging | product-setup and runtime-lifecycle tests; `npm pack --dry-run --json` succeeds |
| Responsive and accessible controls | Browser light desktop/dark 390px, no horizontal overflow; dialog focus/Escape and no-match search checked |

## Final browser checks

Fresh project: park → promote carried title and notes to a real feature; a second
idea was discarded. Direct database inspection confirmed `promoted` with
`promoted_feature_id=FEAT-01`, and `discarded` for the second record.

Real browser offline/online transitions exposed a stream-reconnect gap. The final
HUD closes the stream and displays offline on the browser offline event, then
reopens it on online; closed streams also retry during fallback polling. Both
`Server Offline` and the subsequent `Live Connected` were observed in the final
browser run. The six dashboard engine tests passed after this focused change.

A real failing subprocess produced the visible needs-attention message, 1/3
strikes, exit code 1 and recorded failure logs. Existing automated tests cover
three consecutive failures and explicit human recovery. Successful task and
feature settlement, preserved setup files, real Git trailers, both themes and
filtered empty states were verified in the preceding browser audit.

Browser screenshots are retained under `output/playwright/`, including
`acceptance-settled-light.png`, `acceptance-settled-dark-mobile.png`, and
`release-failure-evidence.png`. `git diff --check` is clean.

No publication or Git commit is required to run the delivered local product.
Start with `npm run hud`; README.md documents other-project setup, MCP and repair.
