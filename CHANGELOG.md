# Changelog

## Unreleased

- Create an issue from an initiative: **New issue** in the details panel creates a GitHub issue (with the person's own
  write token, with the connect-and-resume flow), a Forgejo issue or a Vikunja task (board token, signed with a footer),
  and queues its short ref as a `setIssues` edit. New endpoint `POST /api/repos/<repo>/issues/create` (CSRF, may-submit,
  20 per person per hour), new `createProviders` in `edit-config`, and new `issues.vikunja.projectId` / `projectMap` with a
  project picker fed by `GET /api/repos/<repo>/issues/vikunja-projects`.
- Forgejo (and Gitea) issue refs: `fj#12` for the repository's configured Forgejo repo and `fj:owner/name#12`
  for another repo on the same site. Per-repo `issues.forgejo: { baseUrl, repo, tokenFile? }`: links only without a
  token, live open/closed state with one. Pasted Forgejo issue and pull request URLs become short refs, and
  `edit-config` exposes `forgejoBaseUrl` and `forgejoRepo` (never the token).
- Show initiative and phase reports from `<initiative folder>/reports/` (`.md` and `.html`, `.md`/`.html` twins grouped,
  `phase-<n>` names attached to their phase). The snapshot lists them from the git tree; cards show "N reports", the
  details panel has a **Reports** section and phase chips, and a large viewer renders markdown (sanitized, relative
  images through authenticated endpoints) and HTML twins in a script-less sandboxed frame. New endpoint
  `GET /api/repos/<repo>/initiatives/<id>/reports/<file>`.

- Edit issue refs (`setIssues`) and external links (`setLinks`, new optional `links` field) from the details panel.
- Attach PNG, JPEG, WebP and GIF images in the markdown editors (paste, drop or "Attach image"). Images are committed
  under `<initiative folder>/assets/` in the same commit as the text, and served to signed-in users from
  `GET /api/repos/<repo>/initiatives/<id>/assets/<file>`. Remote images stay blocked.
- Closed columns (done statuses, `parked`, `dropped`) show only items changed in the last 14 days (latest of
  `updated` and the last commit). Each has "Show all (N)" / "Show recent"; headers show "N · M shown". URL:
  `closed=all` or `closed=<status>,<status>`; the older `done=all` still works.
- Fold any board column to a narrow strip from its header. Folded columns still accept drops and are remembered per
  repository in the browser.
- Scaffold the public workspace.
- Read `.snoboard.yml`, parse initiative frontmatter, validate it, and merge a cross-branch snapshot.
- Add the `snoboard` command: `validate`, `next-number`, `status`, and `new`.
- Add `snoboard fix` to normalise opted-in initiative frontmatter in the working tree.
- Document configuration, the initiative schema, and the CLI.
- Serve several repositories from one board (`SNOBOARD_REPOS_FILE`): per-repo sync, API (`/api/repos/<id>/`),
  URLs (`/r/<id>/`) and a repository switcher. Single-repo setups keep their URLs.
- Scope edits per repository: modes, branches, bot token and GitHub write scope come from that repository's
  entry; a submit can never target another repository. Basket and submit mode are stored per repository.
- Helm chart: optional `reposConfig` (ConfigMap and `SNOBOARD_REPOS_FILE`) and `extraSecretMounts`. Default
  render unchanged.
- Show issue tracker refs on cards and in initiative details. Each repository enables GitHub and Vikunja
  on its own; the board lists links without waiting on trackers, and loads open or closed state with the initiative.
