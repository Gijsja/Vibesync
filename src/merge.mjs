/**
 * src/merge.mjs
 * 
 * VibeSync In-Memory Merge Collision Detector
 * Milestone 2: Git Judicial Harness (Features 20 & 21)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGitWithBackoff } from './incubator.mjs';

/**
 * Extracts unique conflicting file paths from git merge-tree output.
 * 
 * @param {string} rawOutput 
 * @returns {string[]} Sorted array of conflicting file paths
 */
export function extractConflictFiles(rawOutput) {
  const files = new Set();
  if (!rawOutput) return [];

  // 1. Stage lines parser: stages 1 (ancestor), 2 (target/ours), 3 (source/theirs)
  const stageRegex = /^\d{6}\s+[0-9a-f]{40}\s+[123]\t(.*)$/gm;
  let stageMatch;
  while ((stageMatch = stageRegex.exec(rawOutput)) !== null) {
    const file = stageMatch[1].trim();
    if (file) files.add(file);
  }

  // 2. Conflict message parser
  const conflictRegex = /CONFLICT\s+\([^)]+\):\s+(?:(?:Merge conflict in|deleted in)\s+)?([^\n\r]+)/gm;
  let conflictMatch;
  while ((conflictMatch = conflictRegex.exec(rawOutput)) !== null) {
    let candidate = conflictMatch[1].trim();
    // Strip trailing phrases like "and modified in...", "version left in..."
    candidate = candidate.replace(/\s+(?:deleted in|and modified in|version left in).*/i, '').trim();
    if (candidate) files.add(candidate);
  }

  return Array.from(files).sort();
}

/**
 * Parses raw git merge-tree output and exit status into a structured object.
 * 
 * @param {string} rawOutput 
 * @param {number} [status=0] 
 * @returns {{ clean: boolean, conflict: boolean, treeSha: string|null, conflictFiles: string[], rawOutput: string }}
 */
export function parseMergeTreeOutput(rawOutput, status = 0) {
  const output = (rawOutput || '').trim();
  const lines = output ? output.split('\n') : [];
  const firstLine = lines.length > 0 ? lines[0].trim() : '';
  const isTreeSha = /^[0-9a-f]{40}$/i.test(firstLine);

  const hasConflictMarkers = output.includes('<<<<<<<') || output.includes('=======') || output.includes('CONFLICT');
  const isConflict = status !== 0 || hasConflictMarkers;

  const conflictFiles = isConflict ? extractConflictFiles(output) : [];
  const treeSha = (!isConflict && isTreeSha) ? firstLine : (isTreeSha ? firstLine : null);

  return {
    clean: !isConflict,
    conflict: isConflict,
    treeSha,
    conflictFiles,
    rawOutput: output
  };
}

/**
 * Resolves polymorphic arguments for simulateMergeTree.
 * Supports:
 * - (baseBranch, taskBranch, repoRoot)
 * - (repoRoot, baseBranch, taskBranch)
 * - ({ baseBranch, taskBranch, repoRoot, baseRef })
 */
function resolveMergeTreeArgs(arg1, arg2, arg3) {
  let repoRoot = process.cwd();
  let baseBranch = 'main';
  let taskBranch = null;
  let baseRef = null;

  if (typeof arg1 === 'object' && arg1 !== null) {
    repoRoot = arg1.repoRoot || process.cwd();
    baseBranch = arg1.baseBranch || arg1.targetBranch || arg1.targetRef || 'main';
    taskBranch = arg1.taskBranch || arg1.sourceBranch || arg1.sourceRef || arg1.branchName;
    baseRef = arg1.baseRef || null;
    return { repoRoot, baseBranch, taskBranch, baseRef };
  }

  if (typeof arg3 === 'string' && arg3.trim()) {
    // 3 string arguments: determine which is repoRoot vs branches
    const isArg1Dir = (arg1.startsWith('/') || arg1.startsWith('.')) && fs.existsSync(arg1);
    const isArg3Dir = (arg3.startsWith('/') || arg3.startsWith('.')) && fs.existsSync(arg3);

    if (isArg1Dir && !isArg3Dir) {
      repoRoot = arg1;
      baseBranch = arg2;
      taskBranch = arg3;
    } else {
      baseBranch = arg1;
      taskBranch = arg2;
      repoRoot = arg3;
    }
  } else if (typeof arg2 === 'string' && arg2.trim()) {
    // 2 string arguments
    const isArg1Dir = (arg1.startsWith('/') || arg1.startsWith('.')) && fs.existsSync(arg1);
    if (isArg1Dir) {
      repoRoot = arg1;
      baseBranch = 'main';
      taskBranch = arg2;
    } else {
      baseBranch = arg1;
      taskBranch = arg2;
      repoRoot = process.cwd();
    }
  } else if (typeof arg1 === 'string' && arg1.trim()) {
    // 1 string argument: assume taskBranch
    taskBranch = arg1;
    baseBranch = 'main';
    repoRoot = process.cwd();
  }

  return { repoRoot, baseBranch, taskBranch, baseRef };
}

/**
 * Simulates a merge in memory using `git merge-tree --write-tree` without modifying disk.
 * 
 * @param {string|object} arg1 - baseBranch, repoRoot, or options object
 * @param {string} [arg2] - taskBranch or baseBranch
 * @param {string} [arg3] - repoRoot or taskBranch
 * @returns {{ clean: boolean, conflict: boolean, safe: boolean, treeSha: string|null, conflictFiles: string[], error: string|null, rawOutput: string }}
 */
export function simulateMergeTree(arg1, arg2, arg3) {
  const { repoRoot, baseBranch, taskBranch, baseRef } = resolveMergeTreeArgs(arg1, arg2, arg3);

  if (!taskBranch) {
    throw new Error('simulateMergeTree: taskBranch (source branch) is required.');
  }

  const cmd = ['merge-tree', '--write-tree'];
  if (baseRef) {
    cmd.push('--merge-base', baseRef);
  }
  cmd.push(baseBranch, taskBranch);

  let rawOutput = '';
  let status = 0;
  let lastError = null;

  try {
    rawOutput = execGitWithBackoff(cmd, { cwd: repoRoot });
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : 1;
    rawOutput = (err.stdout ? err.stdout.toString() : '') + '\n' + (err.stderr ? err.stderr.toString() : '');
    lastError = err;
  }

  // Exit code >= 128 or fatal error output indicates non-existent ref or fatal git error
  const isFatalGitError = status >= 128 ||
    /not something we can merge/i.test(rawOutput) ||
    /fatal:/i.test(rawOutput);

  if (isFatalGitError) {
    const msg = lastError?.stderr?.toString()?.trim() || rawOutput.trim() || lastError?.message || `git merge-tree fatal error (code ${status})`;
    throw new Error(`simulateMergeTree failed: ${msg}`);
  }

  const parsed = parseMergeTreeOutput(rawOutput, status);
  const errorMsg = parsed.conflict
    ? `Semantic or physical merge collision detected in memory against ${baseBranch}${parsed.conflictFiles.length > 0 ? ': ' + parsed.conflictFiles.join(', ') : '.'}`
    : null;

  return {
    ...parsed,
    safe: parsed.clean,
    error: errorMsg
  };
}

/**
 * Convenience wrapper checking whether a task branch is safe to merge into trunk without collisions.
 * 
 * Supports:
 * - checkHeadlessMergeCollision(baseBranch, taskBranch, repoRoot)
 * - checkHeadlessMergeCollision(taskBranch, baseBranch, repoRoot)
 * - checkHeadlessMergeCollision(taskBranch, repoRoot)
 * 
 * @param {string} arg1 
 * @param {string} [arg2='main'] 
 * @param {string} [arg3=process.cwd()] 
 * @returns {{ safe: boolean, conflict: boolean, error: string|null, conflictFiles: string[], treeSha: string|null, rawOutput?: string }}
 */
export function checkHeadlessMergeCollision(arg1, arg2 = 'main', arg3 = process.cwd()) {
  try {
    const sim = simulateMergeTree(arg1, arg2, arg3);
    return {
      safe: sim.safe,
      conflict: sim.conflict,
      error: sim.error,
      conflictFiles: sim.conflictFiles,
      treeSha: sim.treeSha,
      rawOutput: sim.rawOutput
    };
  } catch (err) {
    return {
      safe: false,
      conflict: true,
      error: `git merge-tree evaluation failed: ${err.message}`,
      conflictFiles: [],
      treeSha: null
    };
  }
}
