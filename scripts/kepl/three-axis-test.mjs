/**
 * three-axis-test.mjs — will nesting put a part on the wrong steel?
 *
 * Usage: node scripts/kepl/three-axis-test.mjs <companyId>
 *
 * The case that motivated all of this: a stainless part must not be nested onto
 * mild steel plate. It cuts, it welds, and it fails inspection or corrodes in
 * service — and until `material` existed as data, nothing in the system could
 * have refused it.
 *
 * Also checks the half that is easy to get wrong in the other direction: an
 * ordinary MS part must still nest, and defaults set on the ORDER LINE must
 * reach every part without being restated.
 */

import { pool } from '../../db.js';
import { suggestNesting } from '../../apps/fab_erp/services/nestingSuggestService.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';
import { assignParts, nestingBoard } from '../../apps/fab_erp/services/nestingBoardService.js';

const companyId = Number(process.argv[2]);
if (!companyId) { console.error('Usage: node scripts/kepl/three-axis-test.mjs <companyId>'); process.exit(1); }

const stamp = Date.now().toString().slice(-6);
const log = (m) => console.log(m);
let fail = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};
const made = [];

/**
 * An order whose LINE states material+grade, with parts that may override.
 *
 * `parts[].noLink` leaves the part with NO material row, which is what every
 * part looks like once the pre-nesting assignment is gone — the board is then
 * the thing that picks the plate.
 */
async function build(lineDefaults, parts) {
  const conn = await pool.getConnection();
  const partIds = [];
  try {
    await conn.beginTransaction();
    const [[plant]] = await conn.query(
      'SELECT id FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId],
    );
    const [[mat]] = await conn.query(
      `SELECT ic.id, ic.name FROM fab_item_catalog ic
         JOIN fab_item_groups g ON g.id = ic.group_id AND g.name = 'Plates'
        WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.thickness_mm = 12 LIMIT 1`,
      [companyId],
    );
    if (!mat) throw new Error('need a 12 mm plate in the Plates group');

    const [o] = await conn.query(
      `INSERT INTO fab_orders (company_id, order_number, order_type, status, plant_id, notes,
         created_at, updated_at)
       VALUES (?,?, 'sales', 'draft', ?, 'throwaway: three-axis test', NOW(), NOW())`,
      [companyId, `SO-3AXIS${made.length}-${stamp}`, plant?.id ?? null],
    );
    const [line] = await conn.query(
      `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
         status, line_type, created_at, updated_at)
       VALUES (?,?,1,'L1','three-axis test',1,'nos','open','Composite Girder',NOW(),NOW())`,
      [companyId, o.insertId],
    );
    // The defaults live on the LINE and reach every part through the ladder.
    if (Object.keys(lineDefaults).length) {
      await setFields(companyId, 'order_line', line.insertId, lineDefaults, conn);
    }
    for (const p of parts) {
      const [item] = await conn.query(
        `INSERT INTO fab_items (company_id, order_id, order_line_id, name, unit, qty, level_kind,
           code, length, width, height, dim_unit, weight_unit)
         VALUES (?,?,?,?, 'nos', 1, 'part', ?, ?, ?, ?, 'mm','kg')`,
        [companyId, o.insertId, line.insertId, p.name, `SO-3AXIS${made.length}-${stamp}-${p.code}`,
          p.l, p.w, p.t],
      );
      await setFields(companyId, 'order_item', item.insertId,
        { length_mm: p.l, width_mm: p.w, thickness_mm: p.t, ...(p.overrides ?? {}) }, conn);
      partIds.push(item.insertId);
      if (p.noLink) continue;
      await conn.query(
        `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
           name, unit, qty, height, code, nest_no, level_kind, dim_unit, weight_unit)
         VALUES (?,?,?,?,?,?, 'nos', 1, ?, ?, NULL, 'material','mm','kg')`,
        [companyId, o.insertId, line.insertId, item.insertId, mat.id, mat.name, p.t,
          `SO-3AXIS${made.length}-${stamp}-${p.code}-M`],
      );
    }
    await conn.commit();
    made.push(o.insertId);
    return { orderId: o.insertId, partIds, plateId: mat.id, plateName: mat.name };
  } finally { conn.release(); }
}

try {
  // ── 1. an ordinary MS E350 part, defaults on the line only ───────────────
  const okOrder = await build(
    { material: 'MS', grade: 'E350 BO' },
    [{ code: 'P1', name: 'Plain plate', t: 12, l: 4000, w: 1000 }],
  );
  let s = await suggestNesting(companyId, okOrder.orderId, {});
  log(`MS E350 from the line: ${s.groups.length} nest(s), ${s.unplaced.length} unplaced`);
  check('a part inherits material+grade from its ORDER LINE and nests',
    s.groups.length === 1 && s.unplaced.length === 0,
    s.unplaced[0]?.reason ?? `${s.groups.length} nests`);
  check('the proposal reports all three axes',
    s.groups[0]?.material === 'MS' && s.groups[0]?.grade === 'E350 BO' && s.groups[0]?.thickness === 12,
    `${s.groups[0]?.material} / ${s.groups[0]?.grade} / ${s.groups[0]?.thickness}mm`);

  // ── 2. THE CASE THIS EXISTS FOR: a stainless part on a mild-steel yard ───
  const ssOrder = await build(
    { material: 'MS', grade: 'E350 BO' },
    [{ code: 'S1', name: 'Stainless insert', t: 12, l: 1000, w: 500,
      overrides: { material: 'SS304' } }],
  );
  s = await suggestNesting(companyId, ssOrder.orderId, {});
  const ssRefused = s.groups.length === 0 && s.unplaced.length === 1;
  log(`\nstainless part in an MS order: ${s.groups.length} nest(s), ${s.unplaced.length} unplaced`);
  if (s.unplaced[0]) log(`   reason: ${s.unplaced[0].reason}`);
  check('a stainless part is REFUSED, not nested onto mild steel', ssRefused,
    ssRefused ? '' : `it proposed ${s.groups[0]?.plate?.code}`);
  check('the refusal names the material it could not find',
    /SS304/.test(s.unplaced[0]?.reason ?? ''), s.unplaced[0]?.reason?.slice(0, 60) ?? '');

  // ── 3. a part overriding only the GRADE still narrows correctly ──────────
  const gradeOrder = await build(
    { material: 'MS', grade: 'E350 BO' },
    [{ code: 'G1', name: 'E250 plate', t: 12, l: 4000, w: 1000,
      overrides: { grade: 'E250 BO' } }],
    );
  s = await suggestNesting(companyId, gradeOrder.orderId, {});
  const chosen = s.groups[0];
  log(`\npart overriding grade to E250 BO: ${chosen?.plate?.code ?? 'none'} (${chosen?.grade})`);
  check('a per-part grade override is honoured, not the line default',
    chosen?.grade === 'E250 BO', String(chosen?.grade));

  /**
   * 4. Nothing stated on the line or the part — the LINKED MATERIAL is the
   *    fallback, and that is the designed behaviour, not a gap.
   *
   * This test first asserted a refusal here and was wrong about the code rather
   * than the other way round: while pre-nesting material assignment still
   * exists, a part is linked to a plate that itself states a material and a
   * grade, so the axes are never genuinely unknown. The fallback is what keeps
   * every order built before the order_line rung existed working.
   *
   * WHEN THE PRE-NESTING LINK IS REMOVED this case becomes a real refusal, and
   * this assertion is the one that will have to flip. Left here deliberately as
   * the marker for that change.
   */
  const blindOrder = await build({}, [{ code: 'X1', name: 'Unstated', t: 12, l: 4000, w: 1000 }]);
  s = await suggestNesting(companyId, blindOrder.orderId, {});
  log(`\nnothing on line or part: ${s.groups.length} nest(s), ${s.unplaced.length} unplaced`
    + `  -> fell back to the linked material (${s.groups[0]?.material} / ${s.groups[0]?.grade})`);
  check('with nothing stated, the LINKED material is the fallback',
    s.groups.length === 1 && s.unplaced.length === 0,
    s.unplaced[0]?.reason ?? '');
  check('and the fallback carries real axes, not nulls',
    s.groups[0]?.material != null && s.groups[0]?.grade != null,
    `${s.groups[0]?.material} / ${s.groups[0]?.grade}`);

  /**
   * ── 5. THE MANUAL BOARD, which is the half that was unenforced ───────────
   *
   * The suggestor refusing a stainless part is worth nothing if a drag-and-drop
   * still accepts it, and that was exactly the state until now: the board
   * checked only that a nest's members shared one material id, never whether
   * the part belonged on it. Same rule, same refusal, whichever way the part
   * gets there.
   */
  log('\n── the manual board ──');
  const board = await build(
    { material: 'MS', grade: 'E350 BO' },
    [
      { code: 'B1', name: 'MS part for board', t: 12, l: 3000, w: 900, noLink: true },
      { code: 'B2', name: 'Stainless part for board', t: 12, l: 1000, w: 500,
        noLink: true, overrides: { material: 'SS304' } },
      { code: 'B3', name: 'Thick part for board', t: 25, l: 1000, w: 500, noLink: true },
    ],
  );
  const [msPart, ssPart, thickPart] = board.partIds;

  // A part that agrees on all three axes goes on, and the link is MADE here —
  // nobody assigned material to it beforehand.
  let res = null; let threw = null;
  try {
    res = await assignParts(companyId, board.orderId, {
      partIds: [msPart], materialId: board.plateId, nestNo: 'N1',
    });
  } catch (e) { threw = e; }
  const nested = res?.nests?.find((n) => n.nestNo === 'N1');
  check('the board CREATES the material link when it puts a part on a plate',
    !threw && !!nested && nested.parts.length === 1,
    threw ? threw.message : `${nested?.parts.length ?? 0} part(s) on N1`);

  // The stainless one must be refused, by the board, with a reason.
  threw = null;
  try {
    await assignParts(companyId, board.orderId, {
      partIds: [ssPart], materialId: board.plateId, nestNo: 'N2',
    });
  } catch (e) { threw = e; }
  check('the board REFUSES a stainless part onto mild steel',
    threw?.status === 422, threw ? threw.message : 'it accepted it');
  check('and says which axis disagreed',
    /SS304/.test(threw?.message ?? ''), threw?.message?.slice(0, 90) ?? '');

  // Thickness too, through the same one comparison.
  threw = null;
  try {
    await assignParts(companyId, board.orderId, {
      partIds: [thickPart], materialId: board.plateId, nestNo: 'N3',
    });
  } catch (e) { threw = e; }
  check('the board REFUSES a 25 mm part onto 12 mm plate',
    threw?.status === 422, threw ? threw.message.slice(0, 80) : 'it accepted it');

  // And a part already linked cannot be dragged onto a nest it does not suit.
  // The link is made first with the matching plate, then the part is re-specified
  // to stainless — which is how a real order goes wrong: somebody corrects the
  // spec after nesting, and the next drag must not re-affirm the bad pairing.
  await setFields(companyId, 'order_item', msPart, { material: 'SS304' });
  threw = null;
  try {
    const b = await nestingBoard(companyId, board.orderId);
    const link = b.nests.flatMap((n) => n.parts).find((p) => p.partId === msPart)
      ?? b.unnested.find((p) => p.partId === msPart);
    await assignParts(companyId, board.orderId, {
      linkIds: [link.linkId], nestNo: 'N1',
    });
  } catch (e) { threw = e; }
  check('a re-specified part cannot be re-dropped onto the plate it no longer suits',
    threw?.status === 422, threw ? threw.message.slice(0, 80) : 'it accepted it');
} catch (err) {
  fail++;
  console.error(`\nERROR: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  for (const o of made) {
    await pool.query('UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, o]);
    await pool.query('UPDATE fab_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ?', [companyId, o]);
    await pool.query('UPDATE fab_orders SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [o, companyId]);
  }
  log(fail ? `\n${fail} CHECK(S) FAILED\n` : '\nall three-axis checks passed\n');
  await pool.end();
  process.exitCode = fail ? 1 : 0;
}
