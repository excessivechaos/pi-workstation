# pi-workstation bootstrap (Windows PowerShell 5.1 / PowerShell 7+)
#
# Runs next to a checkout, or standalone from a pipe:
#   irm https://raw.githubusercontent.com/excessivechaos/pi-workstation/main/install.ps1 | iex
#
# Pass arguments through, e.g.:
#   .\install.ps1 -BootstrapArgs '--dry-run'
#   irm .../install.ps1 | iex   (then set $args before invoking, or run the script file)
param([string]$BootstrapArgs = "")

$ErrorActionPreference = "Stop"
$Repo   = "https://github.com/excessivechaos/pi-workstation"
$Branch = "main"

$paths = @()

# Where is bootstrap.mjs? Next to this script when cloned; otherwise fetch the repo into %TEMP%
# (nothing is left behind, and nothing lands in the current directory).
$scriptPath = $MyInvocation.MyCommand.Path
$here = if ($scriptPath) { Split-Path -Parent $scriptPath } else { "" }
$bootstrap = if ($here) { Join-Path $here "bootstrap.mjs" } else { "" }

if (-not $bootstrap -or -not (Test-Path $bootstrap)) {
    Write-Host "fetching $Repo ($Branch)..."
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("pi-workstation-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $paths += $tmp
    $zip = Join-Path $tmp "repo.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $root = Get-ChildItem -Path $tmp -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "bootstrap.mjs") } |
        Select-Object -First 1
    if (-not $root) { throw "downloaded archive has no bootstrap.mjs" }
    $bootstrap = Join-Path $root.FullName "bootstrap.mjs"
}

try {
    if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
        Write-Host "installing pi..."
        irm https://pi.dev/install.ps1 | iex
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "node is not on PATH; pi's installer normally provides it. Install Node 22.19+ and rerun."
    }

    $argv = @("--skip-pi-install")
    if ($BootstrapArgs) { $argv += $BootstrapArgs.Split(" ") }
    & node $bootstrap @argv
    if ($LASTEXITCODE -ne 0) { throw "bootstrap failed with exit code $LASTEXITCODE" }
}
finally {
    foreach ($p in $paths) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
