# Publishing the application source

The public source is published as a fresh-history export. The original local
**development checkout** retains earlier commits with internal agent material,
the reference PDF, machine paths, and VibeSync state refs. Those files and refs
are excluded from the export. Keep that development history private; a normal
file-deletion commit alone would not erase it.

For a clean public starting point, export only the maintained source:

```sh
npm run check:public
node scripts/export-public.mjs /absolute/path/to/new-public-folder
```

The destination must not exist and must be outside the development checkout. The export contains source, tests, current and
archived public documentation, and portable configuration examples. It omits Git
history, runtime state, private local archives, credentials, and agent transcripts.
Inspect that folder, run `npm ci` and `npm test` there, then initialize a new Git
repository and publish that fresh history to your chosen destination. The export
command removes a partial destination if copying fails.

Do not use `git push --mirror` or `git push --all` from the development checkout.
If old material is already on a public remote, making a clean export does not
remove it there. Review and clean that remote's history and refs separately;
coordinate any history rewrite with collaborators. No remote history or visibility
is changed by the export command.
