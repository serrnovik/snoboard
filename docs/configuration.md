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
