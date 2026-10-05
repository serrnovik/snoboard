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

Issue trackers: an initiative can list issue refs in its frontmatter (`gh#123`, `gh:owner/name#123`, `fj#123`, `fj:owner/name#123`, `vj:456`). The board shows a count on the card without calling the tracker. Opening the initiative loads each title, whether it is open or closed, and a link. A state Snoboard cannot read is a plain link. Snoboard never updates or deletes issues; with editing on it can create one from an initiative (see [Creating issues](#creating-issues)).

Each repository enables its own trackers. A provider that is not configured for that repository leaves the ref as text. One repository's token is never sent for another.

### GitHub

| Key | Meaning |
| --- | --- |
| `repo` | `owner/name` used for `gh#123`. `gh:owner/name#123` names that repository itself |

Snoboard reads `GET /repos/{owner}/{name}/issues/{number}`. Pull requests returned by that endpoint are shown too. The token is the shared read token in `SNOBOARD_GITHUB_TOKEN_FILE`. It is sent only for that repository's own `forge.repo` from `.snoboard.yml`. Set `issues.github.repo` to the same `owner/name`. A different repository, including a qualified ref, is read without the token.

When the board serves one repository and that entry has no `issues` block, GitHub uses `forge.repo` and `SNOBOARD_GITHUB_TOKEN_FILE`. Without the token file, refs stay on the board as text and Snoboard does not call GitHub. Vikunja still needs an `issues` block.

### Forgejo

Forgejo and Gitea share the same API.

| Key | Meaning |
| --- | --- |
| `baseUrl` | Forgejo site origin, for example `https://forge.example.com`. Must be `https`. `http` is allowed only when the host is `localhost`, `127.0.0.1`, or `::1` |
| `repo` | `owner/name` used for `fj#123`. `fj:owner/name#123` names another repository on the same site |
| `tokenFile` | Optional. Path to a file that contains an API token. For reading only, give it `issue: Read` and `repository: Read`; to create issues from the board, `issue: Read and Write` and `repository: Read`. Without it, `fj` refs link to `{baseUrl}/{owner}/{name}/issues/{n}`, the state shows as unknown, and Snoboard never calls Forgejo |

Snoboard calls `GET {baseUrl}/api/v1/repos/{owner}/{name}/issues/{n}` with `Authorization: token ...`. Pull requests share the issue numbers, so the same call answers for `/pulls/{n}`. The state is `open` or `closed`; anything else, a missing issue or a rejected token is unknown. `html_url` is used only when it is on `baseUrl`. Redirects are refused. Pasting `https://{host}/{owner}/{name}/issues/{n}` or `/pulls/{n}` from the configured site stores `fj#{n}` for the configured repo and `fj:{owner}/{name}#{n}` for others; URLs from other hosts are rejected.

```yaml
issues:
  forgejo:
    baseUrl: https://forge.example.com
    repo: example/acme
    tokenFile: /var/run/secrets/forgejo-token # optional: omit for links only
```

### Vikunja

| Key | Meaning |
| --- | --- |
| `baseUrl` | Vikunja site origin, for example `https://tasks.example`. Must be `https`. `http` is allowed only when the host is `localhost`, `127.0.0.1`, or `::1` |
| `tokenFile` | Optional. Path to a file that contains the API token. Without it, `vj:` refs link to `{baseUrl}/tasks/{id}`, the state shows as unknown, and Snoboard never calls Vikunja |
| `projectId` | Optional. Positive integer: the default project for new tasks |
| `projectMap` | Optional. Initiative project folder to Vikunja project id, for example `{ app: 23 }`. Preselected in **New issue** for initiatives of that project; `projectId` is the fallback. With a token, `projectId` or `projectMap` enables task creation |

For reading, the token needs permission to read tasks only. To create tasks from the board, it also needs to create tasks in `projectId`. Never grant update or delete.

Snoboard calls `GET /api/v1/tasks/{id}` for each `vj:{id}` (or `vikunja:{id}`) ref. Search uses `GET /api/v1/tasks/all?s=` and keeps at most 10 tasks. A task with `done: true` is closed. Any other task is open. A missing task or a rejected token is shown as unknown.

```yaml
issues:
  vikunja:
    baseUrl: https://tasks.example
    tokenFile: /var/run/secrets/vikunja-token # optional: omit for links only
    projectId: 4 # optional: default project for new tasks
    projectMap: { app: 23 } # optional: initiative project -> Vikunja project
```

Chips always link when Snoboard can build the URL without the network: `gh:owner/name#n` always, `gh#n` when the repository has a GitHub repo, `fj#n` and `fj:owner/name#n` when `forgejo` is set, and `vj:n` when `vikunja.baseUrl` is set. `GET /api/repos/{id}/edit-config` returns these settings as `issues: { githubRepo, vikunjaBaseUrl, forgejoBaseUrl, forgejoRepo }` (never tokens), so the editor can turn a pasted URL into a short ref.

### Creating issues

With editing on (`SNOBOARD_EDIT_MODES`), people who may submit edits can create an issue from the details panel
(**New issue**). The new ref is queued as a `setIssues` edit, so it lands in the initiative with the next submit.
`GET /api/repos/{id}/edit-config` lists the trackers this person may use as `createProviders` (ids only).

| Tracker | Enabled when | Credential and scope |
| --- | --- | --- |
| GitHub (`gh`) | The repository has a GitHub repo (as for reading) and the person signed in with GitHub, or with Cloudflare Access and `SNOBOARD_GITHUB_WRITE_CONNECT=true` | The person's own GitHub write token, the same one used to submit (`repo`, or `public_repo` for public repositories). Never the read token or the bot token. Without one, the board asks them to connect GitHub and then creates the issue |
| Forgejo (`fj`) | `issues.forgejo.tokenFile` is readable | The board's Forgejo token with `issue: Read and Write` and `repository: Read`. A `403` is reported as "token lacks issue write scope" |
| Vikunja (`vj`) | `issues.vikunja.tokenFile` is readable and `projectId` or `projectMap` is set | The board's Vikunja token, allowed to list projects and create tasks in them. The dialog lists projects from `GET {baseUrl}/api/v1/projects` (cached five minutes, only id and title reach the browser, through `GET /api/repos/{id}/issues/vikunja-projects?initiative=<id>`) and preselects the mapped project. The server accepts only a configured project or one the token lists |

Calls: GitHub `POST /repos/{owner}/{name}/issues`, Forgejo `POST {baseUrl}/api/v1/repos/{owner}/{name}/issues`,
Vikunja `PUT {baseUrl}/api/v1/projects/{project}/tasks`. Forgejo and Vikunja issues are written by the board's
token, so their text ends with `Created from Snoboard by <person> for <initiative id>`. Token files are read again
for every creation, so a rotated token is picked up without a restart.

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
| `issues` | no | Trackers for this repository only. `github.repo` is `owner/name` (same as `forge.repo` so the read token is sent). `forgejo` is `baseUrl`, `repo` and an optional `tokenFile`. `vikunja` is `baseUrl`, an optional `tokenFile` and an optional `projectId` (for creating tasks) |

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
- Issue trackers do not cross repositories. A repository without an `issues` block does not use another repository's GitHub repo, Forgejo site or Vikunja token. In a file with several repositories, omitting `issues` leaves refs as text.

### Migrating from environment variables

1. Copy the single-repo values into one entry: `SNOBOARD_REPO_URL` to `url`, `SNOBOARD_SSH_KEY_FILE` to
   `sshKeyFile`, `SNOBOARD_GIT_TOKEN_FILE` to `gitTokenFile`, `SNOBOARD_CONFIG_PATH` to `configPath`,
   `SNOBOARD_EDIT_MODES` to `edit.modes`, `SNOBOARD_EDIT_BASE_BRANCH` to `edit.baseBranch`,
   `SNOBOARD_EDIT_DIRECT_BRANCH` to `edit.directBranch`, `SNOBOARD_EDIT_BOT_TOKEN_FILE` to `edit.botTokenFile`.
2. Use `id: default` to keep existing browser baskets and remembered submit modes (`snoboard:basket:v1:default`,
   `snoboard:submit-mode:v1:default`). Another id starts with an empty basket.
3. Set `SNOBOARD_REPOS_FILE`, then remove the single-repo variables.

## Reports

An initiative can keep reports next to its file: phase summaries, review plans, test plans, a final report. Snoboard
lists them on the board and opens them in a viewer. There is nothing to configure.

```text
initiatives/acme/002-billing/
  initiative.md
  assets/chart.png
  reports/
    final.report.md
    final.report.html        # optional self-contained HTML twin of the .md
    phase-1.report.md
    phase-2.review-plan.md
    pr63-review-test-plan.md
    shots/invoice.png        # an image a report links to
```

- Only `.md` and `.html` files count, directly in `reports/` or one folder deeper (`reports/merge-review/plan.md`).
  Names use letters, digits, `.`, `_` and `-`, and do not start with a dot. Symlinks are ignored.
- A `.md` and an `.html` file with the same name are one report with two formats.
- A report whose name (or folder) starts with `phase-<n>` belongs to phase `n` (`phase-2.report.md`,
  `phase-2.review-plan.md`, `phase-0-baseline/audit.md`). When the initiative has no such phase, the report is listed
  with the initiative's own reports.
- At most 200 reports per initiative are listed.

The list is part of the snapshot and comes from the git tree only: a blob-less clone downloads a report only when
someone opens it. The board payload carries the list, so the card shows "N reports" without another request.

### On the board

- **Card:** a small "N reports" mark.
- **Details panel:** a **Reports** section with the initiative's reports, and chips on each phase row for that
  phase's reports (`report`, `review-plan`, ...).
- **Viewer:** a near full-screen dialog. Previous and next (buttons or the arrow keys) walk all reports of the
  initiative; **MD / HTML** switches when both exist; **Open raw on GitHub** links to the file on the forge, only when
  the configured file URL is `https:`. Esc closes it.

Markdown reports are rendered by the board with the same sanitized renderer as the editor preview (tables, task
lists). Raw HTML inside the markdown is not rendered.

- Images with a relative path inside the initiative folder are shown: `../assets/<file>` through the image endpoint
  (see [editing.md](editing.md#images)), and PNG, JPEG, WebP or GIF files below `reports/` (`./shots/invoice.png`)
  through the report endpoint. Remote, `data:` and other images are never loaded.
- A relative link to another listed report (`./phase-1.report.md`) opens it in the viewer. A relative link to another
  file in the initiative folder opens that file on the forge. `https:` and `mailto:` links open in a new tab. Other
  links show as plain text.

HTML twins render statically in a sandboxed frame: no scripts, no forms, no pop-ups, no access to the board, and no
network requests (styles must be inline, images `data:` URIs). Interactive HTML reports (charts drawn by JavaScript,
tabs, filters) therefore show only their static content; read the markdown twin or open the raw file instead. There
is no switch to allow scripts.

### Report endpoint

`GET /api/repos/<repo>/initiatives/<id>/reports/<file>` (and `.../reports/<folder>/<file>`) answers one file, read
from the clone at the tip of the initiative's source branch. The blob is fetched on demand.

| Request | Answer |
| --- | --- |
| A listed `.md` report | `text/plain; charset=utf-8` |
| A listed `.html` report | `text/html; charset=utf-8` with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'` |
| A PNG, JPEG, WebP or GIF below `reports/` | Its image type, by magic bytes (SVG refused), at most 5 MB |
| Anything else, a report over 2 MB, a symlink, a path outside `reports/` | `404` |

It uses the board's sign-in. Every answer has `X-Content-Type-Options: nosniff` and `Cache-Control: private,
no-store`. The threat model is in [SECURITY.md](../SECURITY.md#report-rendering).
