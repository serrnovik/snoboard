<p align="center"><img src="docs/img/logo.png" alt="Snoboard logo" width="160"></p>

# Snoboard

Snoboard reads initiative documents from a git repository and shows them on a shared, read-only board. The project ships as a library, the `snoboard` command, and a board web app.

**Status: pre-release.**

## Install

Install the command:

```sh
npm i -g snoboard
```

Or run it without a global install:

```sh
pnpm dlx snoboard --help
```

## Quick start

In a git repository, optionally add a [`.snoboard.yml`](docs/configuration.md). Then:

```sh
snoboard new acme search --title "Search"
snoboard validate
snoboard status
```

`new` writes the next numbered initiative (`initiatives/acme/001-search/initiative.md` when `acme` has none). `validate` checks opted-in files and exits 1 when one of them has an error. `status` prints a table of initiatives; `--json` prints JSON. Command details are in [docs/cli.md](docs/cli.md). The frontmatter fields are in [docs/schema.md](docs/schema.md).

## Issue trackers

An initiative can list related issues: `gh#123`, `gh:owner/name#123`, and `vj:456` (alias `vikunja:456`). The card shows how many there are. Open the initiative to see each title, whether it is open or closed, and a link. An unknown issue is a plain link. Snoboard only reads the trackers.

A single-repository board uses `forge.repo` from `.snoboard.yml` and `SNOBOARD_GITHUB_TOKEN_FILE` for GitHub. Several repositories each enable trackers in the server repos file. Setup is in [docs/configuration.md](docs/configuration.md#issues).

## Configure

## Deploy

Run the board with Docker or Helm. The image is `ghcr.io/serrnovik/snoboard`. Password setup, GitHub OAuth, and `none` mode are in [docs/auth.md](docs/auth.md). Commands and the environment variables are in [docs/deploy.md](docs/deploy.md).

![The demo board](docs/img/board.png)

![The demo dependency graph](docs/img/graph.png)
