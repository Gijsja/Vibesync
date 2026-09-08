# Contributing to VibeSync

Thanks for helping make agent collaboration easier to follow.

Use Node.js 24+ and Git, then run `npm ci`. Start the dashboard with `npm run hud`.
Use a disposable project when exercising hotfixes or settlement.

- `src/`: state engine, Git operations, HTTP/SSE and MCP.
- `.vibesync/dashboard.html`: bundled dashboard and pixel room.
- `scripts/`: runtime entry points and repository checks.
- `tests/`: temporary-project regression tests.
- `docs/`: current guides and historical design material.

Keep changes focused and explain the user-visible behavior in your pull request.
Add regression coverage for fixes that affect state, Git safety or runtime
behavior. Run `npm test` and `npm run check:public` before sharing changes.
Do not include your local database, model credentials, raw agent transcripts or
real project logs. Security reports follow SECURITY.md.

Gate and provisioning commands must use executable-and-argument arrays in new
interfaces. Preserve support for simple legacy strings without reintroducing an
implicit shell. Changes to MCP tools must keep purpose/use/non-use/side-effect
descriptions, standard safety annotations, and worker/admin role separation.
