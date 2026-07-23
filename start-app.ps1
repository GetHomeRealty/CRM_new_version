# start-app.ps1 — one-command launcher for the Transaction Desk dev stack.
#
# Starts (if not already running):
#   1. Laravel API   -> http://localhost:8000
#   2. React SPA      -> http://localhost:5173  (Vite dev server, in client/)
# and verifies MySQL (XAMPP) is up first.
#
# Usage:  pwsh -File start-app.ps1
#         (or right-click > Run with PowerShell)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$php    = 'c:\xampp\php\php.exe'
$node   = 'C:\Program Files\nodejs\node.exe'
$client = Join-Path $root 'client'

function Test-Port([int]$Port) {
    [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host '=== Transaction Desk — starting dev stack ===' -ForegroundColor Cyan

# 1) MySQL (XAMPP) must be running — we don't manage it here, just check.
if (Get-Process mysqld -ErrorAction SilentlyContinue) {
    Write-Host '[OK]   MySQL is running' -ForegroundColor Green
} else {
    Write-Host '[WARN] MySQL (mysqld) is NOT running.' -ForegroundColor Yellow
    Write-Host '       Open the XAMPP Control Panel and press Start on MySQL, then re-run this script.' -ForegroundColor Yellow
}

# 2) Laravel API on :8000
if (Test-Port 8000) {
    Write-Host '[OK]   API already running on http://localhost:8000' -ForegroundColor Green
} else {
    Start-Process -FilePath $php -ArgumentList 'artisan','serve','--port','8000' `
        -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    Write-Host '[..]   Started Laravel API on http://localhost:8000' -ForegroundColor Green
}

# 3) React SPA (Vite) on :5173
if (Test-Port 5173) {
    Write-Host '[OK]   React app already running on http://localhost:5173' -ForegroundColor Green
} else {
    Start-Process -FilePath $node -ArgumentList 'node_modules\vite\bin\vite.js' `
        -WorkingDirectory $client -WindowStyle Hidden | Out-Null
    Write-Host '[..]   Started React app on http://localhost:5173' -ForegroundColor Green
}

# Give the servers a moment, then health-check.
Start-Sleep -Seconds 5
Write-Host ''
Write-Host '--- health check ---'
try {
    $a = Invoke-WebRequest 'http://127.0.0.1:8000/api/registration-open' -SkipHttpErrorCheck -TimeoutSec 10
    Write-Host ("API   : HTTP {0}" -f $a.StatusCode) -ForegroundColor Green
} catch {
    Write-Host 'API   : not responding yet (give it a few more seconds)' -ForegroundColor Yellow
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
Write-Host '  Login:  admin@gethomerealty.ca  /  Admin@123' -ForegroundColor White
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Servers run in the background (hidden). To stop them, run:  pwsh -File stop-app.ps1' -ForegroundColor DarkGray
