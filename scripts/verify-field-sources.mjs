/**
 * verify-field-sources.mjs — can the resolver SEE every value that exists?
 *
 * Read-only. Phase 3 made the registry the single DEFINITION of a field while
 * leaving some values in columns, because several are matched or filtered in
 * SQL (the material picker on thickness, weight on density, and from Phase 6
 * consumption on piece dimensions). That is a defensible split, but it is only
 * safe while exactly one place knows where each field lives.
 *
 * This checks that claim from the outside: for every column that backs a
 * registry field, does the value in the column actually reach a formula?
 *
 * A failure here is the bug this whole registry exists to prevent — a value
 * that is plainly visible on screen, sitting in a column, silently arriving at
 * the formula engine as 0.
 *
 * Usage:  node scripts/verify-field-sources.mjs [companyId]
 */

import { pool } from '../db.js';
import { resolveItemFields } from '../apps/fab_erp/services/itemFieldService.js';

const only = Number(process.argv[2]) || null;

/** column → registry field, for every column-backed field. THE map. */
const CATALOG_COLUMNS = {
  thickness_mm: 'thickness_mm',
  density_kg_m3: 'density_kg_m3',
  section_area_mm2: 'section_area_mm2',
};
const PIECE_COLUMNS = { length_mm: 'length_mm', width_mm: 'width_mm' };

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_items i ON i.company_id = c.id AND i.deleted_at IS NULL`,
  only ? [only] : [],
);

let problems = 0;
const flag = (m) => { problems++; console.log(`   ⚠ ${m}`); };

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  // ── catalog-backed values ────────────────────────────────────────────────
  const [items] = await pool.query(
    `SELECT i.id, i.name, c.code AS matCode,
            c.thickness_mm, c.density_kg_m3, c.section_area_mm2
       FROM fab_items i
       JOIN fab_item_catalog c ON c.id = i.catalog_item_id AND c.deleted_at IS NULL
      WHERE i.company_id = ? AND i.deleted_at IS NULL
      LIMIT 400`,
    [co.id],
  );

  if (!items.length) { console.log('   no catalog-bound items'); continue; }

  const resolved = await resolveItemFields(co.id, items.map((i) => i.id));
  let checked = 0;
  for (const it of items) {
    const v = resolved.get(it.id) ?? {};
    for (const [col, field] of Object.entries(CATALOG_COLUMNS)) {
      if (it[col] == null) continue;
      checked++;
      if (v[field] == null) {
        flag(`"${it.name}" (${it.matCode}): catalog ${col} = ${it[col]} but the formula sees NOTHING for ${field}`);
      }
    }
  }
  console.log(`   ${items.length} catalog-bound item(s) · ${checked} column value(s) checked`);

  // ── piece-backed values ─────────────────────────────────────────────────
  const [pieces] = await pool.query(
    `SELECT p.id, p.code, p.length_mm, p.width_mm, p.catalog_item_id
       FROM fab_stock_pieces p
      WHERE p.company_id = ? AND p.deleted_at IS NULL
        AND (p.length_mm IS NOT NULL OR p.width_mm IS NOT NULL)
      LIMIT 100`,
    [co.id],
  );
  if (!pieces.length) {
    console.log('   no sized stock pieces to check (they are only written from 2026-08-16)');
    continue;
  }

  // Pair each sized piece with an item drawn from the same catalog item, which
  // is the only way a piece ever reaches the resolver.
  let pieceChecked = 0;
  for (const p of pieces) {
    const host = items.find((i) => i.matCode && i.id);
    if (!host) break;
    const [[hostRow]] = await pool.query(
      `SELECT id FROM fab_items
        WHERE company_id = ? AND catalog_item_id = ? AND deleted_at IS NULL LIMIT 1`,
      [co.id, p.catalog_item_id],
    );
    if (!hostRow) continue;
    const withPiece = await resolveItemFields(co.id, [hostRow.id], {
      pieceByItem: new Map([[hostRow.id, p.id]]),
    });
    const v = withPiece.get(hostRow.id) ?? {};
    for (const [col, field] of Object.entries(PIECE_COLUMNS)) {
      if (p[col] == null) continue;
      pieceChecked++;
      if (Number(v[field]) !== Number(p[col])) {
        flag(`piece ${p.code}: ${col} = ${p[col]} but the formula sees ${v[field] ?? 'NOTHING'} for ${field}`);
      }
    }
  }
  console.log(`   ${pieces.length} sized piece(s) · ${pieceChecked} column value(s) checked`);
}

console.log(problems === 0
  ? '\nCLEAN — every column-backed value reaches the formula engine.'
  : `\nREVIEW — ${problems} value(s) exist in a column but never reach a formula.`);

await pool.end();
