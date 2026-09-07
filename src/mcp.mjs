/**
 * src/mcp.mjs
 * 
 * VibeSync Stdio Model Context Protocol (MCP) Server
 * Milestone 3: Stdio MCP Server & Ambient HUD (Features 27–34)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { getDb } from './db.mjs';
import { beginOperation, assertWorkspaceIdle } from './operations.mjs';
import { startTask } from './workspace.mjs';
import { featureInput, taskInput } from './input.mjs';
import { claimTask, createTask, releaseTaskLease } from './tasks.mjs';
import { settleFeature, createFeature } from './features.mjs';
import { parkInsight, mergeIncubatorItems, getConventions } from './incubator.mjs';
import { verifyAndSettleTask } from './settle.mjs';
import { getPayload } from './server.mjs';
import { repairDatabase } from './repair.mjs';

/**
 * Creates and configures the VibeSync MCP Server instance with tool declarations and handlers.
 * 
 * @param {object} [options={}]
 * @param {DatabaseSync} [options.db=getDb()]
 * @param {string} [options.repoRoot=process.cwd()]
 * @param {Function} [options.onUpdate=null] - Callback triggered when state mutates (e.g. to broadcast SSE)
 * @returns {Server}
 */
export function createMcpServer(options = {}) {
  const db = options.db || getDb();
  const repoRoot = options.repoRoot || process.cwd();
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;

  const server = new Server(
    { name: 'vibesync', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // 1. Tool Declarations
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'vibesync_create_feature', description: 'Create a feature contract with acceptance criteria and a holistic verification command.',
        inputSchema: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' }, target_milestone: { type: 'string' },
          spec_markdown: { type: 'string' }, holistic_gate_cmd: { type: 'string' }
        }, required: ['id', 'title', 'spec_markdown'] }
      },
      {
        name: 'vibesync_create_task', description: 'Create a scoped execution task under an unsettled feature contract.',
        inputSchema: { type: 'object', properties: {
          id: { type: 'string' }, feature_id: { type: 'string' }, title: { type: 'string' },
          allowed_paths: { type: 'array', items: { type: 'string' } },
          required_gates: { type: 'array', items: { type: 'string' } }
        }, required: ['id', 'feature_id', 'title', 'allowed_paths', 'required_gates'] }
      },
      {
        name: 'vibesync_release_task', description: 'Release an in-progress lease while preserving its branch and worktree.',
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
      },
      {
        name: 'vibesync_get_state',
        description: 'Returns complete project state: active feature contracts, actionable tasks, parked incubator ideas, and audit ledger.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'vibesync_claim_task',
        description: 'Atomically leases a task, sets branch name, establishes 45-minute TTL, and hydrates .vibesync_ACTIVE_TASK.md in the worktree.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Task ID to claim, e.g. TASK-01.1' },
            actor_name: { type: 'string', description: 'Agent identifier, e.g. gemini-antigravity, openai-codex, or anthropic-claude' },
            worktree_path: { type: 'string', description: 'Optional existing worktree path. Omit when claiming to provision an isolated task worktree automatically.' }
          },
          required: ['task_id', 'actor_name']
        }
      },
      {
        name: 'vibesync_verify_and_settle',
        description: 'Executes judicial pipeline: path whitelist check, independent gate runner, in-memory merge simulation, and transactional squash-settlement to main with RFC 2822 trailers and Git notes. Optionally parks discovered insights autonomously.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Task ID to verify and settle' },
            actor_name: { type: 'string', description: 'Agent identifier' },
            worktree_path: { type: 'string', description: 'Optional path to the agent isolated worktree folder' },
            discovered_insights: {
              type: 'array',
              description: 'Optional insights or technical debt discovered during task execution to park autonomously',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Descriptive title' },
                  category: {
                    type: 'string',
                    enum: ['speculative_feature', 'architecture_insight', 'debt', 'ux_polish', 'convention']
                  },
                  context_notes: { type: 'string', description: 'Technical context or constraints' },
                  target_scope: { type: 'string', description: 'Optional file or path pattern' }
                },
                required: ['title', 'category', 'context_notes']
              }
            }
          },
          required: ['task_id', 'actor_name']
        }
      },
      {
        name: 'vibesync_park_insight',
        description: 'Quarantines an off-task idea, technical debt, convention, or refactor insight into the incubator and commits it cleanly to the orphan git branch (zero footprint on main). Coalesces duplicate observations to prevent bloat.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional custom ID, e.g. INC-042' },
            title: { type: 'string', description: 'Descriptive title of the insight or refactor' },
            category: {
              type: 'string',
              enum: ['speculative_feature', 'architecture_insight', 'debt', 'ux_polish', 'convention'],
              description: 'Insight classification'
            },
            target_scope: { type: 'string', description: 'Optional file or module path' },
            context_notes: { type: 'string', description: 'Technical context, rationale, or constraints' },
            actor_name: { type: 'string', description: 'Agent or user identifier' }
          },
          required: ['title', 'category', 'context_notes', 'actor_name']
        }
      },
      {
        name: 'vibesync_merge_insights',
        description: 'Consolidates multiple incubator insights into a single unified record to keep the incubator lean and unbloated.',
        inputSchema: {
          type: 'object',
          properties: {
            source_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of INC-### IDs to merge together'
            },
            target_id: { type: 'string', description: 'Optional target ID to merge into; creates new INC-### if omitted' },
            merged_title: { type: 'string', description: 'Unified title for the consolidated insight' },
            merged_notes: { type: 'string', description: 'Consolidated technical rationale' },
            category: {
              type: 'string',
              enum: ['speculative_feature', 'architecture_insight', 'debt', 'ux_polish', 'convention']
            },
            actor_name: { type: 'string', description: 'Agent or user identifier' }
          },
          required: ['source_ids', 'actor_name']
        }
      },
      {
        name: 'vibesync_settle_feature',
        description: 'Settles a complete functional feature contract once all child tasks are settled and holistic tests pass.',
        inputSchema: {
          type: 'object',
          properties: {
            feature_id: { type: 'string', description: 'Feature ID, e.g. FEAT-01' },
            actor_name: { type: 'string', description: 'Agent or user identifier' }
          },
          required: ['feature_id', 'actor_name']
        }
      },
      {
        name: 'vibesync_repair_state',
        description: 'Rebuilds SQLite state database from Git commit history, RFC 2822 trailers, Git notes, and orphan incubator branch if state.db was corrupted or deleted.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  }));

  // 2. Tool Request Handler
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    try {
      if (name !== 'vibesync_get_state') assertWorkspaceIdle(db);
      if (name === 'vibesync_create_feature' || name === 'vibesync_create_task' || name === 'vibesync_release_task') {
        let result;
        if (name === 'vibesync_create_feature') result = createFeature(featureInput(args), db);
        else if (name === 'vibesync_create_task') {
          const input = taskInput(args);
          const parent = db.prepare('SELECT status FROM features WHERE id = ?').get(input.feature_id);
          if (!parent || parent.status === 'settled') throw new Error('Task requires an existing, unsettled feature.');
          result = createTask(input, db);
        } else { releaseTaskLease(args.task_id, db); result = { taskId: args.task_id }; }
        if (onUpdate) onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }] };
      }
      if (name === 'vibesync_get_state') {
        const payload = getPayload(db, repoRoot);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2)
            }
          ]
        };
      }

      if (name === 'vibesync_claim_task') {
        const claim = args.worktree_path ? claimTask : startTask;
        const result = claim(
          {
            taskId: args.task_id,
            actorName: args.actor_name,
            worktreePath: args.worktree_path
          },
          db,
          repoRoot
        );

        const conventions = getConventions(db);
        if (onUpdate) onUpdate();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Task ${args.task_id} leased to ${args.actor_name} on branch ${result.task.branch_name}.`,
                anchor: result.activeTaskAnchorPath,
                task: result.task,
                conventions
              }, null, 2)
            }
          ]
        };
      }

      if (name === 'vibesync_verify_and_settle') {
        const managedTask = db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(args.task_id);
        const result = managedTask?.worktree_path && !args.worktree_path
          ? await beginOperation('task', args.task_id, args.actor_name, db, repoRoot, onUpdate || (() => {})).completion
          : verifyAndSettleTask(
          {
            taskId: args.task_id,
            actorName: args.actor_name,
            worktreePath: args.worktree_path || db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(args.task_id)?.worktree_path,
            discovered_insights: args.discovered_insights,
            repoRoot,
            db
          }
        );

        if (onUpdate) onUpdate();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (name === 'vibesync_park_insight') {
        const result = parkInsight(
          {
            id: args.id,
            title: args.title,
            category: args.category,
            target_scope: args.target_scope,
            context_notes: args.context_notes,
            logged_by: args.actor_name
          },
          db,
          repoRoot
        );

        if (onUpdate) onUpdate();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                id: result.id,
                coalesced: Boolean(result.coalesced),
                message: result.coalesced
                  ? `Observation coalesced into existing insight ${result.id}.`
                  : `Insight ${result.id} parked in incubator and committed to orphan branch.`,
                commitSha: result.commitSha
              }, null, 2)
            }
          ]
        };
      }

      if (name === 'vibesync_merge_insights') {
        const result = mergeIncubatorItems(
          {
            sourceIds: args.source_ids,
            targetId: args.target_id,
            mergedTitle: args.merged_title,
            mergedNotes: args.merged_notes,
            category: args.category,
            actorName: args.actor_name
          },
          db,
          repoRoot
        );

        if (onUpdate) onUpdate();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Merged ${result.mergedCount} insights into ${result.targetId}.`,
                result
              }, null, 2)
            }
          ]
        };
      }

      if (name === 'vibesync_settle_feature') {
        const result = db.prepare('PRAGMA database_list').all().some(row => row.file)
          ? await beginOperation('feature', args.feature_id, args.actor_name, db, repoRoot, onUpdate || (() => {})).completion
          : settleFeature(
          {
            featureId: args.feature_id,
            actorName: args.actor_name
          },
          db,
          repoRoot
        );

        if (onUpdate) onUpdate();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (name === 'vibesync_repair_state') {
        const summary = repairDatabase(repoRoot, db);
        if (onUpdate) onUpdate();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Reconstructed ${summary.featuresCount} features, ${summary.tasksCount} tasks, ${summary.incubatorCount} incubator items, ${summary.eventsCount} events from Git.`,
                summary
              }, null, 2)
            }
          ]
        };
      }

      throw new Error(`Unrecognized VibeSync tool: ${name}`);

    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `VibeSync Tool Error [${name}]: ${err.message}`
          }
        ]
      };
    }
  });

  return server;
}

/**
 * Connects the MCP server over stdio transport.
 * 
 * @param {object} [options={}]
 * @returns {Promise<{ server: Server, transport: StdioServerTransport }>}
 */
export async function runMcpServer(options = {}) {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}
