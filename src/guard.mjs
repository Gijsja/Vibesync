/**
 * src/guard.mjs
 * 
 * VibeSync Path Whitelist Guard & Scope Boundary Enforcement
 * Milestone 2: Git Judicial Harness (Feature 15)
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import picomatch from 'picomatch';
import { execGitWithBackoff } from './incubator.mjs';

/**
 * Checks whether a path attempts directory traversal outside the repository or sandbox.
 * 
 * @param {string} filePath 
 * @param {string} [repoRoot]
 * @returns {boolean}
 */
export function isTraversalViolation(filePath, repoRoot) {
  if (typeof filePath !== 'string') return false;
  const cleaned = filePath.replace(/\\/g, '/').trim();
  const segments = cleaned.split('/');
  if (segments.includes('..')) return true;
  const root = repoRoot || (path.isAbsolute(cleaned) ? process.cwd() : null);
  if (root && path.isAbsolute(cleaned)) {
    const resolvedRepo = path.resolve(root);
    const resolvedFile = path.resolve(cleaned);
    const rel = path.relative(resolvedRepo, resolvedFile).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes a glob pattern or directory prefix into picomatch-compatible globs.
 * 
 * @param {string} pattern
 * @returns {string[]}
 */
export function normalizePattern(pattern) {
  if (typeof pattern !== 'string') return [];
  let cleaned = pattern.replace(/\\/g, '/').trim();
  if (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  if (!cleaned) return [];
  if (cleaned === '*' || cleaned === '**') return ['**'];
  if (cleaned.endsWith('/**')) return [cleaned, cleaned.slice(0, -3), cleaned.slice(0, -3) + '/*'];
  if (cleaned.endsWith('/')) {
    const base = cleaned.slice(0, -1);
    return [base, cleaned + '**', cleaned + '*'];
  }
  // If pattern has no glob operators (*, ?, [, {, (), it may be a directory or exact file
  if (!/[*?{}()[\]]/.test(cleaned)) {
    return [cleaned, cleaned + '/**', cleaned + '/*'];
  }
  return [cleaned];
}

/**
 * Normalizes a file path to a POSIX repo-relative path.
 * 
 * @param {string} filePath
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function normalizeFilePath(filePath, repoRoot) {
  if (typeof filePath !== 'string') return '';
  let normalized = filePath.replace(/\\/g, '/');
  const root = repoRoot || process.cwd();
  if (path.isAbsolute(normalized)) {
    normalized = path.relative(root, normalized).replace(/\\/g, '/');
  }
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.startsWith('/') && !path.isAbsolute(normalized)) normalized = normalized.slice(1);
  return normalized;
}

/**
 * Determines whether a file is an internal harness metadata artifact that should be ignored.
 * 
 * @param {string} filePath 
 * @returns {boolean}
 */
export function isInternalHarnessArtifact(filePath) {
  const norm = normalizeFilePath(filePath);
  if (!norm) return true;
  if (norm === '.vibesync_ACTIVE_TASK.md' || norm.endsWith('/.vibesync_ACTIVE_TASK.md')) return true;
  if (/^\.vibesync\/(?:state\.db(?:-wal|-shm)?|hud\.url|vibesync\.log)$/.test(norm)) return true;
  if (norm.startsWith('.vibesync/worktrees/') || norm.startsWith('.vibesync/artifacts/')) return true;
  return false;
}

/**
 * Discovers all modified, staged, committed, and untracked files in a worktree or repo.
 * 
 * Supports signatures:
 * - getChangedFiles(baseCommit, worktreePath, options)
 * - getChangedFiles({ cwd, baseCommit, taskBranch, stagedOnly, includeUntracked })
 * 
 * @param {string|object} [baseCommitOrOptions]
 * @param {string} [maybeWorktreePath]
 * @param {object} [maybeOptions={}]
 * @returns {string[]} Sorted array of unique relative file paths
 */
export function getChangedFiles(baseCommitOrOptions, maybeWorktreePath, maybeOptions = {}) {
  let baseCommit = null;
  let taskBranch = null;
  let cwd = process.cwd();
  let stagedOnly = false;
  let includeUntracked = true;

  if (typeof baseCommitOrOptions === 'object' && baseCommitOrOptions !== null) {
    const opts = baseCommitOrOptions;
    baseCommit = opts.baseCommit || null;
    taskBranch = opts.taskBranch || opts.branch || null;
    cwd = opts.cwd || opts.worktreePath || process.cwd();
    stagedOnly = Boolean(opts.stagedOnly);
    includeUntracked = opts.includeUntracked !== false;
  } else {
    baseCommit = baseCommitOrOptions || null;
    cwd = maybeWorktreePath || process.cwd();
    const opts = maybeOptions || {};
    taskBranch = opts.taskBranch || opts.branch || null;
    stagedOnly = Boolean(opts.stagedOnly);
    includeUntracked = opts.includeUntracked !== false;
  }

  const changedSet = new Set();
  const collect = args => {
    const output = execGitWithBackoff(args, { cwd, raw: true });
    output.split('\0').filter(Boolean).forEach(file => changedSet.add(file));
  };
  // NUL-delimited output preserves spaces, newlines, and Unicode filenames.
  // Explicit base/branch failures must stop verification rather than hide changes.
  if (stagedOnly) collect(['diff', '--no-renames', '--name-only', '-z', '--cached', '--']);
  else {
    if (taskBranch) collect(['diff', '--no-renames', '--name-only', '-z', baseCommit || 'HEAD', taskBranch, '--']);
    let hasHead = true;
    try { execGitWithBackoff(['rev-parse', '--verify', 'HEAD'], { cwd }); } catch { hasHead = false; }
    if (baseCommit || hasHead) collect(['diff', '--no-renames', '--name-only', '-z', baseCommit || 'HEAD', '--']);
    collect(['diff', '--no-renames', '--name-only', '-z', '--cached', '--']);
    if (includeUntracked) collect(['ls-files', '--others', '--exclude-standard', '-z']);
  }
  const filtered = Array.from(changedSet).filter(file => !isInternalHarnessArtifact(file));

  return filtered.sort();
}

/**
 * Alias for getChangedFiles with (worktreePath, baseRef) signature.
 * 
 * @param {string} worktreePath 
 * @param {string} [baseRef='main'] 
 * @returns {string[]}
 */
export function getWorktreeChangedFiles(worktreePath, baseRef = 'main') {
  return getChangedFiles(baseRef, worktreePath);
}

/**
 * Captures the persistent workspace state that a gate is capable of changing.
 * Only tracked and non-ignored untracked files are included; OS sandboxing is
 * still required when ignored paths or transient writes must be contained.
 */
export function captureWorkspaceState(cwd = process.cwd()) {
  const files = getChangedFiles({ cwd });
  const entries = {};
  for (const file of files) {
    const absolute = path.join(cwd, file);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) entries[file] = `symlink:${fs.readlinkSync(absolute)}`;
      else if (stat.isFile()) entries[file] = `file:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
      else entries[file] = `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (error.code === 'ENOENT') entries[file] = 'missing';
      else throw error;
    }
  }
  let head = null;
  try { head = execGitWithBackoff(['rev-parse', 'HEAD'], { cwd }); } catch {}
  return { head, entries };
}

/** Return paths persistently changed between two gate workspace snapshots. */
export function diffWorkspaceStates(before, after) {
  const files = new Set([...Object.keys(before?.entries || {}), ...Object.keys(after?.entries || {})]);
  return [...files].filter(file => before?.entries?.[file] !== after?.entries?.[file]).sort();
}

/**
 * Enforces both the task's outer boundary and a gate's optional narrower
 * write_paths declaration. Git history mutation is never a permitted gate write.
 */
export function validateWorkspaceWriteDelta(before, after, allowedPaths = ['*'], declaredWritePaths = []) {
  const writes = diffWorkspaceStates(before, after);
  const taskCheck = validatePathWhitelist(writes, allowedPaths);
  const declaration = Array.isArray(declaredWritePaths) && declaredWritePaths.length ? declaredWritePaths : allowedPaths;
  const declarationCheck = validatePathWhitelist(writes, declaration);
  const gitMutation = Boolean(before?.head && after?.head && before.head !== after.head);
  const violations = [...new Set([
    ...taskCheck.violations,
    ...declarationCheck.violations,
    ...(gitMutation ? ['.git/HEAD'] : [])
  ])].sort();
  return {
    valid: violations.length === 0,
    writes,
    violations,
    allowedPatterns: taskCheck.allowedPatterns,
    declaredWritePaths: declaration,
    gitMutation,
    error: violations.length
      ? `Gate Write Scope Violation: command persisted changes outside its declared boundary:\n${violations.join('\n')}`
      : null
  };
}

/**
 * Validates a list of changed files against allowed path patterns using picomatch.
 * 
 * @param {string[]|string} changedFiles
 * @param {string[]|string|null} allowedPaths
 * @param {object} [options={}]
 * @param {string} [options.repoRoot]
 * @returns {{ valid: boolean, violations: string[], allowedPatterns: string[], error?: string }}
 */
export function validatePathWhitelist(changedFiles, allowedPaths, options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  // Normalize changedFiles into array
  const rawList = Array.isArray(changedFiles) ? changedFiles : (changedFiles ? [changedFiles] : []);

  // Filter and normalize
  const filesList = [];
  const traversalViolations = [];

  for (const rawFile of rawList) {
    if (!rawFile) continue;
    if (isTraversalViolation(rawFile, repoRoot)) {
      traversalViolations.push(rawFile);
      continue;
    }
    const normalized = normalizeFilePath(rawFile, repoRoot);
    if (
      isTraversalViolation(normalized, repoRoot) ||
      normalized.startsWith('..') ||
      path.isAbsolute(normalized)
    ) {
      traversalViolations.push(rawFile);
      continue;
    }
    if (normalized && !isInternalHarnessArtifact(normalized)) {
      filesList.push(normalized);
    }
  }

  // If traversal violations occurred, reject immediately
  if (traversalViolations.length > 0) {
    return {
      valid: false,
      violations: traversalViolations,
      allowedPatterns: Array.isArray(allowedPaths) ? allowedPaths : [String(allowedPaths)],
      error: `Scope Boundary Violation: Detected directory traversal attempt:\n${traversalViolations.join('\n')}`
    };
  }

  // If no files changed, validation trivially passes
  if (filesList.length === 0) {
    return { valid: true, violations: [], allowedPatterns: [] };
  }

  // Parse allowedPaths
  let rawPatterns = allowedPaths;
  if (typeof rawPatterns === 'string') {
    try {
      rawPatterns = JSON.parse(rawPatterns);
    } catch {
      rawPatterns = [rawPatterns];
    }
  }
  if (rawPatterns === null || rawPatterns === undefined) {
    rawPatterns = ['*'];
  }
  if (!Array.isArray(rawPatterns)) {
    rawPatterns = [String(rawPatterns)];
  }

  // Universal wildcard check
  if (rawPatterns.includes('*') || rawPatterns.includes('**')) {
    return { valid: true, violations: [], allowedPatterns: ['*'] };
  }

  // If allowedPaths is explicitly empty [], all changed files are violations
  if (rawPatterns.length === 0) {
    return {
      valid: false,
      violations: filesList,
      allowedPatterns: [],
      error: `Scope Boundary Violation: Task has no allowed paths; all ${filesList.length} modified file(s) are unauthorized:\n${filesList.join('\n')}`
    };
  }

  // Expand and normalize patterns
  const expandedPatterns = rawPatterns.flatMap(normalizePattern);
  const matcher = picomatch(expandedPatterns, { dot: true, posix: true });

  const violations = filesList.filter(file => !matcher(file));

  if (violations.length > 0) {
    return {
      valid: false,
      violations,
      allowedPatterns: rawPatterns,
      error: `Scope Boundary Violation: Agent touched unauthorized paths:\n${violations.join('\n')}`
    };
  }

  return {
    valid: true,
    violations: [],
    allowedPatterns: rawPatterns
  };
}

/**
 * Convenience helper to inspect a worktree and validate against allowed paths.
 * 
 * @param {string} worktreePath
 * @param {string[]|string} allowedPaths
 * @param {object} [options={}]
 * @param {string} [options.baseCommit]
 * @param {string} [options.taskBranch]
 * @param {string} [options.repoRoot]
 * @returns {{ valid: boolean, violations: string[], error?: string }}
 */
export function checkScopeBoundary(worktreePath, allowedPaths, options = {}) {
  const repoRoot = options.repoRoot || worktreePath;
  const changedFiles = getChangedFiles({
    cwd: worktreePath,
    baseCommit: options.baseCommit,
    taskBranch: options.taskBranch,
    stagedOnly: options.stagedOnly
  });

  return validatePathWhitelist(changedFiles, allowedPaths, {
    repoRoot
  });
}
