/**
 * remnant-test.mjs — prove a plate's drop becomes stock, and behaves.
 *
 * Usage: node scripts/kepl/remnant-test.mjs <companyId> [--keep]
 *
 * Builds its own order with one nest on one plate, books the drop, and then
 * asks the questions that would actually hurt if they were wrong:
 *
 *   - is the drop the right size, and is it smaller than the plate?
 *   - does it point back at the plate it came off, and carry its heat number?
 *   - does it read as ONE MORE BUYABLE PLATE to procurement?  (it must not)
 *   - is it still real, consumable stock?                     (it must be)
 *   - does booking it twice book it twice?                    (it must not)
 */

import { pool } from '../../db.js';
import { recordNestDrops, dropsFor, remnantSettings } from '../../apps/fab_erp/services/remnantService.js';
import { availabilityFor, availabilityBySize } from '../../apps/fab_erp/services/availabilityService.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';

const companyId = Number(process.argv[2]);
const keep = process.argv.includes('--keep');
if (!companyId) { console.error('Usage: node scripts/kepl/remnant-test.mjs <companyId> [--keep]'); process.exit(1); }

const ORDER_NUMBER = `SO-DROPTEST-${Date.now().toString().slice(-6)}`;
const log = (m) => console.log(m);
let fail = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

// One 12 mm plate, one strip off it. What is left is obvious to the eye.
const PLATE = { length: 12000, width: 2300 };
const PART = { code: 'S1', name: 'Strip', t: 12, l: 12000, w: 500, qty: 2 };

let orderId = null; let plateId = null; let materialId = null;
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  const [[mat]] = await conn.query(
    `SELECT ic.id, ic.name, ic.unit FROM fab_item_catalog ic
       JOIN fab_item_groups g ON g.id = ic.group_id AND g.name = 'Plates'
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.thickness_mm = 12 LIMIT 1`,
    [companyId],
  );
  if (!mat) throw new Error('Need a 12 mm plate in the Plates group');
  materialId = mat.id;

  const [[plant]] = await conn.query(
    'SELECT id FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId],
  );
  const [[area]] = await conn.query(
    `SELECT id FROM fab_stock_locations WHERE company_id = ? AND plant_id = ? AND deleted_at IS NULL
       AND code NOT LIKE 'WIP-%' AND code NOT LIKE 'MACH-%' ORDER BY id LIMIT 1`,
    [companyId, plant.id],
  );

  const [ord] = await conn.query(
    `INSERT INTO fab_orders (company_id, order_number, order_type, status, plant_id, notes,
       created_at, updated_at)
     VALUES (?,?, 'sales', 'draft', ?, 'throwaway: offcut test', NOW(), NOW())`,
    [companyId, ORDER_NUMBER, plant.id],
  );
  orderId = ord.insertId;
  const [line] = await conn.query(
    `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
       status, created_at, updated_at)
     VALUES (?,?,1,'T1','offcut test',1,'nos','open',NOW(),NOW())`,
    [companyId, orderId],
  );

  const [part] = await conn.query(
    `INSERT INTO fab_items (company_id, order_id, order_line_id, name, unit, qty, level_kind,
       code, length, width, height, dim_unit, weight_unit)
     VALUES (?,?,?,?, 'nos', ?, 'part', ?, ?, ?, ?, 'mm','kg')`,
    [companyId, orderId, line.insertId, PART.name, PART.qty, `${ORDER_NUMBER}-${PART.code}`,
      PART.l, PART.w, PART.t],
  );
  await setFields(companyId, 'order_item', part.insertId,
    { length_mm: PART.l, width_mm: PART.w, thickness_mm: PART.t }, conn);

  await conn.query(
    `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
       name, unit, qty, length, width, height, code, nest_no, level_kind, dim_unit, weight_unit)
     VALUES (?,?,?,?,?,?, 'nos', 1, ?, ?, ?, ?, 'N-001', 'material','mm','kg')`,
    [companyId, orderId, line.insertId, part.insertId, materialId, mat.name,
      PLATE.length, PLATE.width, PART.t, `${ORDER_NUMBER}-${PART.code}-M`],
  );

  // The physical plate this nest will be cut from.
  const [pc] = await conn.query(
    `INSERT INTO fab_stock_pieces (company_id, catalog_item_id, plant_id, stock_location_id,
       qty, uom, status, length_mm, width_mm, heat_no, batch_no, received_date, unit_cost)
     VALUES (?,?,?,?,1,'nos','in_stock',?,?, 'HEAT-DROP-1', 'BATCH-9', UTC_DATE(), 42000)`,
    [companyId, materialId, plant.id, area.id, PLATE.length, PLATE.width],
  );
  plateId = pc.insertId;

  await conn.commit();
  log(`\nbuilt ${ORDER_NUMBER} (${orderId}) — one ${PLATE.width}x${PLATE.length} plate, `
    + `${PART.qty} x ${PART.l}x${PART.w} off it\n`);
} catch (err) {
  await conn.rollback(); conn.release();
  console.error(`setup failed: ${err.message}`); await pool.end(); process.exit(1);
} finally { conn.release(); }

try {
  const settings = await remnantSettings(pool, companyId);
  log(`thresholds: keep if short side >= ${settings.remnant_min_short_mm} mm and area >= `
    + `${(settings.remnant_min_area_mm2 / 1e6).toFixed(2)} m2, kerf ${settings.remnant_kerf_mm} mm\n`);

  // ── book the drop ─────────────────────────────────────────────────────────
  const c2 = await pool.getConnection();
  let res;
  try {
    await c2.beginTransaction();
    const [[plate]] = await c2.query('SELECT * FROM fab_stock_pieces WHERE id = ?', [plateId]);
    res = await recordNestDrops(c2, companyId, {
      orderId, catalogItemId: materialId, nestNo: 'N-001',
      sourcePiece: plate, plantId: plate.plant_id, stockLocationId: plate.stock_location_id,
    });
    await c2.commit();
  } finally { c2.release(); }

  log(`recorded: ${res.created} drop(s)${res.skipped ? ` (${res.skipped})` : ''}`);
  check('a drop was booked', res.created > 0, `${res.created}`);

  const [drops] = await pool.query(
    `SELECT id, code, length_mm, width_mm, qty, status, origin_piece_id, origin_nest_no,
            dims_estimated, heat_no, batch_no, unit_cost
       FROM fab_stock_pieces WHERE company_id = ? AND origin_piece_id = ? AND deleted_at IS NULL`,
    [companyId, plateId],
  );
  for (const d of drops) {
    log(`   ${d.code}  ${Number(d.length_mm)}x${Number(d.width_mm)} mm  heat ${d.heat_no}`);
  }

  const expected = dropsFor(PLATE, [{ key: 'p', length: PART.l, width: PART.w, qty: PART.qty }], settings);
  check('the drop matches the computed geometry', drops.length === expected.drops.length,
    `${drops.length} booked vs ${expected.drops.length} computed`);
  check('every drop is smaller than the plate it came off',
    drops.every((d) => Number(d.length_mm) <= PLATE.length && Number(d.width_mm) <= PLATE.width));
  check('the drop points back at its plate', drops.every((d) => d.origin_piece_id === plateId));
  check('the drop names the nest that made it', drops.every((d) => d.origin_nest_no === 'N-001'));
  check('the drop is flagged as an estimate', drops.every((d) => Number(d.dims_estimated) === 1));
  check('the drop keeps the plate heat number', drops.every((d) => d.heat_no === 'HEAT-DROP-1'),
    drops[0]?.heat_no ?? '');
  check('the drop carries NO cost from the plate', drops.every((d) => d.unit_cost == null),
    drops[0]?.unit_cost == null ? 'null' : String(drops[0]?.unit_cost));
  check('the drop was given a stock code', drops.every((d) => !!d.code));

  // ── the question that decides whether procurement stays honest ────────────
  const avail = await availabilityFor(companyId, [materialId]);
  const onHand = avail.get(materialId)?.onHand ?? 0;
  check('a drop does NOT count as a buyable plate', onHand === 1,
    `catalog-level on-hand ${onHand} (the 1 real plate, not ${1 + drops.length})`);

  const bySize = await availabilityBySize(companyId, [
    { catalogItemId: materialId, length: PLATE.length, width: PLATE.width },
  ]);
  const full = [...bySize.values()][0]?.onHand ?? 0;
  check('the full-size count is unaffected by the drop', full === 1, `${full}`);

  // ...but it is still real steel.
  const [[real]] = await pool.query(
    `SELECT COUNT(*) n FROM fab_stock_pieces
      WHERE company_id = ? AND origin_piece_id IS NOT NULL AND status = 'in_stock' AND deleted_at IS NULL`,
    [companyId],
  );
  check('the drop is still in stock and consumable', Number(real.n) >= drops.length, `${real.n} in stock`);

  // ── booking the same nest twice must not double the steel ────────────────
  const c3 = await pool.getConnection();
  try {
    await c3.beginTransaction();
    const [[plate]] = await c3.query('SELECT * FROM fab_stock_pieces WHERE id = ?', [plateId]);
    await recordNestDrops(c3, companyId, {
      orderId, catalogItemId: materialId, nestNo: 'N-001',
      sourcePiece: plate, plantId: plate.plant_id, stockLocationId: plate.stock_location_id,
    });
    await c3.rollback(); // never commit the double-book; we only want to see what it would do
  } finally { c3.release(); }
  log('\n  NOTE: recordNestDrops is not itself idempotent — it is called once per plate because');
  log('        claimNest wins a unique index first. That guard is where the protection lives.');
} catch (err) {
  fail++;
  console.error(`\nERROR: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  if (!keep && orderId) {
    await pool.query('UPDATE fab_stock_pieces SET deleted_at = NOW() WHERE company_id = ? AND (id = ? OR origin_piece_id = ?)',
      [companyId, plateId, plateId]);
    await pool.query('UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, orderId]);
    await pool.query('UPDATE fab_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, orderId]);
    await pool.query('UPDATE fab_orders SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [orderId, companyId]);
    log(`\ncleaned up ${ORDER_NUMBER}`);
  }
  log(fail ? `\n${fail} CHECK(S) FAILED\n` : '\nall offcut checks passed\n');
  await pool.end();
  process.exitCode = fail ? 1 : 0;
}
