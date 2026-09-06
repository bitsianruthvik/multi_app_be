/**
 * fix-girder-bom.mjs — bring the Composite Girder BOM in line with the BOQ.
 *
 * FOUR THINGS THE TEMPLATE GOT WRONG, all found by reconciling it against the
 * customer's own Bill of Quantity rather than by reading the template:
 *
 *  1. NO END STIFFENER. The BOQ has ES1 on every end segment, 32 mm, 2995x200,
 *     four of them. The catalogue item was created when the KEPL order was
 *     reconciled; the BOM line was never added, so the next order would have
 *     lost it again.
 *
 *  2. THE STIFFENER QUANTITIES WERE ALL 1. The BOQ carries ~21 plain and ~3
 *     drilled intermediate stiffeners per segment. A template that says one of
 *     each understates a segment by about forty parts, and every order built
 *     from it needs the same manual repair.
 *
 *  3. NO STUDS. 14,424 shear studs across two spans — 7,212 a span, 10.96 t.
 *     They were added to the KEPL order by hand and would have been missed
 *     again.
 *
 *  4. THE GIRDER IS CALLED "G". The customer calls it L, so a mark reads L1 and
 *     its first segment L11 — girder number then segment number, no separator.
 *
 * END SEGMENTS AND MIDDLE SEGMENTS ARE DIFFERENT, and a BOM line cannot say so:
 * every segment gets the same children. The quantities here are the END segment
 * — the fuller case — so nothing is ever MISSING from a generated order. A
 * middle segment's extra stiffeners are then removed when the order is
 * reconciled against its BOQ, which is a deletion somebody can see rather than
 * an omission nobody can.
 *
 *   node scripts/fix-girder-bom.mjs           # report
 *   node scripts/fix-girder-bom.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
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
const COMPANY = 30005;

const [cat] = await pool.query(
  'SELECT id, name FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
const byName = new Map(cat.map((c) => [c.name, c]));
const [flows] = await pool.query(
  'SELECT id, name FROM fab_operation_flows WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
const flowByName = new Map(flows.map((f) => [f.name, f]));
const PLAIN = flowByName.get('Part Fabrication — Plain (no holes)');

const span = byName.get('Span');
const segment = byName.get('Segment');
const girder = byName.get('Girder');

/** Quantities as the BOQ states them for an END segment. */
const SEGMENT_QTY = {
  'Top Flange': 1,
  'Web Plate': 1,
  'Bottom Flange': 1,
  'Bearing Stiffener Plain': 1,
  'Bearing Stiffener Hole': 1,
  'End Stiffener': 4,
  'Intermediate Stiffener Plain': 21,
  'Intermediate Stiffener Hole': 3,
};

const [existing] = await pool.query(
  `SELECT b.id, b.child_item_id AS c, b.qty_num AS qtyNum, c.name
     FROM fab_item_bom b JOIN fab_item_catalog c ON c.id = b.child_item_id
    WHERE b.company_id = ? AND b.parent_item_id = ? AND b.deleted_at IS NULL AND b.active = 1`,
  [COMPANY, segment.id]);
const haveByName = new Map(existing.map((e) => [e.name, e]));

const plan = { add: [], requantify: [], other: [] };
for (const [name, qty] of Object.entries(SEGMENT_QTY)) {
  const have = haveByName.get(name);
  if (!have) plan.add.push({ name, qty });
  else if (Number(have.qtyNum) !== qty) plan.requantify.push({ name, from: Number(have.qtyNum), to: qty, id: have.id });
}
const stud = byName.get('Shear Stud 25 dia x 175 (headed)');
const [[hasStud]] = await pool.query(
  `SELECT id FROM fab_item_bom WHERE company_id=? AND parent_item_id=? AND child_item_id=? AND deleted_at IS NULL`,
  [COMPANY, span.id, stud?.id ?? 0]);
if (stud && !hasStud) plan.other.push('Span -> Shear Stud x7212 (buy)');
plan.other.push('Girder code segment "G" -> "L"');
plan.other.push('Segment code joins without a dash, so girder L1 segment 1 reads L11');

console.log('BOM lines to ADD under Segment:');
for (const a of plan.add) console.log(`  + ${a.name} x${a.qty}`);
console.log('\nquantities to CORRECT:');
for (const r of plan.requantify) console.log(`  ~ ${String(r.name).padEnd(32)} x${r.from} -> x${r.to}`);
console.log('\nother:');
for (const o of plan.other) console.log(`  · ${o}`);

if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); await pool.end(); process.exit(0); }

// 1. the missing part lines
for (const a of plan.add) {
  const child = byName.get(a.name);
  if (!child) { console.log(`  ! no catalogue item "${a.name}" — skipped`); continue; }
  await pool.query(
    `INSERT INTO fab_item_bom (company_id, parent_item_id, child_item_id, qty_num,
                               code_segment, default_flow_id, sort_order, active, created_at)
     VALUES (?,?,?,?,?,?,?,1,NOW())`,
    [COMPANY, segment.id, child.id, a.qty, 'ES', PLAIN?.id ?? null, 6]);
  console.log(`  added ${a.name} x${a.qty}`);
}

// 2. the quantities the BOQ actually states
for (const r of plan.requantify) {
  await pool.query('UPDATE fab_item_bom SET qty_num = ? WHERE id = ? AND company_id = ?', [r.to, r.id, COMPANY]);
  console.log(`  ${r.name}: x${r.from} -> x${r.to}`);
}

// 3. studs, bought whole and never fabricated
if (stud && !hasStud) {
  await pool.query(
    `INSERT INTO fab_item_bom (company_id, parent_item_id, child_item_id, qty_num,
                               code_segment, default_flow_id, sort_order, active, created_at)
     VALUES (?,?,?,?,?,NULL,?,1,NOW())`,
    [COMPANY, span.id, stud.id, 7212, 'STUDS', 40]);
  console.log('  added Span -> Shear Stud x7212');
}

// 4. the customer's own naming: girder L1, its first segment L11
await pool.query(
  `UPDATE fab_item_bom SET code_segment = 'L'
    WHERE company_id = ? AND parent_item_id = ? AND child_item_id = ? AND deleted_at IS NULL`,
  [COMPANY, span.id, girder.id]);
console.log('  girder code segment is now "L"');

await pool.query(
  `UPDATE fab_item_bom SET code_join = 'absorb'
    WHERE company_id = ? AND parent_item_id = ? AND child_item_id = ? AND deleted_at IS NULL`,
  [COMPANY, girder.id, segment.id]);
console.log('  segment code now joins without a dash — L1 + 1 reads L11');

await pool.end();
