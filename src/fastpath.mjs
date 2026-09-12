/**
 * src/fastpath.mjs
 * 
 * VibeSync Frictionless Fast-Path Task Engine
 * Single-command task creation, worktree provisioning, and auto-detected verification.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.mjs';
import { listFeatures, createFeature } from './features.mjs';
import { createTask, getTask } from './tasks.mjs';
import { startTask, getTrunk } from './workspace.mjs';

/**
 * Automatically detects the primary verification gate command for the project.
 * 
 * @param {string} repoRoot 
 * @returns {string}
 */
export function detectDefaultGateCommand(repoRoot = process.cwd()) {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) return 'npm test';
    } catch {}
  }

  if (fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(repoRoot, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(repoRoot, 'pytest.ini')) || fs.existsSync(path.join(repoRoot, 'setup.py')) || fs.existsSync(path.join(repoRoot, 'pyproject.toml'))) {
    return 'pytest';
  }
  if (fs.existsSync(path.join(repoRoot, 'Makefile'))) return 'make test';

  return 'npm test';
}

/**
 * Prepares or finds a parent feature contract for the fast-path task.
 * 
 * @param {DatabaseSync} db 
 * @returns {object}
 */
export function getOrCreateFastPathFeature(db = getDb()) {
  const features = listFeatures(db) || [];
  const existing = features.find(f => f.status !== 'settled');
  if (existing) return existing;

  const featureId = 'FEAT-FAST';
  try {
    return createFeature({
      id: featureId,
      title: 'Fast-Path Quick Tasks',
      target_milestone: 'v0.5',
      spec_markdown: 'Container feature contract for rapid fast-path developer tasks.'
    }, db);
  } catch {
    const found = features.find(f => f.id === featureId);
    if (found) return found;
    throw new Error('Could not initialize fast-path feature container.');
  }
}

/**
 * Initializes and provisions an isolated fast-path task in one frictionless step.
 * 
 * @param {object} params
 * @param {string} params.prompt - Task instruction or summary
 * @param {string} [params.actor='human'] - Assigned actor name
 * @param {string} [params.gate] - Optional custom gate command override
 * @param {string[]} [params.allowedPaths] - Optional allowed path globs (defaults to ['*'])
 * @param {string} [params.repoRoot=process.cwd()] - Repository root
 * @param {DatabaseSync} [params.db] - Database connection
 * @returns {object}
 */
export function provisionFastPathTask(params) {
  const {
    prompt,
    actor = 'human',
    gate = null,
    allowedPaths = ['*'],
    repoRoot = process.cwd(),
    db = getDb(null, repoRoot)
  } = params;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('A non-empty task description or prompt is required for fast-path execution.');
  }

  const cleanTitle = prompt.trim();
  const feature = getOrCreateFastPathFeature(db);

  // Generate deterministic unique task ID
  const timestamp = Date.now().toString(36).slice(-5).toUpperCase();
  const taskId = `TASK-FAST-${timestamp}`;
  const gateCmd = gate || detectDefaultGateCommand(repoRoot);

  // 1. Register task in relational engine
  createTask({
    id: taskId,
    feature_id: feature.id,
    title: cleanTitle,
    allowed_paths: allowedPaths,
    required_gates: [gateCmd],
    priority: 'medium'
  }, db);

  // 2. Provision isolated Git worktree & start task lease
  const claimResult = startTask({
    taskId,
    actorName: actor
  }, db, repoRoot);

  return {
    taskId,
    featureId: feature.id,
    title: cleanTitle,
    actor,
    gate: gateCmd,
    worktreePath: claimResult.worktreePath,
    branch: claimResult.task?.branch_name || `task/${taskId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
    leaseExpiresAt: claimResult.task?.lease_expires_at,
    leaseToken: claimResult.leaseToken
  };
}
