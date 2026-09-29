# Security

Do not report suspected vulnerabilities in a public issue. Email
[sergey@novik.fr](mailto:sergey@novik.fr) with a description, reproduction
steps, affected versions, and any known mitigation. Please allow reasonable
time for investigation before public disclosure.

Never commit tokens, `.env` files, credentials, local paths, or consumer
repository configuration. Run
`pwsh -NoProfile -File tests/Test-PublicSource.ps1` before preparing a release.
