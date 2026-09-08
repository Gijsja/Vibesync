import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPublic, publicFiles } from '../scripts/check-public.mjs';
import { exportPublicSource } from '../scripts/export-public.mjs';

test('public file selection omits local state and rejects private files, credentials and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-public-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, '.agents'));
    fs.writeFileSync(path.join(root, '.agents/private.md'), 'private transcript');
    fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
    fs.writeFileSync(path.join(root, 'src/main.mjs'), 'export const ready = true;');
    assert.deepEqual(publicFiles(root), [path.join('src', 'main.mjs')]);
    fs.writeFileSync(path.join(root, 'src/.env'), 'example');
    assert.throws(() => checkPublic(root), /Private filename/);
    fs.unlinkSync(path.join(root, 'src/.env'));
    fs.writeFileSync(path.join(root, 'src/main.mjs'), 'gh' + 'p_' + 'x'.repeat(36));
    assert.throws(() => checkPublic(root), /possible GitHub token/);
    fs.writeFileSync(path.join(root, 'src/main.mjs'), 'safe');
    fs.symlinkSync(path.join(root, '.agents/private.md'), path.join(root, 'src/link.md'));
    assert.throws(() => checkPublic(root), /refuses symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('public export refuses source-contained targets and produces a clean file-only copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-export-source-'));
  const destination = root + '-destination';
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/main.mjs'), 'export const ready = true;');
    assert.throws(() => exportPublicSource(root, path.join(root, 'public-export')), /outside the source checkout/);
    const files = exportPublicSource(root, destination);
    assert.deepEqual(files, [path.join('src', 'main.mjs')]);
    assert.equal(fs.readFileSync(path.join(destination, 'src/main.mjs'), 'utf8'), 'export const ready = true;');
    assert.equal(fs.existsSync(path.join(destination, '.git')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
