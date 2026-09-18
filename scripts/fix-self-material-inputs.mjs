/**
 * fix-self-material-inputs.mjs — parts that wait for stock of themselves.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────────
 *
 * When a part's tasks were raised before it had a material link (nested later),
 * `planOrderTasks` fell back to the part's OWN catalog type as its raw-material
 * input. So "Top Flange" waited for a Top Flange to be in stock. That never
 * clears by itself — and clears the WRONG way the moment any other order
 * finishes a Top Flange: the gate passes and the start draws that other order's
 * part. The materialiser skips tasks that exist, so nesting afterwards never
 * repaired them. The fallback is fixed in taskGatingService (2026-09-18); this
 * repairs inputs already written.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 *
 * For every live raw_material input whose catalog item IS its task's own row
 * type, on a MADE row, on a task that has not started:
 *   · the row now has material children → replace the input with one per child
 *     (exactly what the materialiser writes today)
 *   · it still has none                → drop the input (readiness is what
 *     catches an un-nested part, not a gate on itself)
 * Started tasks are reported and left alone.
 *
 *   node scripts/fix-self-material-inputs.mjs                 # local, dry run
 *   node scripts/fix-self-material-inputs.mjs --apply         # local
 *   node scripts/fix-self-material-inputs.mjs --prod          # TiDB, dry run
 *   node scripts/fix-self-material-inputs.mjs --prod --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.argv.includes('--prod');
const APPLY = process.argv.includes('--apply');

if (PROD) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, {
    DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
  });
}
const { pool } = await import('../db.js');

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [bad] = await conn.query(
    `SELECT ti.id, ti.company_id, ti.task_id, ti.order_id, ti.unit, ti.gate,
            t.item_id, t.status, t.started_at, o.order_number,
            i.name AS item_name
       FROM fab_task_inputs ti
       JOIN fab_project_tasks t ON t.id = ti.task_id AND t.deleted_at IS NULL
       JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_orders o ON o.id = t.order_id
      WHERE ti.deleted_at IS NULL
        AND ti.input_role = 'raw_material'
        AND ti.ref_catalog_item_id = i.catalog_item_id
        AND i.procurement_type = 'make'
      ORDER BY o.order_number, t.item_id, t.seq_no`,
  );

  console.log(`${PROD ? 'PROD' : 'LOCAL'} — ${bad.length} input(s) naming their own row type\n`);

  const byOrder = new Map();
  let replaced = 0, dropped = 0, skipped = 0, added = 0;

  for (const b of bad) {
    const tally = byOrder.get(b.order_number) ?? { replaced: 0, dropped: 0, skipped: 0 };
    byOrder.set(b.order_number, tally);

    if (b.started_at != null || ['in_progress', 'paused', 'done'].includes(b.status)) {
      skipped += 1; tally.skipped += 1;
      console.log(`  SKIP  task ${b.task_id} (${b.item_name}) — already ${b.status}`);
      continue;
    }

    const [mats] = await conn.query(
      `SELECT catalog_item_id, qty FROM fab_items
        WHERE company_id = ? AND parent_item_id = ? AND node_kind = 'material'
          AND catalog_item_id IS NOT NULL AND deleted_at IS NULL`,
      [b.company_id, b.item_id],
    );

    if (APPLY) {
      await conn.query(
        `UPDATE fab_task_inputs SET deleted_at = NOW() WHERE id = ?`,
        [b.id],
      );
    }

    if (!mats.length) {
      dropped += 1; tally.dropped += 1;
      continue;
    }

    replaced += 1; tally.replaced += 1;
    for (const m of mats) {
      const [[dup]] = await conn.query(
        `SELECT COUNT(*) AS n FROM fab_task_inputs
          WHERE company_id = ? AND task_id = ? AND input_role = 'raw_material'
            AND ref_catalog_item_id = ? AND deleted_at IS NULL`,
        [b.company_id, b.task_id, m.catalog_item_id],
      );
      if (Number(dup.n) > 0) continue;
      added += 1;
      if (APPLY) {
        await conn.query(
          `INSERT INTO fab_task_inputs
             (company_id, task_id, order_id, input_role, ref_catalog_item_id, qty, unit, gate)
           VALUES (?, ?, ?, 'raw_material', ?, ?, ?, ?)`,
          [b.company_id, b.task_id, b.order_id, m.catalog_item_id, m.qty ?? null, b.unit, b.gate],
        );
      }
    }
  }

  /**
   * ── ALSO: component gates on rows that no longer exist ──────────────────
   *
   * An assembly's component input names the child ROW it waits for. When that
   * row is later deleted (the KEPL rebuild of 2026-09-11 removed 20), the gate
   * asks whether a deleted row's last step is done — never — so the assembly
   * waits forever. The row is gone from the structure, so the wait is for
   * nothing: drop the input. Unstarted tasks only.
   */
  const [stale] = await conn.query(
    `SELECT ti.id, ti.task_id, o.order_number
       FROM fab_task_inputs ti
       JOIN fab_project_tasks t ON t.id = ti.task_id AND t.deleted_at IS NULL
       JOIN fab_items c ON c.id = ti.producing_item_id
       LEFT JOIN fab_orders o ON o.id = t.order_id
      WHERE ti.deleted_at IS NULL AND ti.input_role = 'component'
        AND c.deleted_at IS NOT NULL
        AND t.started_at IS NULL AND t.status NOT IN ('in_progress', 'paused', 'done')`,
  );
  const staleByOrder = new Map();
  for (const s of stale) staleByOrder.set(s.order_number, (staleByOrder.get(s.order_number) ?? 0) + 1);
  if (APPLY && stale.length) {
    await conn.query(
      `UPDATE fab_task_inputs SET deleted_at = NOW() WHERE id IN (?)`,
      [stale.map((s) => s.id)],
    );
  }
  for (const [order, n] of staleByOrder) {
    console.log(`  ${order}: ${n} component gate(s) waiting on deleted rows — dropped`);
  }

  for (const [order, t] of byOrder) {
    console.log(`  ${order}: ${t.replaced} now wait on their real material, ${t.dropped} dropped (no material yet), ${t.skipped} started — left alone`);
  }
  console.log(`\nTotal: ${replaced} replaced (${added} new inputs), ${dropped} dropped, ${skipped} skipped`);

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
