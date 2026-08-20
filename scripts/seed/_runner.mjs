/**
 * _runner.mjs — compose the Placebo rebuild from its modules and run it ONCE.
 *
 * WHY A RUNNER AND NOT FOUR SCRIPTS. The modules were written in parallel, but
 * they must not RUN in parallel: they share a database, a code generator whose
 * sequences would interleave, and an ordering (a BOM line cannot point at a
 * catalog item that does not exist yet). One process, one transaction, one
 * order — declared here rather than left to whoever runs them.
 *
 * EVERY MODULE IS IDEMPOTENT AND LOOKS UP BY CODE. No module may depend on an
 * auto-increment id another module happened to produce; it finds what it needs
 * by the natural key (`code` within the company) and upserts. That is what makes
 * a half-finished run safe to repeat instead of a mess to unpick.
 *
 * Usage:
 *   node scripts/seed/_runner.mjs <companyId>           # dry run — reports only
 *   node scripts/seed/_runner.mjs <companyId> --apply   # write
 */

import { pool } from '../../db.js';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1];

if (!companyId) {
  console.error('Usage: node scripts/seed/_runner.mjs <companyId> [--apply] [--only=03]');
  process.exit(1);
}

/** Declared order IS the dependency order. */
const MODULES = [
  ['01', './01-fields.mjs'],
  ['02', './02-materials.mjs'],
  ['03', './03-structures.mjs'],
  ['04', './04-shopfloor.mjs'],
  ['05', './05-stock.mjs'],
  ['06', './06-scopes.mjs'],
];

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE id = ?', [companyId]);
if (!company) { console.error(`No company ${companyId}`); process.exit(1); }

console.log(`\n${apply ? 'SEEDING' : 'DRY RUN'} — ${company.name} (${companyId})\n`);

const conn = await pool.getConnection();
const summary = [];
try {
  if (apply) await conn.beginTransaction();

  for (const [key, path] of MODULES) {
    if (only && only !== key) continue;
    let mod;
    try {
      mod = await import(path);
    } catch (e) {
      console.log(`  ${key}  SKIPPED — module not present (${e.code ?? e.message})`);
      continue;
    }
    if (typeof mod.seed !== 'function') {
      console.log(`  ${key}  SKIPPED — no exported seed()`);
      continue;
    }
    const ctx = {
      companyId,
      apply,
      conn,
      log: (msg) => console.log(`        ${msg}`),
    };
    const t0 = Date.now();
    const result = await mod.seed(ctx);
    const ms = Date.now() - t0;
    const counts = result && typeof result === 'object' ? result : {};
    summary.push({ key, name: mod.NAME ?? path, counts, ms });
    const line = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing to do';
    console.log(`  ${key}  ${(mod.NAME ?? path).padEnd(34)} ${line}  (${ms}ms)`);
  }

  if (apply) {
    await conn.commit();
    console.log('\nCommitted.\n');
  } else {
    console.log('\nNothing was written. Re-run with --apply.\n');
  }
} catch (err) {
  if (apply) await conn.rollback();
  console.error(`\nRolled back — nothing written: ${err.message}\n`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
