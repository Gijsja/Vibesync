import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, migrateSchema } from '../src/db.mjs';
import { execGitWithBackoff } from '../src/incubator.mjs';
import { withSandbox } from './harness.mjs';

test('Git commands stay in the active checkout when a sibling .git_repo exists', async () => {
  await withSandbox(async sandbox => {
    const sibling = path.join(sandbox.dir, '.git_repo');
    execFileSync('git', ['init', '--quiet', sibling]);

    const commonDir = execGitWithBackoff(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: sandbox.dir });
    assert.equal(commonDir, path.join(sandbox.dir, '.git'));
  });
});

test('legacy incubator migration preserves rows without updated_at', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  db.exec('DROP TABLE incubator');
  db.exec(`
    CREATE TABLE incubator (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('speculative_feature', 'architecture_insight', 'debt', 'ux_polish')),
      context_notes TEXT NOT NULL,
      logged_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'parked' CHECK(status IN ('parked', 'promoted', 'discarded')),
      promoted_feature_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`INSERT INTO incubator (id, title, category, context_notes, logged_by, status)
    VALUES ('INC-LEGACY', 'Legacy idea', 'debt', 'Preserve this row', 'human', 'parked')`).run();

  migrateSchema(db);

  const row = db.prepare('SELECT id, title, target_scope, merged_into_id, updated_at FROM incubator WHERE id = ?').get('INC-LEGACY');
  assert.equal(row.id, 'INC-LEGACY');
  assert.equal(row.title, 'Legacy idea');
  assert.equal(row.target_scope, null);
  assert.equal(row.merged_into_id, null);
  assert.ok(row.updated_at);
  db.close();
});
