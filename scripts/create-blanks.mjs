/**
 * create-blanks.mjs — slice 0 of FAB_ERP_LOTS_AND_PRODUCTION_ORDERS.md.
 *
 * A BLANK is the piece that comes off the plate: material + grade + thickness +
 * width + length, and nothing else. Every part row of that shape on an order is
 * cut from the same one, which is what makes them a LOT — produced once by a
 * cutting order, drawn down by assemblies.
 *
 * WHAT THIS WRITES
 *   - a `Blanks` group under `Raw Materials`
 *   - a subgroup named after the ORDER
 *   - one catalog item per distinct blank on that order, with its size as FIELDS
 *   - `fab_items.blank_catalog_item_id` on every part row that has one
 *
 * ── WHY UNDER RAW MATERIALS, AND SCOPED TO THE ORDER ─────────────────────────
 *
 * The first attempt filed blanks in a shared namespace, as though a
 * 12 x 170 x 2995 rectangle were a reusable type. It is not. This span has 25
 * distinct shapes and only SIX distinct thicknesses: thickness and grade recur
 * across jobs, the rectangle comes off one drawing and dies with the order.
 * Filed that way the catalog gains ~25 permanently dead items per order and
 * every picker in the app fills with them.
 *
 * Scoped to the order, the catalog grows with LIVE work rather than with
 * history — retire the order and its subgroup goes with it.
 *
 * Under Raw Materials because that is where the hiding already is. Every item
 * picker excludes that category today, so a blank is invisible to the people who
 * should never pick one from the day it is created, with no new filtering rule
 * for anyone to forget. It also reads true: a blank IS the raw material of the
 * assembly that consumes it, and nesting already looks in Raw Materials for the
 * stock it cuts from.
 *
 * NOTHING READS ANY OF IT YET. That is the point of slice 0: the grouping is
 * proved and inspectable before a single consumer depends on it, so being wrong
 * here costs a re-run rather than an order.
 *
 * ── DECISIONS BAKED IN, both the user's ──────────────────────────────────────
 *
 * MERGED ON SIZE. Drilled and plain parts of the same shape are ONE blank, and
 * drilling is a task that happens after cutting. Splitting them was the
 * alternative; on the real BOQ only 3 of 25 sizes carry both, so a second
 * identity axis would have earned its keep on 12% of the catalog.
 *
 * NO DENSITY. Fabricated items had density stripped from them deliberately —
 * it polluted the candidate pool that matches a part to its raw material.
 * A blank's density comes from the plate it is cut from.
 *
 * ── THE CODE IS DERIVED, NOT SEQUENCED ───────────────────────────────────────
 *
 * `BLK-MS-E350BO-12x170x2995`. A sequence would give the same blank a different
 * code on the next order, and then two catalog items would describe one piece of
 * steel — which is the whole failure this change exists to fix. Deriving it from
 * the shape means "have I already got this blank" is answerable by looking.
 *
 *   node scripts/create-blanks.mjs                  # dry run, writes nothing
 *   node scripts/create-blanks.mjs --apply
 *   node scripts/create-blanks.mjs --order 1230064 --apply
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

const APPLY = process.argv.includes('--apply');
const argOrder = process.argv.indexOf('--order');
const ORDER = argOrder > -1 ? Number(process.argv[argOrder + 1]) : 1230064;
const COMPANY = 30005;

const say = (s = '') => console.log(s);
const plan = (s) => console.log(`${APPLY ? '  ' : '  would '}${s}`);

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  // ── the part rows, and the sizes somebody typed on them ───────────────────
  const [parts] = await conn.query(
    `SELECT i.id, i.name, i.code, i.qty,
            MAX(CASE WHEN f.field_key='length_mm'    THEN v.value_num END) AS len,
            MAX(CASE WHEN f.field_key='width_mm'     THEN v.value_num END) AS wid,
            MAX(CASE WHEN f.field_key='thickness_mm' THEN v.value_num END) AS thk
       FROM fab_items i
       LEFT JOIN fab_field_values v
              ON v.company_id = i.company_id AND v.scope = 'order_item'
             AND v.scope_id = i.id AND v.deleted_at IS NULL
       LEFT JOIN fab_fields f ON f.id = v.field_id
      WHERE i.company_id = ? AND i.order_id = ?
        AND i.is_leaf = 1 AND i.node_kind = 'structure'
        AND COALESCE(i.procurement_type,'make') = 'make'
      GROUP BY i.id, i.name, i.code, i.qty`,
    [COMPANY, ORDER],
  );

  /*
   * Material and grade come off the ORDER LINE, not the part.
   *
   * On this order 2,228 parts carry dimensions and 21 carry a material — the
   * line says "MS / E350 BO" once and everything under it inherits. Reading the
   * part first and falling back to the line keeps a part that overrides its
   * line honest, without requiring 1,090 rows to repeat the same two words.
   */
  const [[ord]] = await conn.query(
    `SELECT order_number FROM fab_orders WHERE company_id=? AND id=?`, [COMPANY, ORDER]);
  if (!ord) throw new Error(`Order ${ORDER} not found.`);
  const orderNumber = ord.order_number;

  const [[lineSpec]] = await conn.query(
    `SELECT MAX(CASE WHEN f.field_key='material' THEN v.value_text END) AS material,
            MAX(CASE WHEN f.field_key='grade'    THEN v.value_text END) AS grade
       FROM fab_order_lines ol
       JOIN fab_field_values v
             ON v.company_id = ol.company_id AND v.scope = 'order_line'
            AND v.scope_id = ol.id AND v.deleted_at IS NULL
       JOIN fab_fields f ON f.id = v.field_id
      WHERE ol.company_id = ? AND ol.order_id = ?`,
    [COMPANY, ORDER],
  );
  const [overrides] = await conn.query(
    `SELECT v.scope_id AS itemId, f.field_key AS k, v.value_text AS val
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.deleted_at IS NULL
        AND f.field_key IN ('material','grade')`,
    [COMPANY],
  );
  const ovr = new Map();
  for (const o of overrides) {
    const e = ovr.get(Number(o.itemId)) ?? {};
    e[o.k] = o.val; ovr.set(Number(o.itemId), e);
  }

  // ── group them ────────────────────────────────────────────────────────────
  const blanks = new Map();          // key -> { material, grade, thk, wid, len, pieces, rows[] }
  const noDims = [];
  for (const p of parts) {
    if (p.len == null || p.wid == null || p.thk == null) { noDims.push(p); continue; }
    const o = ovr.get(Number(p.id)) ?? {};
    const material = o.material ?? lineSpec?.material ?? 'MS';
    const grade = o.grade ?? lineSpec?.grade ?? 'E350 BO';
    /*
     * THE RECTANGLE IS NORMALISED: short side, then long side.
     *
     * The BOQ records width and length in whichever order the draughtsman
     * wrote them — this order has "16 x 1250 x 80" and "12 x 170 x 2995" side
     * by side. A blank 80 wide by 1250 long is the same piece of steel as one
     * 1250 by 80, so letting the typing order into the identity would mint two
     * catalog items for one thing, which is the exact failure this change
     * exists to prevent. It merges nothing on THIS order — 25 blanks either
     * way — so it costs nothing today and closes the trap for the next one.
     */
    const thk = Number(p.thk);
    const wid = Math.min(Number(p.wid), Number(p.len));
    const len = Math.max(Number(p.wid), Number(p.len));
    const key = `${material}|${grade}|${thk}|${wid}|${len}`;
    const b = blanks.get(key) ?? { material, grade, thk, wid, len, pieces: 0, rows: [] };
    b.pieces += Number(p.qty) || 1;
    b.rows.push(p.id);
    blanks.set(key, b);
  }

  const num = (n) => (Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '').replace(/\.$/, ''));
  /*
   * THE ORDER IS IN BOTH THE NAME AND THE CODE, and it has to be.
   *
   * `uq_fic2_company_name_active` is UNIQUE on the name and
   * `uq_fic2_company_code_active` on the code, both company-wide. Two orders
   * needing the same rectangle would collide on each without it — and they
   * SHOULD be two items anyway, because a blank cut for one job is not the
   * other job's steel to take.
   */
  const shape = (b) => `${num(b.thk)} x ${num(b.wid)} x ${num(b.len)}`;
  const nameOf = (b) => `${b.material} Blank ${shape(b)} ${b.grade} — ${orderNumber}`;
  const codeOf = (b) => `BLK-${orderNumber}-${b.material}-${b.grade.replace(/\s+/g, '')}-${shape(b).replace(/ /g, '')}`
    .toUpperCase();

  say(`Order ${ORDER} — ${parts.length} part row(s): ${parts.length - noDims.length} sized, ${noDims.length} without dimensions.`);
  say(`${blanks.size} blank type(s), ${[...blanks.values()].reduce((s, b) => s + b.pieces, 0)} pieces.`);
  say();

  // ── the group and its subgroups ───────────────────────────────────────────
  const [[rmCat]] = await conn.query(
    `SELECT id FROM fab_item_categories WHERE company_id=? AND name='Raw Materials' AND deleted_at IS NULL`,
    [COMPANY],
  );
  if (!rmCat) throw new Error('No "Raw Materials" category — nothing to hang blanks off.');

  let [[grp]] = await conn.query(
    `SELECT id FROM fab_item_groups WHERE company_id=? AND category_id=? AND name='Blanks' AND deleted_at IS NULL`,
    [COMPANY, rmCat.id],
  );
  if (!grp) {
    plan('create group  Raw Materials > Blanks');
    if (APPLY) {
      const [r] = await conn.query(
        `INSERT INTO fab_item_groups (company_id, category_id, name, code, description, created_at)
         VALUES (?,?,?,?,?,NOW())`,
        [COMPANY, rmCat.id, 'Blanks', 'blanks',
          'Cut pieces, one subgroup per order. The lot a cutting order makes and assemblies draw from.'],
      );
      grp = { id: r.insertId };
    } else grp = { id: 0 };
  } else say(`group  Raw Materials > Blanks  exists (${grp.id})`);

  /*
   * ONE SUBGROUP PER ORDER, and it is the whole reason this is not catalog bloat.
   * Retire the order and its subgroup goes with it, so the catalog grows with
   * LIVE work rather than with history.
   */
  let subgroupId = 0;
  {
    const [[sg]] = await conn.query(
      `SELECT id FROM fab_item_subgroups WHERE company_id=? AND group_id=? AND name=? AND deleted_at IS NULL`,
      [COMPANY, grp.id, orderNumber],
    );
    if (sg) { subgroupId = sg.id; say(`subgroup  Blanks > ${orderNumber}  exists (${sg.id})`); }
    else {
      plan(`create subgroup  Blanks > ${orderNumber}`);
      if (APPLY) {
        const [r] = await conn.query(
          `INSERT INTO fab_item_subgroups (company_id, group_id, name, code, created_at) VALUES (?,?,?,?,NOW())`,
          [COMPANY, grp.id, orderNumber, orderNumber.toLowerCase()],
        );
        subgroupId = r.insertId;
      }
    }
  }
  say();

  // ── the field ids we stamp onto each blank ────────────────────────────────
  const [fieldRows] = await conn.query(
    `SELECT id, field_key FROM fab_fields
      WHERE company_id=? AND deleted_at IS NULL
        AND field_key IN ('thickness_mm','length_mm','width_mm','material','grade','material_form')`,
    [COMPANY],
  );
  const fieldId = new Map(fieldRows.map((f) => [f.field_key, f.id]));
  for (const k of ['thickness_mm', 'length_mm', 'width_mm', 'material', 'grade']) {
    if (!fieldId.has(k)) throw new Error(`Field "${k}" is missing — a blank cannot be described without it.`);
  }

  /*
   * ON DUPLICATE KEY UPDATE, never delete-then-insert.
   *
   * `uq_ffv_target` is UNIQUE on (company_id, field_id, scope, scope_id) and
   * counts soft-deleted rows, so clearing a value and writing it again in one
   * transaction collides with the row you just "removed".
   */
  const setField = async (catalogItemId, key, { num: n = null, text = null, unit = null }) => {
    if (!APPLY) return;
    await conn.query(
      `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, value_text, unit_code, created_at)
       VALUES (?,?,'catalog_item',?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE value_num=VALUES(value_num), value_text=VALUES(value_text),
                               unit_code=VALUES(unit_code), deleted_at=NULL`,
      [COMPANY, fieldId.get(key), catalogItemId, n, text, unit],
    );
  };

  // ── one catalog item per blank ────────────────────────────────────────────
  let created = 0, existed = 0, stamped = 0;
  const listing = [];
  for (const b of [...blanks.values()].sort((x, y) => y.pieces - x.pieces)) {
    const code = codeOf(b), name = nameOf(b);
    let [[item]] = await conn.query(
      `SELECT id FROM fab_item_catalog WHERE company_id=? AND code=? AND deleted_at IS NULL`,
      [COMPANY, code],
    );
    if (item) { existed += 1; } else {
      created += 1;
      if (APPLY) {
        const [r] = await conn.query(
          `INSERT INTO fab_item_catalog
             (company_id, name, code, unit, description, category_id, group_id, subgroup_id,
              procurement_type, thickness_mm, material_form, created_at)
           VALUES (?,?,?,'nos',?,?,?,?, 'make', ?, 'blank', NOW())`,
          [COMPANY, name, code,
            'Cut blank. Made by a cutting order from plate; assemblies draw from the lot.',
            rmCat.id, grp.id, subgroupId, b.thk],
        );
        item = { id: r.insertId };
      } else item = { id: 0 };
    }

    await setField(item.id, 'thickness_mm', { num: b.thk, unit: 'mm' });
    await setField(item.id, 'width_mm', { num: b.wid, unit: 'mm' });
    await setField(item.id, 'length_mm', { num: b.len, unit: 'mm' });
    await setField(item.id, 'material', { text: b.material });
    await setField(item.id, 'grade', { text: b.grade });
    if (fieldId.has('material_form')) await setField(item.id, 'material_form', { text: 'blank' });

    if (APPLY && b.rows.length) {
      const [u] = await conn.query(
        `UPDATE fab_items SET blank_catalog_item_id = ? WHERE company_id = ? AND id IN (?)`,
        [item.id, COMPANY, b.rows],
      );
      stamped += u.affectedRows;
    } else stamped += b.rows.length;

    listing.push({ code, name, pieces: b.pieces, rows: b.rows.length });
  }

  say('BLANKS');
  console.table(listing);
  say();
  say(`${created} to create, ${existed} already there.`);
  say(`${stamped} part row(s) ${APPLY ? 'stamped' : 'would be stamped'} with their blank.`);
  if (noDims.length) {
    say(`${noDims.length} part row(s) have no dimensions and were left alone:`);
    for (const p of noDims.slice(0, 8)) say(`    ${p.code ?? p.id}  ${p.name}`);
    if (noDims.length > 8) say(`    …and ${noDims.length - 8} more`);
  }

  if (APPLY) { await conn.commit(); say('\nCommitted.'); }
  else say('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
