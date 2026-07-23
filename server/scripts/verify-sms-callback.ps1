# Runs verify-sms-callback.cjs against a throwaway API instance configured with PLACEHOLDER
# Twilio credentials. Nothing contacts Twilio: only the inbound webhooks are exercised, and the
# token is a local string used solely to sign and verify them. The instance is always torn down.
$ErrorActionPreference = 'Stop'
$port = '8099'
$env:SMS_TEST_PORT              = $port
$env:PORT                       = $port
$env:TWILIO_ACCOUNT_SID         = 'ACverification0000000000000000000'
$env:TWILIO_AUTH_TOKEN          = 'verification-token-not-a-real-secret'
$env:TWILIO_FROM_NUMBER         = '+15005550006'   # Twilio's own magic test number
$env:TWILIO_PUBLIC_URL          = "http://127.0.0.1:$port"

$proc = Start-Process -FilePath node -ArgumentList 'dist\main.js' -PassThru -WindowStyle Hidden
try {
  # Wait for it to accept connections rather than sleeping a fixed guess.
  for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:$port/sanctum/csrf-cookie" -UseBasicParsing -TimeoutSec 2 | Out-Null; break }
    catch { Start-Sleep -Milliseconds 250 }
  }
  node scripts\verify-sms-callback.cjs
  $code = $LASTEXITCODE
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item Env:PORT, Env:TWILIO_ACCOUNT_SID, Env:TWILIO_AUTH_TOKEN, Env:TWILIO_FROM_NUMBER, Env:TWILIO_PUBLIC_URL, Env:SMS_TEST_PORT -ErrorAction SilentlyContinue
}
exit $code
