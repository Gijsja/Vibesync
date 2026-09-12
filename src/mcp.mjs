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
import { startTask, inspectBranchDrift } from './workspace.mjs';
import { featureInput, taskInput } from './input.mjs';
import { claimTask, createTask, releaseTaskLease, heartbeatTaskLease, getTask, listTasks } from './tasks.mjs';
import { createFeature, getFeature } from './features.mjs';
import { parkInsight, mergeIncubatorItems, getConventions, getIncubatorItem, promoteIncubatorItem } from './incubator.mjs';
import { verifyAndSettleTask } from './settle.mjs';
import { executePartialVerification } from './gatekeeper.mjs';
import { getPayload } from './server.mjs';
import { repairDatabase } from './repair.mjs';
import { previewTask, previewFeature, approveTaskCommand, approveFeatureCommand, getExecutionPolicy, detectSandboxCapabilities, migratePolicy } from './policy.mjs';
import { buildLeaseRollup } from './audit.mjs';
import { routeTask, getAdapterStatus, cancelAdapterRun, collectAdapterResult, handoffAdapterRun, readAdapterOutput } from './adapters.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';

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
  vibesync_get_lease_rollup: 'admin',
  vibesync_route_task: 'admin', vibesync_adapter_status: 'admin',
  vibesync_policy_status: 'admin', vibesync_migrate_policy: 'admin',
  vibesync_get_state: 'admin', vibesync_get_summary: 'admin', vibesync_get_operation: 'admin', vibesync_list_ready_tasks: 'worker', vibesync_get_task_detail: 'worker',
  vibesync_get_active_task: 'worker',
  vibesync_preview_task: 'worker', vibesync_preview_feature: 'worker', vibesync_claim_task: 'worker', vibesync_heartbeat_task: 'worker',
  vibesync_partial_verify: 'worker',
  vibesync_verify_and_settle: 'worker', vibesync_park_insight: 'worker'
});

const detailSchema = { type: 'string', enum: ['compact', 'full'], default: 'compact', description: 'Response detail. Compact returns the next-action brief; full returns complete evidence.' };
const isFullDetail = args => args.detail === 'full';
const truncate = (value, limit = 1200) => {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const compactText = value => JSON.stringify(value);
const fullText = value => JSON.stringify(value, null, 2);
const toolText = (value, args) => isFullDetail(args) ? fullText(value) : compactText(value);

function taskBrief(task) {
  return {
    task_id: task.id,
    feature_id: task.feature_id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    labels: task.labels || [],
    allowed_paths: task.allowed_paths || [],
    gate_count: (task.required_gates || []).length,
    model_hint: task.model_hint || null
  };
}

function compactFailure(result) {
  if (result?.success !== false) return undefined;
  return {
    code: result.failure?.code || result.phase || 'VERIFICATION_FAILED',
    message: truncate(result.failure?.exact_failure || result.failedGate?.summary || result.errorPayload?.failure || result.error, 800),
    strike_count: result.failure?.strike_count ?? result.consecutiveFailures ?? result.failures ?? null,
    max_strikes: result.failure?.max_strikes ?? null,
    artifact_hash: result.artifactHash || null
  };
}

function nextActionForTask(task) {
  if (task.status === 'ready') return 'Preview this task, then claim it when its approvals are ready.';
  if (task.status === 'in_progress') return 'Continue work in the assigned worktree and heartbeat before the lease expires.';
  if (task.status === 'blocked') return 'Request administrator intervention before continuing.';
  return 'Inspect full task detail if additional evidence is needed.';
}

function compactPreview(preview) {
  const blockedApprovals = preview.approval_required || 0;
  return {
    success: true,
    ...taskBrief(preview.task),
    model_profile: preview.model?.id || null,
    suitability: preview.suitability,
    gate_count: preview.commands?.length || 0,
    approval_required: blockedApprovals,
    estimated_verification_ms: preview.estimated_verification_ms || 0,
    ...(preview.baseline ? {
      baseline_clean: preview.baseline.clean,
      ...(preview.baseline.warning ? { baseline_warning: preview.baseline.warning } : {})
    } : {}),
    ...(preview.drift && preview.drift.behind_trunk > 0 ? {
      drift: {
        behind_trunk: preview.drift.behind_trunk,
        ahead_trunk: preview.drift.ahead_trunk,
        can_merge_cleanly: preview.drift.can_merge_cleanly,
        ...(preview.drift.warning ? { warning: preview.drift.warning } : {})
      }
    } : {}),
    next_action: blockedApprovals
      ? 'Request an administrator to approve the listed task commands before claiming.'
      : 'Claim the task when you are ready to work in its isolated worktree.'
  };
}

function compactGateResult(result, action) {
  const failure = compactFailure(result);
  return {
    success: result?.success !== false,
    task_id: result?.taskId || null,
    status: result?.status || (result?.settled ? 'settled' : 'in_progress'),
    phase: result?.phase || null,
    gate_count: result?.gatesRun?.length || result?.indices?.length || 0,
    settled: Boolean(result?.settled),
    ownership_changed: Boolean(result?.ownershipChanged),
    artifact_hash: result?.artifactHash || null,
    ...(failure ? { failure } : {}),
    next_action: failure ? 'Address the reported failure before retrying verification.' : action
  };
}

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
    { name: 'vibesync', version: '0.5.0' },
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
        name: 'vibesync_get_summary',
        description: description('Read a compact coordination summary.', 'An administrator needs feature, task, and operation status without the full ledger.', 'Do not use when raw audit, gate, or artifact detail is required.', 'Read-only; returns summaries only.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'vibesync_get_operation',
        description: description('Read one verification or settlement operation.', 'An administrator is following a long-running operation by ID.', 'Do not use to start, cancel, or alter an operation.', 'Read-only; returns status and stored result when complete.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { operation_id: { type: 'string' } }, required: ['operation_id'] }
      },
      {
        name: 'vibesync_get_lease_rollup',
        description: description('Read the deterministic audit rollup for one lease run.', 'An administrator is reviewing commands, files, approvals, failures, or handoffs for a specific lease.', 'Do not use to retrieve raw artifact contents or lease tokens.', 'Read-only; returns redacted metadata and artifact references.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { lease_run_id: { type: 'string' } }, required: ['lease_run_id'] }
      },
      {
        name: 'vibesync_route_task',
        description: description('Route and launch a ready task through a configured model CLI adapter.', 'An administrator wants VibeSync to supervise Gemini, Claude, Codex, or a local-model process.', 'Do not use to bypass task readiness, approvals, scope, or lease ownership.', 'Claims the task, provisions its worktree, writes a redacted private context file, and launches a structured process without a shell.'), annotations: annotations(false, true, false),
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, adapter_id: { type: 'string', enum: ['gemini', 'claude', 'codex', 'local'] }, actor_name: { type: 'string' } }, required: ['task_id'] }
      },
      {
        name: 'vibesync_policy_status',
        description: description('Inspect policy version, sandbox capability, and a non-mutating migration preview.', 'An administrator is assessing whether a project is fail-closed.', 'Do not treat capability reporting as proof that a command was sandboxed.', 'Read-only; resolves contracts and reports legacy commands and approvals needed.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'vibesync_migrate_policy',
        description: description('Explicitly migrate project execution policy to version 2 fail-closed defaults.', 'An administrator reviewed the migration preview and accepts commands that may need conversion or approval.', 'Do not invoke from a worker or without human confirmation.', 'Atomically writes policy.json; does not rewrite task contracts or grant approvals.'), annotations: annotations(false, true, false),
        inputSchema: { type: 'object', properties: { apply: { type: 'boolean', default: false }, confirmed_by: { type: 'string' } }, required: ['apply'] }
      },
      {
        name: 'vibesync_adapter_status',
        description: description('Inspect, cancel, or collect a supervised adapter run.', 'An administrator is supervising a launched model process.', 'Do not use as task settlement or to infer provider billing.', 'Status is read-only; cancel terminates the process; collect returns redacted bounded output and removes its private context file.'), annotations: annotations(false, true, false),
        inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, action: { type: 'string', enum: ['status', 'cancel', 'collect', 'read', 'handoff'], default: 'status' },
          artifact_hash: { type: 'string', description: 'Required for read.' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16384 },
          adapter_id: { type: 'string', enum: ['gemini', 'claude', 'codex', 'local'], description: 'Required for handoff.' } }, required: ['run_id'] }
      },
      {
        name: 'vibesync_list_ready_tasks',
        description: description('List only claimable tasks.', 'A worker needs a low-context task queue.', 'Do not use for full history or settled tasks.', 'Read-only; returns compact task summaries.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { feature_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } }
      },
      {
        name: 'vibesync_get_task_detail',
        description: description('Read one task contract and its feature acceptance criteria.', 'A worker is deciding whether to claim or needs its exact constraints.', 'Do not use to mutate task scope or status.', 'Read-only; compact output is action-oriented, while detail=full returns one task and its parent feature.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, detail: detailSchema }, required: ['task_id'] }
      },
      {
        name: 'vibesync_get_active_task',
        description: description('Read the current task leased to an actor without exposing its secret lease token.', 'A worker needs to recover its task context after a restart or context compaction.', 'Do not use to recover or impersonate a lease token; request administrator handoff or release if the token was lost.', 'Read-only; returns one concise active-task brief or an inactive result.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { actor_name: { type: 'string' } }, required: ['actor_name'] }
      },
      {
        name: 'vibesync_preview_task',
        description: description('Preview cost, commands, approvals, and model suitability before claiming.', 'Any worker is deciding whether it can safely execute a task.', 'Do not treat suitability as authorization.', 'Read-only; resolves command policy hashes against the current checkout.'), annotations: annotations(true, false, true),
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, actor_name: { type: 'string' }, detail: detailSchema }, required: ['task_id', 'actor_name'] }
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
            worktree_path: { type: 'string', description: 'Optional existing worktree path. Omit when claiming to provision an isolated task worktree automatically.' },
            detail: detailSchema
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
          worktree_path: { type: 'string', description: 'Optional: path to the task worktree. Server validates it matches the registered path before computing evidence.' },
          detail: detailSchema
        }, required: ['task_id', 'actor_name', 'lease_token'] }
      },
      {
        name: 'vibesync_partial_verify',
        description: description('Run safe declared gates without settling the task.', 'A worker wants early feedback during a long lease.', 'Do not use with legacy or non-idempotent gates, or as final settlement.', 'Consumes governed gate capacity and records partial gate runs; ownership and task status are unchanged.'), annotations: annotations(false, false, true),
        inputSchema: { type: 'object', properties: {
          task_id: { type: 'string' }, actor_name: { type: 'string' },
          indices: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Optional declared gate indices; omit to run every safe structured gate.' },
          detail: detailSchema
        }, required: ['task_id', 'actor_name'] }
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
            detail: detailSchema,
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
      if (!['vibesync_get_state', 'vibesync_get_summary', 'vibesync_get_operation', 'vibesync_list_ready_tasks', 'vibesync_get_task_detail', 'vibesync_get_active_task'].includes(name)) assertWorkspaceIdle(db);
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      if (name === 'vibesync_get_summary') {
        const payload = getPayload(db, repoRoot);
        const taskCounts = Object.fromEntries(['ready', 'in_progress', 'settled', 'blocked'].map(status => [status, payload.tasks.filter(task => task.status === status).length]));
        return { content: [{ type: 'text', text: JSON.stringify({ workspace: payload.workspace, gitHead: payload.gitHead, features: payload.features.map(({ id, title, status }) => ({ id, title, status })), taskCounts, operations: payload.operations.slice(0, 5).map(({ id, kind, target_id, status, started_at, finished_at }) => ({ id, kind, target_id, status, started_at, finished_at })) }, null, 2) }] };
      }
      if (name === 'vibesync_get_operation') {
        const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(args.operation_id);
        if (!row) throw Object.assign(new Error('Operation ' + args.operation_id + ' not found.'), { code: 'NOT_FOUND' });
        return { content: [{ type: 'text', text: JSON.stringify({ ...row, result: row.result_json ? JSON.parse(row.result_json) : null }, null, 2) }] };
      }

      if (name === 'vibesync_list_ready_tasks') {
        const tasks = listTasks(db, { status: 'ready', feature_id: args.feature_id })
          .filter(task => !task.superseded_by_task_id)
          .slice(0, args.limit || 20)
          .map(task => taskBrief(task));
        return { content: [{ type: 'text', text: compactText({ tasks, count: tasks.length, next_action: tasks.length ? 'Read task detail or preview a task before claiming it.' : 'No ready tasks are available.' }) }] };
      }

      if (name === 'vibesync_get_task_detail') {
        const task = getTask(args.task_id, db);
        if (!task) throw Object.assign(new Error(`Task ${args.task_id} not found.`), { code: 'NOT_FOUND' });
        const feature = getFeature(task.feature_id, db);
        if (isFullDetail(args)) return { content: [{ type: 'text', text: fullText({ task, feature }) }] };
        const acceptanceCriteria = truncate(feature?.spec_markdown, 1200);
        return { content: [{ type: 'text', text: compactText({
          success: true,
          ...taskBrief(task),
          feature: feature ? { feature_id: feature.id, title: feature.title, status: feature.status, acceptance_criteria: acceptanceCriteria, acceptance_criteria_truncated: acceptanceCriteria !== String(feature.spec_markdown || '') } : null,
          next_action: nextActionForTask(task)
        }) }] };
      }

      if (name === 'vibesync_get_active_task') {
        const task = listTasks(db, { status: 'in_progress', assigned_actor: args.actor_name })[0] || null;
        if (!task) return { content: [{ type: 'text', text: compactText({ active: false, next_action: 'List ready tasks.' }) }] };
        const expired = db.prepare("SELECT datetime(lease_expires_at) <= datetime('now') AS expired FROM tasks WHERE id = ?").get(task.id)?.expired === 1;
        const drift = task.worktree_path ? inspectBranchDrift(task.worktree_path, repoRoot) : null;
        const telemetry = computeAgentTelemetry(task, db, repoRoot);
        return { content: [{ type: 'text', text: compactText({
          active: !expired,
          expired,
          ...taskBrief(task),
          worktree_path: task.worktree_path || null,
          ...(drift && drift.behind_trunk > 0 ? { drift } : {}),
          telemetry: {
            confidence: telemetry.confidence,
            evidence: telemetry.evidence,
            uncertainty: telemetry.uncertainty
          },
          lease: {
            expires_at: task.lease_expires_at || null,
            last_heartbeat_at: task.last_heartbeat_at || null,
            lease_run_id: task.lease_run_id || null,
            token_available: false
          },
          next_action: expired
            ? 'The lease has expired. Do not continue work; list ready tasks or request administrator release/handoff.'
            : 'Continue work in the assigned worktree. If the lease token was lost, request administrator handoff or release; it cannot be recovered.'
        }) }] };
      }

      if (name === 'vibesync_preview_task') {
        const preview = previewTask({ taskId: args.task_id, actorName: args.actor_name }, db, repoRoot);
        return { content: [{ type: 'text', text: toolText(isFullDetail(args) ? preview : compactPreview(preview), args) }] };
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
              text: toolText(isFullDetail(args) ? {
                success: true,
                message: `Task ${args.task_id} leased to ${args.actor_name} on branch ${result.task.branch_name}.`,
                anchor: result.activeTaskAnchorPath,
                task: result.task,
                lease_token: result.leaseToken,
                heartbeat_minutes: result.heartbeatMinutes,
                model_profile: result.modelProfile,
                conventions
              } : {
                success: true,
                ...taskBrief(result.task),
                worktree_path: result.task.worktree_path || args.worktree_path || null,
                anchor: result.activeTaskAnchorPath,
                lease: { token: result.leaseToken, lease_run_id: result.leaseRunId, expires_at: result.task.lease_expires_at, heartbeat_minutes: result.heartbeatMinutes },
                model_profile: result.modelProfile,
                next_action: 'Implement the task in the assigned worktree and heartbeat before the lease expires.'
              }, args)
            }
          ]
        };
      }

      if (name === 'vibesync_heartbeat_task') {
        const result = heartbeatTaskLease({ taskId: args.task_id, actorName: args.actor_name, leaseToken: args.lease_token, worktreePath: args.worktree_path, repoRoot }, db);
        if (onUpdate) onUpdate();
        const compact = {
          success: true,
          ...taskBrief(result.task),
          lease: { health: result.leaseHealth, expires_at: result.task.lease_expires_at, heartbeat_minutes: result.heartbeatMinutes },
          fingerprint_changed: result.fingerprintChanged,
          guidance: result.guidance,
          next_action: result.leaseHealth === 'active' ? 'Continue implementation and heartbeat again before lease expiry.' : 'Make measurable workspace progress, then heartbeat again.'
        };
        return { content: [{ type: 'text', text: toolText(isFullDetail(args) ? result : compact, args) }] };
      }

      if (name === 'vibesync_get_lease_rollup') {
        return { content: [{ type: 'text', text: JSON.stringify(buildLeaseRollup(args.lease_run_id, db), null, 2) }] };
      }

      if (name === 'vibesync_route_task') {
        const result = await routeTask({ taskId: args.task_id, adapterId: args.adapter_id || null, actorName: args.actor_name || null }, db, repoRoot);
        if (onUpdate) onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'vibesync_policy_status') {
        return { content: [{ type: 'text', text: JSON.stringify({ policy: getExecutionPolicy(repoRoot), capabilities: detectSandboxCapabilities(), migration: migratePolicy(repoRoot, db) }, null, 2) }] };
      }

      if (name === 'vibesync_migrate_policy') {
        const result = migratePolicy(repoRoot, db, { apply: args.apply === true, confirmedBy: args.confirmed_by || null });
        if (onUpdate && result.applied) onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'vibesync_adapter_status') {
        const action = args.action || 'status';
        const result = action === 'cancel' ? cancelAdapterRun(args.run_id)
          : action === 'collect' ? collectAdapterResult(args.run_id, { limit: args.limit })
          : action === 'read' ? readAdapterOutput(args.artifact_hash, { repoRoot, offset: args.offset, limit: args.limit })
          : action === 'handoff' ? await handoffAdapterRun(args.run_id, args.adapter_id, db, repoRoot)
          : getAdapterStatus(args.run_id);
        if (onUpdate && action !== 'status') onUpdate();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'vibesync_partial_verify') {
        const result = executePartialVerification({ taskId: args.task_id, actorName: args.actor_name, indices: args.indices ?? null, repoRoot }, db);
        if (onUpdate) onUpdate();
        return { content: [{ type: 'text', text: toolText(isFullDetail(args) ? result : compactGateResult(result, 'Continue implementation, then run final verification when ready.'), args) }] };
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
              text: toolText(isFullDetail(args) ? result : compactGateResult(result, 'Task settled. Continue with the next assigned task or feature work.'), args)
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
