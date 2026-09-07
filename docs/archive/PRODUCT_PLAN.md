# Product completion audit

Goal: finish VibeSync as a local Git-native coordination product, preserving its
light/dark control deck and pixel agent room.

Completion requires direct evidence for these workflows:

- [x] Install and initialize in a fresh or existing repository without losing configuration or user files.
- [x] Start dashboard alone or MCP plus dashboard; shut down cleanly; handle competing projects and processes.
- [x] Create a feature contract and scoped tasks from both human and agent entry points.
- [x] Park, promote, and discard ideas with persisted provenance.
- [x] Claim a task in a real isolated branch/worktree, release it, and show ownership and lease state.
- [x] Verify the actual task changes, enforce scope and gates, settle safely, and preserve developer edits.
- [x] Display live verification, failures, logs, circuit breakers, and settled provenance.
- [x] Settle feature contracts only after all task and holistic gates pass.
- [x] Recover durable project state from Git with honest limitations documented.
- [x] Provide useful empty, busy, success, failure, offline, and filtered states; keyboard-accessible dialogs and responsive layouts.
- [x] Explain setup, trust boundaries, everyday usage, and recovery in user documentation.
- [x] Pass automated tests and real-browser workflow checks in both themes and at narrow widths.

Earlier hardening work closed HTTP cross-origin access, hotfix command injection,
embedded-state injection, lifecycle reopening, and artifact traversal. That work
is progress toward this goal, not evidence that the whole product is complete.

## Hardening verification

Final regression run: 189 tests passed, zero failures. `git diff --check` and
`npm pack --dry-run` passed. Browser smoke checks confirmed the fresh-project
empty state, live connection, guide dialog and Escape dismissal, theme switching,
and no horizontal overflow at 390px. Screenshots are in `output/playwright/`.
The unchecked broader UX items remain release-audit work; these smoke checks
do not certify every user journey.

## Task handoff and human recovery

Managed worktrees now receive the shared context anchor with feature acceptance
criteria, holistic gate, task scope, task gates, base commit and lease expiry.
Human claim of a blocked task resets the breaker; ejecting an active agent renews
the human lease. `tests/task-workspace.test.mjs` verifies these behaviors and
preservation of unfinished files. The full 190-test run passed 189 tests; the new
recovery test initially omitted a required fixture milestone. After correcting
that fixture, both task-workspace tests passed. No production failure remained.

## Browser acceptance journey and first-run fixes

A fresh initialized repository was exercised through feature creation, task
creation, worktree claim, a real source edit, verification, task settlement, logs,
and feature settlement. The first attempt exposed runtime files becoming visible
when Git stashed the uncommitted setup .gitignore. Runtime patterns now also live
in Git's local info/exclude, including immediately before settlement for existing
projects. The retry settled both task and feature and preserved setup files.
A regression test verifies this exact first-run case.

Successful gates now retain stdout/stderr in their result, Git notes and a
content-addressed artifact linked from the gate-passed event. The background test
asserts that actual gate stdout can be read from that artifact.

Current full suite: **191 passed, zero failed**. Browser search with no matches,
light desktop and dark 390px layout also passed; no horizontal overflow. Rendered
evidence: output/playwright/acceptance-settled-light.png and
output/playwright/acceptance-settled-dark-mobile.png. Remaining browser audit:
incubator park/promote/discard, offline/reconnect, and failure recovery interaction.

## Completed release audit

See RELEASE_ACCEPTANCE.md for the final requirement-to-evidence record. The
current runner passed 198 tests. Incubator parking, promotion and discard, real
offline/reconnect behavior, and failing-gate messages/logs passed browser checks.
The reconnect fix also passed all six dashboard engine tests. Earlier outstanding
items above are historical findings resolved by this final audit.
