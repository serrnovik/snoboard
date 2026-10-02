# Authentication

Snoboard is read-only. Sign-in decides who can open the board. It does not grant write access to the git repository.

Set `SNOBOARD_AUTH_MODES` to a comma-separated list of `password`, `github`, `none`, and `cloudflare-access`. `password` and `github` can be combined. `none` and `cloudflare-access` cannot be combined with other modes. Startup fails when a selected mode is missing the setting it requires.

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

### Write access for edits

Signing in only reads your profile. Write access is a separate grant, asked for the first time you submit
edits (`GET /auth/github/write`), so people who only look at the board never hand Snoboard a write token.

- **Same OAuth app, same callback.** The write flow returns to `/auth/github/callback`; the purpose (`login` or
  `write`) travels in the signed, short-lived state cookie. You add nothing to the OAuth app.
- **Scope.** `repo` by default. A classic OAuth `repo` grant covers every repository the person can write to, not
  only this one. If the board's repository is public, set `SNOBOARD_GITHUB_WRITE_SCOPE=public_repo` to ask for less.
  Per-repository GitHub App user tokens are a later option.
- **Checks.** The write callback needs the same board session that started it, and the GitHub login must equal the
  session's login. It never signs anyone in. After the grant, the browser returns to a same-origin path only.
- **Storage.** The token is kept in server memory only, AES-256-GCM encrypted with a key derived from the session
  secret, for at most one hour and never longer than the session; one token per session. The browser holds only a
  random handle in the httpOnly cookie `snoboard_gh_write` (path `/api`). The token is never put in a cookie, a
  log line, or a response. `DELETE /auth/github/write` and logout drop it.
- **Replicas.** Tokens live in one process. A restart loses them (people reconnect), and several replicas need
  sticky sessions. Run one replica when editing is on.

Password and Cloudflare Access deployments never offer this flow.

## `none` behind a trusted proxy

`none` skips Snoboard's sign-in. Use it only when a proxy in front of the board already authenticates every request, or for local development.

```sh
SNOBOARD_AUTH_MODES=none
SNOBOARD_AUTH_ALLOW_NONE=true
```

Do not publish `none` on an open network. Anyone who can reach the port can read the board. The server will not start in `none` mode when `SNOBOARD_AUTH_ALLOW_NONE` is anything other than `true`.

## Cloudflare Access

`cloudflare-access` trusts a signed Cloudflare Access JWT. The board does not ask for a password, does not keep a session secret, and does not run a GitHub OAuth app. The browser shows who is signed in. Sign out goes to `/cdn-cgi/access/logout`.

The board must only be reachable through Cloudflare Access. Do not publish the application port on an open network. Snoboard accepts the `Cf-Access-Jwt-Assertion` header only. A `CF_Authorization` cookie or a `Cf-Access-Authenticated-User-Email` header is not sign-in.

Certificates are read from `https://<team-domain>/cdn-cgi/access/certs`. The team domain is a hostname ending in `.cloudflareaccess.com`.

```sh
SNOBOARD_AUTH_MODES=cloudflare-access
SNOBOARD_CF_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com
SNOBOARD_CF_ACCESS_AUD=replace-with-access-application-aud
SNOBOARD_ALLOWED_EMAILS=ada@example.com,grace@example.com
SNOBOARD_ALLOWED_EMAIL_DOMAINS=example.com
SNOBOARD_CF_ACCESS_ALLOWED_GROUPS=board-readers
```

`SNOBOARD_CF_ACCESS_AUD` is the Access application audience tag. More than one tag is allowed, separated by commas.

`SNOBOARD_ALLOWED_EMAILS` or `SNOBOARD_ALLOWED_EMAIL_DOMAINS` is required; groups are only an extra allowlist, because Access tokens include `groups` only when the IdP is set up to send them. A person is allowed when their email matches `SNOBOARD_ALLOWED_EMAILS`, the host after `@` matches `SNOBOARD_ALLOWED_EMAIL_DOMAINS`, or any `groups` value in the JWT matches `SNOBOARD_CF_ACCESS_ALLOWED_GROUPS`. Email and domain checks are case-insensitive. The domain is matched exactly, so `ada@example.com` matches `example.com` and `ada@mail.example.com` does not.
