---
name: vibesync-mcp
description: "Operate a VibeSync project through its local MCP server: inspect task contracts, claim and maintain leases, verify work, and administer planning when explicitly requested. Use when a user asks to control VibeSync or its task workflow."
---

# VibeSync MCP

Use the VibeSync MCP server configured by the project’s `.mcp.json`, or run
`node scripts/vibesync.mjs --repo <repo-root> --mcp-role worker` for a local
worker session. Use `--mcp-role admin` only for user-authorized planning,
approval, repair, or adapter administration.

Start by calling `vibesync_preview_task` with the intended task and actor. Read
its resolved commands, scope, policy mode, approval status, and model guidance.
Use `vibesync_list_ready_tasks` for selection and `vibesync_get_task_detail` for
one task; do not retrieve the full ledger unless administration requires it.

For implementation, claim one ready task with `vibesync_claim_task`, use the
returned managed worktree, and renew long-running work through
`vibesync_heartbeat_task`. Claiming provisions a worktree and lease; it does not
launch a coding agent. Keep work within `allowed_paths`, preserve the lease
token as private data, and use `vibesync_park_insight` for unrelated discoveries.

When code is ready, use `vibesync_partial_verify` only for safe declared gates,
then `vibesync_verify_and_settle` for the task’s actual completion path. Report
the exact gate result and stop if verification, scope, or lease checks fail.
Do not bypass approvals, alter task scope after claiming, or advance dependent
tasks merely because they are visible in the queue.

Use administrator tools only after the user asks for the mutation. In
particular, release a task only to requeue abandoned work, settle a feature only
after all its tasks settle, and use policy migration or repair only after reading
their previews.
