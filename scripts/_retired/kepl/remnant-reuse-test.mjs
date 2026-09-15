/**
 * remnant-reuse-test.mjs — the loop that is the whole point.
 *
 * Usage: node scripts/kepl/remnant-reuse-test.mjs <companyId> [--keep]
 *
 * Cut a plate, keep the drop, then nest a SECOND order and check the drop is
 * what it gets offered — ahead of a fresh sheet, once only, and claimed when
 * accepted so nobody else is promised the same steel.
 */

import { pool } from '../../db.js';
import { recordNestDrops } from '../../apps/fab_erp/services/remnantService.js';
import { suggestNesting, acceptSuggestion } from '../../apps/fab_erp/services/nestingSuggestService.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';

const companyId = Number(process.argv[2]);
const keep = process.argv.includes('--keep');
if (!companyId) { console.error('Usage: node scripts/kepl/remnant-reuse-test.mjs <companyId> [--keep]'); process.exit(1); }

const stamp = Date.now().toString().slice(-6);
const log = (m) => console.log(m);
let fail = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const made = { orders: [], pieces: [] };

async function buildOrder(conn, suffix, parts, materialId, plant, area, plate) {
  const number = `SO-REUSE${suffix}-${stamp}`;
  const [ord] = await conn.query(
    `INSERT INTO fab_orders (company_id, order_number, order_type, status, plant_id, notes,
       created_at, updated_at)
     VALUES (?,?, 'sales', 'draft', ?, 'throwaway: offcut reuse test', NOW(), NOW())`,
    [companyId, number, plant.id],
  );
  const [line] = await conn.query(
    `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
       status, created_at, updated_at)
     VALUES (?,?,1,'T1','reuse test',1,'nos','open',NOW(),NOW())`,
    [companyId, ord.insertId],
  );
  for (const p of parts) {
    const [part] = await conn.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, name, unit, qty, level_kind,
         code, length, width, height, dim_unit, weight_unit)
       VALUES (?,?,?,?, 'nos', ?, 'part', ?, ?, ?, ?, 'mm','kg')`,
      [companyId, ord.insertId, line.insertId, p.name, p.qty, `${number}-${p.code}`, p.l, p.w, p.t],
    );
    await setFields(companyId, 'order_item', part.insertId,
      { length_mm: p.l, width_mm: p.w, thickness_mm: p.t }, conn);
    await conn.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
         name, unit, qty, length, width, height, code, nest_no, level_kind, dim_unit, weight_unit)
       VALUES (?,?,?,?,?, 'plate', 'nos', 1, ?, ?, ?, ?, ?, 'material','mm','kg')`,
      [companyId, ord.insertId, line.insertId, part.insertId, materialId,
        plate ? plate.length : null, plate ? plate.width : null, p.t,
        `${number}-${p.code}-M`, plate ? 'N-001' : null],
    );
  }
  made.orders.push(ord.insertId);
  return { orderId: ord.insertId, number };
}

let materialId = null;
try {
  const conn = await pool.getConnection();
  let first; let plateId; let plant; let area;
  const PLATE = { length: 12000, width: 2300 };
  try {
    await conn.beginTransaction();
    const [[mat]] = await conn.query(
      `SELECT ic.id FROM fab_item_catalog ic
         JOIN fab_item_groups g ON g.id = ic.group_id AND g.name = 'Plates'
        WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.thickness_mm = 12 LIMIT 1`,
      [companyId],
    );
    if (!mat) throw new Error('Need a 12 mm plate in the Plates group');
    materialId = mat.id;
    [[plant]] = await conn.query(
      'SELECT id FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId],
    );
    [[area]] = await conn.query(
      `SELECT id FROM fab_stock_locations WHERE company_id = ? AND plant_id = ? AND deleted_at IS NULL
         AND code NOT LIKE 'WIP-%' AND code NOT LIKE 'MACH-%' ORDER BY id LIMIT 1`,
      [companyId, plant.id],
    );

    // Order A: one strip off a full plate, already nested.
    first = await buildOrder(conn, 'A', [
      { code: 'S1', name: 'Strip', t: 12, l: 12000, w: 500, qty: 2 },
    ], materialId, plant, area, PLATE);

    const [pc] = await conn.query(
      `INSERT INTO fab_stock_pieces (company_id, catalog_item_id, plant_id, stock_location_id,
         qty, uom, status, length_mm, width_mm, heat_no, received_date)
       VALUES (?,?,?,?,1,'nos','in_stock',?,?, 'HEAT-REUSE', UTC_DATE())`,
      [companyId, materialId, plant.id, area.id, PLATE.length, PLATE.width],
    );
    plateId = pc.insertId;
    made.pieces.push(plateId);
    await conn.commit();
  } finally { conn.release(); }

  // ── cut order A's plate; the drop becomes stock ──────────────────────────
  const c2 = await pool.getConnection();
  try {
    await c2.beginTransaction();
    const [[plate]] = await c2.query('SELECT * FROM fab_stock_pieces WHERE id = ?', [plateId]);
    const r = await recordNestDrops(c2, companyId, {
      orderId: first.orderId, catalogItemId: materialId, nestNo: 'N-001',
      sourcePiece: plate, plantId: plate.plant_id, stockLocationId: plate.stock_location_id,
    });
    await c2.commit();
    log(`\norder A cut: ${r.created} drop(s) booked`);
    check('cutting order A left a drop', r.created === 1, `${r.created}`);
  } finally { c2.release(); }

  const [[drop]] = await pool.query(
    `SELECT id, code, length_mm, width_mm FROM fab_stock_pieces
      WHERE company_id = ? AND origin_piece_id = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, plateId],
  );
  made.pieces.push(drop.id);
  log(`   drop ${drop.code}: ${Number(drop.length_mm)} x ${Number(drop.width_mm)} mm`);

  // ── order B: a part that fits the drop comfortably ───────────────────────
  const conn3 = await pool.getConnection();
  let second;
  try {
    await conn3.beginTransaction();
    second = await buildOrder(conn3, 'B', [
      { code: 'P1', name: 'Small panel', t: 12, l: 4000, w: 1000, qty: 1 },
    ], materialId, plant, area, null);
    await conn3.commit();
  } finally { conn3.release(); }

  const s = await suggestNesting(companyId, second.orderId, {});
  log(`\norder B suggestion: ${s.groups.length} nest(s)`);
  for (const g of s.groups) {
    log(`   ${g.plate.code}  ${g.plate.width}x${g.plate.length}  ${g.utilisationPct}%  `
      + `${g.plate.isOffcut ? 'OFFCUT' : 'new plate'}`);
  }
  check('it proposed exactly one plate', s.groups.length === 1, `${s.groups.length}`);
  check('it chose the OFFCUT over buying a new sheet', s.groups[0]?.plate.isOffcut === true,
    s.groups[0]?.plate.code ?? 'none');
  check('the offcut names the physical piece', s.groups[0]?.plate.pieceId === drop.id,
    String(s.groups[0]?.plate.pieceId));
  check('the link will still point at the material, not a negative id',
    s.groups[0]?.plate.id === materialId, String(s.groups[0]?.plate.id));

  // ── accept, which must claim the piece ───────────────────────────────────
  const res = await acceptSuggestion(companyId, second.orderId, s.groups);
  log(`\naccepted: ${res.nestsCreated} nest(s), ${res.offcutsClaimed} offcut(s) claimed`);
  check('accepting claimed the offcut', res.offcutsClaimed === 1, `${res.offcutsClaimed}`);

  const [[held]] = await pool.query(
    `SELECT COUNT(*) n FROM fab_stock_reservations
      WHERE company_id = ? AND stock_piece_id = ? AND status = 'active' AND deleted_at IS NULL`,
    [companyId, drop.id],
  );
  check('a reservation exists against that exact piece', Number(held.n) === 1, `${held.n}`);

  // ── and the same drop must not be offered to a third order ───────────────
  const conn4 = await pool.getConnection();
  let third;
  try {
    await conn4.beginTransaction();
    third = await buildOrder(conn4, 'C', [
      { code: 'P2', name: 'Another panel', t: 12, l: 4000, w: 1000, qty: 1 },
    ], materialId, plant, area, null);
    await conn4.commit();
  } finally { conn4.release(); }

  const s3 = await suggestNesting(companyId, third.orderId, {});
  log(`\norder C suggestion: ${s3.groups.map((g) => `${g.plate.code}${g.plate.isOffcut ? ' (OFFCUT)' : ''}`).join(', ')}`);
  check('the claimed drop is NOT offered a second time',
    !s3.groups.some((g) => g.plate.pieceId === drop.id),
    s3.groups[0]?.plate.code ?? 'none');
  check('order C is offered a real plate instead', s3.groups.length === 1 && !s3.groups[0].plate.isOffcut,
    s3.groups[0]?.plate.code ?? 'none');
} catch (err) {
  fail++;
  console.error(`\nERROR: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  if (!keep) {
    for (const o of made.orders) {
      await pool.query('UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, o]);
      await pool.query('UPDATE fab_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, o]);
      await pool.query('UPDATE fab_stock_reservations SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, o]);
      await pool.query('UPDATE fab_orders SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [o, companyId]);
    }
    if (made.pieces.length) {
      await pool.query('UPDATE fab_stock_pieces SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)',
        [companyId, made.pieces]);
    }
    log('\ncleaned up');
  }
  log(fail ? `\n${fail} CHECK(S) FAILED\n` : '\nthe reuse loop works end to end\n');
  await pool.end();
  process.exitCode = fail ? 1 : 0;
}
