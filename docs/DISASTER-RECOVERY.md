# Backup & Disaster Recovery

The runbook for getting this application back after data loss. Written to be followed by somebody
who did not build it, at the worst possible moment.

---

## What a backup of this system is

**Two things, and either one alone is worthless.**

| Part | What it holds |
|---|---|
| `database.dump` | Every row — including the *paths* of uploaded files |
| `storage/` | The files those paths point at: documents, FINTRAC identification, signatures, the brand logo, user photos, generated exports |

Restore only the database and every document row resolves to a file that is not there — the API
answers, the list renders, and every download 404s. Restore only the storage and nothing knows the
files exist. They are always taken and restored **together**.

Each set also carries a `manifest.json` recording when it was taken, the SHA-256 of the dump, the
file count, and **which schema migration the database was at**. That last field matters: a dump
restored against a different schema version is the failure that looks like success until somebody
opens a screen.

---

## Taking a backup

```bash
cd server
npm run backup                       # → ../backups/YYYYMMDD-HHMMSS/
npm run backup -- --out D:/backups --keep 30
```

| Option | Default | Meaning |
|---|---|---|
| `--out` | `../backups` (or `BACKUP_ROOT`) | Where sets are written |
| `--keep` | `14` (or `BACKUP_KEEP`) | Sets retained; older ones are pruned |

Measured on production data (496 leads, 7 transactions, 41 documents): **2.0 seconds**, 25.9 MB
database + 10.5 MB storage.

### Scheduling it

The application does **not** schedule its own backups, on purpose — a backup process that dies with
the application is not a backup process. Use the operating system.

**Windows (Task Scheduler)** — daily at 02:00:

```
schtasks /create /tn "TransactionDesk Backup" /tr ^
  "node C:\path\to\server\scripts\backup.mjs --out D:\backups --keep 30" ^
  /sc daily /st 02:00 /ru SYSTEM
```

**Linux (cron)**:

```
0 2 * * *  cd /srv/app/server && /usr/bin/node scripts/backup.mjs --out /var/backups/td --keep 30
```

**Off-machine copy is not optional.** A backup on the same disk as the database survives a mistake,
not a fire. Sync `--out` to object storage or another host.

---

## Verifying a backup

**A backup nobody has restored is a hope, not a backup.** This restores into a scratch database,
counts what came back, and drops it. It never touches the live database.

```bash
cd server
npm run backup:verify                        # latest set
npm run backup:verify -- --set 20260731-010025
```

Expected output:

```
  integrity … ok  (25.9 MB, sha256 matches)
  tables    80
  rows      users=6  transactions=7  leads=496  invoices=5  documents=41  audit_logs=140  roles=6
  RESTORE VERIFIED — every checked table came back with rows.
```

It exits non-zero if the dump's hash does not match the manifest, or if any checked table comes
back empty. **Run it on a schedule too** — weekly is reasonable. A silently corrupt backup and no
backup are the same thing on the day you need it.

---

## Restoring

### 1. Into a scratch database first (recommended)

Always do this before overwriting anything, unless the live database is already gone.

```bash
cd server
node scripts/restore.mjs --set latest --into myapp_restored
```

Point a spare copy of the application at `myapp_restored`, confirm the data is what you expect,
*then* proceed.

### 2. Over the live database (destructive)

```bash
node scripts/restore.mjs --set latest --into myapp --force
```

`--force` is required. Without it the script refuses to touch the database named in
`DATABASE_URL`, because the whole point of a restore is that it overwrites.

### 3. Restore the files — do not skip this

```bash
# Windows
robocopy "..\backups\20260731-010025\storage" "%STORAGE_ROOT%" /MIR
# Linux
rsync -a --delete ../backups/20260731-010025/storage/ "$STORAGE_ROOT/"
```

### 4. Bring the schema level with the code

```bash
npx prisma migrate deploy
npx prisma migrate status      # expect: up to date
```

If the manifest's `schema_migration` is **older** than the code you are deploying, `migrate deploy`
will bring it forward. If it is **newer**, you are restoring into an older release — deploy the
matching code first.

### 5. Confirm before declaring recovery

```bash
npm test                                  # 310 tests
curl -s localhost:8000/api/health
```

Then, in the application: sign in, open a transaction, open a document (proves database *and*
storage agree), and check the audit trail has entries.

---

## Targets

| | |
|---|---|
| **RPO** (data you can lose) | **24 hours** on a daily schedule — the time since the last set. Move to hourly if that is too much. |
| **RTO** (time to be back) | **~15 minutes** — 2 s dump restore, plus file copy, migration and checks. Dominated by people, not by the tooling. |
| **Retention** | 14 sets by default; 30 recommended |
| **Off-machine copy** | **Not implemented — you must arrange it.** See below. |

---

## Known gaps

Stated plainly, because a runbook that overstates what exists is worse than none.

1. **No off-machine replication.** Sets are written to a local path. If the disk fails, they fail
   with it. Sync `--out` somewhere else.
2. **No point-in-time recovery.** These are periodic snapshots, not continuous archiving. Losing up
   to a full interval is inherent. PITR needs WAL archiving, which is a PostgreSQL configuration
   change, not an application one.
3. **The storage copy is not incremental.** Every set copies every file. Fine at 10 MB; revisit
   when it is gigabytes.
4. **Backups are not encrypted at rest.** They contain client identification and commission
   figures. If they leave this machine, encrypt them.
5. **Nothing alerts on failure.** A scheduled backup that stops running is silent. Whatever runs it
   should report failure somewhere a person will see.
