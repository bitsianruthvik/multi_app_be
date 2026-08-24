/**
 * prenesting-removal-test.mjs — can an order be built without naming a plate?
 *
 * Usage: node scripts/kepl/prenesting-removal-test.mjs <companyId>
 *
 * The BOQ sheet used to carry a Raw Material column that pointed each part at a
 * specific catalogue item, so by the time the BOM finished importing every part
 * was already committed to a plate. That stopped being answerable when the
 * catalogue took on every SIZE — which sheet to buy depends on what else is cut
 * from it, and only nesting knows that.
 *
 * So the order of events changed, and this walks the new one:
 *
 *   1. the line states material + grade; parts state only what DIFFERS
 *   2. parts have NO material link — and the order still weighs correctly,
 *      because density comes from the spec rather than from a chosen plate
 *   3. readiness reports a missing SPEC, not a missing link
 *   4. nesting picks the plate, and the link appears then
 *
 * Step 2 is the one worth being suspicious of: get it wrong and a 668 t order
 * reports as weightless until somebody nests it, and every procurement quantity
 * and progress percentage downstream is computed off that zero.
 *
 * Everything it creates is soft-deleted at the end.
 */

import { pool } from '../../db.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';
import { recomputeOrderWeights } from '../../apps/fab_erp/services/itemWeightService.js';
import { checkOrderNesting, ISSUE, BLOCKING } from '../../apps/fab_erp/services/nestingIntegrityService.js';
import { suggestNesting, acceptSuggestion } from '../../apps/fab_erp/services/nestingSuggestService.js';

const companyId = Number(process.argv[2]);
if (!companyId) {
  console.error('Usage: node scripts/kepl/prenesting-removal-test.mjs <companyId>');
  process.exit(1);
}

const stamp = Date.now().toString().slice(-6);
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};
let orderId = null;

try {
  // ── 1. an order whose LINE states the steel, and parts that do not ────────
  const conn = await pool.getConnection();
  const parts = [];
  try {
    await conn.beginTransaction();
    const [[plant]] = await conn.query(
      'SELECT id FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
      [companyId],
    );
    const [o] = await conn.query(
      `INSERT INTO fab_orders (company_id, order_number, order_type, status, plant_id, notes,
         created_at, updated_at)
       VALUES (?,?, 'sales', 'draft', ?, 'throwaway: pre-nesting removal test', NOW(), NOW())`,
      [companyId, `SO-NOPRE-${stamp}`, plant?.id ?? null],
    );
    orderId = o.insertId;
    const [line] = await conn.query(
      `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
         status, line_type, created_at, updated_at)
       VALUES (?,?,1,'L1','no pre-nesting',1,'nos','open','Composite Girder',NOW(),NOW())`,
      [companyId, orderId],
    );
    // Stated ONCE, on the line. This is the whole point.
    await setFields(companyId, 'order_line', line.insertId,
      { material: 'MS', grade: 'E350 BO' }, conn);

    // A girder to hang parts under, so the tree has a real assembly in it and
    // the roll-up is exercised rather than a single flat row.
    const [gdr] = await conn.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, name, unit, qty, level_kind,
         code, flow_id, dim_unit, weight_unit)
       VALUES (?,?,?, 'Girder', 'nos', 1, 'girder', ?, NULL, 'mm','kg')`,
      [companyId, orderId, line.insertId, `SO-NOPRE-${stamp}-G1`],
    );
    const spec = [
      { code: 'TF', name: 'Top Flange', t: 20, l: 6000, w: 500 },
      { code: 'BF', name: 'Bottom Flange', t: 20, l: 6000, w: 500 },
      { code: 'WEB', name: 'Web Plate', t: 12, l: 6000, w: 1200 },
    ];
    for (const p of spec) {
      const [it] = await conn.query(
        `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, name, unit,
           qty, level_kind, code, length, width, height, flow_id, dim_unit, weight_unit)
         VALUES (?,?,?,?,?, 'nos', 1, 'part', ?, ?, ?, ?, 1, 'mm','kg')`,
        [companyId, orderId, line.insertId, gdr.insertId, p.name,
          `SO-NOPRE-${stamp}-G1-${p.code}`, p.l, p.w, p.t],
      );
      // Dimensions only. NOTHING says which plate — that is the change.
      await setFields(companyId, 'order_item', it.insertId,
        { length_mm: p.l, width_mm: p.w, thickness_mm: p.t }, conn);
      parts.push({ id: it.insertId, ...p });
    }
    await conn.commit();
  } finally { conn.release(); }

  const [[linkCount]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_items
      WHERE company_id = ? AND order_id = ? AND level_kind = 'material' AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  console.log('after the BOM is built:');
  check('no part is committed to a plate yet', Number(linkCount.n) === 0,
    `${linkCount.n} material row(s)`);

  // ── 2. it still weighs the right amount ──────────────────────────────────
  const w = await recomputeOrderWeights(companyId, orderId);
  // 7850 kg/m³ mild steel: two flanges at 20×500×6000 and one web at 12×1200×6000.
  const expected = ((20 * 500 * 6000) * 2 + (12 * 1200 * 6000)) / 1e9 * 7850;
  const got = w.totalWeight == null ? null : Number(w.totalWeight);
  check('the order weighs what the drawing says, with no plate chosen',
    got != null && Math.abs(got - expected) < 1,
    `${got == null ? 'null' : got.toFixed(1)} kg vs ${expected.toFixed(1)} expected`);
  check('and no leaf is left unweighed', w.unweighedLeaves === 0,
    `${w.unweighedLeaves} unweighed`);

  // ── 3. readiness asks for the SPEC, not for a link ───────────────────────
  let r = await checkOrderNesting(companyId, orderId);
  const noMat = r.issues.filter((i) => i.type === ISSUE.NO_MATERIAL);
  const blocking = r.issues.filter((i) => BLOCKING.has(i.type));
  console.log('\nreadiness before nesting:');
  check('a part with a spec but no plate is NOT reported as material-less',
    noMat.length === 0, noMat.length ? noMat[0].message : '');
  check('and nothing blocks the order for simply not being nested yet',
    blocking.length === 0,
    blocking.length ? `${blocking.length}: ${blocking[0].message.slice(0, 70)}` : '');

  // A part that states nothing IS still reported — the check has teeth.
  await pool.query('UPDATE fab_items SET height = NULL WHERE id = ?', [parts[2].id]);
  await setFields(companyId, 'order_item', parts[2].id, { thickness_mm: null });
  r = await checkOrderNesting(companyId, orderId);
  const nowMissing = r.issues.filter((i) => i.type === ISSUE.NO_MATERIAL);
  check('a part with NO thickness is reported', nowMissing.length === 1,
    nowMissing[0]?.message?.slice(0, 80) ?? 'nothing reported');
  await setFields(companyId, 'order_item', parts[2].id, { thickness_mm: 12 });
  await pool.query('UPDATE fab_items SET height = 12 WHERE id = ?', [parts[2].id]);

  // ── 4. nesting is what creates the link ──────────────────────────────────
  const s = await suggestNesting(companyId, orderId, {});
  console.log(`\nsuggestion: ${s.groups.length} nest(s), ${s.unplaced.length} unplaced`);
  check('the suggestor can propose plates from the spec alone',
    s.groups.length > 0, s.unplaced[0]?.reason ?? '');
  check('and every proposal is the material the LINE stated',
    s.groups.every((g) => g.material === 'MS' && g.grade === 'E350 BO'),
    s.groups.map((g) => `${g.material}/${g.grade}`).join(', '));

  if (s.groups.length) {
    await acceptSuggestion(companyId, orderId, s.groups);
    const [[after]] = await pool.query(
      `SELECT COUNT(*) AS n FROM fab_items
        WHERE company_id = ? AND order_id = ? AND level_kind = 'material' AND deleted_at IS NULL`,
      [companyId, orderId],
    );
    check('accepting the suggestion is what creates the material links',
      Number(after.n) === parts.length, `${after.n} link(s) for ${parts.length} parts`);

    const w2 = await recomputeOrderWeights(companyId, orderId);
    const got2 = w2.totalWeight == null ? null : Number(w2.totalWeight);
    check('and the weight does not move now that plates are known',
      got2 != null && Math.abs(got2 - expected) < 1,
      `${got2 == null ? 'null' : got2.toFixed(1)} kg`);
  }
} catch (err) {
  fail++;
  console.error(`\nERROR: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  if (orderId) {
    await pool.query('UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, orderId]);
    await pool.query('UPDATE fab_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, orderId]);
    await pool.query('UPDATE fab_orders SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [orderId, companyId]);
  }
  console.log(fail ? `\n${fail} CHECK(S) FAILED\n` : '\nthe order builds, weighs and nests with no pre-nesting assignment\n');
  await pool.end();
  process.exitCode = fail ? 1 : 0;
}
