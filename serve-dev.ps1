# Dev API server with auto-reload on migration changes.
#
# Runs `php artisan serve` and watches database/migrations. When a migration file
# is added or changed it runs `php artisan migrate --force` and restarts the server,
# so a freshly-migrated table is always visible to the running app (no more
# "Base table or view not found" after adding a migration).
#
# Usage:  pwsh -File serve-dev.ps1   (Ctrl+C to stop)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$php    = 'c:\xampp\php\php.exe'
$port   = 8000
$migDir = Join-Path $root 'database\migrations'

function Stop-Port {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

function Start-Serve {
    Stop-Port
    Start-Process -FilePath $php -ArgumentList 'artisan', 'serve', '--port', $port `
        -WorkingDirectory $root -PassThru -WindowStyle Hidden
}

# Signature of the migrations dir — changes when a file is added/edited/removed.
function Get-MigSignature {
    (Get-ChildItem $migDir -Filter *.php -ErrorAction SilentlyContinue |
        Sort-Object Name |
        ForEach-Object { "$($_.Name):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }) -join '|'
}

$proc = Start-Serve
$last = Get-MigSignature
Write-Host "API server running on http://127.0.0.1:$port (PID $($proc.Id)) - watching migrations for changes"

while ($true) {
    Start-Sleep -Seconds 2

    # Relaunch if the server died on its own.
    if (-not $proc -or $proc.HasExited) {
        Write-Host "Server not running - relaunching..."
        $proc = Start-Serve
    }

    $cur = Get-MigSignature
    if ($cur -ne $last) {
        $last = $cur
        Write-Host "`nMigration change detected - migrating and restarting server..."
        & $php artisan migrate --force
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        $proc = Start-Serve
        Write-Host "Server restarted (PID $($proc.Id))`n"
    }
}
