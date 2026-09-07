/**
 * tests/harness.test.mjs - Verification and Self-Test Suite for Test Infrastructure
 * 
 * Verifies:
 * 1. Git Sandbox Creation & Configuration Isolation
 * 2. Git Plumbing Helpers (branches, commits, trailers, notes, orphan Merkle tree)
 * 3. In-Memory Merge Simulation (clean & conflict detection)
 * 4. Worktree Lifecycle (multi-agent setup, force removal, trunk preservation)
 * 5. Port & Process Concurrency Helpers (occupyPort, isPortInUse, terminateProcess)
 * 6. Client Abstractions (VibeSyncHttpClient, VibeSyncSseClient, McpStdioClient)
 * 7. Teardown Lifecycle (clean exit, no leaked directories or processes)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

import {
  createSandbox,
  withSandbox,
  execGit,
  initRepo,
  commitFile,
  createBranch,
  getHeadSha,
  getNotes,
  attachNote,
  getOrphanContent,
  syncOrphanContent,
  getCommitTrailers,
  simulateMergeTree,
  createWorktree,
  removeWorktree,
  isDirty,
  safeRmDir,
  isPortInUse,
  waitForPortFree,
  occupyPort,
  terminateProcess,
  terminateAllProcesses,
  VibeSyncHttpClient,
  VibeSyncSseClient,
  McpStdioClient,
  McpRpcError
} from "./harness.mjs";

describe("Test Infrastructure Harness Self-Test", () => {

  after(async () => {
    await terminateAllProcesses();
  });

  describe("1. Sandbox Creation & Git Config Isolation", () => {
    test("creates isolated repository in os.tmpdir() with baseline commit", async () => {
      const sandbox = await createSandbox();
      try {
        assert.ok(fs.existsSync(sandbox.dir), "Sandbox directory must exist");
        assert.ok(sandbox.dir.startsWith(fs.realpathSync(os.tmpdir())), "Must be in os.tmpdir()");
        assert.ok(fs.existsSync(path.join(sandbox.dir, ".git")), ".git directory must exist");
        assert.ok(fs.existsSync(path.join(sandbox.dir, ".gitignore")), ".gitignore must exist");
        assert.ok(fs.existsSync(path.join(sandbox.dir, "README.md")), "README.md must exist");

        const headSha = sandbox.getHeadSha();
        assert.strictEqual(typeof headSha, "string");
        assert.strictEqual(headSha.length, 40, "Initial commit SHA must be 40 chars");

        // Verify git config isolation
        const userName = sandbox.execGit("git config user.name");
        assert.strictEqual(userName, "VibeSync Test Runner");
        const userEmail = sandbox.execGit("git config user.email");
        assert.strictEqual(userEmail, "test@vibesync.local");
        const gpgSign = sandbox.execGit("git config commit.gpgsign");
        assert.strictEqual(gpgSign, "false");
      } finally {
        sandbox.cleanup();
        assert.strictEqual(fs.existsSync(sandbox.dir), false, "Sandbox dir must be removed after cleanup");
      }
    });

    test("withSandbox automatically cleans up after callback execution", async () => {
      let createdDir = null;
      await withSandbox(async (sandbox) => {
        createdDir = sandbox.dir;
        assert.ok(fs.existsSync(createdDir));
      });
      assert.ok(createdDir);
      assert.strictEqual(fs.existsSync(createdDir), false, "withSandbox must clean up directory");
    });
  });

  describe("2. Git Plumbing Helpers", () => {
    test("commitFile supports relative paths, custom messages, and RFC 2822 trailers", async () => {
      await withSandbox(async (sandbox) => {
        const sha = sandbox.commitFile(
          "src/shared/utils.js",
          "export const add = (a, b) => a + b;\n",
          "feat: add math utility",
          {
            trailers: {
              "Task-Id": "TASK-101",
              "Feature-Id": "FEAT-10",
              "Agent-Actor": "gemini-antigravity",
              "Base-Commit": "abc1234"
            }
          }
        );

        assert.strictEqual(sha.length, 40);
        assert.ok(fs.existsSync(path.join(sandbox.dir, "src/shared/utils.js")));

        const trailers = sandbox.getCommitTrailers(sha);
        assert.strictEqual(trailers["Task-Id"], "TASK-101");
        assert.strictEqual(trailers["Feature-Id"], "FEAT-10");
        assert.strictEqual(trailers["Agent-Actor"], "gemini-antigravity");
        assert.strictEqual(trailers["Base-Commit"], "abc1234");
      });
    });

    test("attachNote and getNotes support JSON serialization and missing notes", async () => {
      await withSandbox(async (sandbox) => {
        const sha = sandbox.getHeadSha();

        // Note before attachment returns null
        const emptyNote = sandbox.getNotes(sha);
        assert.strictEqual(emptyNote, null, "Missing note must return null without throwing");

        // Attach structured note
        const notePayload = {
          task_id: "TASK-101",
          gate: "PASS",
          verified_by: "runner"
        };
        sandbox.attachNote(sha, notePayload);

        const retrieved = sandbox.getNotes(sha);
        assert.deepStrictEqual(retrieved, notePayload);
      });
    });

    test("syncOrphanContent and getOrphanContent manage orphan branch without checkout", async () => {
      await withSandbox(async (sandbox) => {
        // Missing orphan branch returns null
        const missing = sandbox.getOrphanContent("vibesync/incubator", "incubator.json");
        assert.strictEqual(missing, null, "Missing orphan content must return null");

        // Sync initial records
        const records = [
          { id: "INC-001", title: "Speculative Caching", status: "parked" },
          { id: "INC-002", title: "AST Parser Refactor", status: "parked" }
        ];
        const orphanSha = sandbox.syncOrphanContent(records, "vibesync/incubator", "incubator.json");
        assert.strictEqual(typeof orphanSha, "string");
        assert.strictEqual(orphanSha.length, 40);

        // Retrieve and verify content
        const loaded = sandbox.getOrphanContent("vibesync/incubator", "incubator.json");
        assert.deepStrictEqual(loaded, records);

        // Verify zero footprint on main branch
        const mainLog = sandbox.execGit("git log main --oneline");
        assert.strictEqual(mainLog.includes("INC-001"), false, "Main branch must have zero footprint from incubator");
      });
    });

    test("isDirty and isWorkingTreeClean detect unstaged changes accurately", async () => {
      await withSandbox(async (sandbox) => {
        assert.strictEqual(sandbox.isWorkingTreeClean(), true);
        assert.strictEqual(sandbox.isDirty().dirty, false);

        // Create unstaged file
        fs.writeFileSync(path.join(sandbox.dir, "uncommitted.txt"), "hello dirty world\n");

        assert.strictEqual(sandbox.isWorkingTreeClean(), false);
        const status = sandbox.isDirty();
        assert.strictEqual(status.dirty, true);
        assert.ok(status.files.some(f => f.includes("uncommitted.txt")));
      });
    });
  });

  describe("3. In-Memory Merge Simulation (git merge-tree)", () => {
    test("detects clean merge without file conflicts", async () => {
      await withSandbox(async (sandbox) => {
        // Branch 1 modifies file1
        sandbox.createBranch("feat/branch-1", "main", true);
        sandbox.commitFile("file1.txt", "content 1", "add file 1");

        // Branch 2 modifies file2 from main
        sandbox.createBranch("feat/branch-2", "main", true);
        sandbox.commitFile("file2.txt", "content 2", "add file 2");

        const sim = sandbox.simulateMergeTree("feat/branch-1", "feat/branch-2");
        assert.strictEqual(sim.clean, true, "Disjoint changes must merge cleanly");
        assert.strictEqual(sim.conflict, false);
        assert.strictEqual(typeof sim.treeSha, "string");
      });
    });

    test("detects merge collisions in memory and reports conflicting files", async () => {
      await withSandbox(async (sandbox) => {
        // Base commit with shared file
        sandbox.commitFile("shared.txt", "line A\nline B\n", "base shared file");

        // Branch A modifies shared.txt
        sandbox.createBranch("feat/branch-a", "main", true);
        sandbox.commitFile("shared.txt", "line A\nline B modified by A\n", "mod by A");

        // Branch B modifies same line in shared.txt
        sandbox.createBranch("feat/branch-b", "main", true);
        sandbox.commitFile("shared.txt", "line A\nline B modified by B\n", "mod by B");

        const sim = sandbox.simulateMergeTree("feat/branch-a", "feat/branch-b");
        assert.strictEqual(sim.clean, false, "Conflicting edits must be detected");
        assert.strictEqual(sim.conflict, true);
        assert.ok(sim.conflictFiles.some(f => f.includes("shared.txt")));
      });
    });
  });

  describe("4. Worktree Lifecycle & Multi-Agent Setup", () => {
    test("creates, manages, and removes Git worktrees", async () => {
      await withSandbox(async (sandbox) => {
        const wtPath = sandbox.createWorktree(".vibesync/worktrees/test-agent", "task/agent-task", "main");
        assert.ok(fs.existsSync(wtPath), "Worktree directory must exist");
        assert.ok(fs.existsSync(path.join(wtPath, ".git")), "Worktree must have .git pointer");

        // Commit file inside worktree
        fs.writeFileSync(path.join(wtPath, "agent-file.txt"), "agent work");
        execGit("git add agent-file.txt && git commit -m 'agent commit'", wtPath);

        // Remove worktree
        sandbox.removeWorktree(wtPath);
        assert.strictEqual(fs.existsSync(wtPath), false, "Worktree path must be removed");
      });
    });

    test("setupMultiAgentWorktrees configures isolated checkouts for paired agents", async () => {
      await withSandbox(async (sandbox) => {
        const wts = sandbox.setupMultiAgentWorktrees(["antigravity", "codex"]);
        assert.ok(fs.existsSync(wts.antigravity), "Antigravity worktree must exist");
        assert.ok(fs.existsSync(wts.codex), "Codex worktree must exist");
        assert.notStrictEqual(wts.antigravity, wts.codex, "Worktree paths must be distinct");
      });
    });
  });

  describe("5. Port & Process Concurrency Helpers", () => {
    test("occupyPort, isPortInUse, and waitForPortFree operate reliably", async () => {
      const testPort = 45991;
      assert.strictEqual(await isPortInUse(testPort), false, "Port must initially be free");

      const occupied = await occupyPort(testPort);
      assert.strictEqual(await isPortInUse(testPort), true, "Port must be in use");

      await occupied.close();
      const freed = await waitForPortFree(testPort, 2000);
      assert.strictEqual(freed, true, "Port must be freed after close");
    });

    test("terminateProcess handles two-stage process termination gracefully", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "pipe"
      });

      assert.ok(child.pid, "Child process must have PID");
      await terminateProcess(child, 1000);
      assert.ok(child.killed || child.exitCode !== null, "Process must be terminated");
    });
  });

  describe("6. Client Abstractions (HTTP, SSE, Stdio MCP)", () => {
    test("VibeSyncHttpClient connects to endpoints, parses responses, and polls readiness", async () => {
      const port = 45992;
      const server = http.createServer((req, res) => {
        if (req.url === "/api/state") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ gitHead: "test-sha", features: [], tasks: [] }));
        } else if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body>VibeSync Control Deck</body></html>");
        } else if (req.url === "/api/eject") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise(r => server.listen(port, "127.0.0.1", r));

      try {
        const client = new VibeSyncHttpClient(port);
        await client.waitForReady(2000);

        const state = await client.getState();
        assert.strictEqual(state.gitHead, "test-sha");

        const hud = await client.getHudHtml();
        assert.strictEqual(hud.status, 200);
        assert.ok(hud.html.includes("VibeSync Control Deck"));

        const ejectRes = await client.ejectTask("TASK-01");
        assert.strictEqual(ejectRes.success, true);
      } finally {
        server.closeAllConnections?.();
        server.close();
      }
    });

    test("VibeSyncSseClient receives real-time events and supports waitForState predicate", async () => {
      const port = 45993;
      let sseRes = null;

      const server = http.createServer((req, res) => {
        if (req.url === "/api/events") {
          sseRes = res;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          res.write("data: " + JSON.stringify({ phase: "initial", count: 0 }) + "\n\n");
        }
      });

      await new Promise(r => server.listen(port, "127.0.0.1", r));

      const sseClient = new VibeSyncSseClient(`http://127.0.0.1:${port}/api/events`);
      try {
        const initial = await sseClient.connect(3000);
        assert.strictEqual(initial.phase, "initial");

        // Broadcast a second state asynchronously
        setTimeout(() => {
          if (sseRes) {
            sseRes.write("data: " + JSON.stringify({ phase: "updated", count: 1 }) + "\n\n");
          }
        }, 50);

        const updated = await sseClient.waitForState(s => s.phase === "updated", 3000);
        assert.strictEqual(updated.count, 1);
        assert.strictEqual(sseClient.getAllStates().length, 2);
      } finally {
        sseClient.close();
        server.closeAllConnections?.();
        server.close();
      }
    });

    test("McpStdioClient frames JSON-RPC 2.0 messages and correlates requests/responses", async () => {
      // Mock MCP child process echo server
      const script = `
        process.stdin.setEncoding("utf8");
        let buffer = "";
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2024-11-05", serverInfo: { name: "mock" } }
              }) + "\\n");
            } else if (req.method === "tools/call" && req.params.name === "echo") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: JSON.stringify(req.params.arguments) }] }
              }) + "\\n");
            } else if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo", description: "echo tool" }] }
              }) + "\\n");
            }
          }
        });
        process.stderr.write("mock server ready\\n");
      `;

      const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
      const client = new McpStdioClient(child, 5000);

      try {
        const initResult = await client.initialize();
        assert.strictEqual(initResult.protocolVersion, "2024-11-05");

        const toolsResult = await client.listTools();
        assert.strictEqual(toolsResult.tools[0].name, "echo");

        const callResult = await client.callToolJson("echo", { msg: "hello mcp" });
        assert.deepStrictEqual(callResult, { msg: "hello mcp" });

        const stderr = await client.waitForStderr("mock server ready", 2000);
        assert.ok(stderr.includes("ready"));
      } finally {
        await terminateProcess(child, 1000);
      }
    });
  });
});
