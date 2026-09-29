# Snoboard contributor instructions

- Snoboard supports Node.js 24 on macOS, Linux, and Windows.
- Keep paths relative to the repository root.
- TypeScript is strict ESM (`NodeNext`). Pin exact dependency versions.
- Do not add product names, internal hosts, credentials, user-specific paths, or personal shorthand comments.
- Run `pwsh -NoProfile -File tests/Invoke-Tests.ps1` before committing.
- Do not publish a release unless the Apache-2.0 metadata, full tests, and public-source audit pass.
