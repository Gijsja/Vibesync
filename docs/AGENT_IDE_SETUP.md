# Agent and IDE MCP setup

VibeSync is a local stdio MCP server. A supported client must be able to start a
local command, pass an argument array, and keep that process open for the MCP
session. VibeSync does not provide a remote HTTP MCP endpoint.

The canonical operating instructions are
[`skills/vibesync-mcp/SKILL.md`](../skills/vibesync-mcp/SKILL.md). Point agents
to that file, or install it through the client's normal project-skill mechanism,
so task selection, previews, leases, scope, and settlement follow one workflow.
Client configuration only establishes the transport; it does not replace the
skill or grant administrative authority.

## Supported runtime bindings

Run `vibesync --init --repo /absolute/path/to/project` once for the target
repository. Initialization merges a `vibesync` worker entry into the project's
`.mcp.json` without removing existing servers. The checked-in examples show both
supported runtimes:

| Runtime | Minimum | Binding command | Source example |
| --- | --- | --- | --- |
| Node.js | 22.13+; 24+ recommended | An absolute Node executable with `scripts/vibesync.mjs` and `--repo` arguments | [`.mcp.example.json`](../.mcp.example.json) |
| Bun | 1.3+ | `vibesync-bun` with a `--repo` argument | [`.mcp.bun.example.json`](../.mcp.bun.example.json) |

Use one runtime binding, not both. Keep every path absolute because an IDE may
start the server from a directory other than the project root. The generated
Node binding records the executable used during initialization; moving that
runtime or the VibeSync checkout requires regenerating or updating the binding.

## Agent and IDE matrix

| Client surface | Status | VibeSync binding |
| --- | --- | --- |
| Project clients that load `.mcp.json` | Supported | Enable the generated `mcpServers.vibesync` entry in the target project. |
| ChatGPT desktop app, Codex CLI, and Codex IDE extension | Supported with native Codex configuration | Add the same command and arguments as a project-scoped `.codex/config.toml` entry or through the MCP server UI. These Codex surfaces share the configuration on the same host. |
| Other local MCP clients with a stdio server form | Compatible transport | Copy the generated `command` and `args` values into that client's local stdio configuration. Client-specific discovery and approval UI are outside the VibeSync baseline. |
| Web-only or remote-only MCP clients | Not supported by this binding | They cannot start VibeSync's local stdio process. Do not expose the loopback HUD as an MCP endpoint. |

“Supported” here covers the VibeSync transport and workflow. Provider adapters
for Gemini, Claude, Codex, or a local model are a separate, administrator-owned
feature; configuring an MCP client does not configure or launch an adapter.

### Codex example

Codex uses TOML rather than importing the project's `.mcp.json` directly. Its
[MCP documentation](https://developers.openai.com/codex/mcp) describes the
shared desktop, CLI, and IDE configuration. Copy the generated Node values into
a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.vibesync]
command = "/absolute/path/to/node"
args = [
  "/absolute/path/to/Vibesync/scripts/vibesync.mjs",
  "--repo",
  "/absolute/path/to/your-project",
  "--mcp-role",
  "worker",
]
```

Alternatively, add a local STDIO server named `vibesync` in the ChatGPT desktop
app or Codex IDE extension and enter the same command and arguments. Restart the
client after changing the binding, then confirm that the worker tools appear.
Do not add `--mcp-role admin` to an agent-controlled connection.

### Generic `.mcp.json` example

The initialized project will contain the machine-specific version of this shape:

```json
{
  "mcpServers": {
    "vibesync": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/Vibesync/scripts/vibesync.mjs",
        "--repo",
        "/absolute/path/to/your-project"
      ]
    }
  }
}
```

No role argument is required for the default worker surface. Keeping
`--mcp-role worker` explicitly is also valid.

## Required role separation

Use a worker binding for coding agents. It exposes task inspection, preview,
claim, heartbeat, partial verification, final verification, and insight parking.
It cannot change task contracts, approve commands, release another worker's
lease, or repair state.

Create a separate `--mcp-role admin` binding only in a trusted,
human-controlled client. Worker and admin catalogs are deliberately disjoint.
An administrator reviews hash-bound command approvals and planning mutations;
an agent must not switch its own connection to admin to unblock a gate.

Policy still applies after the MCP client approves launching the server:

- VibeSync command approval is separate from the client's MCP/tool approval.
- `sandbox_mode` controls VibeSync gate containment; client sandbox settings do
  not silently replace it.
- A claim returns a private lease token. Do not place that token in chat,
  documentation, commits, or shared logs.
- Use the managed worktree returned by `vibesync_claim_task` and stay within the
  task's `allowed_paths`.

## Connection check

After enabling the worker server:

1. Call `vibesync_list_ready_tasks` and choose one ready task.
2. Call `vibesync_preview_task` with the intended task and actor before claiming.
3. Confirm the preview's scope, resolved commands, policy mode, approval state,
   model guidance, and baseline warning.
4. Call `vibesync_claim_task` once and work only in the returned worktree.
5. For a long task, renew the lease with `vibesync_heartbeat_task` at the cadence
   returned by the claim.
6. Use `vibesync_partial_verify` only for declared safe gates, then finish with
   `vibesync_verify_and_settle`.

Request `detail: "full"` only when the compact response omits evidence needed
for the decision. If a gate, scope check, approval, or lease check fails, report
the exact result and stop instead of weakening the contract.

## Troubleshooting

- **Server never appears:** run the exact configured command in a terminal and
  check stderr. MCP JSON-RPC is written to stdout, so wrappers must not print
  banners there.
- **Wrong repository:** verify the absolute path following `--repo`. VibeSync
  state and managed worktrees belong to that repository.
- **Runtime moved:** rerun initialization or update the absolute command and
  script paths in the client binding.
- **Only admin or only worker tools appear:** check `--mcp-role`; do not combine
  both roles in one connection.
- **Gate requires approval:** leave the task contract unchanged and ask a human
  administrator to review the current preview and command hash.
- **Port message on stderr:** the HUD binds only to loopback and may select a
  different local port. This does not change the stdio MCP transport.

See [Usage and recovery](USAGE.md) for the complete tool catalogs, execution
policy, settlement behavior, and recovery procedures.
