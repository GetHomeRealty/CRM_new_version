# start-app.ps1 — one-command launcher for the Transaction Desk dev stack.
#
# Starts (if not already running):
#   1. NestJS API  -> http://localhost:8000   (server/, watch mode)
#   2. React SPA   -> http://localhost:5173   (client/, Vite dev server)
# and checks PostgreSQL is up first.
#
# Usage:  pwsh -File start-app.ps1
#         (or right-click > Run with PowerShell)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$server = Join-Path $root 'server'
$client = Join-Path $root 'client'

function Test-Port([int]$Port) {
    [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host '=== Transaction Desk — starting dev stack ===' -ForegroundColor Cyan

# 1) PostgreSQL must be running — we don't manage it here, just check.
if (Test-Port 5432) {
    Write-Host '[OK]   PostgreSQL is listening on 5432' -ForegroundColor Green
} else {
    Write-Host '[WARN] PostgreSQL is NOT listening on 5432.' -ForegroundColor Yellow
    Write-Host '       Start the PostgreSQL service, then re-run this script.' -ForegroundColor Yellow
}

# 2) NestJS API on :8000
if (Test-Port 8000) {
    Write-Host '[OK]   API already running on http://localhost:8000' -ForegroundColor Green
} else {
    Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','start:dev' `
        -WorkingDirectory $server -WindowStyle Hidden | Out-Null
    Write-Host '[..]   Started NestJS API on http://localhost:8000' -ForegroundColor Green
}

# 3) React SPA (Vite) on :5173
if (Test-Port 5173) {
    Write-Host '[OK]   React app already running on http://localhost:5173' -ForegroundColor Green
} else {
    Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' `
        -WorkingDirectory $client -WindowStyle Hidden | Out-Null
    Write-Host '[..]   Started React app on http://localhost:5173' -ForegroundColor Green
}

# The API compiles TypeScript before it listens, so give it longer than the SPA.
Start-Sleep -Seconds 12
Write-Host ''
Write-Host '--- health check ---'
try {
    $a = Invoke-WebRequest 'http://127.0.0.1:8000/api/health' -SkipHttpErrorCheck -TimeoutSec 10
    Write-Host ("API   : HTTP {0}  {1}" -f $a.StatusCode, $a.Content) -ForegroundColor Green
} catch {
    Write-Host 'API   : not responding yet (it compiles first — give it a few more seconds)' -ForegroundColor Yellow
}
try {
    $v = Invoke-WebRequest 'http://localhost:5173' -SkipHttpErrorCheck -TimeoutSec 10
    Write-Host ("React : HTTP {0}" -f $v.StatusCode) -ForegroundColor Green
} catch {
    Write-Host 'React : not responding yet (give it a few more seconds)' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host '  Open:   http://localhost:5173' -ForegroundColor White
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Servers run in the background (hidden). To stop them, run:  pwsh -File stop-app.ps1' -ForegroundColor DarkGray
Write-Host 'API not starting? Run it in the foreground to see why:  cd server; npm run start:dev' -ForegroundColor DarkGray
