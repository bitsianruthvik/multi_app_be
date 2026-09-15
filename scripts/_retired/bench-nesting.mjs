/**
 * bench-nesting.mjs — what more compute actually buys, in steel.
 *
 * Runs the real suggestor over a real order at increasing restart counts and
 * reports plate area bought. Restart 0 is the deterministic packer, so the
 * first row is today's answer and every later row is the improvement.
 *
 * SCORED ON PLATE AREA, not utilisation. Utilisation is a per-plate ratio and
 * can be flattered by using more plates; area bought is what the money follows.
 *
 *   node scripts/bench-nesting.mjs <orderId> [restarts,restarts,...]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const orderId = Number(process.argv[2]);
const LADDER = (process.argv[3] ?? '1,5,20,100,400,1500').split(',').map(Number);

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});

const { pool } = await import('../db.js');
const { suggestNesting } = await import('../apps/fab_erp/services/nestingSuggestService.js');

const COMPANY = 30005;
const DENSITY_T_PER_M2_MM = 7.85 / 1000; // tonnes per m2 per mm of thickness

// Warm the caches so the first timed row is not paying for them.
await suggestNesting(COMPANY, orderId, { includeNested: true, restarts: 1 });

const rows = [];
for (const restarts of LADDER) {
  const t0 = Date.now();
  const s = await suggestNesting(COMPANY, orderId, { includeNested: true, restarts });
  const ms = Date.now() - t0;

  const nests = s.groups;
  const plateArea = nests.reduce((a, n) => a + (n.usedAreaMm2 ?? 0) + (n.wasteAreaMm2 ?? 0), 0);
  const partArea = nests.reduce((a, n) => a + (n.usedAreaMm2 ?? 0), 0);
  const steelT = nests.reduce(
    (a, n) => a + ((n.usedAreaMm2 ?? 0) + (n.wasteAreaMm2 ?? 0)) / 1e6 * n.thickness * DENSITY_T_PER_M2_MM, 0);
  rows.push({
    restarts,
    seconds: Math.round(ms / 100) / 10,
    plates: nests.length,
    plateAreaM2: Math.round(plateArea / 1e6 * 10) / 10,
    wastePct: Math.round((1 - partArea / plateArea) * 1000) / 10,
    steelTonnes: Math.round(steelT * 100) / 100,
    unplaced: s.unplaced?.length ?? 0,
  });
  const base = rows[0];
  const saved = base.steelTonnes - rows[rows.length - 1].steelTonnes;
  console.log(`restarts ${String(restarts).padStart(5)}  ${String(rows[rows.length - 1].seconds).padStart(6)}s  `
    + `${String(rows[rows.length - 1].plates).padStart(4)} plates  `
    + `${String(rows[rows.length - 1].plateAreaM2).padStart(7)} m2  `
    + `waste ${String(rows[rows.length - 1].wastePct).padStart(5)}%  `
    + `${String(rows[rows.length - 1].steelTonnes).padStart(7)} t  `
    + `saved ${saved.toFixed(2)} t`);
}

console.log('\n=== summary ===');
console.table(rows);
const base = rows[0];
for (const r of rows.slice(1)) {
  const t = base.steelTonnes - r.steelTonnes;
  console.log(`${String(r.restarts).padStart(5)} restarts: ${r.seconds}s, saves ${t.toFixed(2)} t `
    + `(${((t / base.steelTonnes) * 100).toFixed(2)}% of steel)`);
}
await pool.end();
