# Initiative schema

Snoboard reads one markdown file per initiative. With the default config that path is:

```text
initiatives/<project>/<NNN>-<slug>/initiative.md
```

`<NNN>` is three digits. The file is **opted in** when its frontmatter contains an `id` key. A file with no `id` (or no frontmatter) is **legacy**: it can be listed, and it is not validated. Frontmatter is YAML between opening and closing `---` lines. Unknown keys are kept and ignored.

## Frontmatter fields

`status` and `priority` must be one of the values configured in `.snoboard.yml`. The defaults are listed below.

| Field | Required | Allowed values |
| --- | --- | --- |
| `id` | yes | `^[a-z0-9_-]+-\d{3}$`, for example `acme-003` |
| `title` | yes | Non-empty string |
| `status` | yes | One of `statuses`. Default list: `idea`, `planned`, `in-progress`, `review`, `done`, `parked`, `dropped` |
| `priority` | yes | One of `priorities`. Default list: `p0`, `p1`, `p2`, `p3` |
| `depends_on` | no | List of dependency ids. Default `[]`. Each entry matches `^[a-z0-9_-]+-\d{3}(#([1-9]\d*))?$` |
| `branch` | no | Non-empty string |
| `updated` | yes | Calendar date `YYYY-MM-DD` |
| `labels` | no | List of non-empty strings |
| `issues` | no | List of at most 30 issue refs. Each entry is `gh#123`, `gh:owner/name#123`, `fj#123`, `fj:owner/name#123`, `vj:456` (alias `vikunja:456`), or `<provider>:<key>` |
| `links` | no | List of at most 20 external links: `{ title, url }`. See [Links](#links) |
| `phases` | no | List of phase objects |

A dependency is either an initiative id (`acme-002`) or an initiative id plus a phase (`acme-001#2`). The phase number has no leading zeros.

`issues` lists related tracker items. `gh#123` is an issue in the configured GitHub repository. `gh:owner/name#123` names that repository. `fj#123` is an issue or pull request in the configured Forgejo repository, and `fj:owner/name#123` names another repository on the same Forgejo site. `vj:456` is a Vikunja task id; `vikunja:456` is accepted as an alias, and the board editor stores new entries as `vj:456`. Any other `<provider>:<key>` is kept and reported as an unknown provider.

The board can edit this list (details panel, **Issues**). Each new ref is checked with the same parser as
validation; a ref that does not parse is refused before it reaches the basket.

### Links

`links` lists related pages outside the repository: a design doc, a dashboard, a mailing list.

| Field | Required | Allowed values |
| --- | --- | --- |
| `title` | yes | 1 to 120 characters, no line breaks |
| `url` | yes | An absolute `https:` or `mailto:` URL, at most 2048 characters, no spaces |

```yaml
links:
  - title: Design doc
    url: https://docs.example.com/reports
  - title: Team
    url: mailto:reports@example.com
```

The board shows them in a **Links** section of the details panel (new tab, `rel="noopener noreferrer"`) and
can edit them. A link with another scheme (`http:`, `javascript:`, `data:`, ...) is a validation error and is
never rendered.

### Attachments

Images attached from the board are committed next to the initiative file, in `assets/`:

```text
initiatives/<project>/<NNN>-<slug>/assets/<name>.<png|jpg|webp|gif>
```

`<name>` uses lowercase letters, digits and single hyphens. The body links them with a relative path, for
example `![diagram](assets/diagram.png)`. They are not a frontmatter field and are not validated.

### Phase fields

| Field | Required | Allowed values |
| --- | --- | --- |
| `id` | yes | Integer greater than zero |
| `title` | yes | Non-empty string |
| `status` | yes | Same list as the initiative `status` |
| `pr` | no | Integer greater than zero |
| `depends_on` | no | List of phase `id` values on **this** initiative |

## Rules

Validation reports each problem as `{ path, field, message, severity }`. Severity is `error` or `warning`.

- The path must match `<root>/<project>/<NNN>-<slug>/<file>` from config. The default pattern is `initiatives/<project>/<NNN>-<slug>/initiative.md`.
- `id` must equal `idFormat` with `{project}` and `{number}` taken from that path. The default format is `{project}-{number}`, so `initiatives/acme/003-reports/initiative.md` must use `acme-003`.
- `id` must be unique among opted-in files.
- Each `depends_on` target must exist. A phase target such as `acme-001#2` exists only when initiative `acme-001` has a phase whose `id` is `2`.
- Phase `id` values must be unique within the initiative.
- Each phase `depends_on` entry must be the `id` of another phase on the same initiative.
- The dependency graph must not contain a cycle.
- When the initiative `status` is a done status, no phase may have status `in-progress` or `review`.
- **Warning:** `updated` is more than `staleAfterDays` before today. Done statuses are exempt, and so are the statuses `parked` and `dropped`.
- **Error:** an `issues` entry is not a valid ref.
- **Error:** more than 30 `issues` entries.
- **Error:** more than 20 `links`, or a link with an empty or too long title, or a URL that is not `https:` or `mailto:`.
- **Warning:** an `issues` entry uses a provider other than `gh`, `fj`, `vj` or `vikunja`.
- **Warning:** an `issues` entry is repeated.

## Example

```markdown
---
id: acme-003
title: Reports
status: planned
priority: p2
depends_on:
  - acme-002
  - acme-001#2
branch: initiative/acme-003-reports
updated: 2026-09-29
labels:
  - billing
issues:
  - gh#123
  - gh:acme/widgets#45
  - vj:456
phases:
  - id: 1
    title: Data collection
    status: planned
  - id: 2
    title: Report view
    status: planned
    pr: 12
    depends_on:
      - 1
---

# Reports

## Summary

Show usage and invoices together.

## Goals

Give operators one place to read usage and invoices.

## Phases
```

`acme-001#2` in this example depends on phase `2` of initiative `acme-001`. That initiative has to exist and define the phase, or validation reports a missing dependency.

A legacy file has the same path shape and no `id`:

```markdown
# Initiative: Continuous integration

## Summary

Run checks on every change.
```
