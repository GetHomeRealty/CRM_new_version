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

Measured on production data (496 leads, 7 transactions, 41 documents): **3.3 seconds**, 53.8 MB
database + 10.4 MB storage.

That database figure was **25.9 MB when this runbook was first written and doubled within a week**,
entirely from `inbound_emails`. Treat these numbers as a reading taken on a date, not a constant —
and see gap 6.

### Scheduling it

The application does **not** schedule its own backups, on purpose — a backup process that dies with
the application is not a backup process. Use the operating system.

**Windows** — one command, from an **elevated** prompt:

```powershell
cd server
pwsh -File scripts/schedule-backup.ps1 -Out E:\backups\transactiondesk -Keep 30
```

Registering a scheduled task requires administrator rights; the script says so and exits 3 rather
than surfacing a bare "Access is denied". It is idempotent — run it again after changing `-Out` or
`-Keep` and it replaces the task instead of adding a second one.

It registers `scripts/backup-nightly.ps1` daily at 02:00, which takes the backup, restores it into a
scratch database every Sunday to prove it is not corrupt, and writes `last-success.json`.

Two things to know about how it is registered:

- **Not as SYSTEM**, which the earlier version of this document suggested. SYSTEM cannot see mapped
  drives or UNC paths under the operator's credentials, so a backup to a network target fails
  silently under SYSTEM while working perfectly when tested by hand. It runs as the registering
  account with logon type S4U — no stored password, runs whether or not that user is signed in.
- **`-StartWhenAvailable`** is set, so a machine that was switched off at 02:00 runs the backup at
  next boot rather than skipping the night.

Check it:

```powershell
pwsh -File scripts/schedule-backup.ps1 -Status              # is the task registered, did it run
pwsh -File scripts/backup-nightly.ps1 -Status -Out E:\...   # did a backup actually succeed
```

**Linux (cron)**:

```
0 2 * * *  cd /srv/app/server && /usr/bin/node scripts/backup.mjs --out /var/backups/td --keep 30
```

### Knowing it stopped

A scheduled backup rarely fails loudly. It stops running, and the failure is that *nothing
happened* — and nothing can detect an event that did not occur. So the check is for **staleness**,
not for errors:

```powershell
pwsh -File scripts/backup-nightly.ps1 -Status -Out E:\backups\transactiondesk
```

`last-success.json` is rewritten **only** after a successful run. The command exits `0` if the last
success is under 25 hours old, `1` if it is stale, and `2` if no backup has ever succeeded — so it
can be a monitoring check as it stands, not just something a person reads. A stale heartbeat means
the backup is broken whether it errored, never fired, or the machine was off, which is the point:
all three are the same emergency.

Point whatever monitoring you have at that exit code. Until something does, this is still gap 5.

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
5. **Nothing alerts on failure — partly closed.** `backup-nightly.ps1 -Status` now exits non-zero on
   a stale or never-successful backup, so the *check* exists. Nothing is running that check on a
   schedule yet. Until a monitor calls it, a dead backup is still silent.
6. **The mail mirror dominates the backup, and it only grows.** `inbound_emails` stores every
   message body, HTML included, and is **77 MB of an 80 MB database — 96% of it**. There is no
   retention policy on it. Backup size, dump time and restore time are therefore governed almost
   entirely by mail volume, and the RTO below will drift as the mailbox fills. A retention window on
   `inbound_emails` (or moving bodies out of the row) is the single highest-leverage change
   available to backup and restore times. Nothing is wrong with the data — the unique index on
   `(account_id, uid)` prevents re-ingestion, so this is real mail, not duplicates.
