# Configuration

Snoboard reads `.snoboard.yml` from the repository root (the directory you pass as `--repo`, or the current directory). A missing file, an empty file, or a file that parses as null uses the defaults. The value must be a mapping. Each `doneStatuses` entry must also appear in `statuses`.

`{project}` and `{number}` in `idFormat` are replaced with the project directory and the three-digit folder prefix.

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | `initiatives` | Directory that contains `<project>/<NNN>-<slug>/` folders |
| `file` | `initiative.md` | Initiative filename inside each folder |
| `idFormat` | `{project}-{number}` | Expected `id` for a folder. Tokens: `{project}`, `{number}` |
| `defaultBranch` | `main` | Branch treated as the default. Always included when reading git refs |
| `branchPatterns` | `["initiative/*"]` | Globs matched against other branch names. `*` matches any sequence, including `/`. `?` matches one character |
| `statuses` | `idea`, `planned`, `in-progress`, `review`, `done`, `parked`, `dropped` | Allowed initiative and phase statuses. At least one |
| `doneStatuses` | `done` | Statuses that count as done. Each one must be listed in `statuses` |
| `priorities` | `p0`, `p1`, `p2`, `p3` | Allowed priorities. At least one |
| `staleAfterDays` | `30` | Days after `updated` before validation emits a warning. Integer, zero or greater |
| `reservedNumbers` | `[]` | Folder numbers that `next-number` and `new` skip when finding the highest number, e.g. parking-lot folders like `999-backlog` |
| `forge` | GitHub `owner/name` with the file and pull request templates below | Where the board links initiative files and pull requests. `type` is `github`. `repo` looks like `owner/name` |

## Example

This is the same as omitting the file:

```yaml
root: initiatives
file: initiative.md
idFormat: "{project}-{number}"
defaultBranch: main
branchPatterns: ["initiative/*"]
statuses: [idea, planned, in-progress, review, done, parked, dropped]
doneStatuses: [done]
priorities: [p0, p1, p2, p3]
staleAfterDays: 30
forge:
  type: github
  repo: owner/name
  fileUrl: "https://github.com/{repo}/blob/{ref}/{path}"
  prUrl: "https://github.com/{repo}/pull/{pr}"
```

Quote `fileUrl` and `prUrl` so YAML does not treat `{repo}` as a mapping. The tokens are `{repo}`, `{ref}`, `{path}`, and `{pr}`. Snoboard replaces each one when it builds a link. A partial `forge` mapping keeps the defaults for the keys you omit.

## Issues

Issue trackers: an initiative can list issue refs in its frontmatter (`gh#123`, `gh:owner/name#123`, `vj:456`). The board shows a count on the card without calling the tracker. Opening the initiative loads each title, whether it is open or closed, and a link. A state Snoboard cannot read is a plain link. Snoboard never creates, updates, or deletes issues.

Each repository enables its own trackers. A provider that is not configured for that repository leaves the ref as text. One repository's token is never sent for another.

### GitHub

| Key | Meaning |
| --- | --- |
| `repo` | `owner/name` used for `gh#123`. `gh:owner/name#123` names that repository itself |

Snoboard reads `GET /repos/{owner}/{name}/issues/{number}`. Pull requests returned by that endpoint are shown too. The token is the shared read token in `SNOBOARD_GITHUB_TOKEN_FILE`. It is sent only for that repository's own `forge.repo` from `.snoboard.yml`. Set `issues.github.repo` to the same `owner/name`. A different repository, including a qualified ref, is read without the token.

When the board serves one repository and that entry has no `issues` block, GitHub uses `forge.repo` and `SNOBOARD_GITHUB_TOKEN_FILE`. Without the token file, refs stay on the board as text and Snoboard does not call GitHub. Vikunja still needs an `issues` block.

### Vikunja

| Key | Meaning |
| --- | --- |
| `baseUrl` | Vikunja site origin, for example `https://tasks.example`. Must be `https`. `http` is allowed only when the host is `localhost`, `127.0.0.1`, or `::1` |
| `tokenFile` | Optional. Path to a file that contains the API token. The token is read once at startup. Without it, `vj:` refs link to `{baseUrl}/tasks/{id}`, the state shows as unknown, and Snoboard never calls Vikunja |

The token needs permission to read tasks only. Do not grant permission to create, update, or delete tasks.

Snoboard calls `GET /api/v1/tasks/{id}` for each `vj:{id}` (or `vikunja:{id}`) ref. Search uses `GET /api/v1/tasks/all?s=` and keeps at most 10 tasks. A task with `done: true` is closed. Any other task is open. A missing task or a rejected token is shown as unknown.

```yaml
issues:
  vikunja:
    baseUrl: https://tasks.example
    tokenFile: /var/run/secrets/vikunja-token # optional: omit for links only
```

Chips always link when Snoboard can build the URL without the network: `gh:owner/name#n` always, `gh#n` when the repository has a GitHub repo, and `vj:n` when `vikunja.baseUrl` is set. `GET /api/repos/{id}/edit-config` returns these settings as `issues: { githubRepo, vikunjaBaseUrl }` (never tokens), so the editor can turn a pasted URL into a short ref.

## Deployed version

The page footer shows `Snoboard {version}`. Set `SNOBOARD_VERSION` (the Helm chart sets it from `image.tag`, else the chart `appVersion`) to show the deployed image version; without it the footer shows the package version.

## Several repositories

One board can serve several repositories. Point `SNOBOARD_REPOS_FILE` at a YAML file on the server. Each
repository gets its own clone, snapshot, edit settings and URLs (`/r/<id>/`, API under `/api/repos/<id>/`). Each
repository still reads its own `.snoboard.yml` (or `configPath`).

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | `[a-z0-9-]{1,32}`, unique. Used in URLs, qualified ids (`<id>:<project>-<NNN>`) and browser storage keys |
| `name` | yes | Label in the repository switcher |
| `url` | yes | Git URL. No credentials in the URL. `git@` and `ssh://` need `sshKeyFile` |
| `sshKeyFile` | for SSH | Path to a read-only deploy key |
| `gitTokenFile` | no | Path to a git token file for private `https` remotes |
| `configPath` | no | Config file to use instead of `.snoboard.yml` in that clone |
| `edit.modes` | no | `direct`, `pr`, or both. Empty or missing: that repository is read-only |
| `edit.baseBranch` | no | Branch pull requests target. Default: that repository's `defaultBranch` |
| `edit.directBranch` | with `direct` | Branch `direct` updates |
| `edit.botTokenFile` | no | Bot token for password and Cloudflare Access users, for this repository only |
| `edit.githubWriteScope` | no | `repo` or `public_repo` for the GitHub write grant. Default: `SNOBOARD_GITHUB_WRITE_SCOPE` |
| `issues` | no | Trackers for this repository only. `github.repo` is `owner/name` (same as `forge.repo` so the read token is sent). `vikunja` is `baseUrl` and an optional `tokenFile` |

```yaml
repos:
  - id: acme
    name: Acme platform
    url: "git@github.com:example/acme.git"
    sshKeyFile: /var/run/secrets/acme/ssh-key
    edit:
      modes: [direct, pr]
      directBranch: main
      botTokenFile: /var/run/secrets/acme/bot-token
    issues:
      github:
        repo: example/acme
      vikunja:
        baseUrl: https://tasks.example
        tokenFile: /var/run/secrets/acme/vikunja-token
  - id: widgets
    name: Widgets
    url: "https://github.com/example/widgets.git"
    edit:
      modes: [pr]
      githubWriteScope: public_repo
```

Unknown keys, duplicate ids, a missing key file, or credentials inside a URL stop the server at startup.

### Fallback rules

- `SNOBOARD_REPOS_FILE` unset: the board serves one repository with id `default`, built from `SNOBOARD_REPO_URL`,
  `SNOBOARD_SSH_KEY_FILE`, `SNOBOARD_GIT_TOKEN_FILE`, `SNOBOARD_CONFIG_PATH` and the `SNOBOARD_EDIT_*` variables.
  Old URLs (`/`, `/graph`, `/initiatives/<id>`) and `/api/*` routes keep working.
- `SNOBOARD_REPOS_FILE` set: those single-repo variables are ignored (a warning names them). Old URLs and `/api/*`
  routes go to the first repository in the file.
- Edit settings never cross repositories. A submit to `/api/repos/<id>/edits/submit` writes only to the `forge.repo`
  of that repository's own config, with that repository's modes, branches and bot token. A request body that names
  another repository is refused. A repository without `edit.botTokenFile` never uses another repository's bot.
- A GitHub user's write grant belongs to the session, not to one repository. If GitHub refuses it for a repository
  (401, 403 or 404), the board asks the user to connect write access again, with that repository's scope.
- Auth, sessions and `SNOBOARD_GITHUB_TOKEN_FILE` (read-only pull request status and GitHub issue state) are shared by all repositories. The issue token is sent only for that repository's own `forge.repo`.
- Issue trackers do not cross repositories. A repository without an `issues` block does not use another repository's GitHub repo or Vikunja token. In a file with several repositories, omitting `issues` leaves refs as text.

### Migrating from environment variables

1. Copy the single-repo values into one entry: `SNOBOARD_REPO_URL` to `url`, `SNOBOARD_SSH_KEY_FILE` to
   `sshKeyFile`, `SNOBOARD_GIT_TOKEN_FILE` to `gitTokenFile`, `SNOBOARD_CONFIG_PATH` to `configPath`,
   `SNOBOARD_EDIT_MODES` to `edit.modes`, `SNOBOARD_EDIT_BASE_BRANCH` to `edit.baseBranch`,
   `SNOBOARD_EDIT_DIRECT_BRANCH` to `edit.directBranch`, `SNOBOARD_EDIT_BOT_TOKEN_FILE` to `edit.botTokenFile`.
2. Use `id: default` to keep existing browser baskets and remembered submit modes (`snoboard:basket:v1:default`,
   `snoboard:submit-mode:v1:default`). Another id starts with an empty basket.
3. Set `SNOBOARD_REPOS_FILE`, then remove the single-repo variables.
