/** Reports the versions actually installed / running (not the package.json ranges). */
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const fs = require('fs');

/** Read an installed package's real version from its own package.json. */
function installed(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return '(not installed)';
  }
}

const CLIENT = path.join(process.cwd(), '..', 'client');
const SERVER = process.cwd();

(async () => {
  const row = (k, v) => console.log('  ' + String(k).padEnd(26) + v);

  console.log('=== RUNTIME ===');
  row('Node.js', process.version);
  row('V8', process.versions.v8);
  row('OpenSSL', process.versions.openssl);
  row('Platform', `${process.platform} ${process.arch}`);

  console.log('\n=== FRONTEND (installed) ===');
  for (const p of ['react', 'react-dom', 'react-router-dom', 'vite', 'typescript', 'axios',
    '@vitejs/plugin-react', 'jspdf', 'pdf-lib', 'html2canvas']) {
    row(p, installed(CLIENT, p));
  }

  console.log('\n=== BACKEND (installed) ===');
  for (const p of ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', 'express',
    'typescript', 'prisma', '@prisma/client', 'exceljs', 'pdfkit', 'archiver', 'nodemailer',
    'decimal.js', 'express-session', 'connect-pg-simple', 'pg', 'jest', 'ts-jest']) {
    row(p, installed(SERVER, p));
  }

  console.log('\n=== DATABASE ===');
  const prisma = new PrismaClient();
  try {
    const [v] = await prisma.$queryRawUnsafe('SELECT version() AS version');
    row('server', String(v.version).split(',')[0]);
    const [s] = await prisma.$queryRawUnsafe(
      "SELECT current_database() AS db, current_setting('server_version') AS ver, current_setting('server_encoding') AS enc",
    );
    row('database', s.db);
    row('server_version', s.ver);
    row('encoding', s.enc);
    const tables = await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
    );
    row('tables (public)', tables[0].n);
    const mig = await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5',
    );
    console.log('\n  migrations applied (latest 5):');
    for (const m of mig) console.log('    ' + m.migration_name);
    const total = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM _prisma_migrations');
    row('\n  migrations total'.trim(), total[0].n);
  } catch (e) {
    console.log('  DB ERROR:', e.message);
  }
  await prisma.$disconnect();
})();
