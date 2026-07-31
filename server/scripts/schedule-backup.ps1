<#
.SYNOPSIS
  Registers (or removes) the nightly backup as a Windows scheduled task.

.DESCRIPTION
  The runbook has always CONTAINED a schtasks command to copy by hand. That is not the same as a
  schedule that exists — the gap between "documented" and "registered" is where backups live until
  the day they are needed. This registers it, and `-Status` proves it is really there.

  WHY NOT `/ru SYSTEM`, which the runbook's example used: SYSTEM cannot see mapped drives or UNC
  paths under the operator's credentials, so a backup written to a network target silently fails
  under SYSTEM while working perfectly when tested by hand. The task is registered for the invoking
  account with LogonType S4U instead — runs whether or not that user is signed in, and needs no
  stored password.

  RUNS AT 02:00 by default, with `-RandomDelay` unset on purpose: a backup is not a thundering herd
  and a predictable start time makes "did last night's run happen" answerable.

  Idempotent. Re-running replaces the existing task rather than creating a second one, so this is
  safe to run again after changing -Out or -Keep.

.EXAMPLE
  # register, backing up to a separate physical disk
  pwsh -File scripts/schedule-backup.ps1 -Out E:\backups\transactiondesk -Keep 30

.EXAMPLE
  pwsh -File scripts/schedule-backup.ps1 -Status
  pwsh -File scripts/schedule-backup.ps1 -Remove
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install')][string]$Out  = 'D:\backups\transactiondesk',
  [Parameter(ParameterSetName = 'Install')][int]   $Keep = 30,
  [Parameter(ParameterSetName = 'Install')][string]$At   = '02:00',
  [Parameter(ParameterSetName = 'Status')] [switch]$Status,
  [Parameter(ParameterSetName = 'Remove')] [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'TransactionDesk Nightly Backup'
$runner   = Join-Path $PSScriptRoot 'backup-nightly.ps1'

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

# ---- status -------------------------------------------------------------------------------------
if ($Status) {
  $t = Get-Task
  if (-not $t) {
    Write-Host "  NOT REGISTERED — nothing is taking backups on this machine." -ForegroundColor Red
    exit 2
  }
  $i = $t | Get-ScheduledTaskInfo
  Write-Host "  task        $TaskName"
  Write-Host "  state       $($t.State)"
  Write-Host "  last run    $($i.LastRunTime)   result $($i.LastTaskResult)"
  Write-Host "  next run    $($i.NextRunTime)"
  Write-Host "  action      $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
  # LastTaskResult 0 means the last run succeeded; anything else is a failed run, not a missing one.
  if ($i.LastTaskResult -ne 0 -and $null -ne $i.LastRunTime) {
    Write-Host "  LAST RUN FAILED (code $($i.LastTaskResult)) — check the logs under -Out." -ForegroundColor Red
  }
  exit 0
}

# ---- remove -------------------------------------------------------------------------------------
if ($Remove) {
  if (Get-Task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  removed $TaskName"
  } else { Write-Host "  $TaskName was not registered" }
  exit 0
}

# ---- install ------------------------------------------------------------------------------------
if (-not (Test-Path $runner)) { throw "runner not found: $runner" }

# Registering a task for another logon session needs elevation, and the failure without it is a bare
# "Access is denied" from Register-ScheduledTask that reads like a bug in this script.
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
  Write-Host "  This must run elevated — registering a scheduled task requires administrator rights." -ForegroundColor Red
  Write-Host "  Open PowerShell as administrator and run:"
  Write-Host "    cd '$(Split-Path -Parent $PSScriptRoot)'"
  Write-Host "    pwsh -File scripts/schedule-backup.ps1 -Out '$Out' -Keep $Keep -At $At"
  exit 3
}

# Prefer PowerShell 7 if present, else Windows PowerShell — the runner works under both.
$shell = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)?.Source ?? 'powershell.exe'

$action = New-ScheduledTaskAction -Execute $shell `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -Out `"$Out`" -Keep $Keep"
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# S4U: run whether or not the operator is signed in, without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew
# -StartWhenAvailable is what covers a machine that was off at 02:00 — it runs at next boot rather
# than skipping the night entirely.

if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Nightly database + storage backup, retention $Keep sets, weekly restore verification." | Out-Null

New-Item -ItemType Directory -Force -Path $Out | Out-Null

Write-Host "  registered  $TaskName" -ForegroundColor Green
Write-Host "  runs        daily at $At as $env:USERDOMAIN\$env:USERNAME"
Write-Host "  target      $Out  (keep $Keep sets, verify restore on Sundays)"
Write-Host ""
Write-Host "  Run it once now to prove it works, rather than finding out in a month:"
Write-Host "    Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "    pwsh -File scripts/backup-nightly.ps1 -Status -Out '$Out'"
Write-Host ""
Write-Host "  This machine is not an off-site copy. Sync $Out to another host or object storage." -ForegroundColor Yellow
