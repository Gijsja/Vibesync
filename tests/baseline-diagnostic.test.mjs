import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from './harness.mjs';
import { getDb } from '../src/db.mjs';
import { inspectBaselineReadiness } from '../src/workspace.mjs';
import { previewTask } from '../src/policy.mjs';
import { createFeature } from '../src/features.mjs';
import { createTask } from '../src/tasks.mjs';
import { createBaselineReceipt, parseBaselineArgs, RECEIPT_FORMAT } from '../scripts/vibesync-baseline.mjs';

const queued = [];
const test = typeof Bun === 'undefined' ? nodeTest : (n, f) => queued.push({ n, f });

test('inspectBaselineReadiness reports clean when repository working tree is clean', async () => {
  await withSandbox(async sandbox => {
    const result = inspectBaselineReadiness(sandbox.dir, ['src/index.mjs']);
    assert.equal(result.clean, true);
    assert.deepEqual(result.uncommitted_files, []);
    assert.deepEqual(result.allowed_paths_affected, []);
    assert.equal(result.warning, null);
  });
});

test('inspectBaselineReadiness detects uncommitted files affecting task allowed_paths', async () => {
  await withSandbox(async sandbox => {
    // Create an uncommitted file in src/
    fs.mkdirSync(path.join(sandbox.dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sandbox.dir, 'src', 'new-feature.mjs'), '// draft code\n');

    const result = inspectBaselineReadiness(sandbox.dir, ['src/*.mjs']);
    assert.equal(result.clean, false);
    assert.ok(result.uncommitted_files.includes('src/new-feature.mjs'));
    assert.ok(result.allowed_paths_affected.includes('src/new-feature.mjs'));
    assert.ok(result.warning.includes('Repository root has uncommitted changes affecting task allowed_paths'));
  });
});

test('inspectBaselineReadiness differentiates uncommitted files outside allowed_paths', async () => {
  await withSandbox(async sandbox => {
    fs.writeFileSync(path.join(sandbox.dir, 'scratch.txt'), 'random notes\n');

    const result = inspectBaselineReadiness(sandbox.dir, ['src/*.mjs']);
    assert.equal(result.clean, false);
    assert.ok(result.uncommitted_files.includes('scratch.txt'));
    assert.deepEqual(result.allowed_paths_affected, []);
    assert.ok(result.warning.includes('uncommitted file(s); managed worktree was branched from committed trunk HEAD'));
  });
});

test('previewTask includes baseline readiness diagnostic in returned preview', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-T1', title: 'Test feature', target_milestone: 'v1.0', spec_markdown: 'Spec text' }, db);
    createTask({
      id: 'TASK-T1.1',
      feature_id: 'FEAT-T1',
      title: 'Task for baseline preview',
      allowed_paths: ['src/app.mjs']
    }, db);

    // Write uncommitted file affecting allowed_paths
    fs.mkdirSync(path.join(sandbox.dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sandbox.dir, 'src', 'app.mjs'), '// modified\n');

    const preview = previewTask({ taskId: 'TASK-T1.1', actorName: 'antigravity' }, db, sandbox.dir);
    assert.ok(preview.baseline);
    assert.equal(preview.baseline.clean, false);
    assert.ok(preview.baseline.allowed_paths_affected.includes('src/app.mjs'));
    assert.ok(preview.baseline.warning.includes('affecting task allowed_paths'));
  });
});

test('hydrateActiveTaskAnchor includes Repository Baseline Notice when baseline has warnings', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    const feature = createFeature({ id: 'FEAT-T2', title: 'Test feature', target_milestone: 'v1.0', spec_markdown: 'Spec text' }, db);
    const task = createTask({
      id: 'TASK-T2.1',
      feature_id: 'FEAT-T2',
      title: 'Task anchor baseline test',
      allowed_paths: ['src/app.mjs']
    }, db);

    const worktreeDir = path.join(sandbox.dir, '.vibesync', 'worktrees', 'test-task');
    fs.mkdirSync(worktreeDir, { recursive: true });
    const baseline = {
      clean: false,
      uncommitted_files: ['src/app.mjs'],
      allowed_paths_affected: ['src/app.mjs'],
      warning: 'Repository root has uncommitted changes affecting task allowed_paths (src/app.mjs).'
    };

    const { hydrateActiveTaskAnchor } = await import('../src/tasks.mjs');
    hydrateActiveTaskAnchor(worktreeDir, task, feature, null, baseline);

    const anchorContent = fs.readFileSync(path.join(worktreeDir, '.vibesync_ACTIVE_TASK.md'), 'utf8');
    assert.ok(anchorContent.includes('## Repository Baseline Notice'));
    assert.ok(anchorContent.includes('Repository root has uncommitted changes affecting task allowed_paths'));
  });
});

test('MCP vibesync_preview_task compact response includes baseline fields', async () => {
  await withSandbox(async sandbox => {
    const db = sandbox.registerDb(getDb(path.join(sandbox.dir, '.vibesync', 'state.db'), sandbox.dir));
    createFeature({ id: 'FEAT-T3', title: 'Test feature', target_milestone: 'v1.0', spec_markdown: 'Spec text' }, db);
    createTask({
      id: 'TASK-T3.1',
      feature_id: 'FEAT-T3',
      title: 'Task for MCP preview',
      allowed_paths: ['src/app.mjs']
    }, db);

    fs.mkdirSync(path.join(sandbox.dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sandbox.dir, 'src', 'app.mjs'), '// modified\n');

    const { createMcpServer } = await import('../src/mcp.mjs');
    const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const server = createMcpServer({ db, repoRoot: sandbox.dir, role: 'worker' });
    const call = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const res = await call({
      method: 'tools/call',
      params: {
        name: 'vibesync_preview_task',
        arguments: { task_id: 'TASK-T3.1', actor_name: 'antigravity' }
      }
    });

    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.baseline_clean, false);
    assert.ok(parsed.baseline_warning.includes('affecting task allowed_paths'));
  });
});

test('baseline command emits a bounded machine-readable receipt and reports release-surface drift', async () => {
  await withSandbox(async sandbox => {
    const receipt = await createBaselineReceipt({ repoRoot: sandbox.dir });
    assert.equal(receipt.format, RECEIPT_FORMAT);
    assert.equal(receipt.status, 'fail');
    assert.ok(receipt.git_revision);
    assert.ok(receipt.runtime.name === 'node' || receipt.runtime.name === 'bun');
    assert.equal(receipt.platform.os, process.platform);
    assert.deepEqual(receipt.checked_surfaces, receipt.evidence.map(item => item.id));
    assert.ok(receipt.evidence.some(item => item.id === 'package' && item.status === 'fail'));
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 32 * 1024);
  });
});

test('baseline command passes when every declared release surface agrees', async () => {
  await withSandbox(async sandbox => {
    const write = (relative, content) => {
      const target = path.join(sandbox.dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    write('scripts/vibesync.mjs', "console.log('--mcp-role --agent-instructions --queue --handoff --eject');\n");
    write('scripts/vibesync-bun.mjs', "console.log('--mcp-role --agent-instructions --queue --handoff --eject');\n");
    write('scripts/vibesync-baseline.mjs', '');
    write('scripts/vibesync-bun-baseline.mjs', '');
    write('skills/vibesync-mcp/SKILL.md', `---\nname: vibesync-mcp\ndescription: Canonical workflow\n---\nWorker and admin roles use vibesync_preview_task, vibesync_claim_task, and vibesync_verify_and_settle.\n`);
    const nodeConfig = JSON.stringify({ mcpServers: { vibesync: { command: 'node', args: ['/package/scripts/vibesync.mjs'] } } });
    const bunConfig = JSON.stringify({ mcpServers: { vibesync: { command: 'vibesync-bun', args: [] } } });
    write('.mcp.example.json', nodeConfig);
    write('.mcp.bun.example.json', bunConfig);
    write('docs/AGENT_IDE_SETUP.md', 'Node and Bun runtime matrix. Worker and admin policy, approval, and sandbox behavior. Canonical skill: skills/vibesync-mcp/SKILL.md.\n');
    write('package.json', JSON.stringify({
      version: '1.0.0',
      files: ['scripts/vibesync-baseline.mjs', 'scripts/vibesync-bun-baseline.mjs', 'skills/vibesync-mcp/', '.mcp.example.json', '.mcp.bun.example.json'],
      scripts: { baseline: 'node scripts/vibesync-baseline.mjs', 'baseline:bun': 'bun scripts/vibesync-bun-baseline.mjs' },
      bin: { 'vibesync-baseline': './scripts/vibesync-baseline.mjs' }
    }));

    const receipt = await createBaselineReceipt({ repoRoot: sandbox.dir });
    assert.equal(receipt.status, 'pass', JSON.stringify(receipt.evidence));
    assert.ok(receipt.evidence.every(item => item.status === 'pass'));
  });
});

test('baseline reports failure when .agents/skills/vibesync-mcp drifts from canonical skill', async () => {
  await withSandbox(async sandbox => {
    const write = (relative, content) => {
      const target = path.join(sandbox.dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    write('scripts/vibesync.mjs', "console.log('--mcp-role --agent-instructions --queue --handoff --eject');\n");
    write('scripts/vibesync-bun.mjs', "console.log('--mcp-role --agent-instructions --queue --handoff --eject');\n");
    write('scripts/vibesync-baseline.mjs', '');
    write('scripts/vibesync-bun-baseline.mjs', '');
    write('skills/vibesync-mcp/SKILL.md', `---\nname: vibesync-mcp\ndescription: Canonical workflow\n---\nWorker and admin roles use vibesync_preview_task, vibesync_claim_task, and vibesync_verify_and_settle.\n`);
    write('.agents/skills/vibesync-mcp/SKILL.md', `---\nname: vibesync-mcp\ndescription: Divergent workflow\n---\nOutdated instructions\n`);
    const nodeConfig = JSON.stringify({ mcpServers: { vibesync: { command: 'node', args: ['/package/scripts/vibesync.mjs'] } } });
    const bunConfig = JSON.stringify({ mcpServers: { vibesync: { command: 'vibesync-bun', args: [] } } });
    write('.mcp.example.json', nodeConfig);
    write('.mcp.bun.example.json', bunConfig);
    write('docs/AGENT_IDE_SETUP.md', 'Node and Bun runtime matrix. Worker and admin policy, approval, and sandbox behavior. Canonical skill: skills/vibesync-mcp/SKILL.md.\n');
    write('package.json', JSON.stringify({
      version: '1.0.0',
      files: ['scripts/vibesync-baseline.mjs', 'scripts/vibesync-bun-baseline.mjs', 'skills/vibesync-mcp/', '.mcp.example.json', '.mcp.bun.example.json'],
      scripts: { baseline: 'node scripts/vibesync-baseline.mjs', 'baseline:bun': 'bun scripts/vibesync-bun-baseline.mjs' },
      bin: { 'vibesync-baseline': './scripts/vibesync-baseline.mjs' }
    }));

    const receipt = await createBaselineReceipt({ repoRoot: sandbox.dir });
    assert.equal(receipt.status, 'fail');
    const skillCheck = receipt.evidence.find(item => item.id === 'canonical_skill');
    assert.equal(skillCheck.status, 'fail');
    assert.match(skillCheck.summary, /Workspace skill drift detected/);
  });
});

test('baseline argument parsing supports explicit repository and receipt paths', () => {
  const parsed = parseBaselineArgs(['--repo', '.', '--output', 'receipt.json']);
  assert.equal(parsed.repoRoot, path.resolve('.'));
  assert.equal(parsed.output, path.resolve('receipt.json'));
  assert.throws(() => parseBaselineArgs(['--unknown']), /Unknown option/);
});

if (typeof Bun !== 'undefined') {
  let fail = false;
  for (const e of queued) {
    try { await e.f(); }
    catch (err) { fail = true; console.error(err); }
  }
  if (fail) process.exitCode = 1;
}
