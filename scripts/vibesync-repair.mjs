#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getDb, closeDb } from '../src/db.mjs';
import { repairDatabase } from '../src/repair.mjs';

async function main() {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('Usage: vibesync-repair [--repo PATH]\nStop the project HUD/MCP before running recovery. Existing database files are backed up automatically.'); return; }
  const root = path.resolve(values.repo || process.cwd());
  const directory = path.join(root, '.vibesync');
  const target = path.join(directory, 'state.db');
  const urlFile = path.join(directory, 'hud.url');
  if (fs.existsSync(urlFile)) {
    let running = false;
    try {
      const url = new URL(fs.readFileSync(urlFile, 'utf8').trim());
      if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        const res = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(750) });
        running = res.ok && (await res.json()).workspace?.root === fs.realpathSync(root);
      }
    } catch {}
    if (running) throw new Error('Stop this project’s HUD/MCP before CLI recovery, or use the connected MCP repair tool.');
  }
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.repair-${process.pid}-${Date.now()}.db`);
  const db = getDb(temporary, root);
  try {
    const result = repairDatabase(root, db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    closeDb(db);
    const existing = ['', '-wal', '-shm'].filter(suffix => fs.existsSync(target + suffix));
    let backup = null;
    if (existing.length) {
      backup = path.join(directory, 'backups', `${Date.now()}-${process.pid}`);
      fs.mkdirSync(backup, { recursive: true });
      for (const suffix of existing) fs.copyFileSync(target + suffix, path.join(backup, `state.db${suffix}`));
    }
    fs.renameSync(temporary, target);
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(target + suffix)) fs.unlinkSync(target + suffix);
    console.log(`Reconciliation Complete\nRecovery mode: ${result.recoveryMode || 'legacy'}\nFeatures: ${result.featuresCount} · Tasks: ${result.tasksCount} · Ideas: ${result.incubatorCount} · Events: ${result.eventsCount}\nDatabase: ${target}${backup ? `\nPrevious database backup: ${backup}` : ''}`);
    if (result.recoveryMode === 'legacy') console.log('No full checkpoint was available. Legacy recovery reconstructs only the provenance stored in Git trailers, notes and incubator history.');
  } finally {
    closeDb(db);
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(temporary + suffix)) fs.unlinkSync(temporary + suffix);
  }
}
main().catch(err => { console.error(`Recovery failed: ${err.message}`); process.exitCode = 1; });
