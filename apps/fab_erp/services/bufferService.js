/**
 * services/bufferService.js
 * -------------------------
 * EU-7: Buffer movement flow + load computation for fab_erp.
 *
 * Builds on the EU-6 buffer schema:
 *   fab_buffers            — one input and/or output buffer per machine (resource).
 *   fab_buffer_contents    — one row per item placed in a buffer; "open" while
 *                            moved_out_at IS NULL.
 *   fab_buffer_level_snapshots — point-in-time load/capacity/pct history rows.
 *
 * Load model
 * ──────────
 * A buffer's capacity is expressed either as a weight (capacity_uom = 'kg', the
 * default) or as a piece count (any non-weight uom, e.g. 'pcs'). We compute load
 * to match:
 *   - Weight uom + at least one open row carries a computed_weight → Σ computed_weight.
 *   - Weight uom but NO open row has a weight metric (all NULL) → fall back to
 *     counting pieces (Σ qty, or the open row COUNT when qty is also NULL). This is
 *     the "items have no weight metric available" fallback — it never blocks on a
 *     null weight and never returns NaN.
 *   - Non-weight uom → always a piece count (Σ qty, or open row COUNT).
 *
 * All state-changing helpers accept an optional mysql connection so they can run
 * inside a caller's transaction (e.g. moveContent) or standalone on the pool (e.g.
 * placeOutput fired from the task-stop route).
 */

import { pool } from '../../../db.js';
import { parseDependsOn } from './taskGatingService.js';

// Units we treat as weights (→ use computed_weight for load). Everything else is
// interpreted as a piece count against capacity.
const WEIGHT_UOMS = new Set([
  'kg', 'kgs', 'kilogram', 'kilograms',
  'g', 'gram', 'grams',
  'mg',
  't', 'mt', 'ton', 'tons', 'tonne', 'tonnes',
  'lb', 'lbs', 'pound', 'pounds', 'oz',
]);

function isWeightUom(uom) {
  return WEIGHT_UOMS.has(String(uom ?? '').trim().toLowerCase());
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Error the /buffers/move route maps to a 400 (bad request) rather than a 500. */
export class BufferMoveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BufferMoveError';
    this.userError = true;
  }
}

/**
 * Derive {load, capacity, pct, fallback} from a buffer row + an aggregate of its
 * OPEN contents. Pure — shared by loadOf (single buffer) and the board route
 * (many buffers in one grouped query), so the load rule lives in exactly one place.
 *
 * @param {object} buffer  fab_buffers row (needs capacity_value, capacity_uom)
 * @param {object} agg     { weightSum, qtySum, cnt, weightCnt } over open rows
 */
export function deriveLoad(buffer, agg) {
  const weightSum = Number(agg?.weightSum ?? 0);
  const qtySum = Number(agg?.qtySum ?? 0);
  const cnt = Number(agg?.cnt ?? 0);
  const weightCnt = Number(agg?.weightCnt ?? 0);

  let load;
  let fallback = null;
  if (isWeightUom(buffer.capacity_uom)) {
    if (weightCnt > 0) {
      load = weightSum; // normal weight-based load
    } else if (cnt > 0) {
      load = qtySum > 0 ? qtySum : cnt; // no weight metric on any item → count pieces
      fallback = 'piece_count_no_weight_metric';
    } else {
      load = 0; // empty buffer
    }
  } else {
    load = qtySum > 0 ? qtySum : cnt; // piece-count buffer
    fallback = 'piece_count_non_weight_uom';
  }

  const capacity = buffer.capacity_value == null ? null : Number(buffer.capacity_value);
  const pct = capacity && capacity > 0 ? round2((load / capacity) * 100) : 0; // guard /0
  return { load: round2(load), capacity, pct, fallback };
}

/** ok / warn / block for a load pct against a buffer's warn/block thresholds. */
export function statusFor(pct, warnPct, blockPct) {
  const p = Number(pct) || 0;
  if (blockPct != null && p >= Number(blockPct)) return 'block';
  if (warnPct != null && p >= Number(warnPct)) return 'warn';
  return 'ok';
}

/**
 * Current load of a buffer.
 * @returns {Promise<{load:number, capacity:number|null, pct:number, uom:string,
 *                    warnPct:number, blockPct:number, fallback:string|null}>}
 * `fallback` names which piece-count fallback (if any) produced the load.
 */
export async function loadOf(companyId, bufferId, conn) {
  const exec = conn ?? pool;
  const [[buffer]] = await exec.query(
    `SELECT id, capacity_value, capacity_uom, weight_metric_key, warn_pct, block_pct
       FROM fab_buffers WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [bufferId, companyId],
  );
  if (!buffer) throw new Error(`Buffer ${bufferId} not found for company ${companyId}`);

  const [[agg]] = await exec.query(
    `SELECT SUM(computed_weight) AS weightSum,
            SUM(qty)             AS qtySum,
            COUNT(*)             AS cnt,
            COUNT(computed_weight) AS weightCnt
       FROM fab_buffer_contents
      WHERE company_id = ? AND buffer_id = ? AND moved_out_at IS NULL AND deleted_at IS NULL`,
    [companyId, bufferId],
  );

  const d = deriveLoad(buffer, agg);
  return {
    load: d.load,
    capacity: d.capacity,
    pct: d.pct,
    uom: buffer.capacity_uom,
    warnPct: buffer.warn_pct,
    blockPct: buffer.block_pct,
    fallback: d.fallback,
  };
}

/**
 * qty × the item's weight_metric_key metric value (fab_item_metric_values).
 * Returns null when the item has no such metric (piece-fallback: the caller stores
 * NULL computed_weight, which loadOf then treats as a piece count).
 */
export async function computeContentWeight(companyId, buffer, itemId, qty, conn) {
  const exec = conn ?? pool;
  const key = buffer.weight_metric_key || 'unit_weight_kg';
  const [[row]] = await exec.query(
    `SELECT metric_value FROM fab_item_metric_values
      WHERE company_id = ? AND item_id = ? AND metric_key = ?
        AND metric_value IS NOT NULL AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [companyId, itemId, key],
  );
  if (!row || row.metric_value == null) return null; // no weight metric → piece-fallback
  const q = Number(qty ?? 0);
  return round2(q * Number(row.metric_value));
}

/** Write a fab_buffer_level_snapshots row from loadOf (AFTER any pending insert). */
export async function snapshot(companyId, bufferId, conn) {
  const exec = conn ?? pool;
  const { load, capacity, pct } = await loadOf(companyId, bufferId, conn);
  await exec.query(
    `INSERT INTO fab_buffer_level_snapshots (company_id, buffer_id, at, load_value, capacity_value, pct)
     VALUES (?, ?, NOW(), ?, ?, ?)`,
    [companyId, bufferId, load, capacity, pct],
  );
  return { load, capacity, pct };
}

/**
 * If the just-completed task's machine has an active output buffer, place the
 * produced item into it and snapshot the buffer. No-op (returns {placed:false})
 * when the machine has no output buffer — buffers are opt-in.
 *
 * `task` needs at least `id`; assigned_resource_id / item_id are re-read from the
 * row when not supplied (the stop route passes a minimal {id, status}). Produced
 * qty is the item's own qty (fab_items.qty) — there is no per-task produced qty
 * column. Safe to call inside a caller transaction via `conn`.
 */
export async function placeOutput(companyId, task, conn) {
  const exec = conn ?? pool;

  let assignedResourceId = task.assigned_resource_id;
  let itemId = task.item_id;
  if (assignedResourceId === undefined || itemId === undefined) {
    const [[t]] = await exec.query(
      `SELECT assigned_resource_id, item_id FROM fab_project_tasks
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [task.id, companyId],
    );
    if (!t) return { placed: false, reason: 'task_not_found' };
    assignedResourceId = t.assigned_resource_id;
    itemId = t.item_id;
  }
  if (!assignedResourceId) return { placed: false, reason: 'no_assigned_resource' };

  const [[buffer]] = await exec.query(
    `SELECT id, capacity_uom, weight_metric_key FROM fab_buffers
      WHERE company_id = ? AND resource_id = ? AND kind = 'output'
        AND active = 1 AND deleted_at IS NULL LIMIT 1`,
    [companyId, assignedResourceId],
  );
  if (!buffer) return { placed: false, reason: 'no_output_buffer' };

  const [[item]] = await exec.query(
    `SELECT qty FROM fab_items WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [itemId, companyId],
  );
  const qty = item ? Number(item.qty) : null;
  const computedWeight = await computeContentWeight(companyId, buffer, itemId, qty, conn);

  const [ins] = await exec.query(
    `INSERT INTO fab_buffer_contents
       (company_id, buffer_id, task_id, item_id, qty, unit, computed_weight, placed_at, moved_out_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NULL)`,
    [companyId, buffer.id, task.id, itemId, qty, null, computedWeight],
  );
  const contentId = ins.insertId;

  const snap = await snapshot(companyId, buffer.id, conn);
  return {
    placed: true,
    bufferId: buffer.id,
    contentId,
    load: snap.load,
    capacity: snap.capacity,
    pct: snap.pct,
  };
}

/**
 * Move an open content row from its current buffer to `toBufferId`: close the
 * source row (moved_out_at = NOW), open a fresh row in the destination with the
 * weight recomputed for the destination buffer's weight_metric_key, and snapshot
 * BOTH buffers. Single transaction.
 *
 * @returns {Promise<{ok:true, movedContentId:number, newContentId:number,
 *                     fromBufferId:number, toBufferId:number}>}
 * @throws {BufferMoveError} when the source content or destination buffer is invalid.
 */
export async function moveContent(companyId, { contentId, toBufferId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[src]] = await conn.query(
      `SELECT id, buffer_id, task_id, item_id, qty, unit FROM fab_buffer_contents
        WHERE id = ? AND company_id = ? AND moved_out_at IS NULL AND deleted_at IS NULL LIMIT 1`,
      [contentId, companyId],
    );
    if (!src) throw new BufferMoveError(`Content ${contentId} not found or already moved out.`);

    const [[dest]] = await conn.query(
      `SELECT id, capacity_uom, weight_metric_key FROM fab_buffers
        WHERE id = ? AND company_id = ? AND active = 1 AND deleted_at IS NULL LIMIT 1`,
      [toBufferId, companyId],
    );
    if (!dest) throw new BufferMoveError(`Destination buffer ${toBufferId} not found or inactive.`);

    if (src.buffer_id === dest.id) {
      throw new BufferMoveError('Source and destination buffers are the same.');
    }

    const computedWeight = await computeContentWeight(companyId, dest, src.item_id, src.qty, conn);

    await conn.query(
      `UPDATE fab_buffer_contents SET moved_out_at = NOW() WHERE id = ? AND company_id = ?`,
      [contentId, companyId],
    );

    const [ins] = await conn.query(
      `INSERT INTO fab_buffer_contents
         (company_id, buffer_id, task_id, item_id, qty, unit, computed_weight, placed_at, moved_out_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NULL)`,
      [companyId, toBufferId, src.task_id, src.item_id, src.qty, src.unit, computedWeight],
    );
    const newContentId = ins.insertId;

    await snapshot(companyId, src.buffer_id, conn);
    await snapshot(companyId, toBufferId, conn);

    await conn.commit();
    return {
      ok: true,
      movedContentId: contentId,
      newContentId,
      fromBufferId: src.buffer_id,
      toBufferId,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Resolve the input buffer of the FIRST downstream machine for a task, for the
 * one-tap "move to next machine". Mirrors taskGatingService's successor semantics
 * (inverted):
 *
 *   1. Intra-item process successors — sibling tasks in the same (item_id, flow_id)
 *      that depend on this task: a sibling S is a successor when parseDependsOn(S.
 *      depends_on) includes this task's seq_no, OR (S has no explicit deps) this
 *      task is S's immediate predecessor (largest seq_no < S.seq_no) — the exact
 *      inverse of processPredecessorsDone's prev-step rule.
 *   2. Cross-BOM successors — only when this task is its item's TERMINAL task (max
 *      seq_no, i.e. terminalTaskDone's definition of "item produced"): tasks that
 *      gate on this item via fab_task_inputs.producing_item_id = this.item_id.
 *
 * Successors are ordered (seq_no, then id) and the first whose assigned machine has
 * an active input buffer wins. Returns that fab_buffers row, or null.
 */
export async function resolveNextInputBuffer(companyId, task, conn) {
  const exec = conn ?? pool;

  let { id, item_id, flow_id, seq_no } = task;
  if (item_id === undefined || flow_id === undefined || seq_no === undefined || id === undefined) {
    const [[t]] = await exec.query(
      `SELECT id, item_id, flow_id, seq_no FROM fab_project_tasks
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id ?? task.id, companyId],
    );
    if (!t) return null;
    ({ id, item_id, flow_id, seq_no } = t);
  }

  const [siblings] = await exec.query(
    `SELECT id, seq_no, depends_on, assigned_resource_id FROM fab_project_tasks
      WHERE company_id = ? AND item_id = ? AND flow_id = ? AND deleted_at IS NULL`,
    [companyId, item_id, flow_id],
  );
  const seqNos = siblings.map((s) => s.seq_no).sort((a, b) => a - b);

  const successors = [];
  for (const s of siblings) {
    if (s.id === id) continue;
    const deps = parseDependsOn(s.depends_on);
    let isSucc;
    if (deps.length > 0) {
      isSucc = deps.includes(seq_no);
    } else {
      let prev = null;
      for (const sn of seqNos) if (sn < s.seq_no && (prev === null || sn > prev)) prev = sn;
      isSucc = prev === seq_no;
    }
    if (isSucc) {
      successors.push({ id: s.id, seq_no: s.seq_no, assignedResourceId: s.assigned_resource_id });
    }
  }

  // Cross-BOM: only the item's terminal task "produces" the item (terminalTaskDone).
  const [[mx]] = await exec.query(
    `SELECT MAX(seq_no) AS mx FROM fab_project_tasks
      WHERE company_id = ? AND item_id = ? AND deleted_at IS NULL`,
    [companyId, item_id],
  );
  if (mx && mx.mx != null && Number(seq_no) === Number(mx.mx)) {
    const [consumers] = await exec.query(
      `SELECT DISTINCT ti.task_id, t.seq_no, t.assigned_resource_id
         FROM fab_task_inputs ti
         JOIN fab_project_tasks t ON t.id = ti.task_id AND t.deleted_at IS NULL
        WHERE ti.company_id = ? AND ti.producing_item_id = ? AND ti.deleted_at IS NULL`,
      [companyId, item_id],
    );
    for (const c of consumers) {
      if (c.task_id === id) continue;
      successors.push({ id: c.task_id, seq_no: c.seq_no, assignedResourceId: c.assigned_resource_id });
    }
  }

  successors.sort((a, b) => (a.seq_no - b.seq_no) || (a.id - b.id));
  for (const s of successors) {
    if (!s.assignedResourceId) continue;
    const [[buf]] = await exec.query(
      `SELECT * FROM fab_buffers
        WHERE company_id = ? AND resource_id = ? AND kind = 'input'
          AND active = 1 AND deleted_at IS NULL LIMIT 1`,
      [companyId, s.assignedResourceId],
    );
    if (buf) return buf;
  }
  return null;
}
