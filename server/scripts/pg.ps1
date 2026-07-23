# Local PostgreSQL control for the Transaction Desk backend.
# Binaries + data live in user space (no admin, no Windows service).
#   Usage:  .\scripts\pg.ps1 start | stop | status | psql
param([Parameter(Position = 0)][string]$cmd = 'status')

$bin  = "C:\Users\ghr\pgsql\pgsql\bin"
$data = "C:\Users\ghr\pgdata"
$log  = Join-Path $data "server.log"
$env:PGPASSWORD = "postgres"

switch ($cmd) {
  'start'  { & (Join-Path $bin 'pg_ctl.exe') -D $data -l $log -w start }
  'stop'   { & (Join-Path $bin 'pg_ctl.exe') -D $data -m fast stop }
  'status' { & (Join-Path $bin 'pg_isready.exe') -h 127.0.0.1 -p 5432 }
  'psql'   { & (Join-Path $bin 'psql.exe') -h 127.0.0.1 -U postgres -d myapp }
  default  { Write-Output "Usage: pg.ps1 start|stop|status|psql" }
}
