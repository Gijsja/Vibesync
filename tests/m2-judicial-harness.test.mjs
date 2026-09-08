/**
 * tests/m2-judicial-harness.test.mjs
 * 
 * Comprehensive Verification Suite for Milestone 2: Git Judicial Harness & Gatekeeper
 * Covers Features 15 through 26 across 12 targeted suites:
 * - Suite 1: Feature 15 — Path Whitelist Guard & Scope Jail
 * - Suite 2: Feature 16 — Shift-Left Gatekeeper Subprocess Runner
 * - Suite 3: Features 17 & 18 — Failure Tracking & 3-Strike Circuit Breaker
 * - Suite 4: Feature 19 — Failure Artifact Storage & SHA-256 Offloading
 * - Suite 5: Features 20 & 21 — In-Memory Conflict Detection (git merge-tree)
 * - Suite 6: Features 22 & 23 — Transactional Squash Settlement & RFC 2822 Trailers
 * - Suite 7: Feature 24 — Git Notes Provenance Stamping (refs/notes/vibesync)
 * - Suite 8: Feature 25 — Dirty Working Tree Preservation
 * - Suite 9: Feature 26 — Error Rollback & Abort Handling
 * - Suite 10: Unified verifyAndSettleTask Pipeline End-to-End
 * - Suite 11: Multi-Agent Concurrency & Worktree Isolation
 * - Suite 12: Adversarial Stress & Boundary Conditions
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { withSandbox, getCommitTrailers, getNotes } from './harness.mjs';
import { getDb, closeDb, saveArtifact, readArtifact } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, getTask } from '../src/tasks.mjs';
import {
  validatePathWhitelist,
  getChangedFiles,
  checkScopeBoundary,
  normalizePattern,
  normalizeFilePath,
  isTraversalViolation
} from '../src/guard.mjs';
import {
  runGateCommand,
  executeGates,
  executeRequiredGates,
  recordGateFailure,
  resetGateFailures,
  executeGatekeeper
} from '../src/gatekeeper.mjs';
import {
  simulateMergeTree,
  checkHeadlessMergeCollision,
  extractConflictFiles,
  parseMergeTreeOutput
} from '../src/merge.mjs';
import {
  formatCommitTrailers,
  appendGitNote,
  getGitNote,
  performSquashSettlement,
  rollbackSettlement,
  verifyAndSettleTask
} from '../src/settle.mjs';

// ============================================================================
// Suite 1: Feature 15 — Path Whitelist Guard & Scope Boundary Jail
// ============================================================================
describe('Suite 1: Feature 15 — Path Whitelist Guard & Scope Boundary Jail', () => {
  it('Case 1.1: Validates matching single glob pattern', () => {
    const res = validatePathWhitelist(['packages/shared/src/types.ts'], ['packages/shared/**']);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.violations.length, 0);
  });

  it('Case 1.2: Validates matching nested path under allowed directory', () => {
    const res = validatePathWhitelist(['src/deep/nested/sub/module.mjs'], ['src/**']);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.violations.length, 0);
  });

  it('Case 1.3: Rejects disallowed file outside allowed scope pattern', () => {
    const res = validatePathWhitelist(
      ['packages/shared/src/types.ts', 'packages/engine/math.ts'],
      ['packages/shared/**']
    );
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.violations, ['packages/engine/math.ts']);
    assert(res.error.includes('Scope Boundary Violation'));
  });

  it('Case 1.4: Rejects disallowed file extension under glob restriction', () => {
    const res = validatePathWhitelist(
      ['src/index.ts', 'src/config.json'],
      ['src/**/*.ts']
    );
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.violations, ['src/config.json']);
  });

  it('Case 1.5: Rejects directory traversal attempts escaping boundary', () => {
    assert.strictEqual(isTraversalViolation('../outside.txt'), true);
    assert.strictEqual(isTraversalViolation('packages/shared/../../secret.txt'), true);
    assert.strictEqual(isTraversalViolation('src/bar.mjs'), false);

    const res = validatePathWhitelist(['packages/shared/../../secret.txt'], ['packages/shared/**']);
    assert.strictEqual(res.valid, false);
    assert(res.error.includes('directory traversal attempt'));
  });

  it('Case 1.6: Universal wildcard permits all files', () => {
    const res = validatePathWhitelist(
      ['any/deep/path/file.mjs', 'root.txt', '.github/ci.yml'],
      ['*']
    );
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.violations.length, 0);
  });

  it('Case 1.7: Multiple glob patterns evaluate accurately', () => {
    const allowed = ['packages/shared/**', 'tests/shared/**'];
    const resValid = validatePathWhitelist(['packages/shared/foo.js', 'tests/shared/foo.test.js'], allowed);
    assert.strictEqual(resValid.valid, true);

    const resInvalid = validatePathWhitelist(['packages/engine/bar.js'], allowed);
    assert.strictEqual(resInvalid.valid, false);
    assert.deepStrictEqual(resInvalid.violations, ['packages/engine/bar.js']);
  });

  it('Case 1.8: Empty allowed paths rejects all modified files', () => {
    const res = validatePathWhitelist(['src/index.js'], []);
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.violations, ['src/index.js']);
  });

  it('Case 1.9: Discovers tracked diffs, staged files, and untracked files in sandbox', async () => {
    await withSandbox(async (sandbox) => {
      // Create initial baseline commit on main
      sandbox.commitFile('src/existing.js', '// v1', 'feat: initial existing file');
      const baseSha = sandbox.getHeadSha();

      // Create a task branch
      sandbox.createBranch('task/task-diff', 'main', true);

      // Commit one change
      sandbox.commitFile('src/committed.js', '// committed', 'feat: committed on task');

      // Create an unstaged edit
      fs.writeFileSync(path.join(sandbox.dir, 'src/existing.js'), '// v2 modified');

      // Create an untracked file
      fs.writeFileSync(path.join(sandbox.dir, 'src/untracked.js'), '// untracked');

      // Create internal harness artifact that should be ignored
      fs.writeFileSync(path.join(sandbox.dir, '.vibesync_ACTIVE_TASK.md'), '# Active Task');

      const changed = getChangedFiles(baseSha, sandbox.dir);
      assert(changed.includes('src/committed.js'));
      assert(changed.includes('src/existing.js'));
      assert(changed.includes('src/untracked.js'));
      assert(!changed.includes('.vibesync_ACTIVE_TASK.md'));
    });
  });
});

// ============================================================================
// Suite 2: Feature 16 — Shift-Left Gatekeeper Subprocess Runner
// ============================================================================
describe('Suite 2: Feature 16 — Shift-Left Gatekeeper Subprocess Runner', () => {
  it('Case 2.1: Single passing command returns OS exit code 0 and success', () => {
    const res = runGateCommand('node -e "process.exit(0)"');
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(res.exitCode, 0);
  });

  it('Case 2.2: Multiple passing gates execute in sequence', () => {
    const gates = [
      'node -e "process.exit(0)"',
      'node -e "console.log(\'gate 2\'); process.exit(0)"'
    ];
    const res = executeGates(gates);
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(res.gatesRun.length, 2);
    assert.strictEqual(res.gatesRun[0].exitCode, 0);
    assert.strictEqual(res.gatesRun[1].exitCode, 0);
  });

  it('Case 2.3: Failing gate command captures non-zero exit code and failure', () => {
    const res = runGateCommand('node -e "process.exit(2)"');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.exitCode, 2);
    assert(res.error.includes('2'));
  });

  it('Case 2.4: Short-circuit execution halts on first failing gate', async () => {
    await withSandbox(async (sandbox) => {
      const sentinelFile = path.join(sandbox.dir, 'should_not_exist.txt');
      const gates = [
        'node -e "process.exit(1)"',
        `node -e "fs.writeFileSync('${sentinelFile}', 'fail')"`
      ];
      const res = executeGates(gates, sandbox.dir);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.gatesRun.length, 0);
      assert.strictEqual(fs.existsSync(sentinelFile), false);
    });
  });

  it('Case 2.5: Captures stdout and stderr from failing process', () => {
    const res = runGateCommand('node -e "process.stderr.write(\'fatal compiler error\'); process.exit(1)"');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.stderr.trim(), 'fatal compiler error');
  });

  it('Case 2.6: Subprocess runner respects working directory cwd', async () => {
    await withSandbox(async (sandbox) => {
      const subDir = path.join(sandbox.dir, 'packages', 'testpkg');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'marker.json'), '{"ok":true}');

      const res = runGateCommand('node -e "process.exit(fs.existsSync(\'marker.json\') ? 0 : 1)"', subDir);
      assert.strictEqual(res.success, true, JSON.stringify(res));
      assert.strictEqual(res.exitCode, 0);
    });
  });

  it('Case 2.7: rejects unquoted shell operators and accepts argv arrays', () => {
    const rejected = runGateCommand('node -e process.exit(0) && echo injected');
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /shell operators/i);
    const accepted = runGateCommand(['node', '-e', 'process.exit(0)']);
    assert.equal(accepted.success, true, JSON.stringify(accepted));
  });
});

// ============================================================================
// Suite 3: Features 17 & 18 — Failure Tracking & 3-Strike Circuit Breaker
// ============================================================================
describe('Suite 3: Features 17 & 18 — Failure Tracking & 3-Strike Circuit Breaker', () => {
  it('Case 3.1 & 3.2: First and second failures increment strike counter in progress', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-CB1', title: 'CB Test', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-CB1', feature_id: 'FEAT-CB1', title: 'Task CB 1', max_failures: 3 }, db);

      // Strike 1
      const f1 = recordGateFailure(db, 'TASK-CB1', 'Gate error 1', { repoRoot: sandbox.dir });
      assert.strictEqual(f1.consecutive_failures, 1);
      assert.strictEqual(f1.status, 'in_progress');
      assert.strictEqual(f1.is_blocked, false);

      // Strike 2
      const f2 = recordGateFailure(db, 'TASK-CB1', 'Gate error 2', { repoRoot: sandbox.dir });
      assert.strictEqual(f2.consecutive_failures, 2);
      assert.strictEqual(f2.status, 'in_progress');
      assert.strictEqual(f2.is_blocked, false);

      const events = db.prepare('SELECT * FROM settlement_events WHERE task_id = ?').all('TASK-CB1');
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0].action, 'gate_failed');
      assert.strictEqual(events[1].action, 'gate_failed');
    });
  });

  it('Case 3.3: Third failure trips circuit breaker and transitions status to blocked', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-CB2', title: 'CB Trip Test', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-CB2', feature_id: 'FEAT-CB2', title: 'Task CB 2', max_failures: 3 }, db);

      recordGateFailure(db, 'TASK-CB2', 'Strike 1', { repoRoot: sandbox.dir });
      recordGateFailure(db, 'TASK-CB2', 'Strike 2', { repoRoot: sandbox.dir });
      const f3 = recordGateFailure(db, 'TASK-CB2', 'Strike 3', { repoRoot: sandbox.dir });

      assert.strictEqual(f3.consecutive_failures, 3);
      assert.strictEqual(f3.status, 'blocked');
      assert.strictEqual(f3.is_blocked, true);

      const task = getTask('TASK-CB2', db);
      assert.strictEqual(task.status, 'blocked');
      assert.strictEqual(task.consecutive_failures, 3);

      const lastEvent = db.prepare('SELECT * FROM settlement_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').get('TASK-CB2');
      assert.strictEqual(lastEvent.action, 'circuit_breaker_tripped');
    });
  });

  it('Case 3.4: Blocked task locks branch and rejects automated AI claims', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-CB3', title: 'Lock Test', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-CB3', feature_id: 'FEAT-CB3', title: 'Task CB 3', max_failures: 1 }, db);

      // Trip circuit breaker
      recordGateFailure(db, 'TASK-CB3', 'Fatal compiler error', { repoRoot: sandbox.dir });

      // AI agent attempt to claim must throw
      assert.throws(
        () => claimTask({ taskId: 'TASK-CB3', actorName: 'gemini-antigravity' }, db, sandbox.dir),
        /blocked by circuit breaker/i
      );

      // Human can still intervene
      const humanClaim = claimTask({ taskId: 'TASK-CB3', actorName: 'human' }, db, sandbox.dir);
      assert.strictEqual(humanClaim.success, true);
    });
  });

  it('Case 3.5: Clean gate pass resets failure counter and records gate_passed', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-CB4', title: 'Reset Test', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-CB4', feature_id: 'FEAT-CB4', title: 'Task CB 4', max_failures: 3 }, db);

      recordGateFailure(db, 'TASK-CB4', 'Temp error 1', { repoRoot: sandbox.dir });
      recordGateFailure(db, 'TASK-CB4', 'Temp error 2', { repoRoot: sandbox.dir });

      const taskMid = getTask('TASK-CB4', db);
      assert.strictEqual(taskMid.consecutive_failures, 2);

      resetGateFailures(db, 'TASK-CB4', { repoRoot: sandbox.dir, gatesRun: [{ cmd: 'npm test', exitCode: 0 }] });

      const taskAfter = getTask('TASK-CB4', db);
      assert.strictEqual(taskAfter.consecutive_failures, 0);

      const passEvent = db.prepare('SELECT * FROM settlement_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').get('TASK-CB4');
      assert.strictEqual(passEvent.action, 'gate_passed');
    });
  });

  it('Case 3.6: Configurable max_failures threshold trips appropriately', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-CB5', title: 'Custom Threshold', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-CB5', feature_id: 'FEAT-CB5', title: 'Task CB 5', max_failures: 2 }, db);

      recordGateFailure(db, 'TASK-CB5', 'Fail 1', { repoRoot: sandbox.dir });
      const f2 = recordGateFailure(db, 'TASK-CB5', 'Fail 2', { repoRoot: sandbox.dir });

      assert.strictEqual(f2.consecutive_failures, 2);
      assert.strictEqual(f2.is_blocked, true);
      assert.strictEqual(f2.status, 'blocked');
    });
  });
});

// ============================================================================
// Suite 4: Feature 19 — Failure Artifact Storage & SHA-256 Offloading
// ============================================================================
describe('Suite 4: Feature 19 — Failure Artifact Storage & SHA-256 Offloading', () => {
  it('Case 4.1 & 4.2: Computes 12-char SHA-256 hash and writes .vibesync/artifacts/<hash>.log', async () => {
    await withSandbox(async (sandbox) => {
      const errorContent = 'Compiler error: SyntaxError on line 42\nStack trace: ...';
      const hash = saveArtifact(errorContent, sandbox.dir);

      assert.strictEqual(typeof hash, 'string');
      assert.strictEqual(hash.length, 12);

      const expectedPath = path.join(sandbox.dir, '.vibesync', 'artifacts', `${hash}.log`);
      assert(fs.existsSync(expectedPath));
      assert.strictEqual(fs.readFileSync(expectedPath, 'utf8'), errorContent);
    });
  });

  it('Case 4.3: Reads artifact content back via readArtifact', async () => {
    await withSandbox(async (sandbox) => {
      const errorText = 'Panic: index out of bounds at module.mjs:10:5';
      const hash = saveArtifact(errorText, sandbox.dir);
      const readBack = readArtifact(hash, sandbox.dir);
      assert.strictEqual(readBack, errorText);
    });
  });

  it('Case 4.4: Ledger event records artifact hash reference', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-ART', title: 'Artifact Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-ART', feature_id: 'FEAT-ART', title: 'Task Artifact' }, db);

      const failInfo = recordGateFailure(db, 'TASK-ART', 'Detailed compiler dump...', { repoRoot: sandbox.dir });
      assert(failInfo.artifactHash);

      const event = db.prepare('SELECT * FROM settlement_events WHERE task_id = ?').get('TASK-ART');
      assert.strictEqual(event.artifact_hash, failInfo.artifactHash);
    });
  });

  it('Case 4.5: Offloads large error payload (500KB) without bloating SQLite database', async () => {
    await withSandbox(async (sandbox) => {
      const largePayload = 'A'.repeat(500 * 1024);
      const hash = saveArtifact(largePayload, sandbox.dir);
      const readBack = readArtifact(hash, sandbox.dir);
      assert.strictEqual(readBack.length, 500 * 1024);
    });
  });
});

// ============================================================================
// Suite 5: Features 20 & 21 — In-Memory Collision Detection (git merge-tree)
// ============================================================================
describe('Suite 5: Features 20 & 21 — In-Memory Collision Detection (git merge-tree)', () => {
  it('Case 5.1: Clean in-memory merge reports clean and returns treeSha', async () => {
    await withSandbox(async (sandbox) => {
      // Base file on main
      sandbox.commitFile('base.txt', 'base content', 'feat: add base file');

      // Create branch A modifying fileA
      sandbox.createBranch('task/clean-a', 'main', false);
      sandbox.checkout('task/clean-a');
      sandbox.commitFile('fileA.txt', 'file A content', 'feat: add file A');

      // Return to main and modify fileB
      sandbox.checkout('main');
      sandbox.commitFile('fileB.txt', 'file B content', 'feat: add file B');

      const sim = simulateMergeTree('main', 'task/clean-a', sandbox.dir);
      assert.strictEqual(sim.clean, true);
      assert.strictEqual(sim.conflict, false);
      assert.strictEqual(sim.safe, true);
      assert(/^[0-9a-f]{40}$/i.test(sim.treeSha));
      assert.strictEqual(sim.conflictFiles.length, 0);
    });
  });

  it('Case 5.2: In-memory conflict detection catches collisions on identical files', async () => {
    await withSandbox(async (sandbox) => {
      sandbox.commitFile('shared.txt', 'line 1: original\nline 2: original', 'feat: shared file');

      // Create branch A modifying line 1
      sandbox.createBranch('task/conflict-a', 'main', false);
      sandbox.checkout('task/conflict-a');
      sandbox.commitFile('shared.txt', 'line 1: modified by A\nline 2: original', 'feat: branch A edit');

      // Modify line 1 differently on main
      sandbox.checkout('main');
      sandbox.commitFile('shared.txt', 'line 1: modified by MAIN\nline 2: original', 'feat: main edit');

      const sim = simulateMergeTree('main', 'task/conflict-a', sandbox.dir);
      assert.strictEqual(sim.clean, false);
      assert.strictEqual(sim.conflict, true);
      assert.strictEqual(sim.safe, false);
      assert(sim.conflictFiles.includes('shared.txt'));
    });
  });

  it('Case 5.3: Zero disk changes occur during collision detection', async () => {
    await withSandbox(async (sandbox) => {
      sandbox.commitFile('app.js', 'console.log(1);', 'feat: init app');

      sandbox.createBranch('task/disk-check', 'main', false);
      sandbox.checkout('task/disk-check');
      sandbox.commitFile('app.js', 'console.log("task");', 'feat: task edit');

      sandbox.checkout('main');
      sandbox.commitFile('app.js', 'console.log("main");', 'feat: main edit');

      const headBefore = sandbox.getHeadSha();
      const contentBefore = fs.readFileSync(path.join(sandbox.dir, 'app.js'), 'utf8');

      // Run collision simulation
      const sim = simulateMergeTree('main', 'task/disk-check', sandbox.dir);
      assert.strictEqual(sim.conflict, true);

      // Verify zero changes to disk or git status
      const headAfter = sandbox.getHeadSha();
      const contentAfter = fs.readFileSync(path.join(sandbox.dir, 'app.js'), 'utf8');
      assert.strictEqual(headBefore, headAfter);
      assert.strictEqual(contentBefore, contentAfter);
      assert.strictEqual(sandbox.isWorkingTreeClean(), true);
    });
  });

  it('Case 5.4: extractConflictFiles parses stage lines and conflict markers', () => {
    const sampleOutput = `100644 ce013625030ba8dba906f756967f9e9ca394464a 1\tsrc/app.js
100644 4257344d31a5945a3073c265f1052d2dfadcfa25 2\tsrc/app.js
100644 ab49a57d2557f98505582142ad7629689b8f763d 3\tsrc/app.js
Auto-merging src/app.js
CONFLICT (content): Merge conflict in src/app.js
CONFLICT (modify/delete): config.json deleted in task and modified in main`;

    const files = extractConflictFiles(sampleOutput);
    assert(files.includes('src/app.js'));
    assert(files.includes('config.json'));
  });

  it('Case 5.5: checkHeadlessMergeCollision convenience helper returns structured collision info', async () => {
    await withSandbox(async (sandbox) => {
      sandbox.commitFile('conflict.txt', 'base', 'feat: base');
      sandbox.createBranch('task/helper-test', 'main', false);
      sandbox.checkout('task/helper-test');
      sandbox.commitFile('conflict.txt', 'task-edit', 'feat: task edit');
      sandbox.checkout('main');
      sandbox.commitFile('conflict.txt', 'main-edit', 'feat: main edit');

      const res = checkHeadlessMergeCollision('main', 'task/helper-test', sandbox.dir);
      assert.strictEqual(res.safe, false);
      assert.strictEqual(res.conflict, true);
      assert(res.conflictFiles.includes('conflict.txt'));
    });
  });
});

// ============================================================================
// Suite 6: Features 22 & 23 — Transactional Squash Settlement & RFC 2822 Trailers
// ============================================================================
describe('Suite 6: Features 22 & 23 — Transactional Squash Settlement & RFC 2822 Trailers', () => {
  it('Case 6.1 & 6.2: Squashes intermediate commits into single linear parent commit', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-SQ1', title: 'Squash Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-SQ1', feature_id: 'FEAT-SQ1', title: 'Squash Task 1' }, db);

      const claim = claimTask({ taskId: 'TASK-SQ1', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      assert.strictEqual(claim.success, true);

      // Create 3 commits on task branch
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/step1.js', '// step 1', 'chore: step 1');
      sandbox.commitFile('src/step2.js', '// step 2', 'chore: step 2');
      sandbox.commitFile('src/step3.js', '// step 3', 'chore: step 3');

      sandbox.checkout('main');
      const mainCommitsBefore = parseInt(sandbox.execGit('git rev-list --count HEAD'), 10);

      const settleRes = performSquashSettlement({
        taskId: 'TASK-SQ1',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      assert.strictEqual(settleRes.success, true);

      const mainCommitsAfter = parseInt(sandbox.execGit('git rev-list --count HEAD'), 10);
      assert.strictEqual(mainCommitsAfter, mainCommitsBefore + 1);

      // Verify single parent commit (linear, not merge commit)
      const parentCount = sandbox.execGit('git rev-list --parents -n 1 HEAD').trim().split(/\s+/).length - 1;
      assert.strictEqual(parentCount, 1);
    });
  });

  it('Case 6.3: Injects complete RFC 2822 commit trailers', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-TR1', title: 'Trailer Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-TR1', feature_id: 'FEAT-TR1', title: 'Trailer Task 1', required_gates: ['npm test'] }, db);

      const claim = claimTask({ taskId: 'TASK-TR1', actorName: 'openai-codex' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/trailer.js', '// trailer', 'feat: trailer test');
      sandbox.checkout('main');

      performSquashSettlement({
        taskId: 'TASK-TR1',
        actorName: 'openai-codex',
        repoRoot: sandbox.dir,
        db,
        gateLogs: [{ cmd: 'npm test', exitCode: 0 }]
      });

      const trailers = getCommitTrailers(sandbox.dir, 'HEAD');
      assert.strictEqual(trailers['Task-Id'], 'TASK-TR1');
      assert.strictEqual(trailers['Feature-Id'], 'FEAT-TR1');
      assert.strictEqual(trailers['Agent-Actor'], 'openai-codex');
      assert(trailers['Base-Commit']);
      assert(trailers['Gate-Verification'].includes('npm test'));
      assert.strictEqual(trailers['Signed-Off-By'], 'VibeSync Engine <engine@local>');
    });
  });

  it('Case 6.4: Deletes ephemeral task branch after settlement', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-BR1', title: 'Branch Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-BR1', feature_id: 'FEAT-BR1', title: 'Branch Task' }, db);

      const claim = claimTask({ taskId: 'TASK-BR1', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/b.js', '// b', 'feat: b');
      sandbox.checkout('main');

      performSquashSettlement({
        taskId: 'TASK-BR1',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      // Branch should no longer exist
      const branches = sandbox.execGit('git branch --list');
      assert(!branches.includes(claim.task.branch_name));
    });
  });

  it('Case 6.5: Updates task in SQLite to settled with settled_commit SHA', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-DB1', title: 'DB Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-DB1', feature_id: 'FEAT-DB1', title: 'DB Task' }, db);

      const claim = claimTask({ taskId: 'TASK-DB1', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/dbcheck.js', '// db', 'feat: db');
      sandbox.checkout('main');

      const res = performSquashSettlement({
        taskId: 'TASK-DB1',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      const task = getTask('TASK-DB1', db);
      assert.strictEqual(task.status, 'settled');
      assert.strictEqual(task.settled_commit, res.settledSha);
      assert.strictEqual(task.consecutive_failures, 0);
    });
  });
});

// ============================================================================
// Suite 7: Feature 24 — Git Notes Provenance Stamping (refs/notes/vibesync)
// ============================================================================
describe('Suite 7: Feature 24 — Git Notes Provenance Stamping (refs/notes/vibesync)', () => {
  it('Case 7.1 & 7.2: Git note attached to settled commit SHA and contains valid structured JSON', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-NT1', title: 'Note Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-NT1', feature_id: 'FEAT-NT1', title: 'Note Task' }, db);

      const claim = claimTask({ taskId: 'TASK-NT1', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/note.js', '// note', 'feat: note');
      sandbox.checkout('main');

      const res = performSquashSettlement({
        taskId: 'TASK-NT1',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db,
        gateLogs: [{ cmd: 'pnpm test', exitCode: 0 }]
      });

      const note = getGitNote(res.settledSha, sandbox.dir);
      assert(note, 'Git note must be attached');
      assert.strictEqual(note.taskId, 'TASK-NT1');
      assert.strictEqual(note.featureId, 'FEAT-NT1');
      assert.strictEqual(note.actor, 'gemini-antigravity');
      assert.strictEqual(note.status, 'PASS');
      assert(Array.isArray(note.gates));
      assert(note.settledAt);
    });
  });

  it('Case 7.3: Commit message remains clean without log pollution', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-NT2', title: 'Clean Log Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-NT2', feature_id: 'FEAT-NT2', title: 'Clean Log Task' }, db);

      const claim = claimTask({ taskId: 'TASK-NT2', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/clean.js', '// clean', 'feat: clean');
      sandbox.checkout('main');

      performSquashSettlement({
        taskId: 'TASK-NT2',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db,
        gateLogs: [{ cmd: 'npm test', exitCode: 0 }]
      });

      const fullLog = sandbox.execGit('git log -1 --pretty=%B');
      assert(!fullLog.includes('{'), 'Commit log should not contain raw JSON payload');
      assert(fullLog.includes('Task-Id: TASK-NT2'));
    });
  });
});

// ============================================================================
// Suite 8: Feature 25 — Dirty Working Tree Preservation
// ============================================================================
describe('Suite 8: Feature 25 — Dirty Working Tree Preservation', () => {
  it('Case 8.1: Preserves untracked developer scratch files on main', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-WT1', title: 'WT Feature 1', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-WT1', feature_id: 'FEAT-WT1', title: 'WT Task 1' }, db);

      const claim = claimTask({ taskId: 'TASK-WT1', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/agentfile.js', '// agent', 'feat: agent change');
      sandbox.checkout('main');

      // Developer has an untracked scratch file on main
      const scratchPath = path.join(sandbox.dir, 'scratch.txt');
      fs.writeFileSync(scratchPath, 'my uncommitted scratch notes');

      performSquashSettlement({
        taskId: 'TASK-WT1',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      // Scratch file must still exist with identical content
      assert(fs.existsSync(scratchPath));
      assert.strictEqual(fs.readFileSync(scratchPath, 'utf8'), 'my uncommitted scratch notes');
    });
  });

  it('Case 8.2: Preserves unstaged modifications to tracked files on main', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-WT2', title: 'WT Feature 2', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-WT2', feature_id: 'FEAT-WT2', title: 'WT Task 2' }, db);

      // Create tracked file on main
      sandbox.commitFile('docs/guide.md', '# Original Guide', 'docs: init guide');

      const claim = claimTask({ taskId: 'TASK-WT2', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/feature.js', '// feature', 'feat: feature');
      sandbox.checkout('main');

      // Developer modifies docs/guide.md without staging
      const guidePath = path.join(sandbox.dir, 'docs', 'guide.md');
      fs.writeFileSync(guidePath, '# Modified Guide (developer draft)');

      performSquashSettlement({
        taskId: 'TASK-WT2',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      // Developer edit must be preserved
      assert.strictEqual(fs.readFileSync(guidePath, 'utf8'), '# Modified Guide (developer draft)');
    });
  });

  it('Case 8.3: Rejects settlement pre-flight if uncommitted edits overlap with task files', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-WT3', title: 'WT Feature 3', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-WT3', feature_id: 'FEAT-WT3', title: 'WT Task 3' }, db);

      sandbox.commitFile('src/shared_code.js', '// original', 'feat: shared code');

      const claim = claimTask({ taskId: 'TASK-WT3', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/shared_code.js', '// agent modified', 'feat: agent change');
      sandbox.checkout('main');

      // Developer modified the EXACT SAME file on main without committing
      fs.writeFileSync(path.join(sandbox.dir, 'src', 'shared_code.js'), '// developer modified');

      assert.throws(
        () => performSquashSettlement({
          taskId: 'TASK-WT3',
          actorName: 'gemini-antigravity',
          repoRoot: sandbox.dir,
          db
        }),
        (err) => {
          return err.phase === 'WORKING_TREE_CONFLICT' || err.message.includes('overlapping with task changes');
        }
      );
    });
  });
});

// ============================================================================
// Suite 9: Feature 26 — Error Rollback & Abort Handling
// ============================================================================
describe('Suite 9: Feature 26 — Error Rollback & Abort Handling', () => {
  it('Case 9.1 & 9.2: Aborts merge cleanly on error and restores main HEAD', async () => {
    await withSandbox(async (sandbox) => {
      const headBefore = sandbox.getHeadSha();

      // Trigger rollbackSettlement
      rollbackSettlement(sandbox.dir, { didStash: false }, 'main');

      const headAfter = sandbox.getHeadSha();
      assert.strictEqual(headBefore, headAfter);
      assert.strictEqual(sandbox.isWorkingTreeClean(), true);
    });
  });

  it('Case 9.3: Leaves zero MERGE_HEAD or intermediate merge debris', async () => {
    await withSandbox(async (sandbox) => {
      rollbackSettlement(sandbox.dir, null, 'main');
      const gitDir = path.join(sandbox.dir, '.git');
      assert(!fs.existsSync(path.join(gitDir, 'MERGE_HEAD')));
      assert(!fs.existsSync(path.join(gitDir, 'MERGE_MSG')));
    });
  });
});

// ============================================================================
// Suite 10: Unified verifyAndSettleTask Pipeline End-to-End
// ============================================================================
describe('Suite 10: Unified verifyAndSettleTask Pipeline End-to-End', () => {
  it('Case 10.1: Full happy path runs Stages A -> B -> C -> D and marks task settled', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-E2E1', title: 'E2E Feature 1', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({
        id: 'TASK-E2E1',
        feature_id: 'FEAT-E2E1',
        title: 'E2E Task 1',
        allowed_paths: ['src/**'],
        required_gates: ['node -e "process.exit(0)"']
      }, db);

      const claim = claimTask({ taskId: 'TASK-E2E1', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/feature1.js', 'export const a = 1;', 'feat: implement feature 1');
      sandbox.checkout('main');

      const res = verifyAndSettleTask({
        taskId: 'TASK-E2E1',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      assert.strictEqual(res.success, true, JSON.stringify(res));
      assert.strictEqual(res.phase, 'SETTLED');
      assert(res.settledSha);

      const task = getTask('TASK-E2E1', db);
      assert.strictEqual(task.status, 'settled');
      assert.strictEqual(task.settled_commit, res.settledSha);
    });
  });

  it('Case 10.2: Halts at Stage A on Scope Violation without running gates', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-E2E2', title: 'E2E Feature 2', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({
        id: 'TASK-E2E2',
        feature_id: 'FEAT-E2E2',
        title: 'E2E Scope Violation Task',
        allowed_paths: ['src/**'],
        required_gates: ['node -e "fs.writeFileSync(\'gate_ran.txt\', \'x\') ; process.exit(0)"']
      }, db);

      const claim = claimTask({ taskId: 'TASK-E2E2', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      // Out of scope edit
      sandbox.commitFile('packages/engine/math.ts', '// out of scope', 'feat: out of scope');
      sandbox.checkout('main');

      const res = verifyAndSettleTask({
        taskId: 'TASK-E2E2',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.phase, 'SCOPE_VIOLATION');
      assert(res.violations.includes('packages/engine/math.ts'));

      // Verify gates did NOT run
      assert(!fs.existsSync(path.join(sandbox.dir, 'gate_ran.txt')));

      // Consecutive failures incremented
      const task = getTask('TASK-E2E2', db);
      assert.strictEqual(task.consecutive_failures, 1);
    });
  });

  it('Case 10.3: Halts at Stage B on Gate Failure without merging', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-E2E3', title: 'E2E Feature 3', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({
        id: 'TASK-E2E3',
        feature_id: 'FEAT-E2E3',
        title: 'E2E Gate Failure Task',
        allowed_paths: ['src/**'],
        required_gates: ['node -e "process.exit(1)"']
      }, db);

      const claim = claimTask({ taskId: 'TASK-E2E3', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/f3.js', '// f3', 'feat: f3');
      sandbox.checkout('main');

      const res = verifyAndSettleTask({
        taskId: 'TASK-E2E3',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.phase, 'GATE_FAILURE');
      assert(res.error);

      // Verify not merged to main
      assert(!fs.existsSync(path.join(sandbox.dir, 'src', 'f3.js')));
    });
  });

  it('Case 10.4: Halts at Stage C on Merge Collision without touching main', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-E2E4', title: 'E2E Feature 4', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({
        id: 'TASK-E2E4',
        feature_id: 'FEAT-E2E4',
        title: 'E2E Collision Task',
        allowed_paths: ['*'],
        required_gates: []
      }, db);

      sandbox.commitFile('src/conflict.js', 'line 1: original', 'feat: init conflict file');

      const claim = claimTask({ taskId: 'TASK-E2E4', actorName: 'gemini-antigravity' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/conflict.js', 'line 1: task edit', 'feat: task edit');

      // Conflicting edit on main
      sandbox.checkout('main');
      sandbox.commitFile('src/conflict.js', 'line 1: main edit', 'feat: main edit');

      const res = verifyAndSettleTask({
        taskId: 'TASK-E2E4',
        actorName: 'gemini-antigravity',
        repoRoot: sandbox.dir,
        db
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.phase, 'MERGE_COLLISION');
      assert(res.conflictFiles.includes('src/conflict.js'));

      // Main must be clean
      assert.strictEqual(sandbox.isWorkingTreeClean(), true);
    });
  });
});

// ============================================================================
// Suite 11: Multi-Agent Concurrency & Worktree Isolation
// ============================================================================
describe('Suite 11: Multi-Agent Concurrency & Worktree Isolation', () => {
  it('Case 11.1: Two agents work in separate worktrees on orthogonal tasks and settle cleanly', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-MA1', title: 'Multi-Agent Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-MA1', feature_id: 'FEAT-MA1', title: 'Agent 1 Task', allowed_paths: ['packages/shared/**'] }, db);
      createTask({ id: 'TASK-MA2', feature_id: 'FEAT-MA1', title: 'Agent 2 Task', allowed_paths: ['packages/engine/**'] }, db);

      // Setup worktrees for antigravity and codex
      const wt1 = sandbox.createWorktree('.vibesync/worktrees/antigravity', 'task/task-ma1', 'main');
      const wt2 = sandbox.createWorktree('.vibesync/worktrees/codex', 'task/task-ma2', 'main');

      claimTask({ taskId: 'TASK-MA1', actorName: 'antigravity', worktreePath: wt1 }, db, sandbox.dir);
      claimTask({ taskId: 'TASK-MA2', actorName: 'codex', worktreePath: wt2 }, db, sandbox.dir);

      // Antigravity writes to packages/shared
      const f1 = path.join(wt1, 'packages', 'shared', 'model.ts');
      fs.mkdirSync(path.dirname(f1), { recursive: true });
      fs.writeFileSync(f1, 'export const MODEL = 1;');

      // Codex writes to packages/engine
      const f2 = path.join(wt2, 'packages', 'engine', 'renderer.ts');
      fs.mkdirSync(path.dirname(f2), { recursive: true });
      fs.writeFileSync(f2, 'export const RENDERER = 2;');

      // Settle Agent 1
      const res1 = verifyAndSettleTask({
        taskId: 'TASK-MA1',
        actorName: 'antigravity',
        worktreePath: wt1,
        repoRoot: sandbox.dir,
        db
      });
      assert.strictEqual(res1.success, true, JSON.stringify(res1));
      assert.strictEqual(res1.phase, 'SETTLED');

      // Settle Agent 2
      const res2 = verifyAndSettleTask({
        taskId: 'TASK-MA2',
        actorName: 'codex',
        worktreePath: wt2,
        repoRoot: sandbox.dir,
        db
      });
      assert.strictEqual(res2.success, true, JSON.stringify(res2));
      assert.strictEqual(res2.phase, 'SETTLED');

      // Verify main has both files
      assert(fs.existsSync(path.join(sandbox.dir, 'packages', 'shared', 'model.ts')));
      assert(fs.existsSync(path.join(sandbox.dir, 'packages', 'engine', 'renderer.ts')));
    });
  });

  it('Case 11.2: Detaches worktree HEAD before branch deletion to avoid branch lock error', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-DLK', title: 'Deletion Lock Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-DLK', feature_id: 'FEAT-DLK', title: 'Deletion Lock Task', allowed_paths: ['*'] }, db);

      const wt = sandbox.createWorktree('.vibesync/worktrees/agent', 'task/task-dlk', 'main');
      claimTask({ taskId: 'TASK-DLK', actorName: 'agent', worktreePath: wt }, db, sandbox.dir);

      fs.writeFileSync(path.join(wt, 'test.txt'), 'hello');

      const res = verifyAndSettleTask({
        taskId: 'TASK-DLK',
        actorName: 'agent',
        worktreePath: wt,
        repoRoot: sandbox.dir,
        db
      });

      assert.strictEqual(res.success, true, JSON.stringify(res));
      // Branch was cleanly deleted because HEAD was detached
      const branches = sandbox.execGit('git branch --list');
      assert(!branches.includes('task/task-dlk'));
    });
  });
});

// ============================================================================
// Suite 12: Adversarial Stress & Boundary Conditions
// ============================================================================
describe('Suite 12: Adversarial Stress & Boundary Conditions', () => {
  it('Case 12.1: Empty required gates settles immediately without running gates', async () => {
    await withSandbox(async (sandbox) => {
      const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
      createFeature({ id: 'FEAT-EMP', title: 'Empty Gates Feature', target_milestone: 'M2', spec_markdown: '# spec' }, db);
      createTask({ id: 'TASK-EMP', feature_id: 'FEAT-EMP', title: 'Empty Gates Task', required_gates: [] }, db);

      const claim = claimTask({ taskId: 'TASK-EMP', actorName: 'agent' }, db, sandbox.dir);
      sandbox.createBranch(claim.task.branch_name, 'main', true);
      sandbox.commitFile('src/emp.js', '// empty', 'feat: empty');
      sandbox.checkout('main');

      const res = verifyAndSettleTask({
        taskId: 'TASK-EMP',
        actorName: 'agent',
        repoRoot: sandbox.dir,
        db
      });

      assert.strictEqual(res.success, true, JSON.stringify(res));
      assert.strictEqual(res.phase, 'SETTLED');
    });
  });

  it('Case 12.2: Gate command timeout triggers failure and is recorded', () => {
    // node script that sleeps for 2000ms with timeoutMs = 200ms
    const res = runGateCommand('node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)"', process.cwd(), {
      timeoutMs: 200
    });
    assert.strictEqual(res.success, false);
    assert(res.error.includes('timed out'));
  });

  it('Case 12.3: Special characters in task title and body format safely into commit trailers', () => {
    const msg = formatCommitTrailers({
      title: 'Fix "bug" in O\'Reilly parser: <foo & bar> [v1]',
      taskId: 'TASK-ESC',
      featureId: 'FEAT-ESC',
      actorName: 'agent-47',
      baseCommit: '1234567',
      body: 'Multiple\nlines\nwith "quotes" and `backticks`.'
    });

    assert(msg.includes('Fix "bug" in O\'Reilly parser: <foo & bar> [v1]'));
    assert(msg.includes('Task-Id: TASK-ESC'));
    assert(msg.includes('Feature-Id: FEAT-ESC'));
    assert(msg.includes('Agent-Actor: agent-47'));
    assert(msg.includes('Base-Commit: 1234567'));
    assert(msg.includes('Gate-Verification: PASS (all gates passed)'));
    assert(msg.includes('Signed-Off-By: VibeSync Engine <engine@local>'));
  });
});
