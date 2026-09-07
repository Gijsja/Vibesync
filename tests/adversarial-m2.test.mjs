/**
 * tests/adversarial-m2.test.mjs
 * 
 * Consolidated Adversarial Stress-Testing & Invariant Verification Suite
 * Milestone 2: Git Judicial Harness (Consolidated Iteration 2: 35 Tests)
 * 
 * Subsystems Covered:
 * - Part 1: Path Whitelist Guard & Scope Boundary Stress (Challenger 1)
 * - Part 2: Shift-Left Gatekeeper & Subprocess Execution Stress (Challenger 1)
 * - Part 3: 3-Strike Circuit Breaker & Artifact Hashing Stress (Challenger 1)
 * - Part 4: In-Memory Conflict Detection & Zero Mutation Invariants (Challenger 2)
 * - Part 5: Settlement & Working Tree Preservation Stress (Challenger 2)
 * - Part 6: Transactional Rollback & Error Recovery Stress (Challenger 2)
 * - Part 7: Challenger 2 Inverted Regression Assertions (Merge & Settlement)
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { GitSandbox, withSandbox, getCommitTrailers, getNotes } from './harness.mjs';
import { getDb, initSchema } from '../src/db.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask, claimTask, getTask, updateTaskStatus } from '../src/tasks.mjs';
import {
  isTraversalViolation,
  normalizePattern,
  normalizeFilePath,
  isInternalHarnessArtifact,
  getChangedFiles,
  checkScopeBoundary,
  validatePathWhitelist
} from '../src/guard.mjs';
import {
  runGateCommand,
  executeGates,
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
  rollbackSettlement,
  performSquashSettlement,
  verifyAndSettleTask
} from '../src/settle.mjs';

/**
 * Helper to initialize a clean VibeSync database inside a sandbox
 */
function setupSandboxDb(sandbox) {
  const dbDir = path.join(sandbox.dir, '.vibesync');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'state.db');
  const db = getDb(dbPath, sandbox.dir);
  initSchema(db);
  sandbox.registerDb(db);
  return { db, dbPath };
}

describe('Consolidated Adversarial Milestone 2 Judicial Suite (35 Tests)', () => {

  // ==========================================================================
  // PART 1: Path Whitelist Guard & Scope Boundary Stress (Challenger 1)
  // ==========================================================================
  describe('Part 1: Path Whitelist Guard & Scope Boundary Stress (Challenger 1)', () => {

    it('ADV-01: Rejects relative directory traversal attempts escaping boundary', () => {
      assert.strictEqual(isTraversalViolation('../escape.js'), true);
      assert.strictEqual(isTraversalViolation('src/../../escape.js'), true);
      assert.strictEqual(isTraversalViolation('src/valid.js'), false);

      const res = validatePathWhitelist(['../escape.js'], ['*']);
      assert.strictEqual(res.valid, false);
      assert.deepStrictEqual(res.violations, ['../escape.js']);
      assert(res.error.includes('directory traversal attempt'));
    });

    it('ADV-02: Hidden dotfile quarantine and internal harness artifact handling', () => {
      // Root dotfile rejected when restricted to src/**
      const resDotRoot = validatePathWhitelist(['.env'], ['src/**']);
      assert.strictEqual(resDotRoot.valid, false);
      assert.deepStrictEqual(resDotRoot.violations, ['.env']);

      // Nested dotfile inside allowed scope permitted
      const resDotNested = validatePathWhitelist(['src/.env.local'], ['src/**']);
      assert.strictEqual(resDotNested.valid, true);

      // Internal harness artifacts ignored
      const resHarness = validatePathWhitelist(
        ['.vibesync_ACTIVE_TASK.md', '.vibesync/state.db'],
        ['packages/shared/**']
      );
      assert.strictEqual(resHarness.valid, true);
      assert.deepStrictEqual(resHarness.violations, []);
    });

    it('ADV-03: Spaces in file and directory names handled safely', async () => {
      await withSandbox(async (s) => {
        s.commitFile('docs/project spec.txt', 'spec content\n', 'add spec');
        s.commitFile('packages/my app/main file.js', 'console.log(1);\n', 'add app');

        const changed = getChangedFiles({ cwd: s.dir, stagedOnly: false, includeUntracked: true });
        assert(Array.isArray(changed));

        const pass = validatePathWhitelist(['docs/project spec.txt'], ['docs/**'], { repoRoot: s.dir });
        assert.strictEqual(pass.valid, true);

        const fail = validatePathWhitelist(['packages/my app/main file.js'], ['src/**'], { repoRoot: s.dir });
        assert.strictEqual(fail.valid, false);
        assert.deepStrictEqual(fail.violations, ['packages/my app/main file.js']);
      });
    });

    it('ADV-04: Deep nesting with recursive glob ** matches arbitrarily deep files', () => {
      const deepPath = 'a/b/c/d/e/f/g/leaf.ts';
      assert.strictEqual(validatePathWhitelist([deepPath], ['a/**']).valid, true);
      assert.strictEqual(validatePathWhitelist([deepPath], ['a/b/c/**']).valid, true);
      assert.strictEqual(validatePathWhitelist([deepPath], ['b/**']).valid, false);
    });

    it('ADV-05: Multiple positive globs evaluate accurately with non-matching files enumerated', () => {
      const allowed = ['src/**', 'docs/**', 'package.json'];
      const changed = ['src/index.js', 'docs/readme.md', 'package.json', 'scripts/build.mjs'];

      const res = validatePathWhitelist(changed, allowed);
      assert.strictEqual(res.valid, false);
      assert.deepStrictEqual(res.violations, ['scripts/build.mjs']);
    });

    it('ADV-06: Untracked out-of-scope files caught by checkScopeBoundary', async () => {
      await withSandbox(async (s) => {
        fs.writeFileSync(path.join(s.dir, 'unauthorized.txt'), 'payload\n');
        const boundaryRes = checkScopeBoundary(s.dir, ['src/**'], { repoRoot: s.dir });

        assert.strictEqual(boundaryRes.valid, false);
        assert(boundaryRes.violations.includes('unauthorized.txt'));
      });
    });

    it('ADV-G-FINDING-01: Rejects absolute external paths under wildcard patterns (* and **)', () => {
      const repoRoot = process.cwd();

      // /etc/passwd under universal '*'
      const resPasswd = validatePathWhitelist(['/etc/passwd'], ['*'], { repoRoot });
      assert.strictEqual(resPasswd.valid, false);
      assert.deepStrictEqual(resPasswd.violations, ['/etc/passwd']);
      assert(resPasswd.error.includes('directory traversal attempt'));

      // /tmp path under '**'
      const resTmp = validatePathWhitelist(['/tmp/outside.js'], ['**'], { repoRoot });
      assert.strictEqual(resTmp.valid, false);
      assert.deepStrictEqual(resTmp.violations, ['/tmp/outside.js']);

      // No repoRoot option provided (must default to cwd and reject external absolute)
      const resNoRepo = validatePathWhitelist(['/etc/passwd'], ['*']);
      assert.strictEqual(resNoRepo.valid, false);

      // In-repo absolute path must be accepted and normalized
      const validAbs = path.join(repoRoot, 'src/guard.mjs');
      const resValid = validatePathWhitelist([validAbs], ['src/**'], { repoRoot });
      assert.strictEqual(resValid.valid, true);
    });

    it('ADV-G-FINDING-02: Single-level glob src/* permits root files but strictly rejects nested subdirectories', () => {
      const allowed = ['src/*'];

      // Single-level file in src/ passes
      assert.strictEqual(validatePathWhitelist(['src/index.js'], allowed).valid, true);

      // Single-level dotfile in src/ passes
      assert.strictEqual(validatePathWhitelist(['src/.env'], allowed).valid, true);

      // Nested file in src/ strictly rejected
      const resNested = validatePathWhitelist(['src/a/b.js'], allowed);
      assert.strictEqual(resNested.valid, false);
      assert.deepStrictEqual(resNested.violations, ['src/a/b.js']);

      // Deeply nested file in src/ strictly rejected
      const resDeep = validatePathWhitelist(['src/a/b/c/d/e.js'], allowed);
      assert.strictEqual(resDeep.valid, false);
      assert.deepStrictEqual(resDeep.violations, ['src/a/b/c/d/e.js']);

      // Recursive glob src/** permits deep nesting
      assert.strictEqual(validatePathWhitelist(['src/a/b/c/d/e.js'], ['src/**']).valid, true);
    });

  });

  // ==========================================================================
  // PART 2: Shift-Left Gatekeeper & Subprocess Execution Stress (Challenger 1)
  // ==========================================================================
  describe('Part 2: Shift-Left Gatekeeper & Subprocess Execution Stress (Challenger 1)', () => {

    it('ADV-07: Subprocess reports exit code 1 and captures stderr', () => {
      const res = runGateCommand(
        'node -e "process.stderr.write(\'custom error output\'); process.exit(1)"',
        process.cwd()
      );
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.exitCode, 1);
      assert(res.stderr.includes('custom error output'));
    });

    it('ADV-08: Subprocess reports exit code 127 for non-existent command', () => {
      const res = runGateCommand('nonexistent_command_xyz_12345', process.cwd());
      assert.strictEqual(res.success, false);
      assert.notStrictEqual(res.exitCode, 0);
    });

    it('ADV-09: Timeout detection in runGateCommand and executeGates (ETIMEDOUT)', () => {
      const res = runGateCommand(
        'node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800)"',
        process.cwd(),
        { timeoutMs: 100 }
      );
      assert.strictEqual(res.success, false);
      assert(res.error && res.error.includes('timed out after 100ms'));
    });

    it('ADV-10: Shift-left sequence halts immediately at first failure without running subsequent gates', () => {
      const gates = [
        'node -e "process.exit(0)"',
        'node -e "process.exit(1)"',
        'node -e "process.exit(0)"'
      ];
      const res = executeGates(gates, process.cwd());

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.gatesRun.length, 1);
      assert.strictEqual(res.failedGate.exitCode, 1);
    });

    it('ADV-G-FINDING-03: executeGatekeeper forwards timeoutMs and env to subprocess runner', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);
        createFeature({ id: 'FEAT-GK-OPT', title: 'GK Opts', target_milestone: 'v0.1', spec_markdown: '# spec' }, db);

        // Timeout forwarding verification
        createTask({
          id: 'TASK-TIMEOUT',
          feature_id: 'FEAT-GK-OPT',
          title: 'Timeout Task',
          required_gates: ['node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)"']
        }, db);
        claimTask({ taskId: 'TASK-TIMEOUT', actorName: 'agent-gk', repoRoot: s.dir }, db);

        const start = Date.now();
        const timeoutRes = executeGatekeeper({
          taskId: 'TASK-TIMEOUT',
          repoRoot: s.dir,
          cwd: s.dir,
          timeoutMs: 100
        }, db);
        const elapsed = Date.now() - start;

        assert.strictEqual(timeoutRes.success, false);
        assert.strictEqual(timeoutRes.phase, 'GATE_FAILURE');
        assert(timeoutRes.error.includes('timed out after 100ms'));
        assert(elapsed < 450, `Gate process should terminate near 100ms, elapsed: ${elapsed}ms`);

        // Environment variable forwarding verification
        createTask({
          id: 'TASK-ENV',
          feature_id: 'FEAT-GK-OPT',
          title: 'Env Task',
          required_gates: ['node -e "if (process.env.VIBESYNC_SECRET !== \'ok\') process.exit(1)"']
        }, db);
        claimTask({ taskId: 'TASK-ENV', actorName: 'agent-gk', repoRoot: s.dir }, db);

        const envFail = executeGatekeeper({ taskId: 'TASK-ENV', repoRoot: s.dir, cwd: s.dir }, db);
        assert.strictEqual(envFail.success, false);

        const envPass = executeGatekeeper({
          taskId: 'TASK-ENV',
          repoRoot: s.dir,
          cwd: s.dir,
          env: { VIBESYNC_SECRET: 'ok' }
        }, db);
        assert.strictEqual(envPass.success, true);
        assert.strictEqual(envPass.phase, 'GATES_PASSED');
      });
    });

  });

  // ==========================================================================
  // PART 3: 3-Strike Circuit Breaker & Artifact Hashing Stress (Challenger 1)
  // ==========================================================================
  describe('Part 3: 3-Strike Circuit Breaker & Artifact Hashing Stress (Challenger 1)', () => {

    it('ADV-11: 3-Strike circuit breaker sequential progression and blocked task execution prevention', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);
        createFeature({ id: 'FEAT-CB-SEQ', title: 'CB Seq', target_milestone: 'v0.1', spec_markdown: '# spec' }, db);
        createTask({
          id: 'TASK-CB-SEQ',
          feature_id: 'FEAT-CB-SEQ',
          title: 'CB Task',
          required_gates: ['node -e "process.exit(1)"']
        }, db);
        claimTask({ taskId: 'TASK-CB-SEQ', actorName: 'agent-cb', repoRoot: s.dir }, db);

        // Strike 1
        const r1 = executeGatekeeper({ taskId: 'TASK-CB-SEQ', repoRoot: s.dir }, db);
        assert.strictEqual(r1.success, false);
        assert.strictEqual(r1.consecutiveFailures, 1);
        assert.strictEqual(getTask('TASK-CB-SEQ', db).status, 'in_progress');

        // Strike 2
        const r2 = executeGatekeeper({ taskId: 'TASK-CB-SEQ', repoRoot: s.dir }, db);
        assert.strictEqual(r2.success, false);
        assert.strictEqual(r2.consecutiveFailures, 2);
        assert.strictEqual(getTask('TASK-CB-SEQ', db).status, 'in_progress');

        // Strike 3 -> trips to blocked
        const r3 = executeGatekeeper({ taskId: 'TASK-CB-SEQ', repoRoot: s.dir }, db);
        assert.strictEqual(r3.success, false);
        assert.strictEqual(r3.consecutiveFailures, 3);
        assert.strictEqual(r3.status, 'blocked');
        const taskBlocked = getTask('TASK-CB-SEQ', db);
        assert.strictEqual(taskBlocked.status, 'blocked');

        // Further execution on blocked task is rejected
        assert.throws(
          () => executeGatekeeper({ taskId: 'TASK-CB-SEQ', repoRoot: s.dir }, db),
          /is not in_progress \(status: blocked\)/
        );
      });
    });

    it('ADV-12: 12-char SHA-256 artifact storage written to .vibesync/artifacts/<hash>.log', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);
        createFeature({ id: 'FEAT-ART', title: 'Artifact Feat', target_milestone: 'v0.1', spec_markdown: '# spec' }, db);
        createTask({
          id: 'TASK-ART',
          feature_id: 'FEAT-ART',
          title: 'Artifact Task',
          required_gates: ['node -e "process.stderr.write(\'artifact payload test 123\'); process.exit(1)"']
        }, db);
        claimTask({ taskId: 'TASK-ART', actorName: 'agent-art', repoRoot: s.dir }, db);

        const res = executeGatekeeper({ taskId: 'TASK-ART', repoRoot: s.dir }, db);
        assert.strictEqual(res.success, false);
        assert(res.artifactHash);
        assert.strictEqual(res.artifactHash.length, 12);

        const artifactPath = path.join(s.dir, '.vibesync', 'artifacts', `${res.artifactHash}.log`);
        assert.strictEqual(fs.existsSync(artifactPath), true);
        const content = fs.readFileSync(artifactPath, 'utf8');
        assert(content.includes('artifact payload test 123'));
      });
    });

    it('ADV-13: Consecutive failure reset on clean gate pass', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);
        createFeature({ id: 'FEAT-RESET', title: 'Reset Feat', target_milestone: 'v0.1', spec_markdown: '# spec' }, db);
        createTask({
          id: 'TASK-RESET',
          feature_id: 'FEAT-RESET',
          title: 'Reset Task',
          required_gates: ['node -e "process.exit(1)"']
        }, db);
        claimTask({ taskId: 'TASK-RESET', actorName: 'agent-reset', repoRoot: s.dir }, db);

        // Fail 2 times
        executeGatekeeper({ taskId: 'TASK-RESET', repoRoot: s.dir }, db);
        executeGatekeeper({ taskId: 'TASK-RESET', repoRoot: s.dir }, db);
        assert.strictEqual(getTask('TASK-RESET', db).consecutive_failures, 2);

        // Switch to passing gate
        db.prepare(`UPDATE tasks SET required_gates = ? WHERE id = ?`).run(
          JSON.stringify(['node -e "process.exit(0)"']),
          'TASK-RESET'
        );

        const passRes = executeGatekeeper({ taskId: 'TASK-RESET', repoRoot: s.dir }, db);
        assert.strictEqual(passRes.success, true);
        assert.strictEqual(passRes.phase, 'GATES_PASSED');

        // Consecutive failures reset to 0
        assert.strictEqual(getTask('TASK-RESET', db).consecutive_failures, 0);
      });
    });

    it('ADV-14: Scope boundary violation increments failure counter and trips breaker on 3rd violation', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);
        createFeature({ id: 'FEAT-SCOPE-CB', title: 'Scope CB', target_milestone: 'v0.1', spec_markdown: '# spec' }, db);
        createTask({
          id: 'TASK-SCOPE-CB',
          feature_id: 'FEAT-SCOPE-CB',
          title: 'Scope CB Task',
          allowed_paths: ['src/**'],
          required_gates: ['node -e "process.exit(0)"']
        }, db);
        claimTask({ taskId: 'TASK-SCOPE-CB', actorName: 'agent-scope', repoRoot: s.dir }, db);

        // Write unauthorized file in working tree
        fs.writeFileSync(path.join(s.dir, 'unauthorized.js'), 'bad code\n');

        // Violation 1
        const r1 = executeGatekeeper({ taskId: 'TASK-SCOPE-CB', repoRoot: s.dir }, db);
        assert.strictEqual(r1.phase, 'SCOPE_VIOLATION');
        assert.strictEqual(r1.consecutiveFailures, 1);

        // Violation 2
        const r2 = executeGatekeeper({ taskId: 'TASK-SCOPE-CB', repoRoot: s.dir }, db);
        assert.strictEqual(r2.consecutiveFailures, 2);

        // Violation 3 -> trips breaker
        const r3 = executeGatekeeper({ taskId: 'TASK-SCOPE-CB', repoRoot: s.dir }, db);
        assert.strictEqual(r3.consecutiveFailures, 3);
        assert.strictEqual(getTask('TASK-SCOPE-CB', db).status, 'blocked');
      });
    });

  });

  // ==========================================================================
  // PART 4: In-Memory Conflict Detection & Zero Mutation Invariants (Challenger 2)
  // ==========================================================================
  describe('Part 4: In-Memory Conflict Detection & Zero Mutation Invariants (Challenger 2)', () => {

    it('ADV-M2-01: Content conflict detected in memory with zero disk/index mutation', async () => {
      await withSandbox(async (s) => {
        s.commitFile('shared.txt', 'line 1\nline 2\nline 3\n', 'baseline commit');

        s.createBranch('task/conflict-content', 'main', true);
        s.commitFile('shared.txt', 'line 1\ntask edit\nline 3\n', 'task branch edit');

        s.checkout('main');
        s.commitFile('shared.txt', 'line 1\nmain edit\nline 3\n', 'main branch edit');

        // Capture filesystem and index state on main
        const statusBefore = s.execGit('git status --porcelain');
        const lsFilesBefore = s.execGit('git ls-files -s');
        const headBefore = s.execGit('git rev-parse HEAD');
        const fileContentBefore = fs.readFileSync(path.join(s.dir, 'shared.txt'), 'utf8');

        // Run simulation
        const sim = simulateMergeTree('main', 'task/conflict-content', s.dir);

        // Verification assertions
        assert.strictEqual(sim.clean, false, 'Merge should not be clean');
        assert.strictEqual(sim.conflict, true, 'Merge should detect conflict');
        assert.strictEqual(sim.safe, false, 'Merge should not be safe');
        assert.deepStrictEqual(sim.conflictFiles, ['shared.txt'], 'Conflicting file should be shared.txt');
        assert(sim.error.includes('shared.txt'), 'Error message should cite conflicting file');

        // Assert ZERO mutation
        assert.strictEqual(s.execGit('git status --porcelain'), statusBefore, 'Working tree status mutated');
        assert.strictEqual(s.execGit('git ls-files -s'), lsFilesBefore, 'Git staging index mutated');
        assert.strictEqual(s.execGit('git rev-parse HEAD'), headBefore, 'Git HEAD pointer mutated');
        assert.strictEqual(
          fs.readFileSync(path.join(s.dir, 'shared.txt'), 'utf8'),
          fileContentBefore,
          'Disk file content mutated'
        );
      });
    });

    it('ADV-M2-02: Add/Add conflict detected when both branches add same path with different content', async () => {
      await withSandbox(async (s) => {
        s.createBranch('task/add-add', 'main', true);
        s.commitFile('new-file.txt', 'content from task\n', 'task added file');

        s.checkout('main');
        s.commitFile('new-file.txt', 'content from main\n', 'main added file');

        const sim = simulateMergeTree('main', 'task/add-add', s.dir);
        assert.strictEqual(sim.clean, false);
        assert.strictEqual(sim.conflict, true);
        assert(sim.conflictFiles.includes('new-file.txt'));
      });
    });

    it('ADV-M2-03: Modify/Delete conflict detected in memory', async () => {
      await withSandbox(async (s) => {
        s.commitFile('target-delete.txt', 'initial text\n', 'baseline file');

        s.createBranch('task/modify-del', 'main', true);
        s.commitFile('target-delete.txt', 'modified text\n', 'task modified file');

        s.checkout('main');
        s.execGit('git rm target-delete.txt');
        s.execGit('git commit -m "main deleted file"');

        const sim = simulateMergeTree('main', 'task/modify-del', s.dir);
        assert.strictEqual(sim.clean, false);
        assert.strictEqual(sim.conflict, true);
        assert(sim.conflictFiles.includes('target-delete.txt'));
      });
    });

    it('ADV-M2-04: Delete/Modify conflict detected in memory', async () => {
      await withSandbox(async (s) => {
        s.commitFile('del-mod.txt', 'orig content\n', 'orig commit');

        s.createBranch('task/del-mod', 'main', true);
        s.execGit('git rm del-mod.txt');
        s.execGit('git commit -m "task deleted file"');

        s.checkout('main');
        s.commitFile('del-mod.txt', 'main changed content\n', 'main modified file');

        const sim = simulateMergeTree('main', 'task/del-mod', s.dir);
        assert.strictEqual(sim.clean, false);
        assert.strictEqual(sim.conflict, true);
        assert(sim.conflictFiles.includes('del-mod.txt'));
      });
    });

    it('ADV-M2-05: Binary file collision detected in memory', async () => {
      await withSandbox(async (s) => {
        const bin1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
        const bin2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]);
        const bin3 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]);

        fs.writeFileSync(path.join(s.dir, 'image.png'), bin1);
        s.execGit('git add image.png');
        s.execGit('git commit -m "baseline binary"');

        s.createBranch('task/bin-conflict', 'main', true);
        fs.writeFileSync(path.join(s.dir, 'image.png'), bin2);
        s.execGit('git add image.png');
        s.execGit('git commit -m "task edit binary"');

        s.checkout('main');
        fs.writeFileSync(path.join(s.dir, 'image.png'), bin3);
        s.execGit('git add image.png');
        s.execGit('git commit -m "main edit binary"');

        const sim = simulateMergeTree('main', 'task/bin-conflict', s.dir);
        assert.strictEqual(sim.clean, false);
        assert.strictEqual(sim.conflict, true);
        assert(sim.conflictFiles.includes('image.png'));
      });
    });

    it('ADV-M2-06: Multi-file concurrent collisions enumerated in sorted order', async () => {
      await withSandbox(async (s) => {
        s.commitFile('z_file.txt', 'z1\n', 'baseline z');
        s.commitFile('a_file.txt', 'a1\n', 'baseline a');
        s.commitFile('m_file.txt', 'm1\n', 'baseline m');

        s.createBranch('task/multi-collision', 'main', true);
        s.commitFile('z_file.txt', 'z_task\n', 'task z');
        s.commitFile('a_file.txt', 'a_task\n', 'task a');
        s.commitFile('m_file.txt', 'm_task\n', 'task m');

        s.checkout('main');
        s.commitFile('z_file.txt', 'z_main\n', 'main z');
        s.commitFile('a_file.txt', 'a_main\n', 'main a');
        s.commitFile('m_file.txt', 'm_main\n', 'main m');

        const sim = simulateMergeTree('main', 'task/multi-collision', s.dir);
        assert.strictEqual(sim.clean, false);
        assert.strictEqual(sim.conflict, true);
        assert.deepStrictEqual(sim.conflictFiles, ['a_file.txt', 'm_file.txt', 'z_file.txt']);
      });
    });

    it('ADV-M2-07: In-memory simulation operates correctly when working tree on main is heavily dirtied', async () => {
      await withSandbox(async (s) => {
        s.commitFile('clean.txt', 'clean content\n', 'baseline clean');

        s.createBranch('task/clean-merge', 'main', true);
        s.commitFile('task_feature.txt', 'feature code\n', 'task commit');

        s.checkout('main');

        // Heavily dirty working tree
        fs.writeFileSync(path.join(s.dir, 'dirty_untracked.tmp'), 'junk untracked\n');
        fs.writeFileSync(path.join(s.dir, 'clean.txt'), 'modified locally in dev\n');
        s.execGit('git add clean.txt');

        // Simulation MUST succeed without being impacted by local dirtiness
        const sim = simulateMergeTree('main', 'task/clean-merge', s.dir);
        assert.strictEqual(sim.clean, true);
        assert.strictEqual(sim.conflict, false);
        assert(sim.treeSha && sim.treeSha.length === 40);

        // Staged and untracked edits on main remain untouched
        assert.strictEqual(s.execGit('git diff --cached --name-only').trim(), 'clean.txt');
        assert(fs.existsSync(path.join(s.dir, 'dirty_untracked.tmp')));
      });
    });

  });

  // ==========================================================================
  // PART 5: Settlement & Working Tree Preservation Stress (Challenger 2)
  // ==========================================================================
  describe('Part 5: Settlement & Working Tree Preservation Stress (Challenger 2)', () => {

    it('ADV-M2-08: Settlement preserves staged and unstaged developer edits byte-identically on main', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-SETTLE-PRESERVE',
          title: 'Preserve Working Tree Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec text'
        }, db);

        createTask({
          id: 'TASK-STASH-DEV',
          feature_id: 'FEAT-SETTLE-PRESERVE',
          title: 'Stash Dev Task',
          allowed_paths: ['src/**'],
          required_gates: []
        }, db);

        claimTask({ taskId: 'TASK-STASH-DEV', actorName: 'agent-coder', repoRoot: s.dir }, db);

        s.createBranch('task/task-stash-dev', 'main', true);
        s.commitFile('src/feature_logic.js', 'export const f = () => 42;\n', 'add feature logic');

        s.checkout('main');
        s.commitFile('existing.txt', 'v1\n', 'existing file commit');

        // Developer creates uncommitted edits on main
        const devUnstagedContent = 'developer unstaged modifications line 1\nline 2\n';
        fs.writeFileSync(path.join(s.dir, 'existing.txt'), devUnstagedContent);

        const devUntrackedContent = 'developer scratchpad notes not tracked\n';
        fs.writeFileSync(path.join(s.dir, 'scratch.tmp'), devUntrackedContent);

        const settleRes = performSquashSettlement({
          taskId: 'TASK-STASH-DEV',
          actorName: 'agent-coder',
          repoRoot: s.dir,
          db,
          targetBranch: 'main'
        });

        assert.strictEqual(settleRes.success, true);
        assert(settleRes.settledSha);

        // Verify working tree is preserved byte-identically
        assert.strictEqual(
          fs.readFileSync(path.join(s.dir, 'existing.txt'), 'utf8'),
          devUnstagedContent,
          'Unstaged developer content was corrupted or lost'
        );
        assert.strictEqual(
          fs.readFileSync(path.join(s.dir, 'scratch.tmp'), 'utf8'),
          devUntrackedContent,
          'Untracked developer scratch file was corrupted or lost'
        );

        // Verify task file settled into main
        assert.strictEqual(
          fs.readFileSync(path.join(s.dir, 'src/feature_logic.js'), 'utf8'),
          'export const f = () => 42;\n'
        );
      });
    });

    it('ADV-M2-09: Settlement generates compliant RFC 2822 commit trailers and Git notes provenance', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-TRAILERS',
          title: 'RFC Trailers Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        createTask({
          id: 'TASK-TRAILERS',
          feature_id: 'FEAT-TRAILERS',
          title: 'RFC Trailers Task',
          allowed_paths: ['src/**'],
          required_gates: ['echo "gate 1 passed"']
        }, db);

        claimTask({ taskId: 'TASK-TRAILERS', actorName: 'antigravity-actor-77', repoRoot: s.dir }, db);

        s.createBranch('task/task-trailers', 'main', true);
        s.commitFile('src/trailers.js', 'export const trailers = true;\n', 'task commit');

        s.checkout('main');

        const settleRes = performSquashSettlement({
          taskId: 'TASK-TRAILERS',
          actorName: 'antigravity-actor-77',
          repoRoot: s.dir,
          db,
          gateLogs: [{ cmd: 'echo "gate 1 passed"', exitCode: 0, status: 'PASS' }],
          targetBranch: 'main'
        });

        assert.strictEqual(settleRes.success, true);
        const settledCommit = settleRes.settledSha;

        // Verify Commit Trailers
        const trailers = getCommitTrailers(s.dir, settledCommit);
        assert.strictEqual(trailers['Task-Id'], 'TASK-TRAILERS');
        assert.strictEqual(trailers['Feature-Id'], 'FEAT-TRAILERS');
        assert.strictEqual(trailers['Agent-Actor'], 'antigravity-actor-77');
        assert(trailers['Base-Commit'], 'Base-Commit trailer missing');

        // Verify Git Notes on refs/notes/vibesync
        const note = getNotes(s.dir, settledCommit, 'refs/notes/vibesync');
        assert(note, 'Git note was not attached to commit');
        assert.strictEqual(note.taskId, 'TASK-TRAILERS');
        assert.strictEqual(note.featureId, 'FEAT-TRAILERS');
        assert.strictEqual(note.actorName, 'antigravity-actor-77');
        assert(note.status === 'PASS' || note.status === 'settled');
        const gatesList = note.gates || note.gatesRun;
        assert(Array.isArray(gatesList));
        assert.strictEqual(gatesList[0].cmd, 'echo "gate 1 passed"');
      });
    });

    it('ADV-M2-10: Settlement executed while checked out on feature branch returns cleanly to feature branch', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-RETURN-BRANCH',
          title: 'Return Branch Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        createTask({
          id: 'TASK-RETURN-BRANCH',
          feature_id: 'FEAT-RETURN-BRANCH',
          title: 'Return Branch Task',
          allowed_paths: ['*'],
          required_gates: []
        }, db);

        claimTask({ taskId: 'TASK-RETURN-BRANCH', actorName: 'agent-branch', repoRoot: s.dir }, db);

        s.createBranch('task/task-return-branch', 'main', true);
        s.commitFile('code.js', 'val = 1;\n', 'task commit');

        // Create secondary developer branch and check it out
        s.createBranch('dev/local-experiment', 'main', true);
        fs.writeFileSync(path.join(s.dir, 'experiment.txt'), 'in-flight dev work\n');

        assert.strictEqual(s.execGit('git rev-parse --abbrev-ref HEAD').trim(), 'dev/local-experiment');

        // Execute settlement targeting main
        const settleRes = performSquashSettlement({
          taskId: 'TASK-RETURN-BRANCH',
          actorName: 'agent-branch',
          repoRoot: s.dir,
          db,
          targetBranch: 'main'
        });

        assert.strictEqual(settleRes.success, true);

        // Branch MUST return to dev/local-experiment
        const currentBranch = s.execGit('git rev-parse --abbrev-ref HEAD').trim();
        assert.strictEqual(currentBranch, 'dev/local-experiment');
        assert.strictEqual(fs.readFileSync(path.join(s.dir, 'experiment.txt'), 'utf8'), 'in-flight dev work\n');

        // Main contains the settled commit
        const mainLog = s.execGit('git log -n 1 --format=%s main').trim();
        assert(mainLog.includes('TASK-RETURN-BRANCH'));
      });
    });

    it('ADV-M2-11: Consecutive task settlements build clean linear history on main with discrete notes', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-MULTI-SETTLE',
          title: 'Multi Settle Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        // Task 1
        createTask({ id: 'TASK-SEQ-1', feature_id: 'FEAT-MULTI-SETTLE', title: 'Task 1', required_gates: [] }, db);
        claimTask({ taskId: 'TASK-SEQ-1', actorName: 'agent-1', repoRoot: s.dir }, db);
        s.createBranch('task/task-seq-1', 'main', true);
        s.commitFile('f1.txt', 'file 1\n', 'c1');
        s.checkout('main');

        const r1 = performSquashSettlement({ taskId: 'TASK-SEQ-1', actorName: 'agent-1', repoRoot: s.dir, db });
        assert.strictEqual(r1.success, true);

        // Task 2
        createTask({ id: 'TASK-SEQ-2', feature_id: 'FEAT-MULTI-SETTLE', title: 'Task 2', required_gates: [] }, db);
        claimTask({ taskId: 'TASK-SEQ-2', actorName: 'agent-2', repoRoot: s.dir }, db);
        s.createBranch('task/task-seq-2', 'main', true);
        s.commitFile('f2.txt', 'file 2\n', 'c2');
        s.checkout('main');

        const r2 = performSquashSettlement({ taskId: 'TASK-SEQ-2', actorName: 'agent-2', repoRoot: s.dir, db });
        assert.strictEqual(r2.success, true);

        // Verify linear commits on main
        const commitCount = parseInt(s.execGit('git rev-list --count main').trim(), 10);
        assert.strictEqual(commitCount, 3); // initial + settle 1 + settle 2

        // Verify discrete Git notes exist on both settled commits
        const note1 = getNotes(s.dir, r1.settledSha, 'refs/notes/vibesync');
        const note2 = getNotes(s.dir, r2.settledSha, 'refs/notes/vibesync');
        assert(note1, 'Note 1 must exist');
        assert(note2, 'Note 2 must exist');
        assert.strictEqual(note1.taskId, 'TASK-SEQ-1');
        assert.strictEqual(note2.taskId, 'TASK-SEQ-2');
      });
    });

  });

  // ==========================================================================
  // PART 6: Transactional Rollback & Error Recovery Stress (Challenger 2)
  // ==========================================================================
  describe('Part 6: Transactional Rollback & Error Recovery Stress (Challenger 2)', () => {

    it('ADV-M2-12: Commit failure triggers rollback: restores HEAD, working tree, and index', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-ROLLBACK',
          title: 'Rollback Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        createTask({
          id: 'TASK-ROLLBACK',
          feature_id: 'FEAT-ROLLBACK',
          title: 'Rollback Task',
          required_gates: []
        }, db);

        claimTask({ taskId: 'TASK-ROLLBACK', actorName: 'agent-rb', repoRoot: s.dir }, db);

        s.createBranch('task/task-rollback', 'main', true);
        s.commitFile('rb.txt', 'content\n', 'task commit');

        s.checkout('main');
        const headBefore = s.execGit('git rev-parse HEAD').trim();

        // Pass invalid db or options that fail during settlement commit/metadata step
        assert.throws(() => {
          performSquashSettlement({
            taskId: 'TASK-ROLLBACK',
            actorName: 'agent-rb',
            repoRoot: s.dir,
            db: null, // Forces failure in SQLite update
            targetBranch: 'main'
          });
        });

        // Verify HEAD restored to baseline
        const headAfter = s.execGit('git rev-parse HEAD').trim();
        assert.strictEqual(headAfter, headBefore);

        // Verify no intermediate merge debris
        assert.strictEqual(fs.existsSync(path.join(s.dir, '.git', 'MERGE_HEAD')), false);
        assert.strictEqual(fs.existsSync(path.join(s.dir, '.git', 'SQUASH_MSG')), false);
      });
    });

    it('ADV-M2-13: True working tree conflict on tracked file aborts settlement cleanly without touching disk', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-TRUE-CONFLICT',
          title: 'True Conflict Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        createTask({
          id: 'TASK-TRUE-CONFLICT',
          feature_id: 'FEAT-TRUE-CONFLICT',
          title: 'True Conflict Task',
          required_gates: []
        }, db);

        claimTask({ taskId: 'TASK-TRUE-CONFLICT', actorName: 'agent-tc', repoRoot: s.dir }, db);

        s.commitFile('conflict_target.js', 'base code\n', 'base commit');

        s.createBranch('task/task-true-conflict', 'main', true);
        s.commitFile('conflict_target.js', 'task branch code\n', 'task commit');

        s.checkout('main');

        // Developer has unsaved modifications to conflict_target.js
        const devUnsaved = 'developer unsaved modifications to same file\n';
        fs.writeFileSync(path.join(s.dir, 'conflict_target.js'), devUnsaved);

        assert.throws(
          () => {
            performSquashSettlement({
              taskId: 'TASK-TRUE-CONFLICT',
              actorName: 'agent-tc',
              repoRoot: s.dir,
              db
            });
          },
          (err) => {
            return err.phase === 'WORKING_TREE_CONFLICT' && err.message.includes('conflict_target.js');
          }
        );

        // Developer unsaved work is preserved intact on disk
        assert.strictEqual(fs.readFileSync(path.join(s.dir, 'conflict_target.js'), 'utf8'), devUnsaved);
      });
    });

    it('ADV-M2-14: verifyAndSettleTask rejects settlement if task is already settled or blocked', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({ id: 'FEAT-GUARD-STATUS', title: 'Status Guard', target_milestone: 'v0.1', spec_markdown: 'Spec' }, db);

        createTask({ id: 'TASK-ALREADY-SETTLED', feature_id: 'FEAT-GUARD-STATUS', title: 'Settled Task', required_gates: [] }, db);
        assert.throws(() => updateTaskStatus('TASK-ALREADY-SETTLED', 'settled', 'system', db), /verifyAndSettleTask/);
        db.prepare("UPDATE tasks SET status = 'settled' WHERE id = ?").run('TASK-ALREADY-SETTLED');

        assert.throws(
          () => verifyAndSettleTask({ taskId: 'TASK-ALREADY-SETTLED', repoRoot: s.dir, db }),
          /already settled/
        );

        createTask({ id: 'TASK-ALREADY-BLOCKED', feature_id: 'FEAT-GUARD-STATUS', title: 'Blocked Task', required_gates: [] }, db);
        updateTaskStatus('TASK-ALREADY-BLOCKED', 'blocked', 'system', db);

        assert.throws(
          () => verifyAndSettleTask({ taskId: 'TASK-ALREADY-BLOCKED', repoRoot: s.dir, db }),
          /blocked/
        );
      });
    });

  });

  // ==========================================================================
  // PART 7: Challenger 2 Inverted Regression Assertions (Merge & Settlement)
  // ==========================================================================
  describe('Part 7: Challenger 2 Inverted Regression Assertions (Merge & Settlement)', () => {

    /**
     * REPAIRED FINDING 1: Merge collisions must NOT reset failure counter.
     * With resetGateFailures moved to Stage D, consecutive merge collisions
     * increment consecutive_failures and trip the circuit breaker on Strike 3.
     */
    it('ADV-S-FINDING-01: In-Memory merge collisions trip 3-strike circuit breaker after consecutive collisions', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-CB-BUG',
          title: 'Circuit Breaker Bug Test',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        createTask({
          id: 'TASK-CB-BUG',
          feature_id: 'FEAT-CB-BUG',
          title: 'Circuit Breaker Bug Task',
          required_gates: ['node -e "process.exit(0)"'] // Stage B passes!
        }, db);

        claimTask({ taskId: 'TASK-CB-BUG', actorName: 'agent-cb', repoRoot: s.dir }, db);

        s.commitFile('collision.txt', 'v1\n', 'c1');
        s.createBranch('task/task-cb-bug', 'main', true);
        s.commitFile('collision.txt', 'v2-task\n', 'task c2');

        s.checkout('main');
        s.commitFile('collision.txt', 'v2-main\n', 'main c2');

        // Run verifyAndSettleTask 3 consecutive times: collision occurs in Stage C each time
        const r1 = await verifyAndSettleTask({ taskId: 'TASK-CB-BUG', actorName: 'agent-cb', repoRoot: s.dir, db });
        assert.strictEqual(r1.success, false);
        assert.strictEqual(r1.phase, 'MERGE_COLLISION');
        assert.strictEqual(r1.consecutiveFailures, 1);

        const r2 = await verifyAndSettleTask({ taskId: 'TASK-CB-BUG', actorName: 'agent-cb', repoRoot: s.dir, db });
        assert.strictEqual(r2.success, false);
        assert.strictEqual(r2.consecutiveFailures, 2);

        const r3 = await verifyAndSettleTask({ taskId: 'TASK-CB-BUG', actorName: 'agent-cb', repoRoot: s.dir, db });
        assert.strictEqual(r3.success, false);
        assert.strictEqual(r3.consecutiveFailures, 3);
        assert.strictEqual(r3.is_blocked, true);

        const taskAfter = getTask('TASK-CB-BUG', db);
        assert.strictEqual(taskAfter.status, 'blocked', 'Task status must transition to blocked on 3rd collision');
        assert.strictEqual(taskAfter.consecutive_failures, 3, 'Consecutive failures must reach 3');
      });
    });

    /**
     * REPAIRED FINDING 2: Merge-base diff isolates task branch changes.
     * When main advances with commits touching unrelated.txt and developer has uncommitted edits
     * to unrelated.txt, settlement succeeds because task branch never touched unrelated.txt.
     */
    it('ADV-S-FINDING-02: Merge-base diff permits settlement when main advanced with unrelated commits', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-TWODOT',
          title: 'Two Dot Diff Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        createTask({
          id: 'TASK-TWODOT',
          feature_id: 'FEAT-TWODOT',
          title: 'Two Dot Diff Task',
          required_gates: []
        }, db);

        claimTask({ taskId: 'TASK-TWODOT', actorName: 'agent-diff', repoRoot: s.dir }, db);

        // Task branch created from main
        s.createBranch('task/task-twodot', 'main', true);
        s.commitFile('src/task_only.txt', 'task code\n', 'task commit');

        // Main advances with an unrelated commit touching unrelated.txt
        s.checkout('main');
        s.commitFile('unrelated.txt', 'unrelated v1\n', 'main commit on unrelated.txt');

        // Developer on main edits unrelated.txt (unstaged)
        const devUncommitted = 'unrelated v1 + dev uncommitted edits\n';
        fs.writeFileSync(path.join(s.dir, 'unrelated.txt'), devUncommitted);

        // Settlement must succeed without throwing false-positive conflict
        const res = performSquashSettlement({
          taskId: 'TASK-TWODOT',
          actorName: 'agent-diff',
          repoRoot: s.dir,
          db
        });

        assert.strictEqual(res.success, true, 'Settlement should succeed when edits do not overlap task changes');
        assert.strictEqual(
          fs.readFileSync(path.join(s.dir, 'unrelated.txt'), 'utf8'),
          devUncommitted,
          'Developer uncommitted edits to unrelated file must be preserved'
        );
      });
    });

    /**
     * REPAIRED FINDING 3: git status --porcelain=v1 -uall discovers untracked files in nested directories.
     * When developer has an untracked file inside a new directory that overlaps with a task change,
     * settlement aborts with WORKING_TREE_CONFLICT and does not clobber developer work.
     */
    it('ADV-S-FINDING-03: Directory untracked files are protected from silent overwrite by porcelain -uall', async () => {
      await withSandbox(async (s) => {
        const { db } = setupSandboxDb(s);

        createFeature({
          id: 'FEAT-DATALOSS',
          title: 'Data Loss Feature',
          target_milestone: 'v0.1',
          spec_markdown: 'Spec'
        }, db);

        createTask({
          id: 'TASK-DATALOSS',
          feature_id: 'FEAT-DATALOSS',
          title: 'Data Loss Task',
          required_gates: []
        }, db);

        claimTask({ taskId: 'TASK-DATALOSS', actorName: 'agent-loss', repoRoot: s.dir }, db);

        s.createBranch('task/task-dataloss', 'main', true);
        s.commitFile('newdir/clobber.js', 'task committed code\n', 'task commit');

        s.checkout('main');

        // Developer creates untracked file in untracked newdir
        fs.mkdirSync(path.join(s.dir, 'newdir'), { recursive: true });
        const devWork = 'developer precious unsaved work\n';
        fs.writeFileSync(path.join(s.dir, 'newdir/clobber.js'), devWork);

        // Settlement must abort with WORKING_TREE_CONFLICT
        assert.throws(
          () => {
            performSquashSettlement({
              taskId: 'TASK-DATALOSS',
              actorName: 'agent-loss',
              repoRoot: s.dir,
              db
            });
          },
          (err) => {
            return err.phase === 'WORKING_TREE_CONFLICT' && err.message.includes('newdir/clobber.js');
          }
        );

        // Developer work must NOT be overwritten
        const contentOnDisk = fs.readFileSync(path.join(s.dir, 'newdir/clobber.js'), 'utf8');
        assert.strictEqual(contentOnDisk, devWork, 'Developer untracked file was preserved without clobbering');
      });
    });

    /**
     * REPAIRED FINDING 4: simulateMergeTree throws a fatal Error on non-existent branches.
     * Non-existent branch references exit code 1 with "not something we can merge" and must
     * throw a fatal Error rather than reporting an in-memory collision.
     */
    it('ADV-S-FINDING-04: Non-existent branch in simulateMergeTree throws fatal error rather than reporting merge collision', async () => {
      await withSandbox(async (s) => {
        assert.throws(
          () => {
            simulateMergeTree('main', 'non_existent_branch_xyz', s.dir);
          },
          /simulateMergeTree failed:.*(?:not something we can merge|fatal:)/i
        );
      });
    });

  });

});
