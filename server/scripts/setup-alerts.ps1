<#
.SYNOPSIS
  Point the health monitor at somewhere alerts can actually arrive, then prove one gets there.

.DESCRIPTION
  The monitor has been running and finding nothing wrong, but with no destination configured it
  detects problems and discards them. This is the last step, and it is one command.

  Give it a webhook URL (Slack or Teams) or SMTP details. It validates them, stores them
  MACHINE-WIDE — the monitor runs as SYSTEM and cannot see a User-scoped variable, which is the
  most common way this silently fails — and immediately sends a test alert so you find out now
  rather than during an incident.

  SELF-ELEVATES. Setting a machine environment variable needs administrator rights, so this
  re-launches itself with a UAC prompt if it is not already elevated.

  WHY IT IS NOT READ FROM THE DATABASE. The application's own mail accounts live in
  `mail_accounts`, encrypted. An alerter that read its credentials from the database could not tell
  you the database was down — precisely when you need it. So this is environment-only, and the
  monitor never opens the database.

.EXAMPLE
  # Slack or Teams — create the webhook first at api.slack.com/apps → Incoming Webhooks
  pwsh -File scripts/setup-alerts.ps1 -WebhookUrl 'https://hooks.slack.com/services/T00/B00/xxxx'

.EXAMPLE
  # Email, using a dedicated mailbox and an APP PASSWORD (not an account password)
  pwsh -File scripts/setup-alerts.ps1 -SmtpHost smtp.gmail.com -SmtpUser alerts@gethomerealty.ca `
       -SmtpPass '<app password>' -EmailTo info@gethomerealty.ca

.EXAMPLE
  # An external dead-man's-switch. Nothing on this machine can report that this machine is off.
  pwsh -File scripts/setup-alerts.ps1 -HeartbeatUrl 'https://hc-ping.com/<uuid>'

.EXAMPLE
  pwsh -File scripts/setup-alerts.ps1 -Status
  pwsh -File scripts/setup-alerts.ps1 -Test        # re-send a test through whatever is configured
#>
[CmdletBinding()]
param(
  [string]$WebhookUrl,
  [string]$SmtpHost,
  [int]   $SmtpPort = 587,
  [string]$SmtpUser,
  [string]$SmtpPass,
  [string]$EmailTo,
  [string]$EmailFrom,
  [string]$HeartbeatUrl,
  [switch]$Status,
  [switch]$Test,
  [switch]$Clear
)

$ErrorActionPreference = 'Stop'
$server = Split-Path -Parent $PSScriptRoot
$KEYS = 'ALERT_WEBHOOK_URL','ALERT_SMTP_HOST','ALERT_SMTP_PORT','ALERT_SMTP_USER','ALERT_SMTP_PASS','ALERT_EMAIL_TO','ALERT_EMAIL_FROM','ALERT_HEARTBEAT_URL'

function Show-Status {
  Write-Host "  configured alert settings (Machine scope):"
  $anyMachine = $false
  foreach ($k in $KEYS) {
    $m = [Environment]::GetEnvironmentVariable($k, 'Machine')
    $u = [Environment]::GetEnvironmentVariable($k, 'User')
    if ($m) { $anyMachine = $true }
    # Never echo a secret back to the console. A webhook URL is a credential in its own right —
    # anyone holding it can post into the channel — so only enough is shown to identify WHICH one
    # is configured, never enough to reuse it from a screenshot or a pasted terminal log.
    $mask = {
      param($v)
      if ($v -match '^https://hooks\.slack\.com/services/([^/]+)/') { "Slack workspace $($Matches[1]) …/****" }
      elseif ($v -match '^https://([^/]+)\.webhook\.office\.com')   { "Teams $($Matches[1]) …/****" }
      elseif ($v -match '^(https?://[^/]+)/')                       { "$($Matches[1])/…/****" }
      else { $v }
    }
    $shown = if ($m) { if ($k -match 'PASS') { '********' } elseif ($k -match 'URL') { & $mask $m } else { $m } }
             elseif ($u) { 'SET IN USER SCOPE ONLY — the SYSTEM task cannot see this' }
             else { '—' }
    $colour = if ($m) { 'Green' } elseif ($u) { 'Yellow' } else { 'DarkGray' }
    Write-Host ("    {0,-20} {1}" -f $k, $shown) -ForegroundColor $colour
  }
  if (-not $anyMachine) {
    Write-Host "  NO DESTINATION — the monitor detects problems and discards them." -ForegroundColor Red
  }
  if (-not [Environment]::GetEnvironmentVariable('ALERT_HEARTBEAT_URL','Machine')) {
    Write-Host "  ALERT_HEARTBEAT_URL unset: nothing here can report that this machine is off." -ForegroundColor Yellow
  }
}

if ($Status) { Show-Status; exit 0 }

function Send-Test {
  Write-Host ""
  Write-Host "  sending a test alert …"
  Push-Location $server
  try {
    # Read the values we just wrote into THIS process, so the test does not depend on a new shell
    # inheriting them. Without this the test fails on a correct configuration, which is worse than
    # not testing at all.
    foreach ($k in $KEYS) {
      $v = [Environment]::GetEnvironmentVariable($k, 'Machine')
      if ($v) { Set-Item -Path "env:$k" -Value $v }
    }
    & node scripts/monitor.mjs --test-alert
    $code = $LASTEXITCODE
  } finally { Pop-Location }

  Write-Host ""
  if ($code -eq 0) {
    Write-Host "  DELIVERED — check the destination. Monitoring is now complete." -ForegroundColor Green
  } else {
    Write-Host "  NOT DELIVERED. The settings are stored but nothing accepted the message." -ForegroundColor Red
    Write-Host "  Check the URL or credentials and run:  pwsh -File scripts/setup-alerts.ps1 -Test"
  }
  return $code
}

# ---- elevation -----------------------------------------------------------------------------------
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Test -and -not ($WebhookUrl -or $SmtpHost -or $HeartbeatUrl -or $Clear)) {
  # Testing alone needs no elevation — reading machine variables is unprivileged.
  exit (Send-Test)
}

if (-not ($WebhookUrl -or $SmtpHost -or $HeartbeatUrl -or $Clear)) {
  Write-Host "  Nothing to do. Give -WebhookUrl, or -SmtpHost/-EmailTo, or -HeartbeatUrl." -ForegroundColor Yellow
  Write-Host "  Run with -Status to see what is configured, or -Test to re-send a test."
  exit 2
}

# Validate BEFORE elevating. Checking afterwards means a mistyped URL raises a UAC prompt, gets
# approved, and only then fails — asking somebody to authorise an action that was never going to work.
if ($WebhookUrl -and $WebhookUrl -notmatch '^https://') {
  Write-Host "  The webhook URL must start with https:// — got '$WebhookUrl'." -ForegroundColor Red
  exit 2
}
if ($SmtpHost -and -not $EmailTo) {
  Write-Host "  -EmailTo is required with -SmtpHost, or the alert has nowhere to go." -ForegroundColor Red
  exit 2
}
if ($HeartbeatUrl -and $HeartbeatUrl -notmatch '^https?://') {
  Write-Host "  The heartbeat URL must be http(s) — got '$HeartbeatUrl'." -ForegroundColor Red
  exit 2
}

if (-not $elevated) {
  Write-Host "  Elevating — approve the UAC prompt." -ForegroundColor Yellow
  # Rebuild the exact invocation rather than asking the operator to retype it elevated.
  $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"$PSCommandPath")
  foreach ($p in $PSBoundParameters.GetEnumerator()) {
    if ($p.Value -is [switch]) { if ($p.Value.IsPresent) { $args += "-$($p.Key)" } }
    else { $args += @("-$($p.Key)", [string]$p.Value) }
  }
  try {
    $proc = Start-Process pwsh -Verb RunAs -PassThru -Wait -ArgumentList $args
    exit $proc.ExitCode
  } catch {
    Write-Host "  Elevation was declined, so nothing was changed." -ForegroundColor Red
    exit 3
  }
}

# ---- validate, then store ------------------------------------------------------------------------
if ($Clear) {
  foreach ($k in $KEYS) { [Environment]::SetEnvironmentVariable($k, $null, 'Machine') }
  Write-Host "  cleared every ALERT_* machine variable."
  Show-Status
  exit 0
}

$set = @{}

if ($WebhookUrl) {
  if ($WebhookUrl -notmatch '^https://') { throw "The webhook URL must start with https:// — got '$WebhookUrl'." }
  $set['ALERT_WEBHOOK_URL'] = $WebhookUrl
  # A friendly note, not a restriction: any endpoint accepting {"text": "..."} works.
  if ($WebhookUrl -match 'hooks\.slack\.com')          { Write-Host "  destination: Slack" }
  elseif ($WebhookUrl -match 'webhook\.office\.com')   { Write-Host "  destination: Microsoft Teams" }
  else                                                 { Write-Host "  destination: generic webhook" }
}

if ($SmtpHost) {
  if (-not $EmailTo) { throw "-EmailTo is required with -SmtpHost, or the alert has nowhere to go." }
  $set['ALERT_SMTP_HOST'] = $SmtpHost
  $set['ALERT_SMTP_PORT'] = "$SmtpPort"
  if ($SmtpUser) { $set['ALERT_SMTP_USER'] = $SmtpUser }
  if ($SmtpPass) { $set['ALERT_SMTP_PASS'] = $SmtpPass }
  $set['ALERT_EMAIL_TO'] = $EmailTo
  if ($EmailFrom) { $set['ALERT_EMAIL_FROM'] = $EmailFrom } elseif ($SmtpUser) { $set['ALERT_EMAIL_FROM'] = $SmtpUser }
  Write-Host "  destination: email to $EmailTo via $SmtpHost`:$SmtpPort"
}

if ($HeartbeatUrl) {
  if ($HeartbeatUrl -notmatch '^https?://') { throw "The heartbeat URL must be http(s) — got '$HeartbeatUrl'." }
  $set['ALERT_HEARTBEAT_URL'] = $HeartbeatUrl
  Write-Host "  dead-man's-switch: $HeartbeatUrl"
}

foreach ($kv in $set.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, 'Machine')
  # Also into this process, so the test below sees them without a new shell.
  Set-Item -Path "env:$($kv.Key)" -Value $kv.Value
}
Write-Host "  stored $($set.Count) setting(s) machine-wide." -ForegroundColor Green

# A User-scoped copy left over from an earlier attempt would shadow nothing for the SYSTEM task, but
# it does make `-Status` confusing later. Say so rather than silently deleting someone else's value.
foreach ($k in $set.Keys) {
  if ([Environment]::GetEnvironmentVariable($k, 'User')) {
    Write-Host "  note: $k also exists in User scope. The SYSTEM task uses the Machine value." -ForegroundColor Yellow
  }
}

exit (Send-Test)
