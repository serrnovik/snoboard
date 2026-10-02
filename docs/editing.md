# Editing

Snoboard can save small changes from the board: status, priority, phase status, title, labels, issue refs, external links, the markdown body (with attached images), or a new initiative. Changes stay in the browser until someone submits them. Set `SNOBOARD_EDIT_MODES` to turn this on. Leave it empty, or unset, and the board stays read-only.

| Env var | Meaning |
| --- | --- |
| `SNOBOARD_EDIT_MODES` | Comma-separated `direct` and `pr`. `direct` pushes to a branch. `pr` opens a pull request |
| `SNOBOARD_EDIT_BASE_BRANCH` | Branch pull requests target. Defaults to the repository's default branch |
| `SNOBOARD_EDIT_DIRECT_BRANCH` | Branch `direct` updates. Required when `direct` is enabled. This is usually `main` |
| `SNOBOARD_EDIT_BOT_TOKEN_FILE` | Optional token file so password and Cloudflare Access users can submit |
| `SNOBOARD_PASSWORD_NAME` | Optional label in bot commit trailers. Defaults to `password-user` |

`direct` is the default when it is allowed. The board remembers the last choice for each repository in the browser.

## Issues and links

The details panel lists the initiative's issue refs as chips, with the same open or closed state as the
**Issues** section. Type a ref (`gh#12`, `gh:owner/name#12`, `vj:45`) and press Enter to add it; the
field says so while the syntax is wrong. `vikunja:45` is saved as `vj:45`. Pasting a GitHub issue or pull request URL
adds `gh#12` (this repository) or `gh:owner/name#12`; pasting a task URL from the configured Vikunja site adds
`vj:45`. A URL from any other host is refused. Chips link to the tracker even when the state is unknown. The x on a chip removes it. Each change replaces the whole list
in one `setIssues` edit.

**Links** is a small table of title and URL rows. **Save links** checks every row (title 1 to 120
characters, `https:` or `mailto:` URL) and queues one `setLinks` edit. See [schema.md](schema.md#links).

## Images

Both markdown editors (**Edit text** in the details panel and **Text** in **New initiative**) take images:
paste one, drop one, or use **Attach image** in the toolbar.

- Only PNG, JPEG, WebP and GIF, recognised by their first bytes (the file name and browser type do not
  count). SVG is refused.
- At most 5 MB per image, 10 images per basket, and 8 MB of images per submit.
- The image is named after the file (`Screen Shot.png` becomes `assets/screen-shot.png`; a name already
  used gets `-2`, `-3`, ...) and the editor inserts `![Screen Shot](assets/screen-shot.png)` at the cursor.
- The bytes stay in the browser's IndexedDB until you submit. The basket in `localStorage` keeps only a
  reference (`addAttachment` with path, type, size and sha256). Removing the edit or clearing the basket
  deletes the bytes. An image the text no longer mentions is dropped when you save the text.
- On submit the browser sends the bytes base64-encoded with the edits. The server checks each image again
  (magic bytes, size, sha256, safe name, path inside the initiative folder, name not already taken) and
  writes it as a blob in the same single commit as the text.
- For a new initiative, images go into the new folder (`<project>/<NNN>-<slug>/assets/`) once the number is
  assigned.

Committed images are served only to signed-in users, from
`GET /api/repos/<repo>/initiatives/<id>/assets/<file>`. The editor preview and the details panel show
`assets/...` images through that endpoint (pending ones from the browser). Remote image URLs are never
loaded.

## Who submits

A person signed in with GitHub always submits with their own write token, from `GET /auth/github/write`. Snoboard never uses the bot token for that sign-in, even when the bot file is set.

Password and Cloudflare Access sign-in can view the board but not submit, unless `SNOBOARD_EDIT_BOT_TOKEN_FILE` points at a token file. The commit is made by the bot. The trailer still names the person:

```text
Snoboard-Edit-By: password-user (via bot)
Snoboard-Edit-By: ada@example.com (via bot)
```

Password sign-in uses `password-user` unless `SNOBOARD_PASSWORD_NAME` is set. Cloudflare Access uses the signed-in email. Without the bot file, those users see a read-only message and no submit button.

## Bot token

Create a fine-grained personal access token for the one repository the board edits:

- **Contents:** Read and write. Snoboard reads the files it changes and pushes a commit.
- **Pull requests:** Read and write. Required for `pr` mode.
- **Issues:** Read and write only when Snoboard should apply the `snoboard` label. The label is best-effort: without Issues access the submit still succeeds and the response warns that the label was not added.

Put the token in a file by itself and point `SNOBOARD_EDIT_BOT_TOKEN_FILE` at that path. Do not put the token in an environment variable. Snoboard reads the file when someone submits and does not log it.

## GitHub sign-in and scopes

GitHub users connect write access once per session from the submit dialog (`GET /auth/github/write`). Login asks
only for read scopes; the write grant asks for `repo` (or `public_repo`, see `docs/auth.md`). The token stays
encrypted in server memory for at most an hour and is dropped on logout.

With several repositories (`SNOBOARD_REPOS_FILE`), every edit setting above lives on the repository entry
(`edit.modes`, `edit.baseBranch`, `edit.directBranch`, `edit.botTokenFile`, `edit.githubWriteScope`). The basket
and the remembered submit mode are kept per repository in the browser. See
[configuration.md](configuration.md#several-repositories).

## What a submit does

Every edit in the basket is checked again on the server against the head of the target branch. If any edit no
longer applies, nothing is written.

- `direct`: one commit on top of the branch head, then a fast-forward of `SNOBOARD_EDIT_DIRECT_BRANCH` with the
  expected old sha. Never a force push. If someone pushed in between, Snoboard re-applies once on the new head. If
  branch protection refuses the push, the dialog says so and offers `pr`.
- `pr`: one commit on a new `snoboard/edits-<time>-<random>` branch, then a pull request to
  `SNOBOARD_EDIT_BASE_BRANCH` (default branch when unset). If the pull request cannot be opened, the branch is
  deleted. The `snoboard` label is added when it exists.

Open edit branches show as **proposed** on their cards until they are merged or deleted.

## Conflicts

Each edit remembers the value you saw (`from`), or a hash of the text for body edits.

| Situation | Result |
| --- | --- |
| The file changed upstream, but not the field you edited | Applied; the response lists the file under `reapplied` |
| The field changed upstream (`from` no longer matches) | `409 rejected`, the stale edit is marked, nothing written |
| The branch moved twice during a `direct` submit | `409 branch_moved`, nothing written; try again |
| A new initiative's number was taken meanwhile | `409 number_taken`; validate again to get the next number |

## Audit trail

Each commit message lists one line per edit and names the person last:

```text
snoboard: 2 edits by octocat

Snoboard-Edit: acme-004: status idea -> planned
Snoboard-Edit: acme-004: priority p3 -> p2
Snoboard-Edit-By: octocat
```

The server also logs one info line per submit with the outcome, reason code, user and number of edits. It never logs
edit content or tokens:

```text
snoboard: submit denied reason="csrf" user="octocat" actor=github mode="pr" edits=1
snoboard: submit ok reason="ok" user="octocat" actor=github repo="default" mode="direct" edits=3 attachments=1 attachment_bytes=48213
```

With images, the line adds their count and total bytes, never their names or content.

## Limits

A batch is at most 50 edits and 64 KiB. Each person can submit 10 times per hour.

Images: at most 5 MB each, 10 per basket, 8 MB per submit. Only the submit route accepts a larger body
(12 MiB, to fit the base64 images); everything except the images still has to fit in 64 KiB. A larger request
is refused with `413 too_large` and nothing is written.

## Turning editing off

Unset `SNOBOARD_EDIT_MODES` (or set it to an empty string) and restart. The basket, edit controls and submit routes
go away; `POST /api/edits/submit` answers `403 editing_disabled`. Remove the bot token file and revoke the token if
you no longer need it. Open `snoboard/edits-*` branches stay in the repository until you merge or delete them.
