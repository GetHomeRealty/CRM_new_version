<#
.SYNOPSIS
  What the scheduled task actually runs. Takes a backup, records whether it worked, and leaves a
  trail somebody can check months later.

.DESCRIPTION
  `backup.mjs` takes the backup. This wraps it with the three things a scheduled job needs and a
  bare command line does not:

    A LOG PER RUN, kept next to the backups. When somebody asks "when did backups stop working",
    the answer has to exist somewhere other than a console nobody was watching.

    A HEARTBEAT FILE (last-success.json) rewritten only on success. This is the part that matters.
    A scheduled backup does not usually fail loudly — it stops running, and the failure is that
    nothing happened at all. Nothing can detect an event that did not occur, so the check has to be
    for STALENESS: if last-success.json is older than about 25 hours, the nightly backup is broken,
    whether it errored, never fired, or the machine was off. `-Status` reads it.

    A NON-ZERO EXIT on failure, so Task Scheduler records the run as failed instead of green.

  Weekly, it also runs `backup:verify`, which restores the newest set into a scratch database and
  drops it. A backup nobody has restored is a hope, not a backup — and a corrupt one is
  indistinguishable from a good one until the day it is needed.
#>
[CmdletBinding()]
param(
  [string]$Out    = 'D:\backups\transactiondesk',
  [int]   $Keep   = 30,
  # Verify on this weekday. Restoring costs more than dumping, so it does not run nightly.
  [string]$VerifyOn = 'Sunday',
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$server    = Split-Path -Parent $PSScriptRoot
$heartbeat = Join-Path $Out 'last-success.json'
$logDir    = Join-Path $Out 'logs'

# ---- status -------------------------------------------------------------------------------------
# Deliberately usable by a human at a prompt AND by a monitor: exit 0 fresh, 1 stale, 2 never ran.
if ($Status) {
  if (-not (Test-Path $heartbeat)) {
    Write-Host "  NO BACKUP HAS EVER SUCCEEDED at $Out" -ForegroundColor Red
    exit 2
  }
  $hb    = Get-Content $heartbeat -Raw | ConvertFrom-Json
  $age   = (Get-Date) - [datetime]$hb.finished_at
  $stale = $age.TotalHours -gt 25          # a daily job, plus an hour of slack for a slow night
  $color = if ($stale) { 'Red' } else { 'Green' }
  Write-Host ("  last success  {0}  ({1:N1} h ago)" -f $hb.finished_at, $age.TotalHours) -ForegroundColor $color
  Write-Host  "  set           $($hb.set)"
  Write-Host  "  took          $($hb.took_ms) ms"
  if ($stale) { Write-Host "  STALE — the nightly backup is not running." -ForegroundColor Red }
  exit ([int]$stale)
}

# ---- run ----------------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $Out, $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log   = Join-Path $logDir "backup-$stamp.log"
$began = Get-Date

"=== backup $stamp ===" | Tee-Object -FilePath $log

try {
  Push-Location $server
  # 2>&1 so a stderr line lands in the log instead of vanishing.
  & node scripts/backup.mjs --out $Out --keep $Keep 2>&1 | Tee-Object -FilePath $log -Append
  if ($LASTEXITCODE -ne 0) { throw "backup.mjs exited $LASTEXITCODE" }

  if ((Get-Date).DayOfWeek -eq $VerifyOn) {
    "--- weekly verify ---" | Tee-Object -FilePath $log -Append
    & npm run backup:verify 2>&1 | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -ne 0) { throw "backup:verify exited $LASTEXITCODE — the newest set did not restore" }
  }

  # Newest set on disk, by name: backup.mjs stamps YYYYMMDD-HHMMSS, which sorts lexicographically.
  $set = (Get-ChildItem $Out -Directory | Where-Object Name -match '^\d{8}-\d{6}$' |
          Sort-Object Name | Select-Object -Last 1).Name

  @{
    finished_at = (Get-Date).ToString('o')
    set         = $set
    took_ms     = [int]((Get-Date) - $began).TotalMilliseconds
    verified    = ((Get-Date).DayOfWeek -eq $VerifyOn)
  } | ConvertTo-Json | Set-Content $heartbeat -Encoding utf8

  # Old logs are not evidence, they are clutter. Keep roughly the same window as the backups.
  Get-ChildItem $logDir -Filter 'backup-*.log' | Sort-Object Name |
    Select-Object -SkipLast ([Math]::Max($Keep, 14)) | Remove-Item -Force -ErrorAction SilentlyContinue

  "OK  set=$set" | Tee-Object -FilePath $log -Append
}
catch {
  # The heartbeat is deliberately NOT written here — staleness is the alarm.
  "FAILED: $_" | Tee-Object -FilePath $log -Append
  Write-Error $_
  exit 1
}
finally { Pop-Location }
