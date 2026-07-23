# stop-app.ps1 — stops the dev servers started by start-app.ps1.
# Leaves MySQL (XAMPP) alone — manage that from the XAMPP Control Panel.
#
# Usage:  pwsh -File stop-app.ps1

$ErrorActionPreference = 'SilentlyContinue'

function Stop-Port([int]$Port, [string]$Label) {
    $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    if ($pids) {
        $pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
        Write-Host ("[stopped] {0} (port {1})" -f $Label, $Port) -ForegroundColor Yellow
    } else {
        Write-Host ("[--]      {0} was not running (port {1})" -f $Label, $Port) -ForegroundColor DarkGray
    }
}

Write-Host ''
Stop-Port 8000 'Laravel API'
Stop-Port 5173 'React app (Vite)'
Write-Host ''
Write-Host 'Done. (MySQL left running — stop it from XAMPP if needed.)' -ForegroundColor DarkGray
