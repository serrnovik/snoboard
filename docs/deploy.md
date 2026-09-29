# Deploy

The board image is `ghcr.io/serrnovik/snoboard`. Tags are the release version (`0.1.0`) and `latest`. The process is `node apps/board/dist/server/index.mjs`. It listens on `PORT` (8080 in the image) on all interfaces.

The image includes `git` and `openssh-client`, runs as uid/gid 10001, and does not contain repository credentials. Pass those at runtime.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `SNOBOARD_REPO_URL` | yes, for a ready board | Git URL to clone. `https://`, `ssh://`, `git@`, or `file://` |
| `SNOBOARD_DATA_DIR` | no | Clone directory. Image default `/tmp/snoboard`. The chart sets `/var/lib/snoboard` |
| `SNOBOARD_REFRESH_SECONDS` | no | Seconds between fetches. Default 120 |
| `SNOBOARD_SSH_KEY_FILE` | for SSH remotes | Path to a read-only deploy key |
| `SNOBOARD_GIT_TOKEN_FILE` | for HTTPS remotes | Path to a file whose contents are a git token |
| `SNOBOARD_CONFIG_PATH` | no | Config file to use instead of `.snoboard.yml` in the clone |
| `SNOBOARD_AUTH_MODES` | no | Comma-separated `password`, `github`, `none`. See [auth.md](auth.md) |
| `SNOBOARD_AUTH_ALLOW_NONE` | for `none` | Must be `true` or `none` is refused |
| `SNOBOARD_PUBLIC_URL` | for sign-in | Public origin, scheme included, no path |
| `SNOBOARD_SESSION_SECRET_FILE` | for `password` and `github` | Path to a secret of at least 32 bytes |
| `SNOBOARD_PASSWORD_HASH_FILE` | for `password` | Path to the argon2id hash file |
| `SNOBOARD_GITHUB_CLIENT_ID` | for `github` | OAuth app client id |
| `SNOBOARD_GITHUB_CLIENT_SECRET_FILE` | for `github` | Path to the OAuth client secret |
| `SNOBOARD_ALLOWED_GITHUB_LOGINS` | no | Comma-separated GitHub logins |
| `SNOBOARD_ALLOWED_GITHUB_ORGS` | no | Comma-separated GitHub organizations |
| `SNOBOARD_GITHUB_TOKEN_FILE` | no | Path to a read-only token for pull request and check status |
| `PORT` | no | HTTP port. Default 8080 |

Every `*_FILE` variable is a path. The file contents are the secret. Do not put secrets in the other variables or in the image.

Use either `SNOBOARD_SSH_KEY_FILE` or `SNOBOARD_GIT_TOKEN_FILE` for the clone. Prefer a read-only deploy key or a read-only token.

## Docker

Password mode against a remote repository:

```sh
printf '%s' 'choose-a-strong-password' | node apps/board/scripts/hash-password.mjs > password.hash
openssl rand -base64 32 > session.secret

docker run --rm -p 8080:8080 \
  -e SNOBOARD_REPO_URL=https://github.com/acme/initiatives.git \
  -e SNOBOARD_AUTH_MODES=password \
  -e SNOBOARD_PUBLIC_URL=http://localhost:8080 \
  -e SNOBOARD_PASSWORD_HASH_FILE=/run/secrets/password.hash \
  -e SNOBOARD_SESSION_SECRET_FILE=/run/secrets/session.secret \
  -v "$PWD/password.hash:/run/secrets/password.hash:ro" \
  -v "$PWD/session.secret:/run/secrets/session.secret:ro" \
  ghcr.io/serrnovik/snoboard:0.1.0
```

Open `http://localhost:8080`. `/healthz` returns `ok` as soon as the process is up. `/readyz` returns `ok` after the first clone succeeds.

To point at a local bare repository (for example one built from `examples/demo-repo`):

```sh
docker run --rm -p 8080:8080 \
  -e SNOBOARD_REPO_URL=file:///repos/demo.git \
  -e SNOBOARD_AUTH_MODES=password \
  -e SNOBOARD_PUBLIC_URL=http://localhost:8080 \
  -e SNOBOARD_PASSWORD_HASH_FILE=/run/secrets/password.hash \
  -e SNOBOARD_SESSION_SECRET_FILE=/run/secrets/session.secret \
  -v "$PWD/password.hash:/run/secrets/password.hash:ro" \
  -v "$PWD/session.secret:/run/secrets/session.secret:ro" \
  -v "$PWD/demo.git:/repos/demo.git:ro" \
  ghcr.io/serrnovik/snoboard:0.1.0
```

The files must be readable by uid 10001. The image sets `safe.directory=*` so a repository owned by another user can still be cloned.

## Helm

The chart is `deploy/helm/snoboard`. It runs the same uid, with a read-only root filesystem. An `emptyDir` is mounted at `dataDir` (`/var/lib/snoboard`) and at `/tmp`. `HOME` is `/tmp` so git and SSH can write under the read-only root. Liveness probes `/healthz`. Readiness probes `/readyz`. Requests are 100m CPU and 128Mi memory. The memory limit is 256Mi.

Create a Secret whose keys match `secretFiles` in `values.yaml`. Unused keys can be empty files. They still have to exist, because each key is mounted.

```sh
openssl rand -base64 32 > session.secret
printf '%s' 'choose-a-strong-password' | node apps/board/scripts/hash-password.mjs > password.hash
touch ssh-key git-token github-client.secret github-token

kubectl create secret generic snoboard-secrets \
  --from-file=ssh-key=./ssh-key \
  --from-file=git-token=./git-token \
  --from-file=session-secret=./session.secret \
  --from-file=password-hash=./password.hash \
  --from-file=github-client-secret=./github-client.secret \
  --from-file=github-token=./github-token
```

| Secret key | Environment variable |
| --- | --- |
| `ssh-key` | `SNOBOARD_SSH_KEY_FILE` |
| `git-token` | `SNOBOARD_GIT_TOKEN_FILE` |
| `session-secret` | `SNOBOARD_SESSION_SECRET_FILE` |
| `password-hash` | `SNOBOARD_PASSWORD_HASH_FILE` |
| `github-client-secret` | `SNOBOARD_GITHUB_CLIENT_SECRET_FILE` |
| `github-token` | `SNOBOARD_GITHUB_TOKEN_FILE` |

Install with the example overlay, which sets `existingSecret` and a repository URL:

```sh
helm install snoboard deploy/helm/snoboard \
  -f deploy/helm/snoboard/values-existing-secret.example.yaml
```

Ingress is off by default. Set `ingress.enabled`, `ingress.className`, `ingress.hosts`, and `ingress.annotations` to publish the Service. `ingress.hosts[].host` is the hostname. Each entry's `paths` list has `path` and `pathType`.

Check the templates before installing:

```sh
helm lint deploy/helm/snoboard
helm template snoboard deploy/helm/snoboard
helm template snoboard deploy/helm/snoboard \
  -f deploy/helm/snoboard/values-existing-secret.example.yaml
```
