/**
 * kepl-boq-part-names.mjs — the parts KEPL's BOQ names, as catalog items.
 *
 * Five parts on this job are the customer's own nouns: a jacking stiffener, a
 * pad plate, and the inner side / flange / corner plates of an intermediate
 * diaphragm. The catalog called them something else, so the order did too.
 *
 * RATHER THAN RENAME what was there, each becomes its own catalog item under
 * the same category, group and subgroup — a kind of part, with its size left to
 * the order, exactly like Top Flange. The recipe and this order both point at
 * the new item, and the old item is retired once nothing uses it.
 *
 * Also retires five stiffener items left unused when stiffeners moved out of
 * the Segment BOM on 2026-09-11: nothing references them at all.
 *
 *   node scripts/kepl-boq-part-names.mjs           # dry run
 *   node scripts/kepl-boq-part-names.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const { generateCode, getRule } = await import('../apps/fab_erp/services/codegenService.js');

const APPLY = process.argv.includes('--apply');
const C = 30005;

/** The customer's name, and what the catalog called it. */
const RENAMES = [
  ['Jacking Stiffener', 'End Diaphragm Joint Stiffener'],
  ['Pad Plate', 'End Diaphragm Packing Plate'],
  ['Inner Side Plate', 'Interm Diaphragm Side Plate'],
  ['Inner Flange Plate', 'Interm Diaphragm Fill Plate'],
  ['Inner Corner Plate', 'Interm Diaphragm Corner Plate'],
];
/** Unused since stiffeners left the Segment BOM. */
const RETIRE = ['Bearing Stiffener Plain', 'Bearing Stiffener Hole',
  'Intermediate Stiffener Plain', 'Intermediate Stiffener Hole', 'End Stiffener'];

await getRule(C, 'item');           // its table check must not sit in the transaction
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  for (const [want, had] of RENAMES) {
    const [[old]] = await conn.query(
      `SELECT id, unit, category_id, group_id, subgroup_id, procurement_type FROM fab_item_catalog
        WHERE company_id = ? AND name = ? AND deleted_at IS NULL`, [C, had],
    );
    if (!old) { console.log(`${had}: not found, skipped`); continue; }
    const [[exists]] = await conn.query(
      `SELECT id FROM fab_item_catalog WHERE company_id = ? AND name = ? AND deleted_at IS NULL`, [C, want],
    );
    let id = exists?.id ?? null;
    if (!id && APPLY) {
      const code = await generateCode(C, 'item', { categoryId: old.category_id }, conn);
      const [r] = await conn.query(
        `INSERT INTO fab_item_catalog
           (company_id, name, code, unit, description, category_id, group_id, subgroup_id, procurement_type, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
        [C, want, code, old.unit ?? 'nos', `As named on the customer drawing (was "${had}").`,
          old.category_id, old.group_id, old.subgroup_id, old.procurement_type ?? 'make'],
      );
      id = r.insertId;
    }
    const [bom] = await conn.query(
      `SELECT id FROM fab_item_bom WHERE company_id = ? AND child_item_id = ? AND deleted_at IS NULL`, [C, old.id],
    );
    const [items] = await conn.query(
      `SELECT i.id FROM fab_items i JOIN fab_orders o ON o.id = i.order_id AND o.deleted_at IS NULL
        WHERE i.company_id = ? AND i.catalog_item_id = ? AND i.deleted_at IS NULL`, [C, old.id],
    );
    if (APPLY) {
      if (bom.length) await conn.query(`UPDATE fab_item_bom SET child_item_id = ? WHERE id IN (?)`, [id, bom.map((b) => b.id)]);
      if (items.length) await conn.query(`UPDATE fab_items SET catalog_item_id = ?, name = ? WHERE id IN (?)`, [id, want, items.map((i) => i.id)]);
      await conn.query(`UPDATE fab_item_catalog SET deleted_at = NOW() WHERE id = ?`, [old.id]);
    }
    console.log(`${want.padEnd(20)} ${APPLY ? 'created' : 'to create'} · ${bom.length} BOM line, ${items.length} order rows repointed · "${had}" retired`);
  }

  for (const name of RETIRE) {
    const [[it]] = await conn.query(
      `SELECT id FROM fab_item_catalog WHERE company_id = ? AND name = ? AND deleted_at IS NULL`, [C, name],
    );
    if (!it) continue;
    const [[used]] = await conn.query(
      `SELECT (SELECT COUNT(*) FROM fab_item_bom WHERE company_id = ? AND deleted_at IS NULL AND (child_item_id = ? OR parent_item_id = ?)) bom,
              (SELECT COUNT(*) FROM fab_items i JOIN fab_orders o ON o.id = i.order_id AND o.deleted_at IS NULL
                WHERE i.catalog_item_id = ? AND i.deleted_at IS NULL) rows_,
              (SELECT COUNT(*) FROM fab_stock_pieces WHERE catalog_item_id = ? AND deleted_at IS NULL) stock`,
      [C, it.id, it.id, it.id, it.id],
    );
    if (used.bom || used.rows_ || used.stock) { console.log(`${name}: still used (${JSON.stringify(used)}), left alone`); continue; }
    if (APPLY) await conn.query(`UPDATE fab_item_catalog SET deleted_at = NOW() WHERE id = ?`, [it.id]);
    console.log(`${name.padEnd(30)} ${APPLY ? 'retired' : 'to retire'} — nothing uses it`);
  }

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else { await conn.rollback(); console.log('\nDRY RUN — nothing written.'); }
} catch (e) { await conn.rollback(); throw e; } finally { conn.release(); await pool.end(); }
