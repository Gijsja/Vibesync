# Security

VibeSync is intended for trusted, local, single-user development. Gate commands
execute as the current user. The loopback HUD is not a remotely authenticated
service and should not be exposed through a public tunnel or reverse proxy.
See [HARDENING.md](HARDENING.md) for the enforced runtime boundaries.

## Reporting an issue

Please do not put credentials, private source code, or exploitable sensitive
payloads in a public issue. If the repository offers GitHub's private vulnerability
reporting option, use it. Otherwise open a minimal issue asking for a private
reporting channel, without the sensitive details.

## What to keep private

Local MCP configuration, environment files, keys, databases, logs, backups,
worktrees, browser captures and internal agent transcripts are ignored by Git.
Use `.mcp.example.json` as a template; never add real credentials to it.

Git also stores data outside the working directory: `vibesync/state`,
`vibesync/incubator`, and `refs/notes/vibesync` may contain project specifications,
ideas and command output. Treat these as project data. Do not mirror-push a
working VibeSync repository to publish the application source.

Removing a file from the current tree does not erase prior commits. See
[public publication instructions](docs/PUBLISHING.md) before publishing an existing
private development repository. The local pattern check is a useful guardrail,
not an exhaustive secret scanner; rotate any credential that was exposed.
