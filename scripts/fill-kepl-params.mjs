/**
 * fill-kepl-params.mjs — the eighteen rows the order could not answer for.
 *
 * ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────────
 *
 * Three different places, and the difference matters more than the numbers do.
 *
 * 1. ROLLED UP, not guessed. An assembly's weight and surface area are the sum
 *    of its parts — a Segment weighs what its flanges, web and stiffeners weigh.
 *    That is arithmetic on values already in the order, so it is computed here
 *    rather than assumed, and it will be right.
 *
 * 2. READ OFF THE RETIRED ORDER. Weld lengths were recorded on the old KEPL
 *    build and survived it, because its field values outlived its soft-deleted
 *    rows. A Segment at 12,000 welds 227.74 m; at 11,650 it welds 249.6 m — the
 *    SHORTER one welds more, which is the sort of thing nobody would guess and
 *    is exactly why reading beats inventing. End Diaphragm 59.808, Intermediate
 *    Diaphragm 41.312, Splice 33.852.
 *
 * 3. ASSUMED, and said so. Hole counts. The old order recorded 4 and 2 for the
 *    intermediate stiffener in equal numbers — a tie, not a fact — and nothing
 *    at all for the bearing stiffener. Both are set to 4: the larger of the tie,
 *    and the same count for its heavier neighbour.
 *
 *    This one is a guess and it is load-bearing: holes drive drilling time,
 *    which drives the schedule. It is here so the order can move, and it should
 *    be replaced by the drawing the first time somebody has it.
 *
 *   node scripts/fill-kepl-params.mjs            # dry run
 *   node scripts/fill-kepl-params.mjs --apply
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
const COMPANY = 30005;
const ORDER = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 1410063);

/** Read off the retired KEPL order. Segment depends on its length. */
const WELD_M = {
  'End Diaphragm': 59.808,
  'Intermediate Diaphragm': 41.312,
  Splice: 33.852,
};
const SEGMENT_WELD_M = { 12000: 227.74, 11650: 249.6 };

/** Assumed — see the header. Replace with the drawing when there is one. */
const HOLES = {
  // Names since 2026-09-11, when stiffeners became rows added on the order.
  'Bearing Stiffener (drilled)': 4,
  'Intermediate Stiffener (drilled)': 4,
};

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [fields] = await conn.query(
    `SELECT id, field_key, default_unit FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL
        AND field_key IN ('weld_length_m','num_holes','unit_weight_kg','surface_area_m2')`,
    [COMPANY],
  );
  const fieldOf = new Map(fields.map((f) => [f.field_key, f]));

  const [rows] = await conn.query(
    `SELECT id, parent_item_id AS parentItemId, name, qty, is_leaf AS isLeaf
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND node_kind = 'structure'`,
    [COMPANY, ORDER],
  );
  const kids = new Map();
  for (const r of rows) {
    const k = r.parentItemId == null ? 'root' : String(r.parentItemId);
    kids.set(k, [...(kids.get(k) ?? []), r]);
  }

  const [vals] = await conn.query(
    `SELECT v.scope_id AS itemId, f.field_key AS k, v.value_num AS n
       FROM fab_field_values v JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.deleted_at IS NULL
        AND v.scope_id IN (?)
        AND f.field_key IN ('unit_weight_kg','surface_area_m2','length_mm','weld_length_m','num_holes')`,
    [COMPANY, rows.map((r) => r.id)],
  );
  const have = new Map();
  for (const v of vals) {
    const e = have.get(Number(v.itemId)) ?? {};
    e[v.k] = v.n == null ? null : Number(v.n);
    have.set(Number(v.itemId), e);
  }

  /**
   * An assembly's weight and area, from its children. Depth-first so a Segment
   * can be summed before the Line that contains it.
   */
  const rollUp = (row) => {
    const mine = have.get(Number(row.id)) ?? {};
    const children = kids.get(String(row.id)) ?? [];
    if (!children.length) return { kg: mine.unit_weight_kg ?? 0, m2: mine.surface_area_m2 ?? 0 };

    let kg = 0;
    let m2 = 0;
    for (const c of children) {
      const sub = rollUp(c);
      const q = Number(c.qty) || 0;
      kg += sub.kg * q;
      m2 += sub.m2 * q;
    }
    return { kg, m2 };
  };

  const planned = [];
  for (const row of rows) {
    const mine = have.get(Number(row.id)) ?? {};
    const children = kids.get(String(row.id)) ?? [];

    if (children.length) {
      const { kg, m2 } = rollUp(row);
      if (mine.unit_weight_kg == null && kg > 0) {
        planned.push([row, 'unit_weight_kg', Number(kg.toFixed(3)), 'summed from its parts']);
      }
      if (mine.surface_area_m2 == null && m2 > 0) {
        planned.push([row, 'surface_area_m2', Number(m2.toFixed(3)), 'summed from its parts']);
      }
    }

    if (mine.weld_length_m == null) {
      let w = WELD_M[row.name];
      if (row.name === 'Segment') {
        /*
         * A SEGMENT HAS NO LENGTH OF ITS OWN — it is an assembly, and the
         * 12,000 or 11,650 lives on the flanges and web inside it. Reading
         * length_mm off the segment itself found nothing and skipped all four.
         */
        const longest = (kids.get(String(row.id)) ?? [])
          .map((c) => Number((have.get(Number(c.id)) ?? {}).length_mm) || 0)
          .reduce((a2, b2) => Math.max(a2, b2), 0);
        w = SEGMENT_WELD_M[longest] ?? null;
      }
      if (w != null) planned.push([row, 'weld_length_m', w, 'from the retired KEPL order']);
    }

    if (mine.num_holes == null && HOLES[row.name] != null) {
      planned.push([row, 'num_holes', HOLES[row.name], 'ASSUMED — no drawing value']);
    }
  }

  console.log(`ORDER ${ORDER} — ${planned.length} value(s) to write\n`);
  const bySrc = new Map();
  for (const [, , , src] of planned) bySrc.set(src, (bySrc.get(src) ?? 0) + 1);
  for (const [src, n] of bySrc) console.log(`  ${String(n).padStart(3)}  ${src}`);
  console.log('');
  for (const [row, key, value, src] of planned.slice(0, 14)) {
    console.log(`  ${String(row.name).slice(0, 30).padEnd(31)} ${key.padEnd(16)} ${String(value).padStart(10)}   ${src}`);
  }
  if (planned.length > 14) console.log(`  …and ${planned.length - 14} more`);

  if (APPLY) {
    for (const [row, key, value] of planned) {
      const f = fieldOf.get(key);
      if (!f) continue;
      await conn.query(
        `INSERT INTO fab_field_values
           (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
         VALUES (?,?,'order_item',?,?,?,NOW())
         ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
        [COMPANY, f.id, row.id, value, f.default_unit ?? null],
      );
    }
    await conn.commit();
    console.log('\nCommitted.');
  } else {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
  }
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
