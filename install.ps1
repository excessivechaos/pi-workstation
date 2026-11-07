# pi-workstation bootstrap (Windows PowerShell 5.1 / PowerShell 7+)
#
# Installs pi (and Node, if the official installer needs to), then runs bootstrap.mjs.
# Pass arguments through, e.g.:
#   .\install.ps1 -BootstrapArgs '--dry-run'
#   .\install.ps1
param([string]$BootstrapArgs = "")

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    Write-Host "installing pi..."
    irm https://pi.dev/install.ps1 | iex
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node is not on PATH; pi's installer normally provides it. Install Node 22.19+ and rerun."
}

$args = @("--skip-pi-install")
if ($BootstrapArgs) { $args += $BootstrapArgs.Split(" ") }
& node (Join-Path $here "bootstrap.mjs") @args
exit $LASTEXITCODE
