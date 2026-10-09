# Security

Do not report suspected vulnerabilities in a public issue. Email
[sergey@novik.fr](mailto:sergey@novik.fr) with a description, reproduction
steps, affected versions, and any known mitigation. Please allow reasonable
time for investigation before public disclosure.

Never commit tokens, `.env` files, credentials, local paths, or consumer
repository configuration. Run
`pwsh -NoProfile -File tests/Test-PublicSource.ps1` before preparing a release.

## Threat model

Snoboard reads a git repository and shows it. With `SNOBOARD_EDIT_MODES` unset it never writes anything.
Sign-in (password, GitHub, Cloudflare Access) only decides who may view; see `docs/auth.md`.

### Report rendering

Reports under `<initiative folder>/reports/` are written by anyone who can push to the repository, so their content is
untrusted. Assets: the viewer's session on the board, and the viewer's privacy (no tracking loads).

| Threat | Control |
| --- | --- |
| Reading files outside `reports/` | The snapshot lists reports from the git tree: regular blobs only (mode `100644`/`100755`; symlinks and submodules are skipped), `.md` or `.html`, plain ASCII names, at most one folder below `reports/`. `GET /api/repos/<repo>/initiatives/<id>/reports/<file>` answers only a name in that list, built into `<folder>/reports/<name>` by the server; `..`, encoded separators and other extensions are `404`. Images below `reports/` must match a strict name pattern and are answered only when their magic bytes are PNG, JPEG, WebP or GIF (a symlink blob fails that check). |
| Script in an HTML report | Served as `text/html` with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` and shown in an `<iframe sandbox="">` (no `allow-scripts`, no `allow-same-origin`): no script runs, the document has an opaque origin and cannot read board cookies, storage or the API, cannot submit forms, open pop-ups or navigate the board. There is no option to allow scripts. Opening the endpoint directly gets the same CSP `sandbox`. |
| Tracking loads from a report | The HTML CSP allows no network fetches (only `data:` images and inline styles). Markdown is rendered by the board without raw HTML and sanitized; images load only from relative paths inside the initiative folder, through the authenticated endpoints. Remote and `data:` images in markdown are dropped. |
| Script or HTML in a markdown report | Served as `text/plain` with `nosniff` and a `default-src 'none'; sandbox` CSP. The viewer skips raw HTML and runs `rehype-sanitize`. Links: other listed reports open in the viewer, other folder files open on the forge (`https:` only), `https:`/`mailto:` links open with `rel="noopener noreferrer"`, everything else is plain text. |
| Unauthenticated access | Same sign-in as the board API; every answer has `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`. |
| Resource use | Listing reads trees only (no blobs). One blob is read per request, at most 2 MB per report and 5 MB per image (size checked with `git cat-file -s` before reading). At most 200 reports per initiative are listed. |

### Icons

Project icons come from `.snoboard.yml`, initiative icons from frontmatter; both are written by anyone who can push.

| Threat | Control |
| --- | --- |
| Reading arbitrary repository files | `GET /api/repos/<repo>/icons/<encoded path>` answers only a path that `.snoboard.yml` `projects.*.icon` or a shown initiative's `icon` names. The path must be repo-relative ASCII segments ending in `.png`, `.svg`, `.webp` or `.ico`; `..`, `.` segments, a leading `/`, backslashes and anything unreferenced are `404` before git runs. The blob is read with `git cat-file` at the default branch tip (project icons) or the initiative's commit; trees, submodules and blobs over 256 KB are refused. |
| Content-type confusion | Answered only when the magic bytes are PNG, WebP, ICO or SVG markup **and** match the extension; otherwise `404`. `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. |
| Script in an SVG icon | The board only uses icons as `<img src>`, where SVG never runs scripts or loads resources; it never inlines SVG markup into the page. Opening the URL directly gets `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, so scripts and network loads are still blocked. |
| Unauthenticated access | Same sign-in as the board API. Successful answers use `Cache-Control: private, max-age=3600`; errors `private, no-store`. |
| Bad values | Emoji must be one or two grapheme clusters of pictographic characters; label icons are emoji only; label colours come from a fixed palette mapped to CSS classes, so no CSS value from the repository reaches the page. Bad values are validation warnings and are dropped before they reach the browser. |

### Write path (`SNOBOARD_EDIT_MODES` set)

Assets: the target repository, the issue trackers, the GitHub write tokens (each GitHub user's own token, and the optional bot token),
and the audit trail in commit trailers. See `docs/editing.md` for operator settings.

| Threat | Control |
| --- | --- |
| Cross-site request to `POST /api/edits/submit` | Origin/Referer must match `SNOBOARD_PUBLIC_URL`, plus a CSRF token from `GET /api/edit-config` bound to the session (or Access identity) and given only to people who may submit. Session cookies are `SameSite=Lax`, `HttpOnly`. |
| Read-only users writing | Anonymous and `none` mode never submit. Password and Access users submit only when a bot token file is configured, or (Access with `SNOBOARD_GITHUB_WRITE_CONNECT=true`) with a GitHub token they connected themselves. GitHub users always use their own token, never the bot token. |
| Access write-connect binding | `/auth/github/write` and its callback verify the Access JWT themselves; the callback must come from the same Access login (email, subject, token issue time) that started it, checks the token with `GET /user`, and enforces `SNOBOARD_ALLOWED_GITHUB_LOGINS` when set. The stored token is bound to that Access login and email: another Access user or a new Access login cannot use it. |
| Token leak | GitHub write tokens are AES-GCM encrypted in process memory for `SNOBOARD_GITHUB_WRITE_TOKEN_TTL` (default one hour, at most 12 hours, never past the session); with `SNOBOARD_GITHUB_WRITE_TOKEN_STORE=encrypted-file` they are also kept in a `0600` file in the data directory, sealed again with AES-256-GCM under a key derived from the session secret (no token, login or handle in clear; the file store refuses to start without a session secret file); the browser holds a random handle in an `HttpOnly` cookie scoped to `/api`. The bot token is read from a file at submit time. No token is put in `localStorage`, HTML, an API body, a log line, or an error (GitHub messages are scrubbed). Logout and `DELETE /auth/github/write` drop the user token; a `401` from GitHub drops it too. |
| Writing outside the initiatives | Every path must be `<root>/<project>/<NNN>-<slug>/<file>` with the configured file name; `..`, `.`, empty segments, backslashes, `:` and NUL are refused. The file at the target head must be a regular file at exactly that path (symlinks, directories and submodules are refused). |
| Malicious edit values | The browser is untrusted. The server re-parses every edit, re-applies it to the file at the target branch head, re-parses the result and refuses any new validation error. Field values go through a YAML serializer; titles and labels cannot contain line breaks; a body never changes the frontmatter (the first closing `---` ends it). Status and priority must be values from `.snoboard.yml`. |
| Lost updates and races | Each edit carries the value the user saw (`from`, or `fromHash` for the body); a mismatch rejects the whole batch with nothing written. `direct` creates one commit whose parent is the head it read, then moves the branch with `force: false` after checking the expected old sha; one retry if the branch moved. One submit at a time per person. |
| Force push / history rewrite | Never. No call sets `force: true`. |
| Pushing to an arbitrary branch | The selected branch is untrusted input (`?ref=` and the submit body's `branch`). It must pass `git check-ref-format` rules (no `..`, `//`, `@{`, control characters, spaces, `~^:?*[\`, components starting with `.` or ending in `.lock`), may not start with `-` or `refs/`, is at most 200 characters, and must exist on the remote (`ls-remote`) before it is read or written. `direct` pushes only to a branch matching `edit.directBranches` (default: only `edit.directBranch`; the default branch gets no exception), checked on the server before any GitHub call; anything else is `403 branch_not_allowed`. `pr` only names it as the pull request base. |
| Ref injection in git | Branch names reach git only as arguments to `spawn` (no shell), only after validation, and only inside refspecs `+refs/heads/<name>:refs/snoboard/heads/<name>` or as `refs/snoboard/heads/<name>`; names from `ls-remote` that fail validation are dropped. Branch views read `refs/snoboard/heads/*`, never `refs/remotes/origin/*`, so they cannot change the merged snapshot. |
| Branch fetch cost | The list fetches heads with `--filter=blob:none` (commits and trees, no file content), at most 2000 heads, refreshed at most once per `SNOBOARD_REFRESH_SECONDS`; a branch view fetches one head on demand and only the initiative blobs it shows. Other git calls run with `GIT_NO_LAZY_FETCH=1`. Fetches share one lock with the periodic sync. Single-branch snapshots are cached per ref, at most 8 per repository (least recently used is dropped). `GET /api/repos/<repo>/branches` needs the board sign-in; `q` is at most 200 characters. |
| Half-written pull requests | `pr` order: commit, branch, PR. If the PR fails, the branch is deleted. The label is best-effort. |
| Abuse | Request body at most 64 KiB and 50 edits per batch; 10 submits per person per hour (signing in again does not reset it). Only the submit route accepts up to 12 MiB, for images; the rest of that body is still held to 64 KiB. |
| Malicious uploads | Images are checked on the server, never trusted from the browser: PNG, JPEG, WebP or GIF by magic bytes only (SVG, HTML and anything else refused), declared type must match the bytes, at most 5 MB each, 10 per submit and 8 MB in total, sha256 and size must match the edit, and every uploaded byte must belong to an edit. |
| Upload path tricks | The asset name must be `assets/[a-z0-9-]+.(png\|jpg\|webp\|gif)`, built from the initiative folder the server resolves itself (an existing id, or a `new:<project>/<slug>` created in the same batch). The full path must be `<root>/<project>/<NNN>-<slug>/assets/<file>`; an existing file is never overwritten. |
| Serving images | `GET /api/repos/<repo>/initiatives/<id>/assets/<file>` uses the same sign-in as the board API (an `.png` ending never makes an API path public). The file name must match the same pattern, so `..`, `/` and encoded variants never reach git; the blob is read at the snapshot commit with `git cat-file` (trees and oversize blobs refused). It is answered only when its magic bytes are PNG, JPEG, WebP or GIF, with that `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'` and `Cross-Origin-Resource-Policy: same-origin`; everything else is `404`. |
| Image rendering | Markdown previews never render raw HTML. `<img>` is allowed only for relative `assets/...` paths, rewritten to the endpoint above or, before submit, to a local object URL. Remote, `data:` and other image URLs are dropped, so viewing an initiative cannot leak the viewer to a third-party host. External `links` must be `https:` or `mailto:` and open with `rel="noopener noreferrer"`. |
| Untrusted edit branches | Proposals are read from `snoboard/edits-*` branches, which anyone with push access can create. Values are shown as text only (React escapes them), PR links must be `https:`. Edit branches are hidden from the normal snapshot so they never replace a card. |
| Creating issues (`POST /api/repos/<repo>/issues/create`) | Same origin and CSRF checks as submit; only people who may submit; 20 per person per hour; body at most 96 KiB, title 1 to 256 characters on one line, text at most 20 000 characters; the initiative must exist. GitHub uses only the person's own write token (never the read or bot token; a `401` drops it). Forgejo and Vikunja use their configured token files (a Vikunja project must be configured or listed by the token; the project list endpoint returns only ids and titles to people who may create) and sign the text with `Created from Snoboard by <person> for <initiative>`. Requests go only to `api.github.com` or the configured `baseUrl` (no host or URL comes from the browser), redirects are refused, tracker messages are scrubbed of the token and transport errors are replaced by a fixed text. `edit-config` lists only provider ids. One info log line per attempt with outcome, reason, user, provider, initiative and ref, never the title, text or a token. |
| Repudiation | Every commit ends with `Snoboard-Edit: <summary>` lines and `Snoboard-Edit-By: <user>` (`<user> (via bot)` for the bot, `<github login> (<access email>)` for an Access user's own token). Each submit is logged at info with outcome, reason code, user, edit count and image count and bytes, never content, file names or tokens. |

Known limits: image bytes wait in the browser's IndexedDB until submit, readable by anything running on the board's
origin in that browser profile. Committed images stay in git history even if the text stops linking them.

Write tokens live in one process (a second replica never sees them; with the default memory store a restart forgets
them and people reconnect). A longer `SNOBOARD_GITHUB_WRITE_TOKEN_TTL` or the `encrypted-file` store trades fewer
reconnects for more live tokens exposed if the server, or its data directory together with the session secret, is
compromised. `SNOBOARD_GITHUB_LOGIN_REQUESTS_WRITE=true` makes every GitHub sign-in hand over a write token. A
classic OAuth `repo` grant covers every repository the person can write to; Snoboard only calls the configured one.
Two people creating an initiative in the same project at the same moment in `pr` mode can be given the same number on
different branches; review catches it at merge.
