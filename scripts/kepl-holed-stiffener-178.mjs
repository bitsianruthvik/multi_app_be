/**
 * kepl-holed-stiffener-178.mjs — the holed intermediate stiffener is 178 wide.
 *
 * The 2026-09-10 rebuild forced every "… Hole" row to its plain twin's width,
 * on the reading that two widths for one part were a slip in the source. The
 * BOQ does not agree: all twenty segments list one row at 170 and one at 178,
 * and the width pairs with the quantity every time — the 18-to-23-off stiffener
 * is 170, the 3-or-6-off one is 178. Eight millimetres of extra steel beside a
 * bolt hole is ordinary practice, not a typo.
 *
 * So the drilled rows go back to 178. They become their own blank, which is the
 * cost of it, and the order then matches the BOQ to the kilogram.
 *
 *   node scripts/kepl-holed-stiffener-178.mjs           # dry run
 *   node scripts/kepl-holed-stiffener-178.mjs --apply
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
const { recomputeDerived } = await import('../apps/fab_erp/services/fieldDeriveService.js');
const { syncUnstartedTasks } = await import('../apps/fab_erp/services/taskGatingService.js');

const APPLY = process.argv.includes('--apply');
const C = 30005;
const ORDER = 1410063;
const WIDTH = 178;
const NAME = 'Stiffener 12 × 178';

await getRule(C, 'item');
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  let [[item]] = await conn.query(
    `SELECT id FROM fab_item_catalog WHERE company_id = ? AND name = ? AND deleted_at IS NULL`, [C, NAME],
  );
  if (!item && APPLY) {
    const [[like]] = await conn.query(
      `SELECT category_id, group_id, subgroup_id FROM fab_item_catalog
        WHERE company_id = ? AND name = 'Stiffener 12 × 170' AND deleted_at IS NULL`, [C],
    );
    const code = await generateCode(C, 'item', { categoryId: like.category_id }, conn);
    const [r] = await conn.query(
      `INSERT INTO fab_item_catalog
         (company_id, name, code, unit, description, category_id, group_id, subgroup_id,
          procurement_type, thickness_mm, created_at)
       VALUES (?,?,?,'nos',?,?,?,?,'make',12,NOW())`,
      [C, NAME, code, 'Flat stiffener 12 mm thick, 178 mm wide. Length on the order.',
        like.category_id, like.group_id, like.subgroup_id],
    );
    item = { id: r.insertId };
    const [fields] = await conn.query(
      `SELECT id, field_key FROM fab_fields
        WHERE company_id = ? AND deleted_at IS NULL AND field_key IN ('thickness_mm','width_mm')`, [C],
    );
    for (const f of fields) {
      await conn.query(
        `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
         VALUES (?,?,'catalog_item',?,?,'mm',NOW())
         ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
        [C, f.id, item.id, f.field_key === 'width_mm' ? WIDTH : 12],
      );
    }
    console.log(`catalog: ${NAME} created (${code})`);
  } else {
    console.log(`catalog: ${NAME} ${item ? 'already exists' : 'to create'}`);
  }

  const [rows] = await conn.query(
    `SELECT id, qty FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND name = 'Intermediate Stiffener (drilled)'`,
    [C, ORDER],
  );
  const [[wf]] = await conn.query(
    `SELECT id FROM fab_fields WHERE company_id = ? AND field_key = 'width_mm' AND deleted_at IS NULL`, [C],
  );
  console.log(`order: ${rows.length} drilled stiffener rows to ${WIDTH} wide`);

  if (APPLY && rows.length) {
    await conn.query(`UPDATE fab_items SET catalog_item_id = ? WHERE id IN (?)`, [item.id, rows.map((r) => r.id)]);
    for (const r of rows) {
      await conn.query(
        `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
         VALUES (?,?,'order_item',?,?,'mm',NOW())
         ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
        [C, wf.id, r.id, WIDTH],
      );
    }
    // Weight and painted area follow the rectangle.
    await recomputeDerived(C, rows.map((r) => r.id), conn);

    // …and every assembly above them weighs what its parts weigh.
    const [all] = await conn.query(
      `SELECT id, parent_item_id p, name, qty FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND node_kind = 'structure'
          AND order_line_id IS NOT NULL`, [C, ORDER],
    );
    const [vals] = await conn.query(
      `SELECT v.scope_id id, f.field_key k, v.value_num n FROM fab_field_values v
         JOIN fab_fields f ON f.id = v.field_id
        WHERE v.company_id = ? AND v.scope = 'order_item' AND v.deleted_at IS NULL AND v.scope_id IN (?)
          AND f.field_key IN ('unit_weight_kg','surface_area_m2')`, [C, all.map((a) => a.id)],
    );
    const have = new Map();
    for (const v of vals) {
      const e = have.get(Number(v.id)) ?? {};
      e[v.k] = Number(v.n);
      have.set(Number(v.id), e);
    }
    const kids = new Map();
    for (const a of all) { const k = String(a.p ?? 'root'); kids.set(k, [...(kids.get(k) ?? []), a]); }
    const roll = (a) => {
      const ch = kids.get(String(a.id)) ?? [];
      const me = have.get(Number(a.id)) ?? {};
      if (!ch.length) return { kg: me.unit_weight_kg ?? 0, m2: me.surface_area_m2 ?? 0 };
      return ch.reduce((s, c) => {
        const x = roll(c);
        return { kg: s.kg + x.kg * Number(c.qty), m2: s.m2 + x.m2 * Number(c.qty) };
      }, { kg: 0, m2: 0 });
    };
    const [fdefs] = await conn.query(
      `SELECT id, field_key, default_unit FROM fab_fields
        WHERE company_id = ? AND deleted_at IS NULL AND field_key IN ('unit_weight_kg','surface_area_m2')`, [C],
    );
    const fieldOf = new Map(fdefs.map((f) => [f.field_key, f]));
    let rolled = 0;
    for (const a of all) {
      if (!(kids.get(String(a.id)) ?? []).length) continue;
      const { kg, m2 } = roll(a);
      for (const [key, value] of [['unit_weight_kg', kg], ['surface_area_m2', m2]]) {
        if (!(value > 0)) continue;
        const f = fieldOf.get(key);
        await conn.query(
          `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
           VALUES (?,?,'order_item',?,?,?,NOW())
           ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
          [C, f.id, a.id, Number(value.toFixed(3)), f.default_unit ?? null],
        );
      }
      rolled += 1;
    }
    const synced = await syncUnstartedTasks(conn, C, ORDER);
    console.log(`values: ${rolled} assemblies re-rolled · tasks: ${synced} re-synced`);
    await conn.commit();
    console.log('Committed.');
  } else {
    await conn.rollback();
    console.log('DRY RUN — nothing written.');
  }
} catch (e) {
  await conn.rollback();
  throw e;
} finally {
  conn.release();
  await pool.end();
}
