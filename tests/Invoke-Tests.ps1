[CmdletBinding()]
param(
    [switch] $E2E
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $root
try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    pnpm typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    pnpm test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if ($E2E) {
        if ($IsLinux) {
            pnpm --filter @snoboard/board exec playwright install --with-deps chromium
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        pnpm e2e
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}
finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot 'Test-PublicSource.ps1')
