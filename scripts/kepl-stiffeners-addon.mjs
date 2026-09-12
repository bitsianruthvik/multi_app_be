/**
 * kepl-stiffeners-addon.mjs — stiffeners out of the Segment's BOM, into the
 * catalog by size, and onto the KEPL order as rows added on the order.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * The Segment's BOM said every segment carries 1 + 1 bearing, 4 end and 21 + 3
 * intermediate stiffeners. KEPL's BOQ says otherwise, and it says it per girder:
 *
 *   middle segment   outer girders (G1, G4)  23 IS + 3 IS/D
 *                    inner girders (G2, G3)  20 IS + 6 IS/D
 *   end segment      G1   BS 200 + BS/D 210 + 4 ES 200        + 21 IS + 3 IS/D
 *                    G4   BS/D 210 + ES 210 + 4 ES 200         + 21 IS + 3 IS/D
 *                    G2/G3  2 BS/D 210 + 4 ES 210              + 18 IS + 6 IS/D
 *
 * No single recipe fits that, so stiffeners stop being part of the recipe. A
 * segment's BOM is its flanges and web; the stiffeners are chosen per order,
 * from sized catalog items, in the quantities the drawing gives.
 *
 * Which also means one "Line ×4" row cannot say it any more: G1, G4 and the two
 * inner girders differ. The line becomes three rows — G1 ×1, G2–G3 ×2, G4 ×1.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────
 *
 *   catalog   group "Stiffeners" (Fabricated) > "Plate Stiffeners", and one
 *             item per thickness × width. Length is the web depth of whichever
 *             girder it goes in, so it is set on the order row, not the item.
 *   BOM       the five stiffener lines come off Segment.
 *   order     through bomService.applyTree, so ids, sizes, tasks and plate
 *             links follow the same rules as an edit made on screen.
 *   values    num_holes for drilled stiffeners (assumed 4, as before), weld
 *             for new segments, weights and areas re-rolled for every assembly.
 *   tasks     built for the new rows, and every unstarted task re-synced.
 *
 * Nesting is NOT re-run. The blanks change (fewer 32 mm, more 12 mm), so the
 * accepted plan is stale and the Nesting step will say so; re-nesting and
 * accepting is the planner's call.
 *
 *   node scripts/kepl-stiffeners-addon.mjs            # dry run
 *   node scripts/kepl-stiffeners-addon.mjs --apply
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
const { currentTree, applyTree } = await import('../apps/fab_erp/services/bomService.js');
const { materializeOrderTasks, syncUnstartedTasks } = await import('../apps/fab_erp/services/taskGatingService.js');

const APPLY = process.argv.includes('--apply');
const C = 30005;
const ORDER = 1410063;
const FABRICATED = 360037;
const SEGMENT_ITEM = 450085;
const OLD_STIFFENERS = [450089, 450090, 450091, 450092, 660062];
const FLOW_PLAIN = 120001;
const FLOW_DRILLED = 120002;
const WEB_DEPTH = 2995;

/** The family: every thickness × width a plate girder commonly takes. */
const THICKNESSES = [10, 12, 16, 20, 25, 32];
const WIDTHS = [150, 170, 200, 210, 250];

/** One stiffener row on a segment. */
const st = (name, t, w, qty, drilled = false) => ({ name, t, w, qty, drilled });
const IS = (q) => st('Intermediate Stiffener Plain', 12, 170, q);
const ISD = (q) => st('Intermediate Stiffener Hole', 12, 170, q, true);

/** Per girder, per segment kind — read off the BOQ, checked against its weights. */
const SPEC = {
  G1: {
    mid: [IS(23), ISD(3)],
    end: [st('Bearing Stiffener Plain', 32, 200, 1), st('Bearing Stiffener Hole', 32, 210, 1, true),
      st('End Stiffener', 32, 200, 4), IS(21), ISD(3)],
  },
  'G2–G3': {
    mid: [IS(20), ISD(6)],
    end: [st('Bearing Stiffener Hole', 32, 210, 2, true), st('End Stiffener', 32, 210, 4), IS(18), ISD(6)],
  },
  G4: {
    mid: [IS(23), ISD(3)],
    end: [st('Bearing Stiffener Hole', 32, 210, 1, true), st('End Stiffener', 32, 210, 1),
      st('End Stiffener', 32, 200, 4), IS(21), ISD(3)],
  },
};
const LINES = [['G1', 1], ['G2–G3', 2], ['G4', 1]];

/** What the BOQ says one span holds, for the check below. */
const BOQ_PER_SPAN = {
  'IS 12x170': 414, 'IS/D 12x170': 90, 'BS 32x200': 2, 'BS/D 32x210': 12, 'ES 32x210': 18, 'ES 32x200': 16,
};

const conn = await pool.getConnection();
try {
  // The code generator creates its table on first use, and that statement
  // would end an open transaction — so it runs before one is opened.
  await getRule(C, 'item');
  await conn.beginTransaction();

  // ── 1. catalog ────────────────────────────────────────────────────────────
  let [[group]] = await conn.query(
    `SELECT id FROM fab_item_groups WHERE company_id = ? AND category_id = ? AND name = 'Stiffeners' AND deleted_at IS NULL`,
    [C, FABRICATED],
  );
  if (!group && APPLY) {
    const [r] = await conn.query(
      `INSERT INTO fab_item_groups (company_id, category_id, name, code, shortform, description, is_system, created_at)
       VALUES (?, ?, 'Stiffeners', 'stiffeners', 'STF', 'Flat plate stiffeners, by thickness x width. Any girder.', 0, NOW())`,
      [C, FABRICATED],
    );
    group = { id: r.insertId };
  }
  let [[sub]] = group ? await conn.query(
    `SELECT id FROM fab_item_subgroups WHERE company_id = ? AND group_id = ? AND name = 'Plate Stiffeners' AND deleted_at IS NULL`,
    [C, group.id],
  ) : [[null]];
  if (!sub && APPLY) {
    const [r] = await conn.query(
      `INSERT INTO fab_item_subgroups (company_id, group_id, name, code, shortform, description, is_system, created_at)
       VALUES (?, ?, 'Plate Stiffeners', 'STF-PLATE', 'STF-PLATE', 'Length is set on the order — it is the web depth.', 0, NOW())`,
      [C, group.id],
    );
    sub = { id: r.insertId };
  }

  const [fieldRows] = await conn.query(
    `SELECT id, field_key, default_unit FROM fab_fields WHERE company_id = ? AND deleted_at IS NULL
      AND field_key IN ('thickness_mm','width_mm','num_holes','weld_length_m','unit_weight_kg','surface_area_m2')`,
    [C],
  );
  const field = new Map(fieldRows.map((f) => [f.field_key, f]));

  const stiffenerId = new Map();   // "t x w" -> catalog id
  let itemsCreated = 0;
  for (const t of THICKNESSES) {
    for (const w of WIDTHS) {
      const name = `Stiffener ${t} × ${w}`;
      const [[have]] = await conn.query(
        `SELECT id FROM fab_item_catalog WHERE company_id = ? AND name = ? AND deleted_at IS NULL`, [C, name],
      );
      if (have) { stiffenerId.set(`${t}x${w}`, Number(have.id)); continue; }
      if (!APPLY) { stiffenerId.set(`${t}x${w}`, -1); itemsCreated++; continue; }
      const code = await generateCode(C, 'item', { categoryId: FABRICATED }, conn);
      const [r] = await conn.query(
        `INSERT INTO fab_item_catalog
           (company_id, name, code, unit, description, category_id, group_id, subgroup_id,
            procurement_type, thickness_mm, created_at)
         VALUES (?, ?, ?, 'nos', ?, ?, ?, ?, 'make', ?, NOW())`,
        [C, name, code, `Flat stiffener ${t} mm thick, ${w} mm wide. Length on the order.`,
          FABRICATED, group.id, sub.id, t],
      );
      const id = r.insertId;
      for (const [k, v] of [['thickness_mm', t], ['width_mm', w]]) {
        await conn.query(
          `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
           VALUES (?, ?, 'catalog_item', ?, ?, 'mm', NOW())
           ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
          [C, field.get(k).id, id, v],
        );
      }
      stiffenerId.set(`${t}x${w}`, id);
      itemsCreated++;
    }
  }
  console.log(`catalog: ${itemsCreated} stiffener item(s) ${APPLY ? 'created' : 'to create'} under Fabricated > Stiffeners > Plate Stiffeners`);

  // ── 2. the Segment BOM loses its stiffeners ──────────────────────────────
  const [bomLines] = await conn.query(
    `SELECT id FROM fab_item_bom WHERE company_id = ? AND parent_item_id = ? AND child_item_id IN (?) AND deleted_at IS NULL`,
    [C, SEGMENT_ITEM, OLD_STIFFENERS],
  );
  if (APPLY && bomLines.length) {
    await conn.query(`UPDATE fab_item_bom SET deleted_at = NOW() WHERE id IN (?)`, [bomLines.map((b) => b.id)]);
  }
  console.log(`BOM: ${bomLines.length} stiffener line(s) ${APPLY ? 'removed from' : 'to remove from'} Segment`);

  // ── 3. the order ─────────────────────────────────────────────────────────
  const [lines] = await conn.query(
    `SELECT id, description FROM fab_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY line_no`,
    [C, ORDER],
  );
  const totals = [];
  for (const line of lines) {
    const tree = await currentTree(C, ORDER, line.id, conn);
    const lineIdx = tree.children.findIndex((c) => c.catalogItemId === 450084);
    const line0 = tree.children[lineIdx];
    if (!line0) throw new Error(`No Line under ${line.description}`);
    if (Number(line0.qty) !== 4) throw new Error(`Line qty is ${line0.qty}, expected 4 — already converted?`);

    /** A fresh copy of a subtree: no ids, so applyTree inserts it. */
    const fresh = (n) => ({ ...n, itemId: undefined, key: undefined, children: (n.children ?? []).map(fresh) });
    const kindOf = (seg) => {
      const tf = seg.children.find((c) => /Top Flange/.test(c.name));
      return Number(tf?.dims?.length_mm) === 11650 ? 'end' : 'mid';
    };
    const stiffenerRows = (spec) => spec.map((s) => ({
      catalogItemId: stiffenerId.get(`${s.t}x${s.w}`),
      name: s.name,
      unit: 'nos',
      qty: s.qty,
      defaultFlowId: s.drilled ? FLOW_DRILLED : FLOW_PLAIN,
      dims: { thickness_mm: s.t, width_mm: s.w, length_mm: WEB_DEPTH },
      children: [],
    }));
    const build = (base, label, qty, keepIds) => {
      const src = keepIds ? base : fresh(base);
      return {
        ...src,
        name: `Line ${label}`,
        qty,
        children: src.children.map((seg) => ({
          ...seg,
          children: [
            ...seg.children.filter((c) => !OLD_STIFFENERS.includes(Number(c.catalogItemId))
              && !/Stiffener/.test(c.name)),
            ...stiffenerRows(SPEC[label][kindOf(seg)]),
          ],
        })),
      };
    };
    const newLines = LINES.map(([label, qty], i) => build(line0, label, qty, i === 0));
    tree.children.splice(lineIdx, 1, ...newLines);

    // the check: stiffeners per span, against the BOQ
    const count = {};
    for (const [label, qty] of LINES) {
      for (const seg of line0.children) {
        for (const s of SPEC[label][kindOf(seg)]) {
          const k = `${s.name.startsWith('Intermediate') ? 'IS' : s.name.startsWith('Bearing') ? 'BS' : 'ES'}${s.drilled ? '/D' : ''} ${s.t}x${s.w}`;
          count[k] = (count[k] ?? 0) + s.qty * Number(seg.qty) * qty;
        }
      }
    }
    totals.push([line.description, count]);

    if (APPLY) {
      const res = await applyTree(C, { orderId: ORDER, orderLineId: line.id, tree }, conn);
      console.log(`${line.description} (line ${line.id}): +${res.created} rows, ${res.updated} changed, ${res.removed} removed, ${res.sized} sizes`);
    }
  }

  console.log('\nStiffeners per span  (order  vs  BOQ)');
  for (const [name, count] of totals) {
    for (const [k, want] of Object.entries(BOQ_PER_SPAN)) {
      const got = count[k] ?? 0;
      console.log(`  ${name.padEnd(6)} ${k.padEnd(14)} ${String(got).padStart(4)}  ${String(want).padStart(4)}  ${got === want ? 'match' : 'DIFFERS'}`);
    }
  }

  if (APPLY) {
    // ── 4. values the flows need ───────────────────────────────────────────
    const [rows] = await conn.query(
      `SELECT id, parent_item_id AS p, name, qty FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND node_kind = 'structure'
          AND order_line_id IS NOT NULL`,
      [C, ORDER],
    );
    const [vals] = await conn.query(
      `SELECT v.scope_id AS id, f.field_key AS k, v.value_num AS n FROM fab_field_values v
         JOIN fab_fields f ON f.id = v.field_id
        WHERE v.company_id = ? AND v.scope = 'order_item' AND v.deleted_at IS NULL AND v.scope_id IN (?)
          AND f.field_key IN ('unit_weight_kg','surface_area_m2','length_mm','weld_length_m','num_holes')`,
      [C, rows.map((r) => r.id)],
    );
    const have = new Map();
    for (const v of vals) { const e = have.get(Number(v.id)) ?? {}; e[v.k] = v.n == null ? null : Number(v.n); have.set(Number(v.id), e); }
    const kids = new Map();
    for (const r of rows) { const k = String(r.p ?? 'root'); kids.set(k, [...(kids.get(k) ?? []), r]); }
    const roll = (r) => {
      const ch = kids.get(String(r.id)) ?? [];
      const me = have.get(Number(r.id)) ?? {};
      if (!ch.length) return { kg: me.unit_weight_kg ?? 0, m2: me.surface_area_m2 ?? 0 };
      return ch.reduce((a, c) => { const x = roll(c); return { kg: a.kg + x.kg * Number(c.qty), m2: a.m2 + x.m2 * Number(c.qty) }; }, { kg: 0, m2: 0 });
    };
    const put = async (id, key, value) => {
      const f = field.get(key);
      await conn.query(
        `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
         VALUES (?, ?, 'order_item', ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
        [C, f.id, id, value, f.default_unit ?? null],
      );
    };
    let wrote = 0;
    for (const r of rows) {
      const ch = kids.get(String(r.id)) ?? [];
      const me = have.get(Number(r.id)) ?? {};
      if (ch.length) {
        // An assembly weighs what its parts weigh — and its parts just changed.
        const { kg, m2 } = roll(r);
        if (kg > 0) { await put(r.id, 'unit_weight_kg', Number(kg.toFixed(3))); wrote++; }
        if (m2 > 0) { await put(r.id, 'surface_area_m2', Number(m2.toFixed(3))); wrote++; }
      }
      if (r.name === 'Segment' && me.weld_length_m == null) {
        const longest = ch.reduce((m, c) => Math.max(m, (have.get(Number(c.id)) ?? {}).length_mm ?? 0), 0);
        const w = { 12000: 227.74, 11650: 249.6 }[longest];
        if (w != null) { await put(r.id, 'weld_length_m', w); wrote++; }
      }
      if (/\(drilled\)/.test(r.name) && me.num_holes == null) { await put(r.id, 'num_holes', 4); wrote++; }
    }
    console.log(`\nvalues: ${wrote} written (weights and areas re-rolled, weld on new segments, 4 holes on drilled stiffeners — ASSUMED)`);

    // ── 5. tasks ────────────────────────────────────────────────────────────
    const built = await materializeOrderTasks(conn, C, ORDER);
    const synced = await syncUnstartedTasks(conn, C, ORDER);
    console.log(`tasks: ${built.tasksInserted} built for new rows, ${synced} re-synced`);

    await conn.commit();
    console.log('\nCommitted.');
  } else {
    await conn.rollback();
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  }
} catch (err) {
  await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
