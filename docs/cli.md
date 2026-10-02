# CLI

The `snoboard` package bin is `dist/cli.js` (`#!/usr/bin/env node`). It uses Node's `parseArgs`. There is no short form of these flags.

```text
snoboard validate [--repo <dir>] [--ref <ref>] [--changed-since <ref>] [--json]
snoboard next-number <project> [--repo <dir>] [--fetch]
snoboard status [--ready | --stale] [--project <project>] [--repo <dir>] [--json]
snoboard new <project> <slug> [--title <title>] [--priority <priority>] [--repo <dir>] [--fetch]
snoboard fix [--repo <dir>] [--dry-run] [--json] [paths...]
snoboard --version
snoboard --help
```

## Exit codes

| Code | When |
| --- | --- |
| 0 | The command succeeded. `validate` also exits 0 when every issue is a warning. `fix` exits 0 when nothing changed or every change was written. |
| 1 | `validate` found an error, `fix --dry-run` found pending changes, or the command failed (git failed, the destination folder already exists, the template is missing). |
| 2 | The arguments are invalid. The message is followed by `Run snoboard --help for usage.` |

Usage errors go to stderr. `validate` writes issues to stdout. `status` writes parse errors to stderr and the table or JSON to stdout.

## Global flags

| Flag | Meaning |
| --- | --- |
| `--repo <dir>` | Repository root. Defaults to the current directory. `.snoboard.yml` is read from this directory. |
| `--version` | Print the version and exit 0. |
| `--help` | Print help and exit 0. |

```text
$ snoboard --version
0.1.0
```

## validate

Check initiative files. Errors fail the process. Warnings are printed and do not.

| Flag | Meaning |
| --- | --- |
| `--ref <ref>` | Read files from this git ref (no checkout). Without `--ref`, validate reads the working tree. |
| `--changed-since <ref>` | Validate only files changed since `<ref>`. The file list is `git diff --name-only <ref>...HEAD`, limited to the configured root (`initiatives` by default). Id uniqueness is still checked across the repository: a changed file that reuses an id from an unchanged file is an error. A dependency cycle is reported when it includes a changed initiative. Issues in files the diff did not touch are omitted. |
| `--json` | Print the issue array as JSON. Each object has `path`, `field`, `message`, and `severity` (`error` or `warning`). |

Human output is one issue per block. Errors have no prefix. Warnings start with `warning:`.

```text
$ snoboard validate
initiatives/platform/002-broken/initiative.md: frontmatter: Missing closing "quote at line 3, column 16:

status: planned
               ^

```

That command exits 1. After the broken folder is removed, the same command exits 0.

```text
$ snoboard validate --json
[
  {
    "path": "initiatives/platform/002-broken/initiative.md",
    "field": "frontmatter",
    "message": "Missing closing \"quote at line 3, column 16:\n\nstatus: planned\n               ^\n",
    "severity": "error"
  }
]
```

A stale `updated` date is a warning and exits 0:

```text
warning: initiatives/acme/003-reports/initiative.md: updated: updated 2020-01-01 is older than 30 days
```

## next-number

```text
snoboard next-number <project> [--repo <dir>] [--fetch]
```

Print the next free three-digit number for `<project>`, then a newline.

`<project>` must start with a lowercase letter or digit and then use only lowercase letters, digits, `_`, or `-`.

The command considers folder prefixes (`004-x` contributes `004`) and initiative ids (`acme-004`) on:

- the working tree, for folders that contain the initiative file
- the default branch
- every branch that matches `branchPatterns`

Branches that do not match are ignored. The printed number is one higher than the highest of those, padded to three digits. An empty project prints `001`.

| Flag | Meaning |
| --- | --- |
| `--fetch` | Fetch from `origin` before reading branch tips. Fails if `origin` is missing or the fetch fails. |

```text
$ snoboard next-number acme
004
```

With a branch named like `initiative/acme-004-x` that contains `acme/004-x`, the same command prints `005`.

## status

```text
snoboard status [--ready | --stale] [--project <project>] [--repo <dir>] [--json]
```

List opted-in initiatives from the default branch and from branches that match `branchPatterns`. When `origin` has remote-tracking refs, those tips are used; otherwise local branches are used. If the default branch marks an initiative done, that version is used. Otherwise the ref whose newest commit touches the file is used. Equal commit times keep the default branch, then the earlier branch name.

Parse failures are written to stderr and do not change the exit code. Legacy files are omitted.

| Flag | Meaning |
| --- | --- |
| `--ready` | Only initiatives that are not done and whose dependencies are all done. |
| `--stale` | Only initiatives that would produce the stale-`updated` warning. |
| `--project <project>` | Only this project. Same name rules as `next-number`. |
| `--json` | Print JSON instead of a table. |

`--ready` and `--stale` together exit 2.

The table columns are `id`, `title`, `status`, `priority`, `updated`, and `ready` (`yes` or `no`):

```text
$ snoboard status
id        title                status       priority  updated     ready
acme-001  Customer onboarding  done         p1        2026-09-29  no
acme-002  Billing              in-progress  p1        2026-09-29  yes
acme-003  Reports              planned      p2        2026-09-29  no
```

On this repository, stderr also contains the broken file:

```text
initiatives/platform/002-broken/initiative.md (main): Missing closing "quote at line 3, column 16:

status: planned
               ^
```

`--json` prints an array of objects with `id`, `title`, `project`, `status`, `priority`, `updated`, `ready`, `stale`, `blockedBy`, and `path`. `--ready` on the same repository returns `acme-002`:

```json
[
  {
    "id": "acme-002",
    "title": "Billing",
    "project": "acme",
    "status": "in-progress",
    "priority": "p1",
    "updated": "2026-09-29",
    "ready": true,
    "stale": false,
    "blockedBy": [],
    "path": "initiatives/acme/002-billing/initiative.md"
  }
]
```

`acme-003` depends on `acme-002`, so it is not ready yet. After `acme-002` is `done`, `snoboard status --ready --json` returns `acme-003` only.

## new

```text
snoboard new <project> <slug> [--title <title>] [--priority <priority>] [--repo <dir>] [--fetch]
```

Take the next number (same rules as `next-number`, including `--fetch`) and write:

```text
<root>/<project>/<NNN>-<slug>/<file>
```

With the defaults that is `initiatives/<project>/<NNN>-<slug>/initiative.md`. The command prints that path. If the folder already exists, it writes nothing and exits 1.

`<slug>` uses lowercase letters, digits, and single hyphens (`search`, `search-box`).

| Flag | Meaning |
| --- | --- |
| `--title <title>` | Initiative title. The default splits the slug on hyphens and capitalizes each word (`search-box` becomes `Search Box`). The title cannot contain a line break. |
| `--priority <priority>` | Priority. Default `p2`. Must be one of the configured priorities. |
| `--fetch` | Fetch from `origin` before choosing the number. |

The file is the built-in template: frontmatter plus `Summary`, `Goals`, and `Phases` headings. `status` is the first configured status that is not a done status (`idea` with the defaults). `updated` is the UTC date when the command runs. `id` uses `idFormat`.

```text
$ snoboard new acme search --title "Search"
initiatives/acme/004-search/initiative.md
```

```markdown
---
id: acme-004
title: "Search"
status: idea
priority: p2
updated: 2026-09-29
---

# Search

## Summary

## Goals

## Phases
```

`snoboard validate` accepts that file.

## fix

```text
snoboard fix [--repo <dir>] [--dry-run] [--json] [paths...]
```

Normalise opted-in initiative files in the working tree. `fix` does not read git objects. A file with no `id` is legacy and is left byte-for-byte unchanged. Paths limit the run to those initiative files or to directories that contain them. With no paths, every initiative file under the configured root is considered.

Each change is printed. Unknown status, priority, phase status, and date values are reported and left unchanged. Other keys, key order, comments, and the markdown body stay as they were.

| Change | What is written |
| --- | --- |
| `status`, `priority`, phase `status` | Case and separators are folded onto a configured value. `In Progress` and `in_progress` both become `in-progress`. `P1` becomes `p1`. |
| `id` | Rewritten to `<project>-<NNN>` from the path when the current id differs only by case or padding (`Acme-4` becomes `acme-004`). Any other mismatch is left unchanged. |
| `updated` | A year-first date such as `2026-9-3` or `2026/9/3` becomes `YYYY-MM-DD`. |
| `depends_on` | A string becomes a list. Duplicates and self-references (the initiative's own id, including `#phase`) are dropped. |
| `phases` | Identical entries are dropped. An entry with no `id` receives the next integer after the highest id already present. Existing ids are not renumbered. |

```text
$ snoboard fix --dry-run
initiatives/acme/002-billing/initiative.md: status: "In Progress" -> "in-progress"
initiatives/acme/002-billing/initiative.md: id: "Acme-2" -> "acme-002"
initiatives/acme/002-billing/initiative.md: updated: "2026-9-3" -> "2026-09-03"
initiatives/acme/002-billing/initiative.md: priority: unknown value "urgent"
```

That command writes nothing and exits 1 because a change is pending. After `snoboard fix` applies the changes, the same command exits 0. A run that only reports unknown values also exits 0.

`--json` prints an array. A change has `path`, `field`, `from`, and `to`. A report has `path`, `field`, and `message`.

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Print pending changes and exit 1 when any file would change. Write nothing. |
| `--json` | Print changes and reports as JSON. |
| `paths` | Optional initiative files or directories. Defaults to every initiative file. |
