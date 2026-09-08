# Security

VibeSync is intended for local, single-user development. New projects use policy
version 2: commands require hash-bound administrator approval, legacy command
forms are disabled, network is denied by default, and Linux Bubblewrap containment
is required. The contained process still runs under the current user identity.
Version-1 compatibility projects may use process-only hardening, which is not a
filesystem or network security boundary. The loopback HUD is not a remotely
authenticated service and should not be exposed through a tunnel or reverse proxy.
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

## Trust boundary and limitations

Treat approved gate code, configured adapter executables, Git hooks, package
scripts, and their dependencies as trusted code. VibeSync validates persistent
write scope and protects Git metadata during contained gates, but pattern-based
secret scanning cannot detect every credential. Adapter lifecycle state does not
survive a VibeSync supervisor restart. Bubblewrap is Linux-specific; required mode
fails closed on unsupported hosts. Time, output, and concurrency limits are
enforced, but portable hard CPU and memory quotas are not.

Audit rollups redact sensitive keys and common secret patterns and HTML-escape
untrusted strings. Raw source, external provider logs, Git history, and artifacts
may still contain private data and should be handled accordingly.
