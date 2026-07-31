<#
.SYNOPSIS
  Registers the health monitor to run every few minutes.

.DESCRIPTION
  The counterpart to schedule-backup.ps1, and the thing that finally closes the gap between "the
  checks exist" and "somebody finds out". `monitor.mjs` calls the health endpoints, the metrics
  endpoint and the backup heartbeat, and alerts only when a check CHANGES state.

  ALERT ROUTING COMES FROM THE ENVIRONMENT, not from the application database — a monitor that reads
  its SMTP credentials from the database cannot tell you the database is down. Set at least one of
  these for the account the task runs as (System, not User, since the task runs unattended):

    ALERT_WEBHOOK_URL     Slack/Teams incoming webhook. The simplest thing that works.
    ALERT_SMTP_HOST       plus ALERT_SMTP_PORT / ALERT_SMTP_USER / ALERT_SMTP_PASS
    ALERT_EMAIL_TO        where alerts go        ALERT_EMAIL_FROM
    ALERT_HEARTBEAT_URL   external dead-man's-switch, pinged after each fully healthy run

  SET ALERT_HEARTBEAT_URL. Everything else here runs on this machine, so nothing here can tell you
  this machine is off — which is exactly when you most need to know. An external service that
  alerts when the pings stop is the only check that survives that, and it is a free tier away.

  RUNS AS SYSTEM, unlike the backup task. This one only reads HTTP endpoints and a local JSON file,
  so it needs no user profile or network credentials, and running as SYSTEM means it keeps working
  when the operator's password changes.

.EXAMPLE
  pwsh -File scripts/schedule-monitor.ps1 -Backup E:\backups\transactiondesk -Every 5
  pwsh -File scripts/schedule-monitor.ps1 -Status
  pwsh -File scripts/schedule-monitor.ps1 -Remove
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install')][string]$Url    = 'http://localhost:8000',
  [Parameter(ParameterSetName = 'Install')][string]$Backup = 'D:\backups\transactiondesk',
  [Parameter(ParameterSetName = 'Install')][int]   $Every  = 5,     # minutes between checks
  [Parameter(ParameterSetName = 'Install')][int]   $Remind = 60,    # minutes between repeat alerts
  [Parameter(ParameterSetName = 'Status')] [switch]$Status,
  [Parameter(ParameterSetName = 'Remove')] [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'TransactionDesk Health Monitor'
$script   = Join-Path $PSScriptRoot 'monitor.mjs'
$server   = Split-Path -Parent $PSScriptRoot

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

if ($Status) {
  $t = Get-Task
  if (-not $t) {
    Write-Host "  NOT REGISTERED — nothing is checking whether this application is healthy." -ForegroundColor Red
    exit 2
  }
  $i = $t | Get-ScheduledTaskInfo
  Write-Host "  task        $TaskName"
  Write-Host "  state       $($t.State)"
  Write-Host "  last run    $($i.LastRunTime)   result $($i.LastTaskResult)"
  Write-Host "  next run    $($i.NextRunTime)"
  # 1 means the monitor ran and found something wrong — that is the monitor WORKING, not failing.
  # Anything else non-zero means the monitor itself could not run, which is the worse case.
  switch ($i.LastTaskResult) {
    0       { Write-Host "  last check  all healthy" -ForegroundColor Green }
    1       { Write-Host "  last check  FOUND PROBLEMS (this is the monitor working)" -ForegroundColor Yellow }
    default { Write-Host "  THE MONITOR ITSELF FAILED (code $($i.LastTaskResult)) — nothing is being checked." -ForegroundColor Red }
  }
  foreach ($v in 'ALERT_WEBHOOK_URL','ALERT_EMAIL_TO','ALERT_HEARTBEAT_URL') {
    $set = [Environment]::GetEnvironmentVariable($v, 'Machine')
    Write-Host ("  {0,-20} {1}" -f $v, $(if ($set) { 'set' } else { 'NOT SET' }))
  }
  if (-not ([Environment]::GetEnvironmentVariable('ALERT_WEBHOOK_URL','Machine') -or
            [Environment]::GetEnvironmentVariable('ALERT_EMAIL_TO','Machine'))) {
    Write-Host "  No alert channel — problems will be detected and then discarded." -ForegroundColor Red
  }
  exit 0
}

if ($Remove) {
  if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "  removed $TaskName" }
  else { Write-Host "  $TaskName was not registered" }
  exit 0
}

if (-not (Test-Path $script)) { throw "monitor not found: $script" }

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
  Write-Host "  This must run elevated — registering a scheduled task requires administrator rights." -ForegroundColor Red
  Write-Host "  Open PowerShell as administrator and run:"
  Write-Host "    cd '$server'"
  Write-Host "    pwsh -File scripts/schedule-monitor.ps1 -Url '$Url' -Backup '$Backup' -Every $Every"
  exit 3
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
if (-not $node) { throw 'node.exe is not on PATH for this account' }

$action = New-ScheduledTaskAction -Execute $node `
  -Argument "`"$script`" --url `"$Url`" --backup `"$Backup`" --remind $Remind" -WorkingDirectory $server

# TWO triggers, and the duration is one DAY rather than "forever".
#
# The obvious spelling of "repeat forever" — `-RepetitionDuration ([TimeSpan]::MaxValue)` — is
# widely suggested and is rejected by Task Scheduler: it serialises to P99999999DT23H59M59S and
# registration fails with "a value which is incorrectly formatted or out of range". Observed here,
# not theorised.
#
# A daily trigger repeating every $Every minutes for 24 hours is the supported way to say the same
# thing: the daily trigger re-arms each midnight, so the repetition never has to be unbounded. The
# startup trigger exists so checks resume within minutes of a reboot instead of waiting for the
# next midnight.
$daily = New-ScheduledTaskTrigger -Daily -At 00:00
$daily.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $Every) `
  -RepetitionDuration (New-TimeSpan -Days 1)).Repetition

$atBoot = New-ScheduledTaskTrigger -AtStartup
$atBoot.Repetition = $daily.Repetition

$trigger = @($daily, $atBoot)

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Checks liveness, readiness, error rate, latency, backup freshness and disk space every $Every minutes. Alerts on state change." | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "  registered  $TaskName" -ForegroundColor Green
Write-Host "  runs        every $Every minutes as SYSTEM, starting now"
Write-Host "  checks      $Url  ·  backup heartbeat in $Backup"
Write-Host "  reminders   repeat alerts no more often than every $Remind minutes"
Write-Host ""

$chan = @('ALERT_WEBHOOK_URL','ALERT_EMAIL_TO') | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Machine') }
if (-not $chan) {
  Write-Host "  NO ALERT CHANNEL IS CONFIGURED." -ForegroundColor Red
  Write-Host "  The monitor will detect problems and then throw them away. Set one, machine-wide:"
  Write-Host "    [Environment]::SetEnvironmentVariable('ALERT_WEBHOOK_URL','https://hooks.slack.com/...','Machine')"
  Write-Host "  then re-run this script so the task picks it up."
} else {
  Write-Host "  alerting via  $($chan -join ', ')" -ForegroundColor Green
}

if (-not [Environment]::GetEnvironmentVariable('ALERT_HEARTBEAT_URL','Machine')) {
  Write-Host ""
  Write-Host "  ALERT_HEARTBEAT_URL is not set. Nothing on this machine can tell you this machine" -ForegroundColor Yellow
  Write-Host "  is off. Point it at an external dead-man's-switch to cover that." -ForegroundColor Yellow
}
