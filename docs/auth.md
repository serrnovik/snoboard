# Authentication

Snoboard is read-only. Sign-in decides who can open the board. It does not grant write access to the git repository.

Set `SNOBOARD_AUTH_MODES` to a comma-separated list of `password`, `github`, and `none`. Modes can be combined. Startup fails when a selected mode is missing the secret it requires.

`none` is refused unless `SNOBOARD_AUTH_ALLOW_NONE` is `true`.

## Password

Password mode checks one shared password against an argon2id hash. The server reads the hash from a file. It does not take the password or the hash as an environment value.

From a checkout of this repository, generate the hash:

```sh
printf '%s' 'choose-a-strong-password' | node apps/board/scripts/hash-password.mjs > password.hash
```

The script reads the password from the terminal (so it is not stored in shell history) and prints one argon2id hash. Keep that single line as the file contents. Point the server at it:

```sh
SNOBOARD_PASSWORD_HASH_FILE=/run/secrets/password.hash
```

Create a session secret of at least 32 bytes and store it in its own file:

```sh
openssl rand -base64 32 > session.secret
```

```sh
SNOBOARD_SESSION_SECRET_FILE=/run/secrets/session.secret
```

The session cookie is `snoboard_session`. It is HttpOnly, SameSite=Lax, and Secure unless `SNOBOARD_PUBLIC_URL` is `http://localhost` (any port). It expires after 30 days. Replacing the session secret signs everyone out.

A wrong password is rejected. Repeated failures from the same address are rate-limited.

Set:

```sh
SNOBOARD_AUTH_MODES=password
SNOBOARD_PUBLIC_URL=http://localhost:8080
```

`SNOBOARD_PUBLIC_URL` is the origin users type in the browser, with the scheme and no path.

## GitHub

Create a GitHub OAuth app (Settings → Developer settings → OAuth Apps):

| Field | Value |
| --- | --- |
| Homepage URL | The value of `SNOBOARD_PUBLIC_URL` |
| Authorization callback URL | `<SNOBOARD_PUBLIC_URL>/auth/github/callback` |

Example callback: `https://board.example.com/auth/github/callback`.

Put the client id in the environment and the client secret in a file:

```sh
SNOBOARD_GITHUB_CLIENT_ID=Ov23liExampleClientId
SNOBOARD_GITHUB_CLIENT_SECRET_FILE=/run/secrets/github-client.secret
```

Allow sign-in with a login list, an organization list, or both. A person must match at least one list. If both lists are empty, nobody can sign in with GitHub.

```sh
SNOBOARD_ALLOWED_GITHUB_LOGINS=ada,grace
SNOBOARD_ALLOWED_GITHUB_ORGS=acme
```

Organization checks call the GitHub API and need the `read:org` scope. Snoboard requests `read:user`, and adds `read:org` when `SNOBOARD_ALLOWED_GITHUB_ORGS` is set. The GitHub access token from login is not stored.

`SNOBOARD_GITHUB_TOKEN_FILE` is separate from the OAuth client secret. It is an optional fine-grained token used only to read pull request state and checks. Give it read access to the repository and nothing else.

```sh
SNOBOARD_AUTH_MODES=password,github
```

## `none` behind a trusted proxy

`none` skips Snoboard's sign-in. Use it only when a proxy in front of the board already authenticates every request, or for local development.

```sh
SNOBOARD_AUTH_MODES=none
SNOBOARD_AUTH_ALLOW_NONE=true
```

Do not publish `none` on an open network. Anyone who can reach the port can read the board. The server will not start in `none` mode when `SNOBOARD_AUTH_ALLOW_NONE` is anything other than `true`.
