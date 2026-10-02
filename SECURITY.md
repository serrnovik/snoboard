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

### Write path (`SNOBOARD_EDIT_MODES` set)

Assets: the target repository, the GitHub write tokens (each GitHub user's own token, and the optional bot token),
and the audit trail in commit trailers. See `docs/editing.md` for operator settings.

| Threat | Control |
| --- | --- |
| Cross-site request to `POST /api/edits/submit` | Origin/Referer must match `SNOBOARD_PUBLIC_URL`, plus a CSRF token from `GET /api/edit-config` bound to the session (or Access identity) and given only to people who may submit. Session cookies are `SameSite=Lax`, `HttpOnly`. |
| Read-only users writing | Anonymous and `none` mode never submit. Password and Access users submit only when a bot token file is configured, or (Access with `SNOBOARD_GITHUB_WRITE_CONNECT=true`) with a GitHub token they connected themselves. GitHub users always use their own token, never the bot token. |
| Access write-connect binding | `/auth/github/write` and its callback verify the Access JWT themselves; the callback must come from the same Access login (email, subject, token issue time) that started it, checks the token with `GET /user`, and enforces `SNOBOARD_ALLOWED_GITHUB_LOGINS` when set. The stored token is bound to that Access login and email: another Access user or a new Access login cannot use it. |
| Token leak | GitHub write tokens are AES-GCM encrypted in process memory for at most an hour; the browser holds a random handle in an `HttpOnly` cookie scoped to `/api`. The bot token is read from a file at submit time. No token is put in `localStorage`, HTML, an API body, a log line, or an error (GitHub messages are scrubbed). Logout and `DELETE /auth/github/write` drop the user token; a `401` from GitHub drops it too. |
| Writing outside the initiatives | Every path must be `<root>/<project>/<NNN>-<slug>/<file>` with the configured file name; `..`, `.`, empty segments, backslashes, `:` and NUL are refused. The file at the target head must be a regular file at exactly that path (symlinks, directories and submodules are refused). |
| Malicious edit values | The browser is untrusted. The server re-parses every edit, re-applies it to the file at the target branch head, re-parses the result and refuses any new validation error. Field values go through a YAML serializer; titles and labels cannot contain line breaks; a body never changes the frontmatter (the first closing `---` ends it). Status and priority must be values from `.snoboard.yml`. |
| Lost updates and races | Each edit carries the value the user saw (`from`, or `fromHash` for the body); a mismatch rejects the whole batch with nothing written. `direct` creates one commit whose parent is the head it read, then moves the branch with `force: false` after checking the expected old sha; one retry if the branch moved. One submit at a time per person. |
| Force push / history rewrite | Never. No call sets `force: true`. |
| Half-written pull requests | `pr` order: commit, branch, PR. If the PR fails, the branch is deleted. The label is best-effort. |
| Abuse | Request body at most 64 KiB and 50 edits per batch; 10 submits per person per hour (signing in again does not reset it). Only the submit route accepts up to 12 MiB, for images; the rest of that body is still held to 64 KiB. |
| Malicious uploads | Images are checked on the server, never trusted from the browser: PNG, JPEG, WebP or GIF by magic bytes only (SVG, HTML and anything else refused), declared type must match the bytes, at most 5 MB each, 10 per submit and 8 MB in total, sha256 and size must match the edit, and every uploaded byte must belong to an edit. |
| Upload path tricks | The asset name must be `assets/[a-z0-9-]+.(png\|jpg\|webp\|gif)`, built from the initiative folder the server resolves itself (an existing id, or a `new:<project>/<slug>` created in the same batch). The full path must be `<root>/<project>/<NNN>-<slug>/assets/<file>`; an existing file is never overwritten. |
| Serving images | `GET /api/repos/<repo>/initiatives/<id>/assets/<file>` uses the same sign-in as the board API (an `.png` ending never makes an API path public). The file name must match the same pattern, so `..`, `/` and encoded variants never reach git; the blob is read at the snapshot commit with `git cat-file` (trees and oversize blobs refused). It is answered only when its magic bytes are PNG, JPEG, WebP or GIF, with that `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'` and `Cross-Origin-Resource-Policy: same-origin`; everything else is `404`. |
| Image rendering | Markdown previews never render raw HTML. `<img>` is allowed only for relative `assets/...` paths, rewritten to the endpoint above or, before submit, to a local object URL. Remote, `data:` and other image URLs are dropped, so viewing an initiative cannot leak the viewer to a third-party host. External `links` must be `https:` or `mailto:` and open with `rel="noopener noreferrer"`. |
| Untrusted edit branches | Proposals are read from `snoboard/edits-*` branches, which anyone with push access can create. Values are shown as text only (React escapes them), PR links must be `https:`. Edit branches are hidden from the normal snapshot so they never replace a card. |
| Repudiation | Every commit ends with `Snoboard-Edit: <summary>` lines and `Snoboard-Edit-By: <user>` (`<user> (via bot)` for the bot, `<github login> (<access email>)` for an Access user's own token). Each submit is logged at info with outcome, reason code, user, edit count and image count and bytes, never content, file names or tokens. |

Known limits: image bytes wait in the browser's IndexedDB until submit, readable by anything running on the board's
origin in that browser profile. Committed images stay in git history even if the text stops linking them.

Write tokens live in one process (a restart or a second replica forgets them; people reconnect). A
classic OAuth `repo` grant covers every repository the person can write to; Snoboard only calls the configured one.
Two people creating an initiative in the same project at the same moment in `pr` mode can be given the same number on
different branches; review catches it at merge.
