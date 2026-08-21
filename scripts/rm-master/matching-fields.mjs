/**
 * matching-fields.mjs — the three axes that decide what a part may be cut from.
 *
 * Usage: node scripts/rm-master/matching-fields.mjs <companyId> [--apply]
 *
 * WHAT DECIDES INTERCHANGEABILITY is exactly three things: the MATERIAL (mild
 * steel, stainless, aluminium), the GRADE (IS 2062 E250 / E350, with its quality
 * suffix), and the THICKNESS. Everything else about a plate — its width, its
 * length, its price — decides whether a part FITS or what it COSTS, not whether
 * it may legally be cut from it.
 *
 * Two of those three were not expressible on a part:
 *
 *   material   did not exist as data anywhere. It lived inside a subgroup label
 *              ("MS E350 BO") and inside item names, which means nothing could
 *              act on it. Two consequences worth stating plainly: nothing could
 *              stop a stainless part being nested onto mild steel plate, and
 *              weight is computed from a density that differs by material
 *              (MS 7850, stainless ~7900-8000, aluminium 2700).
 *
 *   grade      existed, but at `applies_at: catalog_item`. A value may be set at
 *              its rung OR BROADER, and an order item is NARROWER — so a grade
 *              could be stated for a catalogue item and could NOT be stated for
 *              a span, a girder or a part. That is the wrong way round for a
 *              job: the drawing says what grade the bridge is, and the catalogue
 *              only says what the merchant stocks.
 *
 * Widening both to `order_item` makes the ladder do the work the shop already
 * does: state the grade and material ONCE on the span, and every part beneath
 * inherits it, because the resolver walks part -> segment -> girder -> span.
 * A part that is genuinely different — one stainless insert in a steel deck —
 * overrides it on that part alone.
 *
 * `stock_piece` is deliberately NOT the limit. A piece cannot be a different
 * material from the item it is a piece of; allowing an override there would let
 * somebody declare one plate of a mild-steel item to be stainless.
 */

import { pool } from '../../db.js';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
if (!companyId) {
  console.error('Usage: node scripts/rm-master/matching-fields.mjs <companyId> [--apply]');
  process.exit(1);
}
const log = (m) => console.log(m);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/** The narrowest rung each may be set on. See the header for why order_item. */
const WANT = {
  material: { label: 'Material', dataType: 'text', appliesAt: 'order_item', sort: 201 },
  grade: { label: 'Steel grade', dataType: 'text', appliesAt: 'order_item', sort: 200 },
};

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const summary = [];

  for (const [key, w] of Object.entries(WANT)) {
    const [[row]] = await conn.query(
      `SELECT id, applies_at, data_type, deleted_at FROM fab_fields
        WHERE company_id = ? AND field_key = ? LIMIT 1`,
      [companyId, key],
    );

    if (!row) {
      summary.push(`+ ${key.padEnd(9)} create as ${w.dataType} @ ${w.appliesAt}`);
      if (apply) {
        await conn.query(
          `INSERT INTO fab_fields
             (company_id, field_key, label, data_type, dimension, default_unit, applies_at,
              formula_usable, is_standard, sort_order, active)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, 1, ?, 1)`,
          [companyId, key, w.label, w.dataType, w.appliesAt, w.sort],
        );
      }
      continue;
    }

    // A soft-deleted definition is revived, never re-inserted: the unique key is
    // (company_id, field_key) and it does not exclude deleted rows.
    if (row.deleted_at) {
      summary.push(`~ ${key.padEnd(9)} revive (was soft-deleted)`);
      if (apply) await conn.query('UPDATE fab_fields SET deleted_at = NULL, active = 1 WHERE id = ?', [row.id]);
    }

    if (row.applies_at !== w.appliesAt) {
      summary.push(`~ ${key.padEnd(9)} widen applies_at ${row.applies_at} -> ${w.appliesAt}`);
      if (apply) {
        await conn.query('UPDATE fab_fields SET applies_at = ? WHERE id = ?', [w.appliesAt, row.id]);
      }
    } else {
      summary.push(`= ${key.padEnd(9)} already ${w.appliesAt}`);
    }
  }

  /**
   * Backfill `material` on the raw-material catalogue.
   *
   * Every item in the customer's RM master is mild steel — the sheet's forms are
   * MS PLATE, ISA, ISMB, ISLB, ISHB, ISJB, Channel, Wide Flange and UB, all of
   * which are carbon steel. So 'MS' is a statement about THIS data, not a
   * default to apply blind: an item outside that set is left alone rather than
   * assumed, because guessing a material wrong is the one error this field
   * exists to prevent.
   */
  // Counted unconditionally so a dry run reports what an apply would do. The
  // field may not exist yet on this tenant, which is precisely when somebody is
  // most likely to be running the preview.
  let backfilled = 0;
  {
    const [targets] = await conn.query(
      `SELECT ic.id FROM fab_item_catalog ic
        WHERE ic.company_id = ? AND ic.deleted_at IS NULL
          AND ic.code REGEXP '^RM[0-9]{5}$'`,
      [companyId],
    );
    summary.push(`  material  backfill 'MS' on ${targets.length} RM catalogue item(s)`);
    if (apply && targets.length) {
      const [[field]] = await conn.query(
        'SELECT id FROM fab_fields WHERE company_id = ? AND field_key = ? LIMIT 1', [companyId, 'material'],
      );
      const ids = targets.map((t) => t.id);
      // Idempotent: retire this field's previous answer for these items rather
      // than stacking a second live value the resolver would have to choose between.
      for (const g of chunk(ids, 500)) {
        await conn.query(
          `UPDATE fab_field_values SET deleted_at = NOW()
            WHERE company_id = ? AND field_id = ? AND scope = 'catalog_item'
              AND scope_id IN (?) AND deleted_at IS NULL`,
          [companyId, field.id, g],
        );
      }
      for (const g of chunk(ids.map((id) => [companyId, field.id, 'catalog_item', id, 'MS']), 900)) {
        await conn.query(
          'INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_text) VALUES ?',
          [g],
        );
      }
      backfilled = ids.length;
    }
  }

  log(`\nmatching fields for company ${companyId}`);
  for (const s of summary) log(`  ${s}`);
  if (!apply) {
    await conn.rollback();
    log('\nNothing written. Re-run with --apply.\n');
  } else {
    await conn.commit();
    log(`  backfilled ${backfilled} material value(s)`);
    log('  committed\n');
  }
} catch (err) {
  await conn.rollback();
  console.error(`\nRolled back — nothing written: ${err.message}`);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
