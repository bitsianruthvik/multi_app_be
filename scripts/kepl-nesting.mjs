/**
 * kepl-nesting.mjs — nest the KEPL order onto plates.
 *
 * Drives the SUGGESTOR rather than assigning plates by hand: it groups parts by
 * the three things that decide what they may legally be cut from — thickness,
 * grade and material — and packs each group onto sizes drawn from the catalogue,
 * preferring offcuts already paid for. Choosing the plate SIZE is most of the
 * win; the same parts on a badly chosen sheet leave a third of it as scrap.
 *
 * GRADE AND MATERIAL ARE SET ON THE ORDER LINE, not on each part. `order_line`
 * is a rung of the field ladder that an order item inherits from, so two writes
 * cover all thousand-odd parts. The BOQ states neither — every row is plain
 * structural plate — so this is a stated assumption, not something read off the
 * sheet, and it is printed as one.
 *
 * SUGGEST WRITES NOTHING. Only `--apply` accepts, and accepting is what creates
 * the material links and the nest numbers.
 *
 *   node scripts/kepl-nesting.mjs             # suggest and report
 *   node scripts/kepl-nesting.mjs --apply     # suggest, then accept every nest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');

/**
 * These have to match the catalogue's own strings EXACTLY — the suggestor groups
 * on (thickness, grade, material) and a near-miss places nothing at all rather
 * than placing something approximate, which is the correct behaviour and a
 * confusing symptom.
 *
 * The 180 catalogue plates carry material "MS" and grade "E350 BO" (115 of
 * them), "E250 BO" or "E350 BR". Not "MS Plate" / "E350", which is what a
 * person reading the plate NAMES would write down.
 */
const GRADE = 'E350 BO';
const MATERIAL = 'MS';

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
const { setFields } = await import('../apps/fab_erp/services/fieldService.js');
const { suggestNesting, acceptSuggestion } = await import('../apps/fab_erp/services/nestingSuggestService.js');
const { recomputeOrderWeights } = await import('../apps/fab_erp/services/itemWeightService.js');

const COMPANY = 30005;
const [[order]] = await pool.query(
  `SELECT id, order_number FROM fab_orders WHERE company_id=? AND deleted_at IS NULL
     AND order_type='sales' ORDER BY id DESC LIMIT 1`, [COMPANY]);
console.log(`order ${order.order_number} (#${order.id})`);
console.log(`assumed for every part: material "${MATERIAL}", grade "${GRADE}" — the BOQ states neither\n`);

if (APPLY) {
  const [lines] = await pool.query(
    'SELECT id, code FROM fab_order_lines WHERE company_id=? AND order_id=? AND deleted_at IS NULL',
    [COMPANY, order.id]);
  for (const l of lines) {
    const { rejected } = await setFields(COMPANY, 'order_line', l.id, { grade: GRADE, material: MATERIAL });
    if (rejected.length) console.log(`  line ${l.code}: rejected ${rejected.map((r) => `${r.fieldKey} (${r.why})`).join(', ')}`);
    else console.log(`  line ${l.code}: grade + material set`);
  }
}

const s = await suggestNesting(COMPANY, order.id, { grade: GRADE, material: MATERIAL });
if (s.message) { console.log(`\nsuggestor: ${s.message}`); await pool.end(); process.exit(1); }

/*
 * `groups` is already the flat list of NESTS — one entry per plate, each with
 * its own thickness/grade/material and the parts laid on it. `ok` is only
 * `unplaced.length === 0`, so a false there is a report about a few parts, not
 * a refusal to suggest anything.
 */
const nests = s.groups;
console.log(`\nnests proposed: ${nests.length} · unplaced: ${s.unplaced?.length ?? 0} · skipped: ${s.skipped?.length ?? 0} · every part placed: ${s.ok}`);

const byThickness = new Map();
for (const n of nests) {
  const k = n.thickness;
  if (!byThickness.has(k)) byThickness.set(k, { plates: 0, parts: 0, used: 0, waste: 0 });
  const b = byThickness.get(k);
  b.plates += 1; b.parts += n.pieces ?? n.parts.length;
  b.used += n.usedAreaMm2 ?? 0; b.waste += n.wasteAreaMm2 ?? 0;
}
console.log('\nby thickness:');
for (const [t, b] of [...byThickness].sort((a, c) => a[0] - c[0])) {
  const util = b.used + b.waste ? (b.used / (b.used + b.waste)) * 100 : 0;
  console.log(`  ${String(t).padStart(3)}mm  ${String(b.plates).padStart(3)} plates  ${String(b.parts).padStart(4)} pieces  ${util.toFixed(1)}% used`);
}
if (s.summary) console.log(`\nsummary: ${JSON.stringify(s.summary)}`);
if (s.unplaced?.length) {
  console.log('\nunplaced (no catalogue plate big enough):');
  for (const u of s.unplaced.slice(0, 10)) console.log('  ', JSON.stringify(u).slice(0, 140));
}
if (s.skipped?.length) {
  console.log('\nskipped:');
  for (const k of s.skipped.slice(0, 10)) console.log('  ', JSON.stringify(k).slice(0, 140));
}

if (!APPLY) { console.log('\nDRY RUN — pass --apply to accept these nests.'); await pool.end(); process.exit(0); }

const res = await acceptSuggestion(COMPANY, order.id, nests);
console.log(`\naccepted: ${JSON.stringify(res)}`);

await recomputeOrderWeights(COMPANY, order.id);
const [[after]] = await pool.query(
  `SELECT COUNT(*) links, COUNT(DISTINCT nest_no) nests FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND node_kind='material'`,
  [COMPANY, order.id]);
console.log(`material links: ${after.links} across ${after.nests} nests`);
await pool.end();
