/**
 * kepl-vs-client.mjs — our nesting against the customer's own raw-material list.
 *
 * The customer sent a plate schedule with their BOQ: 116 plates, 692.69 t for
 * two spans, plus 14,424 studs. That is the number to beat, and it is a far
 * better benchmark than our own greedy baseline — it is what they would
 * actually have bought.
 *
 * Compared SIZE BY SIZE, not just on the total. Buying the same tonnage in
 * different sizes is not the same purchase: it changes what can be cut from
 * what, and a total that matches while the sizes do not is a coincidence rather
 * than an agreement.
 *
 *   node scripts/kepl-vs-client.mjs <orderId> [effort]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const orderId = Number(process.argv[2]);
const EFFORT = process.argv[3] ?? 'deep';
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

const RATE = 85000; // Rs per tonne, indicative

/** The customer's schedule, transcribed from their PDF. Two spans. */
const CLIENT = [
  { t: 12, w: 2300, l: 12050, qty: 16, mt: 41.77 },
  { t: 12, w: 2250, l: 12050, qty: 4, mt: 10.22 },
  { t: 16, w: 2500, l: 12050, qty: 16, mt: 60.54 },
  { t: 25, w: 2050, l: 12050, qty: 14, mt: 67.87 },
  { t: 25, w: 1750, l: 10850, qty: 4, mt: 14.91 },
  { t: 28, w: 3100, l: 12050, qty: 40, mt: 328.43 },
  { t: 32, w: 2000, l: 11000, qty: 4, mt: 22.11 },
  { t: 40, w: 2150, l: 12050, qty: 14, mt: 113.89 },
  { t: 40, w: 2500, l: 10500, qty: 4, mt: 32.97 },
];
const CLIENT_STUD_MT = 10.96;

const s = await suggestNesting(30005, orderId, { includeNested: true, effort: EFFORT });
if (s.message) { console.log(`suggestor: ${s.message}`); await pool.end(); process.exit(1); }

/** Ours, aggregated by the size actually bought. */
const mine = new Map();
for (const n of s.groups) {
  const t = n.thickness;
  const l = Math.max(n.plate.length, n.plate.width);
  const w = Math.min(n.plate.length, n.plate.width);
  const k = `${t}|${w}|${l}`;
  if (!mine.has(k)) mine.set(k, { t, w, l, qty: 0 });
  mine.get(k).qty += 1;
}
const mt = (r) => (r.t * r.w * r.l * r.qty * 7.85) / 1e9;

console.log(`order #${orderId} · effort ${EFFORT} · unplaced ${s.unplaced?.length ?? 0}\n`);
console.log('OURS — plates the nesting wants:');
let ourMt = 0; let ourQty = 0;
for (const r of [...mine.values()].sort((a, b) => a.t - b.t || a.w - b.w)) {
  const m = mt(r); ourMt += m; ourQty += r.qty;
  console.log(`  ${String(r.t).padStart(3)} x ${String(r.w).padStart(5)} x ${String(r.l).padStart(6)}   ${String(r.qty).padStart(3)}   ${m.toFixed(2)} MT`);
}
console.log(`  ${''.padStart(28)} ${String(ourQty).padStart(3)}   ${ourMt.toFixed(2)} MT`);

console.log('\nCLIENT — plates their schedule asks for:');
let cliMt = 0; let cliQty = 0;
for (const r of CLIENT) {
  cliMt += r.mt; cliQty += r.qty;
  console.log(`  ${String(r.t).padStart(3)} x ${String(r.w).padStart(5)} x ${String(r.l).padStart(6)}   ${String(r.qty).padStart(3)}   ${r.mt.toFixed(2)} MT`);
}
console.log(`  ${''.padStart(28)} ${String(cliQty).padStart(3)}   ${cliMt.toFixed(2)} MT`);

const saved = cliMt - ourMt;
console.log(`\n${'='.repeat(58)}`);
console.log(`client   ${cliQty} plates   ${cliMt.toFixed(2)} MT`);
console.log(`ours     ${ourQty} plates   ${ourMt.toFixed(2)} MT`);
console.log(`${saved >= 0 ? 'SAVED' : 'OVER '}    ${Math.abs(cliQty - ourQty)} plates   ${Math.abs(saved).toFixed(2)} MT`
  + `   ~Rs ${Math.abs(Math.round(saved * RATE)).toLocaleString('en-IN')}`);
console.log(`(studs are the same either way: ${CLIENT_STUD_MT} MT, bought not cut)`);

// Thicknesses one side has and the other does not — the first sign the two are
// not describing the same bridge.
const ourT = new Set([...mine.values()].map((r) => r.t));
const cliT = new Set(CLIENT.map((r) => r.t));
const onlyOurs = [...ourT].filter((t) => !cliT.has(t));
const onlyClient = [...cliT].filter((t) => !ourT.has(t));
if (onlyOurs.length || onlyClient.length) {
  console.log(`\nthickness mismatch — ours only: ${onlyOurs.join(', ') || 'none'}`
    + ` · theirs only: ${onlyClient.join(', ') || 'none'}`);
}
console.log(`\nour summary: ${JSON.stringify(s.summary)}`);
await pool.end();
