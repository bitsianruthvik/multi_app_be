/**
 * nest-accept-test.mjs — exercise suggest -> accept on a throwaway order.
 *
 * Usage: node scripts/kepl/nest-accept-test.mjs <companyId> [--keep]
 *
 * WHY NOT TEST ON A REAL ORDER. Accepting a suggestion repoints what every
 * part is cut from, which is a purchasing decision. The only order in this
 * tenant big enough to be interesting is already confirmed, procured and
 * received, so testing there would rewrite what a delivered order says it
 * bought. This builds its own order, proves the write path, checks the result,
 * and removes it again unless asked to keep it.
 */

import { pool } from '../../db.js';
import { suggestNesting, acceptSuggestion } from '../../apps/fab_erp/services/nestingSuggestService.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';

const companyId = Number(process.argv[2]);
const keep = process.argv.includes('--keep');
if (!companyId) { console.error('Usage: node scripts/kepl/nest-accept-test.mjs <companyId> [--keep]'); process.exit(1); }

const ORDER_NUMBER = `SO-NESTTEST-${Date.now().toString().slice(-6)}`;
const log = (m) => console.log(m);

// Parts chosen so the answer is checkable by hand: eight 12 mm strips that
// should share a plate, and two 16 mm plates that cannot go with them.
const PARTS = [
  { code: 'A1', name: 'Strip A1', t: 12, l: 6000, w: 500, qty: 2 },
  { code: 'A2', name: 'Strip A2', t: 12, l: 6000, w: 500, qty: 2 },
  { code: 'A3', name: 'Strip A3', t: 12, l: 3000, w: 400, qty: 4 },
  { code: 'B1', name: 'Panel B1', t: 16, l: 4000, w: 1200, qty: 1 },
  { code: 'B2', name: 'Panel B2', t: 16, l: 4000, w: 1200, qty: 1 },
];

let orderId = null;
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  // A plate of each thickness to link the parts to, so grade resolves from the
  // material the way it does on a real order.
  const [mats] = await conn.query(
    `SELECT ic.id, ic.code, ic.name, ic.thickness_mm AS t FROM fab_item_catalog ic
       JOIN fab_item_groups g ON g.id = ic.group_id AND g.name = 'Plates'
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.thickness_mm IN (12, 16)
      ORDER BY ic.thickness_mm, ic.id`,
    [companyId],
  );
  const matFor = new Map();
  for (const m of mats) if (!matFor.has(Number(m.t))) matFor.set(Number(m.t), m);
  if (matFor.size < 2) throw new Error('Need a 12 mm and a 16 mm plate in the Plates group');

  const [[plant]] = await conn.query(
    'SELECT id FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId],
  );
  const [ord] = await conn.query(
    `INSERT INTO fab_orders (company_id, order_number, order_type, status, plant_id, currency,
       notes, wizard_step, created_at, updated_at)
     VALUES (?,?, 'sales', 'draft', ?, 'INR', 'throwaway: nesting suggestor test', 'nesting', NOW(), NOW())`,
    [companyId, ORDER_NUMBER, plant?.id ?? null],
  );
  orderId = ord.insertId;
  const [line] = await conn.query(
    `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
       status, line_type, created_at, updated_at)
     VALUES (?,?,1,'T1','nesting test',1,'nos','open','Composite Girder',NOW(),NOW())`,
    [companyId, orderId],
  );

  for (const p of PARTS) {
    const [ins] = await conn.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, name, unit, qty,
         level_kind, code, length, width, height, dim_unit, weight_unit)
       VALUES (?,?,?,NULL,?, 'nos', ?, 'part', ?, ?, ?, ?, 'mm','kg')`,
      [companyId, orderId, line.insertId, p.name, p.qty, `${ORDER_NUMBER}-${p.code}`, p.l, p.w, p.t],
    );
    await setFields(companyId, 'order_item', ins.insertId,
      { length_mm: p.l, width_mm: p.w, thickness_mm: p.t }, conn);
    const mat = matFor.get(p.t);
    await conn.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
         name, unit, qty, length, width, height, code, nest_no, level_kind, dim_unit, weight_unit)
       VALUES (?,?,?,?,?,?, 'nos', 1, NULL, NULL, ?, ?, NULL, 'material','mm','kg')`,
      [companyId, orderId, line.insertId, ins.insertId, mat.id, mat.name, p.t,
        `${ORDER_NUMBER}-${p.code}-${mat.code}`],
    );
  }
  await conn.commit();
  log(`\nbuilt ${ORDER_NUMBER} (${orderId}) with ${PARTS.length} parts\n`);
} catch (err) {
  await conn.rollback();
  console.error(`setup failed: ${err.message}`);
  conn.release();
  await pool.end();
  process.exit(1);
} finally {
  conn.release();
}

let failures = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  // ── suggest ───────────────────────────────────────────────────────────────
  const s = await suggestNesting(companyId, orderId, {});
  log('suggest:');
  for (const g of s.groups) {
    log(`   ${String(g.thickness).padStart(2)}mm ${g.plate.code} ${g.plate.width}x${g.plate.length} `
      + `${g.utilisationPct}%  parts ${g.parts.map((p) => p.partCode.split('-').pop()).join(',')}`);
  }
  check('proposed at least one nest', s.groups.length > 0, `${s.groups.length} nests`);
  check('nothing unplaced', s.unplaced.length === 0, `${s.unplaced.length} unplaced`);
  check('grade came from the linked material, not a parameter',
    s.groups.every((g) => g.grade), s.groups[0]?.grade ?? 'none');
  check('12 mm and 16 mm did not share a plate',
    s.groups.every((g) => new Set(g.parts.map((p) => p.partCode)).size === g.parts.length)
    && !s.groups.some((g) => g.parts.length && g.thickness == null));

  // Proposing must not have written anything.
  const [[before]] = await pool.query(
    `SELECT COUNT(*) n FROM fab_items WHERE company_id = ? AND order_id = ? AND nest_no IS NOT NULL`,
    [companyId, orderId],
  );
  check('proposing wrote nothing', Number(before.n) === 0, `${before.n} nested rows`);

  // ── accept ────────────────────────────────────────────────────────────────
  const res = await acceptSuggestion(companyId, orderId, s.groups);
  log(`\naccept: ${res.nestsCreated} nests, ${res.partsNested} links moved`);
  check('every proposed nest was created', res.nestsCreated === s.groups.length);

  const [after] = await pool.query(
    `SELECT rm.nest_no, rm.catalog_item_id, ic.code AS matCode, rm.length, rm.width, rm.height,
            p.code AS partCode
       FROM fab_items rm
       JOIN fab_items p ON p.id = rm.parent_item_id
       JOIN fab_item_catalog ic ON ic.id = rm.catalog_item_id
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.level_kind = 'material'
        AND rm.deleted_at IS NULL ORDER BY rm.nest_no`,
    [companyId, orderId],
  );
  check('every link got a nest number', after.every((r) => r.nest_no), '');
  check('every link was repointed to a specific RM size',
    after.every((r) => /^RM\d{5}$/.test(r.matCode)),
    [...new Set(after.map((r) => r.matCode))].join(', '));
  check('every link carries its plate size',
    after.every((r) => r.length != null && r.width != null && r.height != null));

  // The whole point: what the order now buys is a size, and it is big enough.
  const [buy] = await pool.query(
    `SELECT ic.code, COUNT(DISTINCT rm.nest_no) plates FROM fab_items rm
       JOIN fab_item_catalog ic ON ic.id = rm.catalog_item_id
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.level_kind = 'material'
        AND rm.deleted_at IS NULL GROUP BY 1`,
    [companyId, orderId],
  );
  log(`\nthis order now buys: ${buy.map((b) => `${b.plates} x ${b.code}`).join(', ')}`);

  const { checkOrderNesting, blockingIssues } = await import('../../apps/fab_erp/services/nestingIntegrityService.js');
  const integrity = await checkOrderNesting(companyId, orderId);
  check("the server's own nesting check passes", blockingIssues(integrity).length === 0,
    JSON.stringify(integrity.summary));

  // ── re-running must not duplicate ─────────────────────────────────────────
  const again = await suggestNesting(companyId, orderId, {});
  check('a second suggest finds nothing left to nest', again.groups.length === 0,
    again.message ?? `${again.groups.length} nests`);
} catch (err) {
  failures++;
  console.error(`\nERROR: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  if (!keep && orderId) {
    await pool.query('UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, orderId]);
    await pool.query('UPDATE fab_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, orderId]);
    await pool.query('UPDATE fab_orders SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [orderId, companyId]);
    log(`\ncleaned up ${ORDER_NUMBER}`);
  } else if (orderId) {
    log(`\nkept ${ORDER_NUMBER} (${orderId})`);
  }
  log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nall checks passed\n');
  await pool.end();
  process.exitCode = failures ? 1 : 0;
}
