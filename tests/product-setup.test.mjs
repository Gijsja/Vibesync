import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { initializeWorkspace } from '../src/init.mjs';
import { getDb, closeDb } from '../src/db.mjs';
import { startServer } from '../src/server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
test('setup installs a usable empty product and preserves existing workspace configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-setup-'));
  try {
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ custom: true, mcpServers: { other: { command: 'other' } } }));
    fs.writeFileSync(path.join(root, 'user.txt'), 'preserve');
    const result = initializeWorkspace(root);
    const config = JSON.parse(fs.readFileSync(result.configPath));
    assert.equal(config.custom, true);
    assert.equal(config.mcpServers.other.command, 'other');
    assert.ok(path.isAbsolute(config.mcpServers.vibesync.args[0]));
    assert.deepEqual(config.mcpServers.vibesync.args.slice(1), ['--repo', root]);
    assert.equal(git(root, 'ls-tree', '--name-only', 'HEAD'), '');
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
    const exclude = fs.readFileSync(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'), 'utf8');
    assert.match(exclude, /# VibeSync runtime/);
    assert.match(exclude, /^\.vibesync\/worktrees\/$/m);
    const db = getDb(null, root);
    assert.equal(db.prepare('SELECT count(*) AS n FROM features').get().n, 0);
    closeDb(db);
    fs.writeFileSync(result.dashboardPath, 'custom dashboard');
    initializeWorkspace(root);
    assert.equal(fs.readFileSync(result.dashboardPath, 'utf8'), 'custom dashboard');
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
    assert.equal(fs.readFileSync(path.join(root, 'user.txt'), 'utf8'), 'preserve');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid MCP config is rejected before changing a workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-invalid-'));
  try {
    fs.writeFileSync(path.join(root, '.mcp.json'), '{broken');
    assert.throws(() => initializeWorkspace(root));
    assert.equal(fs.existsSync(path.join(root, '.git')), false);
    assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), '{broken');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('setup ignores an npm-local git executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-init-git-shim-'));
  const shimDir = path.join(root, 'node_modules', '.bin');
  try {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'git');
    fs.writeFileSync(shimPath, '#!/bin/sh\necho "unexpected local git shim" >&2\nexit 77\n');
    fs.chmodSync(shimPath, 0o755);
    const entry = `import { initializeWorkspace } from ${JSON.stringify(pathToFileURL(path.resolve('src/init.mjs')).href)}; initializeWorkspace(${JSON.stringify(root)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', entry], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(root, 'rev-parse', '--show-toplevel'), root);
    assert.match(git(root, 'log', '-1', '--format=%s'), /initialize VibeSync repository/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('different projects negotiate separate HUDs; bundled dashboard works without setup', async () => {
  const roots = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-port-')));
  const dbs = roots.map(root => getDb(null, root));
  const instances = [];
  try {
    instances.push(await startServer({ port: 0, db: dbs[0], repoRoot: roots[0], quiet: true }));
    instances.push(await startServer({ port: instances[0].port, db: dbs[1], repoRoot: roots[1], quiet: true }));
    assert.equal(instances[1].isCompanion, false);
    assert.notEqual(instances[0].port, instances[1].port);
    const html = await (await fetch(`http://127.0.0.1:${instances[1].port}/`)).text();
    assert.ok(html.includes('features-root'));
    assert.ok(html.includes('window.__INITIAL_STATE__'));
  } finally {
    for (const instance of instances) await instance.close();
    dbs.forEach(closeDb);
    roots.forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  }
});

test('server without an injected database opens the explicitly selected project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-selected-'));
  let server;
  try {
    initializeWorkspace(root);
    server = await startServer({ port: 0, repoRoot: root, quiet: true });
    const state = await (await fetch(`http://127.0.0.1:${server.port}/api/state`)).json();
    assert.deepEqual(state.features, []);
    assert.deepEqual(state.tasks, []);
    const db = getDb(null, root);
    assert.equal(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file, path.join(root, '.vibesync/state.db'));
  } finally {
    if (server) await server.close();
    closeDb(getDb(null, root));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
