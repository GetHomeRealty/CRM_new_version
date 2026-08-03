/**
 * Moves existing call recordings out of the database and onto disk.
 *
 * DELIBERATELY NOT PART OF THE SCHEMA MIGRATION. `20260802160000_recordings_to_disk` only makes
 * room — it adds the path column and relaxes the NOT NULL, and every existing row keeps its bytes
 * and keeps working. Copying files is a separate step, run when somebody is watching, because a
 * copy that silently fails loses the recording of a conversation with a client and a schema
 * migration is the wrong place to discover that.
 *
 *   node scripts/migrate-recordings.cjs --dry-run     # report what would move, touch nothing
 *   node scripts/migrate-recordings.cjs               # move them
 *   RECORDING_STORAGE_DIR=/mnt/recordings node scripts/migrate-recordings.cjs
 *
 * SAFETY, in order:
 *   1. the file is written,
 *   2. it is read back and its SHA-256 compared with the bytes still in the database,
 *   3. only then is the row pointed at the file and the column cleared.
 * A failure at any step leaves the row exactly as it was, still serving from the database. Re-run
 * it as often as you like; rows already moved are skipped.
 */
const { PrismaClient } = require('@prisma/client');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DRY = process.argv.includes('--dry-run');
const BATCH = 25;                       // small: each row is up to 8 MB of audio held in memory
const ROOT = path.resolve(process.env.RECORDING_STORAGE_DIR ?? path.join(process.cwd(), 'storage', 'recordings'));

const EXT = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
};

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mb = (n) => (n / 1024 / 1024).toFixed(1);

const prisma = new PrismaClient();

async function main() {
  const pending = await prisma.lead_call_recordings.count({ where: { storage_path: null } });
  const already = await prisma.lead_call_recordings.count({ where: { storage_path: { not: null } } });

  console.log(`\nCall recording migration${DRY ? ' — DRY RUN, nothing will be written' : ''}`);
  console.log(`  storage root : ${ROOT}`);
  console.log(`  in database  : ${pending}`);
  console.log(`  already moved: ${already}\n`);

  if (!pending) { console.log('  Nothing to do.\n'); return; }

  if (!DRY) {
    // Prove the destination is writable before reading a single 8 MB row out of the database.
    await fs.mkdir(ROOT, { recursive: true });
    const probe = path.join(ROOT, `.probe-${crypto.randomBytes(6).toString('hex')}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
  }

  let moved = 0, failed = 0, bytes = 0;

  /*
   * Paged by an id cursor, not by "fetch the ones still unmigrated".
   *
   * The obvious loop — repeatedly SELECT WHERE storage_path IS NULL — works only because each pass
   * removes its own rows from that set. A dry run removes nothing, so it re-reads the same batch
   * for ever; a row that fails to copy does the same. Both were reachable, and the second is the
   * one that would have happened at 3am on somebody's read-only volume. The cursor advances
   * regardless of what the pass did, so the loop always terminates.
   */
  let cursor = 0;
  for (;;) {
    const rows = await prisma.lead_call_recordings.findMany({
      where: { storage_path: null, id: { gt: cursor } },
      select: { id: true, call_id: true, content_type: true, size: true, data: true, created_at: true },
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const label = `recording #${row.id} (call ${row.call_id}, ${mb(row.size)} MB)`;
      if (!row.data) {
        console.log(`  ! ${label}: no bytes in the column and no path — skipped, nothing to move.`);
        failed++;
        continue;
      }

      const when = row.created_at ?? new Date();
      const rel = [
        String(when.getUTCFullYear()),
        String(when.getUTCMonth() + 1).padStart(2, '0'),
        `${crypto.randomBytes(16).toString('hex')}${EXT[String(row.content_type).toLowerCase()] ?? '.audio'}`,
      ].join('/');

      if (DRY) {
        console.log(`  · ${label} → ${rel}`);
        moved++; bytes += row.size;
        continue;
      }

      const abs = path.join(ROOT, ...rel.split('/'));
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, Buffer.from(row.data));

        // Read it back and compare. Writing then trusting the write is how a half-full disk turns
        // into a directory of truncated audio that nobody notices until somebody plays one.
        const back = await fs.readFile(abs);
        if (sha(back) !== sha(Buffer.from(row.data))) {
          throw new Error('checksum mismatch after write — the copy on disk does not match the database');
        }

        await prisma.lead_call_recordings.update({
          where: { id: row.id },
          data: { storage_path: rel, data: null },
        });
        moved++; bytes += row.size;
        if (moved % 25 === 0) process.stdout.write(`\r  moved ${moved} / ${pending}…`);
      } catch (err) {
        failed++;
        console.log(`\n  ! ${label}: ${err.message} — left in the database, still playable.`);
        await fs.unlink(abs).catch(() => undefined);   // no half-written file left behind
      }
    }
  }

  console.log(`\r  ${DRY ? 'would move' : 'moved'} ${moved} recording(s), ${mb(bytes)} MB${failed ? `, ${failed} left in the database` : ''}.`);
  if (!DRY && moved) {
    console.log('\n  The bytes are out of the database, but Postgres does not return the space to the');
    console.log('  filesystem on its own — run VACUUM FULL lead_call_recordings (it takes an exclusive');
    console.log('  lock) or leave it for autovacuum to reuse in place.\n');
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('\n', e, '\n'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
