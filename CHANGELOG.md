# Changelog

## Unreleased

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
