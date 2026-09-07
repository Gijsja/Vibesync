import path from 'node:path';

// Filesystem Directories and Files
export const VIBESYNC_DIR = '.vibesync';
export const DB_FILE = '.vibesync/state.db';
export const ARTIFACTS_DIR = '.vibesync/artifacts';
export const INCUBATOR_BRANCH = 'vibesync/incubator';
export const HUD_URL_FILE = '.vibesync/hud.url';
export const DASHBOARD_FILE = '.vibesync/dashboard.html';
export const LOG_FILE = '.vibesync/vibesync.log';
export const ACTIVE_TASK_FILENAME = '.vibesync_ACTIVE_TASK.md';
export const USAGE_CONFIG_FILE = '.vibesync/usage.json';

// Supported AI Providers Configuration
export const DEFAULT_PROVIDERS = Object.freeze([
  {
    id: 'gemini',
    name: 'Google Gemini',
    actorName: 'gemini-antigravity',
    aliases: ['gemini', 'antigravity', 'gemini-antigravity'],
    icon: '✨',
    color: '#38bdf8',
    limit5h: 100,
    unit: 'req'
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    actorName: 'openai-codex',
    aliases: ['codex', 'openai', 'openai-codex'],
    icon: '⚡',
    color: '#34d399',
    limit5h: 100,
    unit: 'req'
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    actorName: 'anthropic-claude',
    aliases: ['claude', 'anthropic', 'anthropic-claude'],
    icon: '🟣',
    color: '#c084fc',
    limit5h: 100,
    unit: 'req'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Coder',
    actorName: 'deepseek-coder',
    aliases: ['deepseek', 'deepseek-coder'],
    icon: '🐋',
    color: '#60a5fa',
    limit5h: 100,
    unit: 'req'
  }
]);

// Engine Constants
export const LEASE_TTL_MINUTES = 45;
export const MAX_FAILURES = 3;
export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_PORT = 4040;
export const DEFAULT_HTTP_PORT = 4040;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const GIT_NOTES_REF = 'refs/notes/vibesync';
export const ARTIFACT_HASH_LENGTH = 12;

// Strict Schema Enums
export const INCUBATOR_CATEGORIES = Object.freeze([
  'speculative_feature',
  'architecture_insight',
  'debt',
  'ux_polish',
  'convention'
]);

export const INCUBATOR_STATUSES = Object.freeze([
  'parked',
  'promoted',
  'discarded',
  'merged'
]);

export const FEATURE_STATUSES = Object.freeze([
  'draft',
  'ready',
  'in_progress',
  'settled'
]);

export const TASK_STATUSES = Object.freeze([
  'backlog',
  'ready',
  'in_progress',
  'review',
  'settled',
  'blocked'
]);

export const PRIORITY_LEVELS = Object.freeze([
  'urgent',
  'high',
  'medium',
  'low'
]);

export const SETTLEMENT_ACTIONS = Object.freeze([
  'incubator_logged',
  'incubator_merged',
  'feature_created',
  'task_claimed',
  'gate_failed',
  'gate_passed',
  'circuit_breaker_tripped',
  'task_settled',
  'feature_settled',
  'lease_released',
  'ejected_to_human',
  'repaired_from_git'
]);

// Path Resolution Helpers
export function resolveRepoPath(relPath, repoRoot = process.cwd()) {
  return path.resolve(repoRoot, relPath);
}

export function getVibeSyncDir(repoRoot = process.cwd()) {
  return resolveRepoPath(VIBESYNC_DIR, repoRoot);
}

export function getDbPath(repoRoot = process.cwd()) {
  return resolveRepoPath(DB_FILE, repoRoot);
}

export function getArtifactsDir(repoRoot = process.cwd()) {
  return resolveRepoPath(ARTIFACTS_DIR, repoRoot);
}

export function getHudUrlPath(repoRoot = process.cwd()) {
  return resolveRepoPath(HUD_URL_FILE, repoRoot);
}

export function getDashboardPath(repoRoot = process.cwd()) {
  return resolveRepoPath(DASHBOARD_FILE, repoRoot);
}

export function getUsageConfigPath(repoRoot = process.cwd()) {
  return resolveRepoPath(USAGE_CONFIG_FILE, repoRoot);
}

export function getMcpConfigPath(repoRoot = process.cwd()) {
  return resolveRepoPath('.mcp.json', repoRoot);
}
