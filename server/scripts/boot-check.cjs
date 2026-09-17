#!/usr/bin/env node
// Assembles the WHOLE application from a build exactly as start-up does - every module, every
// provider, every constructor argument - without opening a port or starting a scheduler.
//
// 2026-09-16: every unit spec passed, the gate passed, and crm-api then could not start at all
// ("Nest can't resolve dependencies of the UsersService ... argument Object at index [6]"). The
// specs build services by hand; nothing ever put AppModule together. This does, before any restart.
//
// Usage: node scripts/boot-check.cjs [distDir]      (default: ./dist)   exit 1 on any failure.
process.env.RUN_SCHEDULERS = 'false';
process.env.REMINDER_SWEEP_DISABLED = '1';
const path = require('path');
const root = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(root, '.env') }); } catch { /* the app loads it its own way */ }
const dist = path.resolve(root, process.argv[2] || 'dist');
const { Test } = require('@nestjs/testing');
const { AppModule } = require(path.join(dist, 'app.module.js'));

const quiet = { log() {}, error() {}, warn() {}, debug() {}, verbose() {} };
(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).setLogger(quiet).compile();
  // Assembly is the test. Shutting down is courtesy, and must not be able to hang a deploy.
  await Promise.race([mod.close().catch(() => undefined), new Promise((r) => setTimeout(r, 10000).unref())]);
  console.log(`boot-check: the whole application assembles (${path.relative(root, dist) || 'dist'}).`);
  process.exit(0);
})().catch((e) => {
  console.error(`boot-check FAILED (${path.relative(root, dist)}): ${String((e && e.message) || e).split('\n')[0]}`);
  process.exit(1);
});
