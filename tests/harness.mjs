/**
 * tests/harness.mjs - VibeSync E2E Test Infrastructure & Sandbox Harness
 * 
 * Synthesizes:
 * 1. Isolated Git Sandbox Fixture Generator & Git Plumbing Helpers (Explorer 1)
 * 2. MCP Stdio Client, HTTP REST Client, SSE Client, Port Concurrency & Teardown Helpers (Explorer 2)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { execSync, spawn } from "node:child_process";

// ============================================================================
// 1. Git Isolation Constants & Low-Level Helpers
// ============================================================================

export const ISOLATED_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "VibeSync Test Runner",
  GIT_AUTHOR_EMAIL: "test@vibesync.local",
  GIT_COMMITTER_NAME: "VibeSync Test Runner",
  GIT_COMMITTER_EMAIL: "test@vibesync.local"
};

/**
 * Synchronous sleep with atomic wait
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Executes a Git command with exponential backoff on index.lock contention
 */
export function execGit(cmd, cwd, options = {}) {
  let opts = options;
  if (typeof options === "string" || Buffer.isBuffer(options)) {
    opts = { input: options };
  }
  const maxRetries = opts.maxRetries ?? 5;
  const initialJitter = opts.initialJitter ?? 100;
  const env = { ...process.env, ...ISOLATED_GIT_ENV, ...(opts.env || {}) };

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const output = execSync(cmd, {
        cwd,
        env,
        input: opts.input,
        stdio: opts.stdio || ["pipe", "pipe", "pipe"],
        maxBuffer: opts.maxBuffer || 10 * 1024 * 1024
      });
      const stdout = output ? output.toString().trim() : "";
      if (opts.allowFailure) {
        return {
          status: 0,
          stdout,
          stderr: ""
        };
      }
      return stdout;
    } catch (err) {
      lastError = err;
      const stderr = err.stderr ? err.stderr.toString() : "";
      const stdout = err.stdout ? err.stdout.toString() : "";
      const message = err.message || "";

      // Check if lock file contention occurred
      const isLockContention = /\.git\/index\.lock|\.git\/refs\/.*\.lock/i.test(stderr + message);
      if (isLockContention && attempt < maxRetries) {
        const jitter = Math.floor((Math.random() * 200 + initialJitter) * attempt);
        sleepSync(jitter);
        continue;
      }

      if (opts.allowFailure) {
        return {
          status: err.status ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: err
        };
      }
      throw new Error(`execGit failed: "${cmd}" in ${cwd}\nStderr: ${stderr}\n${err.message}`);
    }
  }
  throw lastError;
}

/**
 * Safely removes a directory with retries for open file handles
 */
export function safeRmDir(targetDir, maxAttempts = 5, delayMs = 100) {
  if (!fs.existsSync(targetDir)) return;

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (err) {
      if (i === maxAttempts) {
        throw new Error(`safeRmDir failed after ${maxAttempts} attempts on ${targetDir}: ${err.message}`);
      }
      sleepSync(delayMs * i);
    }
  }
}

/**
 * Initializes a Git repository with local config isolation and an initial commit on main
 */
export function initRepo(targetDir, options = {}) {
  const initialBranch = options.initialBranch || "main";
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    execGit(`git init -b ${initialBranch}`, targetDir);
  } catch {
    execGit("git init", targetDir);
    execGit(`git branch -m ${initialBranch}`, targetDir);
  }

  // Local config isolation
  execGit('git config user.name "VibeSync Test Runner"', targetDir);
  execGit('git config user.email "test@vibesync.local"', targetDir);
  execGit("git config commit.gpgsign false", targetDir);
  execGit(`git config init.defaultBranch ${initialBranch}`, targetDir);
  execGit("git config core.autocrlf false", targetDir);

  // Baseline .gitignore
  const defaultGitignore = [
    "node_modules/",
    ".vibesync/state.db*",
    ".vibesync/artifacts/",
    ".vibesync/hud.url",
    ".vibesync/*.log",
    ".vibesync_ACTIVE_TASK.md"
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(targetDir, ".gitignore"), defaultGitignore);

  // Baseline README
  fs.writeFileSync(path.join(targetDir, "README.md"), "# VibeSync Test Sandbox\n");

  // Additional files
  if (options.files) {
    for (const [relPath, content] of Object.entries(options.files)) {
      const fullPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }

  if (options.initialCommit !== false) {
    execGit("git add -A", targetDir);
    execGit('git commit -m "chore: initial repository baseline"', targetDir);
  }

  const headSha = execGit("git rev-parse HEAD", targetDir);
  return { repoDir: targetDir, headSha };
}

// ============================================================================
// 2. Standalone Git Plumbing Helpers
// ============================================================================

export function createBranch(repoDir, branchName, fromRef = "main", options = {}) {
  const checkout = typeof options === "boolean" ? options : Boolean(options.checkout);
  if (checkout) {
    execGit(`git checkout -b ${branchName} ${fromRef}`, repoDir);
  } else {
    execGit(`git branch ${branchName} ${fromRef}`, repoDir);
  }
}

export function commitFile(repoDir, relativePath, content, commitMessage, options = {}) {
  if (relativePath) {
    const fullPath = path.join(repoDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    execGit(`git add "${relativePath}"`, repoDir);
  }

  let fullMsg = commitMessage || "chore: update file";
  if (options.trailers) {
    fullMsg += "\n\n" + Object.entries(options.trailers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }

  const allowEmptyFlag = options.allowEmpty || !relativePath ? "--allow-empty" : "";
  execGit(`git commit ${allowEmptyFlag} -m "${fullMsg.replace(/"/g, '\\"')}"`, repoDir);
  return getHeadSha(repoDir);
}

export function getHeadSha(repoDir, options = {}) {
  const flag = options.short ? "--short" : "";
  return execGit(`git rev-parse ${flag} HEAD`.trim(), repoDir);
}

export function getNotes(repoDir, commitSha, ref = "refs/notes/vibesync") {
  const res = execGit(`git notes --ref=${ref} show ${commitSha}`, repoDir, { allowFailure: true });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}

export function attachNote(repoDir, commitSha, payload, ref = "refs/notes/vibesync") {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  execGit(`git notes --ref=${ref} add -f -m '${raw.replace(/'/g, "'\\''")}' ${commitSha}`, repoDir);
}

export function getOrphanContent(repoDir, branchName = "vibesync/incubator", filePath = "incubator.json") {
  const res = execGit(`git show ${branchName}:${filePath}`, repoDir, { allowFailure: true });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}

export function syncOrphanContent(repoDir, recordsOrBranch, maybeFilePath, maybeContent, maybeCommitMessage) {
  let branchName = "vibesync/incubator";
  let filePath = "incubator.json";
  let payloadStr = "";
  let commitMessage = "sync: update orphan branch";

  if (typeof recordsOrBranch === "object" || Array.isArray(recordsOrBranch)) {
    payloadStr = JSON.stringify(recordsOrBranch, null, 2);
    if (typeof maybeFilePath === "string") branchName = maybeFilePath;
    if (typeof maybeContent === "string") filePath = maybeContent;
  } else if (typeof maybeContent === "string" || typeof maybeContent === "object") {
    branchName = recordsOrBranch;
    filePath = maybeFilePath;
    payloadStr = typeof maybeContent === "object" ? JSON.stringify(maybeContent, null, 2) : String(maybeContent);
    if (maybeCommitMessage) commitMessage = maybeCommitMessage;
  } else {
    payloadStr = String(recordsOrBranch);
    if (maybeFilePath) branchName = maybeFilePath;
    if (maybeContent) filePath = maybeContent;
  }

  const blobSha = execGit("git hash-object -w --stdin", repoDir, { input: payloadStr });
  const treeSha = execGit("git mktree", repoDir, { input: `100644 blob ${blobSha}\t${filePath}\n` });

  let parentFlag = "";
  try {
    const parentSha = execGit(`git rev-parse ${branchName}`, repoDir);
    if (parentSha) parentFlag = `-p ${parentSha}`;
  } catch {}

  const commitSha = execGit(`git commit-tree ${treeSha} ${parentFlag} -m "${commitMessage.replace(/"/g, '\\"')}"`, repoDir);
  execGit(`git update-ref refs/heads/${branchName} ${commitSha}`, repoDir);
  return commitSha;
}

export function getCommitTrailers(repoDir, commitSha = "HEAD") {
  const raw = execGit(`git log -1 --format="%(trailers:only,unfold)" ${commitSha}`, repoDir);
  const trailers = {};
  if (!raw) return trailers;
  for (const line of raw.split("\n")) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      trailers[match[1].trim()] = match[2].trim();
    }
  }
  return trailers;
}

export function simulateMergeTree(repoDir, targetBranch = "main", sourceBranch) {
  let target = targetBranch;
  let source = sourceBranch;
  if (!source) {
    source = targetBranch;
    target = "main";
  }

  const modernRes = execGit(`git merge-tree --write-tree ${target} ${source}`, repoDir, { allowFailure: true });
  const rawOutput = modernRes.stdout || modernRes.stderr || "";
  const hasConflict = modernRes.status !== 0 || rawOutput.includes("CONFLICT");

  const conflictFiles = [];
  if (hasConflict) {
    for (const line of rawOutput.split("\n")) {
      const match = line.match(/CONFLICT \([^)]+\): Merge conflict in (.*)$/);
      if (match) {
        conflictFiles.push(match[1].trim());
      }
    }
  }

  return {
    clean: !hasConflict,
    conflict: hasConflict,
    treeSha: !hasConflict && modernRes.stdout ? modernRes.stdout.split("\n")[0].trim() : null,
    conflictFiles,
    rawOutput
  };
}

export function createWorktree(repoDir, worktreePath, branchName, fromRef = "main") {
  const fullPath = path.isAbsolute(worktreePath) ? worktreePath : path.join(repoDir, worktreePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  let branchExists = false;
  try {
    execGit(`git rev-parse --verify ${branchName}`, repoDir);
    branchExists = true;
  } catch {}

  if (branchExists) {
    execGit(`git worktree add "${fullPath}" ${branchName}`, repoDir);
  } else {
    execGit(`git worktree add -b ${branchName} "${fullPath}" ${fromRef}`, repoDir);
  }

  return fullPath;
}

export function removeWorktree(repoDir, worktreePath) {
  const fullPath = path.isAbsolute(worktreePath) ? worktreePath : path.join(repoDir, worktreePath);
  execGit(`git worktree remove --force "${fullPath}"`, repoDir, { allowFailure: true });
  execGit("git worktree prune", repoDir, { allowFailure: true });
}

export function isDirty(repoDir) {
  const status = execGit("git status --porcelain", repoDir);
  const files = status.length > 0 ? status.split("\n").map(l => l.trim().slice(3)) : [];
  return {
    dirty: status.length > 0,
    files,
    output: status
  };
}

// ============================================================================
// 3. Git Sandbox Fixture Class
// ============================================================================

export class GitSandbox {
  constructor(options = {}) {
    this.options = options;
    const rawTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibesync-sandbox-"));
    this.dir = fs.realpathSync(rawTmpDir);
    this.worktrees = new Set();
    this.openDbs = new Set();
    this.childProcesses = new Set();
    this.activeServers = new Set();
    this.cleanedUp = false;

    initRepo(this.dir, options);
  }

  registerDb(db) {
    this.openDbs.add(db);
    return db;
  }

  registerProcess(proc) {
    this.childProcesses.add(proc);
    registerProcess(proc);
    return proc;
  }

  execGit(cmd, options = {}) {
    return execGit(cmd, this.dir, options);
  }

  getHeadSha(options = {}) {
    return getHeadSha(this.dir, options);
  }

  createBranch(branchName, fromRef = "main", checkout = false) {
    createBranch(this.dir, branchName, fromRef, checkout);
  }

  checkout(branchOrRef) {
    execGit(`git checkout ${branchOrRef}`, this.dir);
  }

  commitFile(relativePath, content, commitMessage, options = {}) {
    return commitFile(this.dir, relativePath, content, commitMessage, options);
  }

  getNotes(commitSha, ref = "refs/notes/vibesync") {
    return getNotes(this.dir, commitSha, ref);
  }

  attachNote(commitSha, payload, ref = "refs/notes/vibesync") {
    attachNote(this.dir, commitSha, payload, ref);
  }

  getOrphanContent(branchName = "vibesync/incubator", filePath = "incubator.json") {
    return getOrphanContent(this.dir, branchName, filePath);
  }

  syncOrphanContent(records, branchName = "vibesync/incubator", filePath = "incubator.json") {
    return syncOrphanContent(this.dir, records, branchName, filePath);
  }

  getCommitTrailers(commitSha = "HEAD") {
    return getCommitTrailers(this.dir, commitSha);
  }

  simulateMergeTree(targetBranch = "main", sourceBranch) {
    return simulateMergeTree(this.dir, targetBranch, sourceBranch);
  }

  createWorktree(relativePath, branchName, fromRef = "main") {
    const fullPath = createWorktree(this.dir, relativePath, branchName, fromRef);
    this.worktrees.add(fullPath);
    return fullPath;
  }

  removeWorktree(worktreePath) {
    const fullPath = path.isAbsolute(worktreePath) ? worktreePath : path.join(this.dir, worktreePath);
    removeWorktree(this.dir, fullPath);
    this.worktrees.delete(fullPath);
  }

  setupMultiAgentWorktrees(agents = ["antigravity", "codex"]) {
    const result = {};
    for (const agent of agents) {
      const wtRel = path.join(".vibesync", "worktrees", agent);
      const wtBranch = `agent/${agent}`;
      result[agent] = this.createWorktree(wtRel, wtBranch, "main");
    }
    return result;
  }

  isDirty() {
    return isDirty(this.dir);
  }

  isWorkingTreeClean() {
    return !this.isDirty().dirty;
  }

  async spawnMcp(options = {}) {
    const srv = await spawnMcpServer({ cwd: this.dir, ...options });
    this.registerProcess(srv.proc);
    return srv;
  }

  async fetchState(port = 4040) {
    const client = new VibeSyncHttpClient(port, this.dir);
    return await client.getState();
  }

  async postAction(endpoint, payload = {}, port = 4040) {
    const client = new VibeSyncHttpClient(port, this.dir);
    return await client.request("POST", endpoint, { body: payload });
  }

  subscribeSse(callback, port = 4040) {
    const sse = new VibeSyncSseClient(`http://127.0.0.1:${port}/api/events`);
    sse.on("state", callback);
    sse.connect().catch(() => {});
    return sse;
  }

  async fetchDashboard(port = 4040) {
    const client = new VibeSyncHttpClient(port, this.dir);
    const res = await client.getHudHtml();
    return { status: res.status, body: res.html };
  }

  cleanup() {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    // 1. Terminate tracked subprocesses
    for (const proc of this.childProcesses) {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
    this.childProcesses.clear();

    // 2. Close registered databases
    for (const db of this.openDbs) {
      try {
        db.close();
      } catch {}
    }
    this.openDbs.clear();

    // 3. Remove worktrees
    for (const wt of this.worktrees) {
      try {
        execGit(`git worktree remove --force "${wt}"`, this.dir, { allowFailure: true });
      } catch {}
    }
    try {
      execGit("git worktree prune", this.dir, { allowFailure: true });
    } catch {}
    this.worktrees.clear();

    // 4. Remove sandbox directory
    safeRmDir(this.dir);
  }
}

export async function createSandbox(options = {}) {
  return new GitSandbox(options);
}

export async function withSandbox(fn, options = {}) {
  const sandbox = new GitSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

// ============================================================================
// 4. MCP Stdio Client Helper
// ============================================================================

export class McpRpcError extends Error {
  constructor(code, message, data) {
    super(`MCP JSON-RPC Error [${code}]: ${message}`);
    this.name = "McpRpcError";
    this.code = code;
    this.data = data;
  }
}

export class McpStdioClient extends EventEmitter {
  constructor(childProcess, defaultTimeoutMs = 10000) {
    super();
    this.proc = childProcess;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.requestIdSeq = 0;
    this.pendingRequests = new Map();

    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf-8");
      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          this.handleMessage(msg);
        } catch (err) {
          this.emit("parseError", { line: trimmed, error: err });
        }
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      this.stderrBuffer += text;
      this.emit("stderr", text);
    });

    this.proc.on("exit", (code, signal) => {
      for (const [id, pending] of this.pendingRequests.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server process exited with code ${code} (signal: ${signal}) during '${pending.method}'`));
      }
      this.pendingRequests.clear();
      this.emit("exit", { code, signal });
    });
  }

  handleMessage(msg) {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id);
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);

      if (msg.error) {
        pending.reject(new McpRpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        pending.resolve(msg.result);
      }
    } else if (msg.method && msg.id === undefined) {
      this.emit("notification", msg);
    } else {
      this.emit("message", msg);
    }
  }

  sendRequest(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    const id = ++this.requestIdSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request '${method}' (id ${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer, method, sentAt: Date.now() });

      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      try {
        if (this.proc.stdin && this.proc.stdin.writable && !this.proc.stdin.destroyed) {
          this.proc.stdin.write(payload);
        } else {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error("Cannot send request: process stdin is not writable"));
        }
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  sendNotification(method, params = {}) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      if (this.proc.stdin && this.proc.stdin.writable && !this.proc.stdin.destroyed) {
        this.proc.stdin.write(payload);
      }
    } catch {}
  }

  sendRaw(rawString) {
    try {
      if (this.proc.stdin && this.proc.stdin.writable && !this.proc.stdin.destroyed) {
        this.proc.stdin.write(rawString);
      }
    } catch {}
  }

  async initialize(clientInfo = { name: "vibesync-test-client", version: "1.0.0" }) {
    const res = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: true } },
      clientInfo
    });
    this.sendNotification("notifications/initialized", {});
    return res;
  }

  async callTool(name, argumentsObj = {}) {
    return await this.sendRequest("tools/call", { name, arguments: argumentsObj });
  }

  async callToolJson(name, argumentsObj = {}) {
    const res = await this.callTool(name, argumentsObj);
    if (res.isError) {
      const errText = res.content?.[0]?.text || "Tool execution failed";
      throw new Error(`Tool ${name} returned error: ${errText}`);
    }
    const rawText = res.content?.[0]?.text;
    if (!rawText) return null;
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }

  async getState() {
    return await this.callToolJson("vibesync_get_state", {});
  }

  async claimTask({ taskId, actorName, worktreePath }) {
    return await this.callTool("vibesync_claim_task", {
      task_id: taskId,
      actor_name: actorName,
      worktree_path: worktreePath
    });
  }

  async verifyAndSettle({ taskId, actorName, worktreePath }) {
    return await this.callToolJson("vibesync_verify_and_settle", {
      task_id: taskId,
      actor_name: actorName,
      worktree_path: worktreePath
    });
  }

  async parkInsight({ id, title, category, contextNotes, actorName }) {
    return await this.callTool("vibesync_park_insight", {
      id,
      title,
      category,
      context_notes: contextNotes,
      actor_name: actorName
    });
  }

  async settleFeature({ featureId, actorName }) {
    return await this.callToolJson("vibesync_settle_feature", {
      feature_id: featureId,
      actor_name: actorName
    });
  }

  async repairState() {
    return await this.callTool("vibesync_repair_state", {});
  }

  async listTools() {
    return await this.sendRequest("tools/list", {});
  }

  async readResource(uri) {
    return await this.sendRequest("resources/read", { uri });
  }

  async listResources() {
    return await this.sendRequest("resources/list", {});
  }

  async listPrompts() {
    return await this.sendRequest("prompts/list", {});
  }

  async getPrompt(name, argumentsObj = {}) {
    return await this.sendRequest("prompts/get", { name, arguments: argumentsObj });
  }

  getStderr() {
    return this.stderrBuffer;
  }

  waitForStderr(pattern, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const match = () => {
        if (typeof pattern === "string" && this.stderrBuffer.includes(pattern)) return true;
        if (pattern instanceof RegExp && pattern.test(this.stderrBuffer)) return true;
        return false;
      };

      if (match()) return resolve(this.stderrBuffer);

      const timer = setTimeout(() => {
        this.proc.stderr.removeListener("data", onData);
        reject(new Error(`Timeout waiting for stderr matching '${pattern}' after ${timeoutMs}ms. Actual:\n${this.stderrBuffer}`));
      }, timeoutMs);

      const onData = () => {
        if (match()) {
          clearTimeout(timer);
          this.proc.stderr.removeListener("data", onData);
          resolve(this.stderrBuffer);
        }
      };

      this.proc.stderr.on("data", onData);
    });
  }
}

// ============================================================================
// 5. HTTP Client Helper
// ============================================================================

export class VibeSyncHttpClient {
  constructor(portOrBaseUrl = 4040, sandboxDir = null) {
    if (typeof portOrBaseUrl === "string" && portOrBaseUrl.startsWith("http")) {
      this.baseUrl = portOrBaseUrl.replace(/\/$/, "");
    } else {
      this.baseUrl = `http://127.0.0.1:${portOrBaseUrl}`;
    }
    this.sandboxDir = sandboxDir;
  }

  async waitForReady(timeoutMs = 5000, intervalMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.baseUrl}/api/state`);
        if (res.status === 200) return;
      } catch {
        // Retry on connection refused
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`HTTP server at ${this.baseUrl} did not become ready within ${timeoutMs}ms`);
  }

  async getState() {
    const res = await fetch(`${this.baseUrl}/api/state`);
    if (!res.ok) throw new Error(`getState failed with status ${res.status}`);
    return await res.json();
  }

  async getHudHtml() {
    const res = await fetch(`${this.baseUrl}/`);
    const html = await res.text();
    return { status: res.status, headers: res.headers, html };
  }

  async ejectTask(taskId) {
    const res = await fetch(`${this.baseUrl}/api/eject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId })
    });
    return await res.json();
  }

  async parkIdea({ title, category = "architecture_insight", notes = "" }) {
    const res = await fetch(`${this.baseUrl}/api/park`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, category, notes })
    });
    return await res.json();
  }

  async hotfix(message = "hotfix: manual intervention") {
    const res = await fetch(`${this.baseUrl}/api/hotfix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    return await res.json();
  }

  async request(method, endpointPath, options = {}) {
    const url = `${this.baseUrl}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}`;
    const headers = { Accept: "application/json", ...options.headers };
    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof Uint8Array)) {
      body = JSON.stringify(body);
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, headers: res.headers, body: text, json };
  }
}

// ============================================================================
// 6. Server-Sent Events (SSE) Client Helper
// ============================================================================

export class VibeSyncSseClient extends EventEmitter {
  constructor(url = "http://127.0.0.1:4040/api/events") {
    super();
    this.url = new URL(url);
    this.req = null;
    this.history = [];
    this.buffer = "";
    this.isConnected = false;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let connectedFired = false;
      const timer = setTimeout(() => {
        this.close();
        reject(new Error(`SSE connection to ${this.url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.req = http.get(this.url, {
        headers: { Accept: "text/event-stream" },
        agent: new http.Agent({ keepAlive: false })
      }, (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          return reject(new Error(`SSE endpoint returned status ${res.statusCode}`));
        }

        const contentType = res.headers["content-type"] || "";
        if (!contentType.includes("text/event-stream")) {
          clearTimeout(timer);
          return reject(new Error(`Invalid SSE Content-Type: ${contentType}`));
        }

        this.isConnected = true;

        res.on("data", (chunk) => {
          this.buffer += chunk.toString("utf-8");
          const parts = this.buffer.split("\n\n");
          this.buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.trim()) continue;
            for (const line of part.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  this.history.push(data);
                  this.emit("state", data);
                  if (!connectedFired) {
                    connectedFired = true;
                    clearTimeout(timer);
                    resolve(data);
                  }
                } catch (err) {
                  this.emit("error", err);
                }
              }
            }
          }
        });

        res.on("end", () => {
          this.isConnected = false;
          this.emit("end");
        });
      });

      this.req.on("error", (err) => {
        if (!this.isConnected) {
          clearTimeout(timer);
          reject(err);
        } else {
          this.emit("error", err);
        }
      });
    });
  }

  async waitForState(predicate, timeoutMs = 5000) {
    // 1. Check history first to eliminate race conditions
    for (const pastState of this.history) {
      if (predicate(pastState)) return pastState;
    }

    // 2. Listen to future state broadcasts
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("state", onState);
        reject(new Error(`waitForState timed out after ${timeoutMs}ms. States received: ${this.history.length}`));
      }, timeoutMs);

      const onState = (state) => {
        if (predicate(state)) {
          clearTimeout(timer);
          this.removeListener("state", onState);
          resolve(state);
        }
      };

      this.on("state", onState);
    });
  }

  getLatestState() {
    return this.history[this.history.length - 1] ?? null;
  }

  getAllStates() {
    return [...this.history];
  }

  clearHistory() {
    this.history = [];
  }

  close() {
    if (this.req) {
      this.req.on("error", () => {}); // Swallow socket destruction errors
      this.req.destroy();
      this.req = null;
    }
    this.isConnected = false;
    this.removeAllListeners();
  }
}

// ============================================================================
// 7. Process, Port & Concurrency Helpers
// ============================================================================

export const activeProcesses = new Set();
export const activeServers = new Set();

export function registerProcess(proc) {
  activeProcesses.add(proc);
  proc.once("exit", () => activeProcesses.delete(proc));
  return proc;
}

export function unregisterProcess(proc) {
  activeProcesses.delete(proc);
}

export function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.once("connect", () => {
      socket.destroy();
      resolve(true); // Port is occupied
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false); // Port is free
    });
    socket.connect(port, host);
  });
}

export async function waitForPortFree(port, timeoutMs = 3000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inUse = await isPortInUse(port);
    if (!inUse) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Port ${port} was not freed within ${timeoutMs}ms`);
}

export function occupyPort(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => res.end("occupied"));
    server.once("error", reject);
    server.listen(port, host, () => {
      activeServers.add(server);
      resolve({
        port,
        host,
        close: () => new Promise((res) => {
          try {
            server.closeAllConnections?.();
            server.close(() => {
              activeServers.delete(server);
              res();
            });
          } catch {
            activeServers.delete(server);
            res();
          }
        })
      });
    });
  });
}

export function terminateProcess(child, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || !child.pid) {
      if (child) activeProcesses.delete(child);
      return resolve();
    }

    let forceKillTimer = null;

    const onExit = () => {
      clearTimeout(forceKillTimer);
      activeProcesses.delete(child);
      resolve();
    };

    child.once("exit", onExit);

    // 1. Attempt graceful close
    try {
      if (child.stdin && child.stdin.writable && !child.stdin.destroyed) {
        child.stdin.end();
      }
      child.kill("SIGTERM");
    } catch {}

    // 2. Force kill fallback
    forceKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      activeProcesses.delete(child);
      resolve();
    }, timeoutMs);
  });
}

export async function terminateAllProcesses(timeoutMs = 2000) {
  const killPromises = Array.from(activeProcesses).map(proc => terminateProcess(proc, timeoutMs));
  const serverPromises = Array.from(activeServers).map(srv => {
    return new Promise((res) => {
      try {
        srv.closeAllConnections?.();
        srv.close(() => {
          activeServers.delete(srv);
          res();
        });
      } catch {
        activeServers.delete(srv);
        res();
      }
    });
  });
  await Promise.allSettled([...killPromises, ...serverPromises]);
  activeProcesses.clear();
  activeServers.clear();
}

export async function cleanupAll() {
  await terminateAllProcesses();
}

let cleanupRegistered = false;
export function setupHarnessCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const exitHandler = () => {
    for (const proc of activeProcesses) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    for (const srv of activeServers) {
      try { srv.closeAllConnections?.(); srv.close?.(); } catch {}
    }
  };
  process.once("SIGINT", () => { exitHandler(); process.exit(130); });
  process.once("SIGTERM", () => { exitHandler(); process.exit(143); });
  process.once("exit", exitHandler);
}

export async function spawnMcpServer(optionsOrSandboxDir, envOrOptions = {}) {
  setupHarnessCleanup();
  let options = {};
  if (typeof optionsOrSandboxDir === "string") {
    options = { cwd: optionsOrSandboxDir, env: envOrOptions };
  } else {
    options = { ...optionsOrSandboxDir };
    if (envOrOptions && typeof envOrOptions === "object") {
      options.env = { ...(options.env || {}), ...envOrOptions };
    }
  }

  const cwd = options.cwd;
  const scriptPath = options.scriptPath || path.resolve(process.cwd(), "scripts/vibesync.mjs");
  const port = options.port || 4040;
  const env = { ...process.env, VIBESYNC_PORT: String(port), ...(options.env || {}) };

  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  registerProcess(child);

  const client = new McpStdioClient(child, options.requestTimeoutMs || 10000);
  const http = new VibeSyncHttpClient(port, cwd);
  const sse = new VibeSyncSseClient(`http://127.0.0.1:${port}/api/events`);

  if (options.autoInit !== false) {
    try {
      await client.initialize();
    } catch {
      // Auto-init may be called before vibesync.mjs exists; retain client
    }
  }

  return {
    proc: child,
    client,
    http,
    sse,
    pid: child.pid,
    cwd,
    port,
    async stop(timeoutMs = 2000) {
      sse.close();
      await terminateProcess(child, timeoutMs);
      await waitForPortFree(port).catch(() => {});
    }
  };
}

export async function spawnSiblingMcpServers(sandbox1, sandbox2, options = {}) {
  const dir1 = typeof sandbox1 === "string" ? sandbox1 : sandbox1.dir;
  const dir2 = typeof sandbox2 === "string" ? sandbox2 : sandbox2.dir;
  const port = options.port || 4040;

  const server1 = await spawnMcpServer({ cwd: dir1, port, ...options });
  try {
    await server1.http.waitForReady(3000);
  } catch {}

  const server2 = await spawnMcpServer({ cwd: dir2, port, ...options });

  return { server1, server2 };
}
