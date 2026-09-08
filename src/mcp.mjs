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
import { claimTask, createTask, releaseTaskLease, heartbeatTaskLease, getTask, listTasks } from './tasks.mjs';
import { createFeature, getFeature } from './features.mjs';
import { parkInsight, mergeIncubatorItems, getConventions, getIncubatorItem, promoteIncubatorItem } from './incubator.mjs';
import { verifyAndSettleTask } from './settle.mjs';
import { getPayload } from './server.mjs';
import { repairDatabase } from './repair.mjs';
import { previewTask, previewFeature, approveTaskCommand, approveFeatureCommand } from './policy.mjs';

const commandSchema = { oneOf: [
  { type: 'string', description: 'Legacy shell-free command string.' },
  { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Executable and argument array.' },
  { type: 'object', properties: {
    type: { type: 'string', enum: ['argv', 'node-test', 'npm-script', 'pytest', 'make'] },
    argv: { type: 'array', minItems: 1, items: { type: 'string' } }, args: { type: 'array', items: { type: 'string' } },
    script: { type: 'string' }, target: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 1, maximum: 3600000 },
    network: { type: 'boolean' }, write_paths: { type: 'array', items: { type: 'string' } },
    idempotency: { type: 'string', enum: ['safe', 'unsafe'] }
  }, required: ['type'], description: 'Structured command contract with explicit capabilities.' }
] };
const annotations = (readOnlyHint, destructiveHint, idempotentHint) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false });
const description = (purpose, use, avoid, effects) => `Purpose: ${purpose}\nWhen to use: ${use}\nWhen NOT to use: ${avoid}\nSide effects: ${effects}`;

const TOOL_ROLES = Object.freeze({
  vibesync_create_feature: 'admin', vibesync_create_task: 'admin', vibesync_release_task: 'admin',
  vibesync_merge_insights: 'admin', vibesync_settle_feature: 'admin', vibesync_repair_state: 'admin',
  vibesync_promote_insight: 'admin',
  vibesync_approve_task_command: 'admin',
  vibesync_approve_feature_command: 'admin',
  vibesync_get_state: 'admin', vibesync_list_ready_tasks: 'worker', vibesync_get_task_detail: 'worker',
  vibesync_preview_task: 'worker', vibesync_preview_feature: 'worker', vibesync_claim_task: 'worker', vibesync_heartbeat_task: 'worker',
  vibesync_verify_and_settle: 'worker', vibesync_park_insight: 'worker'
});

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
  const role = options.role || 'all';

  const server = new Server(
    { name: 'vibesync', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // 1. Tool Declarations
  const tools = [
      {
        name: 'vibesync_create_feature', description: description('Create a feature contract.', 'A human administrator is defining approved acceptance criteria.', 'Do not use from a worker session or to revise a settled contract.', 'Writes the database and audit ledger.'), annotations: annotations(false, false, false),
        inputSchema: { type: 'object', properties: {
          id: { type: 'string', description: 'Optional; server generates FEAT-01 style IDs.' }, title: { type: 'string' }, target_milestone: { type: 'string' },
          spec_markdown: { type: 'string' }, holistic_gate_cmd: commandSchema
        }, required: ['title', 'spec_markdown'] }
      },
      {
        name: 'vibesync_create_task', description: description('Create a scoped task under a feature.', 'A human administrator is assigning scope, gates, and provisioning.', 'Do not use to self-expand a claimed task.', 'Writes the database; later claiming may create a worktree and run setup commands.'), annotations: annotations(false, false, false),
        inputSchema: { type: 'object', properties: {
          id: { type: 'string', description: 'Optional; server generates TASK-01.1 style IDs.' }, feature_id: { type: 'string' }, title: { type: 'string' },
          allowed_paths: { type: 'array', items: { type: 'string' } },
          required_gates: { type: 'array', items: commandSchema },
          setup: { type: 'array', items: commandSchema, description: 'Optional commands executed in order after managed worktree creation.' },
          model_hint: { type: 'string', enum: ['gemini', 'claude', 'codex', 'local', 'generic'], description: 'Suggested model family; never grants additional permissions.' }
        }, required: ['feature_id', 'title', 'allowed_paths', 'required_gates'] }
      },
      {
        name: 'vibesync_release_task', description: description('Release an active task lease.', 'An administrator needs to requeue abandoned work.', 'Do not use to bypass failed gates.', 'Changes task ownership and status; preserves branch and worktree.'), annotations: annotations(false, false, false),
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
      },
      {
        name: 'vibesync_get_state',
        description: description('Read the complete project ledger.', 'Administrative diagnosis requires every record.', 'Do not use for normal task selection; use list_ready_tasks or get_task_detail.', 'Read-only but may return a large payload.'), annotations: annotations(true, false, true),
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'vibesync_list_ready_tasks',
        description: description('List only claimable tasks.', 'A worker needs a low-context task queue.', 'Do not use for full history or settled tasks.', 'Read-only; returns compact task summaries.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { feature_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } }
      },
      {
        name: 'vibesync_get_task_detail',
        description: description('Read one task contract and its feature acceptance criteria.', 'A worker is deciding whether to claim or needs its exact constraints.', 'Do not use to mutate task scope or status.', 'Read-only; returns one task and its parent feature.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
      },
      {
        name: 'vibesync_preview_task',
        description: description('Preview cost, commands, approvals, and model suitability before claiming.', 'Any worker is deciding whether it can safely execute a task.', 'Do not treat suitability as authorization.', 'Read-only; resolves command policy hashes against the current checkout.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, actor_name: { type: 'string' } }, required: ['task_id', 'actor_name'] }
      },
      {
        name: 'vibesync_approve_task_command',
        description: description('Approve the current resolved form of one task command.', 'A human administrator reviewed the preview and command capabilities.', 'Do not approve on behalf of an untrusted worker.', 'Persists a hash-bound approval invalidated by command or package-script changes.'), annotations: annotations(false, true, false),
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, phase: { type: 'string', enum: ['setup', 'gate', 'feature'] }, index: { type: 'integer', minimum: 0 }, approved_by: { type: 'string' } }, required: ['task_id', 'phase', 'index', 'approved_by'] }
      },
      {
        name: 'vibesync_preview_feature',
        description: description('Preview a feature holistic gate and its approval state.', 'An administrator or reviewer is preparing feature settlement.', 'Do not treat preview as approval.', 'Read-only; resolves the holistic gate against the current checkout.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { feature_id: { type: 'string' }, actor_name: { type: 'string' } }, required: ['feature_id', 'actor_name'] }
      },
      {
        name: 'vibesync_approve_feature_command',
        description: description('Approve the current resolved holistic feature gate.', 'A human administrator reviewed the gate and capabilities.', 'Do not approve on behalf of an untrusted worker.', 'Persists a hash-bound approval invalidated by gate or package-script changes.'), annotations: annotations(false, true, false),
        inputSchema: { type: 'object', properties: { feature_id: { type: 'string' }, approved_by: { type: 'string' } }, required: ['feature_id', 'approved_by'] }
      },
      {
        name: 'vibesync_claim_task',
        description: description('Lease a ready task and prepare its workspace.', 'A worker is ready to execute the existing contract.', 'Do not use for blocked or already-leased tasks.', 'Changes DB lease state; may create a worktree, install a scope hook, and run declared setup commands.'), annotations: annotations(false, false, false),
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
        name: 'vibesync_heartbeat_task',
        description: description('Renew an owned task lease. Server computes workspace progress evidence server-side.', 'A working agent remains active, including slower local models.', 'Do not use another actor\'s token or revive an expired lease outside its grace window.', 'Extends the lease when actor and opaque lease token still match; returns structured lease_health (active/stagnant/warning/grace) and actionable guidance. Throws LEASE_EXPIRED when stagnation limit is exhausted.'), annotations: annotations(false, false, true),
        inputSchema: { type: 'object', properties: {
          task_id: { type: 'string' },
          actor_name: { type: 'string' },
          lease_token: { type: 'string' },
          worktree_path: { type: 'string', description: 'Optional: path to the task worktree. Server validates it matches the registered path before computing evidence.' }
        }, required: ['task_id', 'actor_name', 'lease_token'] }
      },
      {
        name: 'vibesync_verify_and_settle',
        description: description('Verify and settle a claimed task.', 'The worker has completed in-scope changes and wants final adjudication.', 'Do not use before work is ready or to override scope/gate failures.', 'Runs gates, increments strikes on failure, and on success squash-merges to trunk and updates DB/Git notes.'), annotations: annotations(false, true, false),
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
        description: description('Park an off-task discovery.', 'A worker finds useful work outside the claimed scope.', 'Do not use as a substitute for completing the current task.', 'Writes an incubator record and orphan-branch commit; may coalesce duplicates.'), annotations: annotations(false, false, false),
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
        description: description('Merge related parked insights.', 'An administrator is curating duplicate discoveries.', 'Do not use from a worker session.', 'Rewrites incubator statuses and creates an orphan-branch commit.'), annotations: annotations(false, false, false),
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
        name: 'vibesync_promote_insight',
        description: description('Promote one parked insight directly into a draft feature contract.', 'An administrator accepts a discovery for planning.', 'Do not use from a worker session or for an already-promoted insight.', 'Creates a draft feature, suggests scope in its spec, marks the insight promoted, and commits incubator state.'), annotations: annotations(false, false, false),
        inputSchema: { type: 'object', properties: {
          insight_id: { type: 'string' }, feature_id: { type: 'string', description: 'Optional; server generates FEAT-01 style IDs.' },
          title: { type: 'string' }, target_milestone: { type: 'string' }, spec_markdown: { type: 'string' },
          holistic_gate_cmd: commandSchema, actor_name: { type: 'string' }
        }, required: ['insight_id', 'actor_name'] }
      },
      {
        name: 'vibesync_settle_feature',
        description: description('Settle a completed feature contract.', 'An administrator confirms all child tasks are settled.', 'Do not use from a worker session or while child tasks remain open.', 'Runs the holistic gate and changes feature settlement state.'), annotations: annotations(false, true, false),
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
        description: description('Repair the state database from Git provenance.', 'A human administrator has diagnosed missing or corrupt state.', 'Do not use for routine reads or from a worker session.', 'Destructively reconciles database records from commits, notes, and the incubator branch.'), annotations: annotations(false, true, false),
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ];
  const visibleTools = role === 'all' ? tools : tools.filter(tool => TOOL_ROLES[tool.name] === role);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools }));

  // 2. Tool Request Handler
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    try {
      if (!visibleTools.some(tool => tool.name === name)) throw Object.assign(new Error(`Tool ${name} is not available to the ${role} MCP role.`), { code: 'ROLE_FORBIDDEN' });
      if (!['vibesync_get_state', 'vibesync_list_ready_tasks', 'vibesync_get_task_detail'].includes(name)) assertWorkspaceIdle(db);
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

      if (name === 'vibesync_list_ready_tasks') {
        const tasks = listTasks(db, { status: 'ready', feature_id: args.feature_id }).slice(0, args.limit || 20)
          .map(({ id, feature_id, title, priority, labels, allowed_paths, required_gates, model_hint }) => ({ id, feature_id, title, priority, labels, allowed_paths, required_gates, model_hint }));
        return { content: [{ type: 'text', text: JSON.stringify({ tasks, count: tasks.length }, null, 2) }] };
      }

      if (name === 'vibesync_get_task_detail') {
        const task = getTask(args.task_id, db);
        if (!task) throw Object.assign(new Error(`Task ${args.task_id} not found.`), { code: 'NOT_FOUND' });
        const feature = getFeature(task.feature_id, db);
        return { content: [{ type: 'text', text: JSON.stringify({ task, feature }, null, 2) }] };
      }

      if (name === 'vibesync_preview_task') {
        return { content: [{ type: 'text', text: JSON.stringify(previewTask({ taskId: args.task_id, actorName: args.actor_name }, db, repoRoot), null, 2) }] };
      }

      if (name === 'vibesync_approve_task_command') {
        const result = approveTaskCommand({ taskId: args.task_id, phase: args.phase, index: args.index, approvedBy: args.approved_by }, db, repoRoot);
        if (onUpdate) onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'vibesync_preview_feature') {
        return { content: [{ type: 'text', text: JSON.stringify(previewFeature({ featureId: args.feature_id, actorName: args.actor_name }, db, repoRoot), null, 2) }] };
      }

      if (name === 'vibesync_approve_feature_command') {
        const result = approveFeatureCommand({ featureId: args.feature_id, approvedBy: args.approved_by }, db, repoRoot);
        if (onUpdate) onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'vibesync_claim_task') {
        if (role === 'worker' && args.actor_name === 'human') {
          throw Object.assign(new Error('Worker sessions cannot impersonate the human administrator or reset a blocked task.'), { code: 'ROLE_FORBIDDEN' });
        }
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
                lease_token: result.leaseToken,
                heartbeat_minutes: result.heartbeatMinutes,
                model_profile: result.modelProfile,
                conventions
              }, null, 2)
            }
          ]
        };
      }

      if (name === 'vibesync_heartbeat_task') {
        const result = heartbeatTaskLease({ taskId: args.task_id, actorName: args.actor_name, leaseToken: args.lease_token, worktreePath: args.worktree_path, repoRoot }, db);
        if (onUpdate) onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'vibesync_verify_and_settle') {
        const managedTask = db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(args.task_id);
        const resolvedWorktreePath = args.worktree_path || managedTask?.worktree_path;
        const result = managedTask?.worktree_path && !args.worktree_path
          ? await beginOperation('task', args.task_id, args.actor_name, db, repoRoot, onUpdate || (() => {})).completion
          : verifyAndSettleTask(
          {
            taskId: args.task_id,
            actorName: args.actor_name,
            worktreePath: resolvedWorktreePath,
            discovered_insights: args.discovered_insights,
            repoRoot,
            db
          }
        );

        if (onUpdate) onUpdate();

        if (result && result.success === false) {
          const task = getTask(args.task_id, db);
          result.failure = {
            code: result.phase || 'VERIFICATION_FAILED',
            strike_count: task?.consecutive_failures ?? result.consecutive_failures ?? 0,
            max_strikes: task?.max_failures ?? 3,
            exact_failure: result.failedGate?.summary || result.errorPayload?.failure || result.error,
            forbidden_actions: result.phase === 'SCOPE_VIOLATION'
              ? ['Do NOT edit files outside allowed_paths.', 'Do NOT edit test files unless they are explicitly allowed.']
              : ['Do NOT edit tests merely to make a failing gate pass.', 'Do NOT retry settlement without addressing the reported failure.']
          };
        }

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

      if (name === 'vibesync_promote_insight') {
        const insight = getIncubatorItem(args.insight_id, db);
        if (!insight || insight.status !== 'parked') throw new Error(`Parked insight ${args.insight_id} not found.`);
        const scope = insight.target_scope || 'Scope to be confirmed by an administrator.';
        const feature = createFeature({
          id: args.feature_id,
          title: args.title || insight.title,
          target_milestone: args.target_milestone || 'backlog',
          status: 'draft',
          spec_markdown: args.spec_markdown || `## Promoted from ${insight.id}\n\n${insight.context_notes}\n\n## Suggested scope\n\n- ${scope}`,
          holistic_gate_cmd: args.holistic_gate_cmd || ['git', 'diff', '--check'],
          actor: args.actor_name
        }, db);
        const promotion = promoteIncubatorItem({ id: insight.id, featureId: feature.id, actorName: args.actor_name }, db, repoRoot);
        if (onUpdate) onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, feature, insight: promotion.item, suggested_scopes: [scope] }, null, 2) }] };
      }

      if (name === 'vibesync_settle_feature') {
        const result = await beginOperation('feature', args.feature_id, args.actor_name, db, repoRoot, onUpdate || (() => {})).completion;

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
      const taskId = args.task_id;
      const task = taskId ? getTask(taskId, db) : null;
      const envelope = {
        success: false,
        error: {
          code: err.code || err.phase || 'TOOL_ERROR',
          tool: name,
          exact_failure: err.message,
          strike_count: task?.consecutive_failures ?? 0,
          max_strikes: task?.max_failures ?? 3,
          circuit_breaker_tripped: task?.status === 'blocked',
          forbidden_actions: task?.status === 'blocked'
            ? ['Do NOT claim or modify this task until a human administrator resets it.', 'Do NOT edit test files to bypass the failure.']
            : ['Do NOT bypass the task contract or its required gates.']
        }
      };
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(envelope, null, 2)
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
