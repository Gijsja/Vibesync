import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getDb, closeDb } from './db.mjs';

const runtimePath = fileURLToPath(new URL('../scripts/vibesync.mjs', import.meta.url));
export const bundledDashboardPath = fileURLToPath(new URL('../.vibesync/dashboard.html', import.meta.url));
const ignores = ['.vibesync/*.db', '.vibesync/*.db-wal', '.vibesync/*.db-shm', '.vibesync/*.log',
  '.vibesync/hud.url', '.vibesync/artifacts/', '.vibesync/backups/', '.vibesync/worktrees/', '.vibesync_ACTIVE_TASK.md'];

/** Local exclusions survive stashing an uncommitted .gitignore. */
export function ensureRuntimeExcludes(repoRoot) {
  const excludePath = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const missing = ignores.filter(line => !existing.split(/\r?\n/).includes(line));
  if (missing.length) fs.appendFileSync(excludePath, '\n# VibeSync runtime\n' + missing.join('\n') + '\n');
}

/** Initialize only VibeSync-owned state; existing MCP servers and dashboard customizations survive. */
export function initializeWorkspace(repoRoot = process.cwd()) {
  repoRoot = path.resolve(repoRoot);
  fs.mkdirSync(repoRoot, { recursive: true });
  const configPath = path.join(repoRoot, '.mcp.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    throw new Error('Existing .mcp.json must contain an object with an optional mcpServers object.');
  }
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    const root = git(['rev-parse', '--show-toplevel']);
    if (fs.realpathSync(root) !== fs.realpathSync(repoRoot)) throw new Error('Initialize from the repository root.');
  } catch (err) {
    if (err.message === 'Initialize from the repository root.') throw err;
    git(['init', '-b', 'main']);
  }
  let hasCommits = true;
  try { git(['rev-parse', '--verify', 'HEAD']); } catch { hasCommits = false; }
  // Do not stage or commit user files as a side effect of setup.
  if (!hasCommits) {
    git(['-c', 'user.name=VibeSync Engine', '-c', 'user.email=engine@local', 'commit', '--allow-empty', '--only', '-m', 'chore: initialize VibeSync repository']);
  }
  ensureRuntimeExcludes(repoRoot);
  const ignorePath = path.join(repoRoot, '.gitignore');
  const existingIgnore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const missing = ignores.filter(line => !existingIgnore.split(/\r?\n/).includes(line));
  if (missing.length) fs.writeFileSync(ignorePath, `${existingIgnore}${existingIgnore.endsWith('\n') || !existingIgnore ? '' : '\n'}\n# VibeSync local runtime\n${missing.join('\n')}\n`);
  const db = getDb(null, repoRoot);
  closeDb(db);
  const policyPath = path.join(repoRoot, '.vibesync', 'policy.json');
  if (!fs.existsSync(policyPath)) fs.writeFileSync(policyPath, JSON.stringify({
    version: 2,
    approval_mode: 'enforce',
    sandbox_mode: 'required',
    network_default: false,
    allow_legacy_commands: false
  }, null, 2) + '\n');
  const dashboardPath = path.join(repoRoot, '.vibesync', 'dashboard.html');
  if (!fs.existsSync(dashboardPath)) fs.copyFileSync(bundledDashboardPath, dashboardPath);
  config.mcpServers ||= {};
  // Keep a deliberately customized existing VibeSync binding.
  config.mcpServers.vibesync ||= { command: process.execPath, args: [runtimePath, '--repo', repoRoot] };
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(temporary, configPath);
  return { repoRoot, dashboardPath, configPath, policyPath, createdAnchor: !hasCommits };
}
