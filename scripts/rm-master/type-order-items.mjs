/**
 * type-order-items.mjs — give every order row the catalog TYPE it is an instance of.
 *
 * Usage: node scripts/rm-master/type-order-items.mjs <companyId> <orderId> [--apply]
 *
 * THE PRINCIPLE THIS RESTORES. `fab_item_catalog` holds the TYPE of a thing;
 * `fab_items` says what THIS order is making; `fab_stock_pieces` is what
 * physically exists. A `fab_items` row is therefore an INSTANCE and must name
 * its type — and the KEPL order was built with `catalog_item_id` NULL on all
 * 1,268 structural rows. Only the material links were typed.
 *
 * WHY THAT IS NOT COSMETIC. The field ladder climbs
 * category -> group -> subgroup -> catalog_item -> order_line -> order_item, and
 * the catalogue rungs are reached THROUGH the item's own type (see
 * fieldLadder.spliceOwnType). An untyped part therefore inherits nothing from
 * "all top flanges are E350" or from anything its category says — it silently
 * loses two to four rungs of the ladder, and the loss shows up as a missing
 * value rather than as an error.
 *
 * IT ALSO EXPOSED A REAL GAP. The Composite Girder family in the catalogue
 * carried ten types — span, girder, segment, and the seven plates of a bare
 * girder. A real bridge also has end diaphragms, intermediate diaphragms and
 * splices, and none of those had a type at all. Twenty are added here, following
 * the existing conventions exactly: `-D` suffix for a drilled part, `flow_id`
 * 120001 plain / 120002 drilled / 120003 assembly, `procurement_type = 'make'`.
 *
 * The mapping is DECLARED, not inferred from names. A part's code suffix is what
 * the shop wrote on the drawing; guessing a type by fuzzy-matching a label is
 * how a bearing stiffener quietly becomes an intermediate one.
 */

import { pool } from '../../db.js';

const args = process.argv.slice(2);
const [companyId, orderId] = args.filter((a) => /^\d+$/.test(a)).map(Number);
const apply = args.includes('--apply');
if (!companyId || !orderId) {
  console.error('Usage: node scripts/rm-master/type-order-items.mjs <companyId> <orderId> [--apply]');
  process.exit(1);
}
const log = (m) => console.log(m);

/** Flows already seeded for this family. Plain / drilled / assembly. */
const FLOW = { plain: 120001, drilled: 120002, assembly: 120003 };

/**
 * The types a composite-girder bridge needs beyond a bare girder.
 *
 * Codes follow the family's own convention — `COMPOS-<abbr>`, with `-D` where
 * the part is drilled, which is also what routes it to the drilled flow.
 */
const NEW_TYPES = [
  // the three cross-girder assemblies
  ['COMPOS-EDIA', 'End Diaphragm', 'segment', FLOW.assembly],
  ['COMPOS-IDIA', 'Intermediate Diaphragm', 'segment', FLOW.assembly],
  ['COMPOS-SPL', 'Splice', 'segment', FLOW.assembly],
  // end diaphragm
  ['COMPOS-EDTF', 'End Diaphragm Top Flange', 'part', FLOW.plain],
  ['COMPOS-EDW', 'End Diaphragm Web', 'part', FLOW.plain],
  ['COMPOS-EDBF', 'End Diaphragm Bottom Flange', 'part', FLOW.plain],
  ['COMPOS-JS-D', 'End Diaphragm Joint Stiffener', 'part', FLOW.drilled],
  ['COMPOS-PP-D', 'End Diaphragm Packing Plate', 'part', FLOW.drilled],
  // intermediate diaphragm
  ['COMPOS-IDTF', 'Interm Diaphragm Top Flange', 'part', FLOW.plain],
  ['COMPOS-IDW', 'Interm Diaphragm Web', 'part', FLOW.plain],
  ['COMPOS-IDDW', 'Interm Diaphragm Diagonal Web', 'part', FLOW.plain],
  ['COMPOS-IDBF', 'Interm Diaphragm Bottom Flange', 'part', FLOW.plain],
  ['COMPOS-ISP', 'Interm Diaphragm Side Plate', 'part', FLOW.plain],
  ['COMPOS-IFP', 'Interm Diaphragm Fill Plate', 'part', FLOW.plain],
  ['COMPOS-ICP', 'Interm Diaphragm Corner Plate', 'part', FLOW.plain],
  // splice
  ['COMPOS-WCP-D', 'Web Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-TFICP-D', 'Top Flange Inner Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-TFOCP-D', 'Top Flange Outer Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-BFOCP-D', 'Bottom Flange Outer Cover Plate', 'part', FLOW.drilled],
  ['COMPOS-BFICP-D', 'Bottom Flange Inner Cover Plate', 'part', FLOW.drilled],
];

/**
 * Order-row code suffix -> catalogue code. DECLARED, never guessed.
 *
 * The suffix is the last dash-separated piece of the row's code, which is what
 * the drawing calls the part: `KEPL-ROB60-SPAN1/G1/S1-IS1/D` -> `IS1/D`.
 */
const PART_TYPE = {
  TF: 'COMPOS-TF',
  W: 'COMPOS-WP',
  BF: 'COMPOS-BF',
  'BS/D': 'COMPOS-BS-D',
  // An end stiffener is a plain stiffener at the bearing; the family's plain
  // bearing-stiffener type is exactly that thing.
  ES: 'COMPOS-BS',
  'IS1/D': 'COMPOS-IS-D',
  IS2: 'COMPOS-IS',
  EDTF: 'COMPOS-EDTF',
  EDW: 'COMPOS-EDW',
  EDBF: 'COMPOS-EDBF',
  'JS/D': 'COMPOS-JS-D',
  'PP/D': 'COMPOS-PP-D',
  IDTF: 'COMPOS-IDTF',
  IDW: 'COMPOS-IDW',
  IDDW: 'COMPOS-IDDW',
  IDBF: 'COMPOS-IDBF',
  ISP: 'COMPOS-ISP',
  IFP: 'COMPOS-IFP',
  ICP: 'COMPOS-ICP',
  'WCP/D': 'COMPOS-WCP-D',
  'TFICP/D': 'COMPOS-TFICP-D',
  'TFOCP/D': 'COMPOS-TFOCP-D',
  'BFOCP/D': 'COMPOS-BFOCP-D',
  'BFICP/D': 'COMPOS-BFICP-D',
};

/** Assemblies and the tree above them, matched on the shape of the suffix. */
function structureType(levelKind, suffix) {
  if (levelKind === 'span') return 'COMPOS-SPAN';
  if (levelKind === 'girder') return 'COMPOS-GDR';
  if (levelKind === 'segment') {
    // A girder segment's suffix carries its position — SPAN1/G1/S1. An assembly's
    // is a tag — ED01, ID07, SPL14. Different things, different types.
    if (/\/S\d+$/.test(suffix)) return 'COMPOS-SEG';
    if (/^ED\d+$/.test(suffix)) return 'COMPOS-EDIA';
    if (/^ID\d+$/.test(suffix)) return 'COMPOS-IDIA';
    if (/^SPL\d+$/.test(suffix)) return 'COMPOS-SPL';
    return null;
  }
  if (levelKind === 'part') {
    // A stud is bought, not made — its type is the fastener itself, resolved by
    // the material it is already linked to rather than invented here.
    if (suffix === 'STUD') return null;
    return PART_TYPE[suffix] ?? null;
  }
  return null;
}

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  const [[cat]] = await conn.query(
    `SELECT id FROM fab_item_categories WHERE company_id = ? AND name = 'Composite Girder'
       AND deleted_at IS NULL LIMIT 1`,
    [companyId],
  );
  if (!cat) throw new Error('No "Composite Girder" category on this company');

  // ── the missing types ─────────────────────────────────────────────────────
  const [existing] = await conn.query(
    `SELECT id, code FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL
       AND code LIKE 'COMPOS-%'`,
    [companyId],
  );
  const idByCode = new Map(existing.map((e) => [e.code, e.id]));
  let created = 0;
  for (const [code, name, levelKind, flowId] of NEW_TYPES) {
    if (idByCode.has(code)) continue;
    created++;
    if (!apply) continue;
    const [ins] = await conn.query(
      `INSERT INTO fab_item_catalog
         (company_id, code, name, category_id, level_kind, flow_id,
          procurement_type, mrp_policy, unit, density_kg_m3)
       VALUES (?,?,?,?,?,?, 'make', 'lot_for_lot', 'nos', 7850)`,
      [companyId, code, name, cat.id, levelKind, flowId],
    );
    idByCode.set(code, ins.insertId);
  }

  // ── type the order's rows ────────────────────────────────────────────────
  const [rows] = await conn.query(
    `SELECT id, code, level_kind, catalog_item_id FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND level_kind <> 'material'`,
    [companyId, orderId],
  );

  const byType = new Map();
  const unmatched = new Map();
  for (const r of rows) {
    if (r.catalog_item_id != null) continue;
    const suffix = String(r.code ?? '').split('-').pop();
    const wanted = structureType(r.level_kind, suffix);
    if (!wanted) {
      const key = `${r.level_kind}:${suffix}`;
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
      continue;
    }
    if (!idByCode.has(wanted) && !apply) {
      // A type this run would have created; counted as matched for the preview.
      byType.set(wanted, (byType.get(wanted) ?? 0) + 1);
      continue;
    }
    if (!idByCode.has(wanted)) throw new Error(`catalogue type ${wanted} is missing`);
    byType.set(wanted, (byType.get(wanted) ?? 0) + 1);
    if (apply) {
      await conn.query(
        'UPDATE fab_items SET catalog_item_id = ? WHERE id = ? AND company_id = ?',
        [idByCode.get(wanted), r.id, companyId],
      );
    }
  }

  const typed = [...byType.values()].reduce((a, b) => a + b, 0);
  log(`\ntyping order ${orderId}`);
  log(`  catalogue types: ${created} to create, ${existing.length} already there`);
  log(`  order rows: ${rows.length} structural, ${typed} would be typed`);
  for (const [code, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    log(`     ${String(n).padStart(5)}  ->  ${code}`);
  }
  if (unmatched.size) {
    log('  NOT typed (no declared mapping — left alone rather than guessed):');
    for (const [k, n] of [...unmatched].sort((a, b) => b[1] - a[1])) log(`     ${String(n).padStart(5)}  ${k}`);
  }

  if (!apply) { await conn.rollback(); log('\nNothing written. Re-run with --apply.\n'); }
  else { await conn.commit(); log('\n  committed\n'); }
} catch (err) {
  await conn.rollback();
  console.error(`\nRolled back — nothing written: ${err.message}`);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
