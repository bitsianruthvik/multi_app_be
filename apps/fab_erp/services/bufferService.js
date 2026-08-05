/**
 * services/bufferService.js
 * -------------------------
 * EU-7: Buffer movement flow + load computation for fab_erp.
 *
 * SCHEMA
 *   fab_buffers — one input and/or output buffer per machine. Configuration
 *                 only: capacity, uom, thresholds. It is the ONLY table this
 *                 service owns; load is read from stock, never stored.
 *
 * WHERE THE LOAD COMES FROM
 * ─────────────────────────
 * fab_stock_pieces at the machine's WIP stock location — the same rows
 * wipInventoryService moves on task start. There is no separate buffer-contents
 * ledger; there was one until 2026-08-05 and it recorded the same physical fact
 * a second time, with no automatic drain, so the two diverged permanently.
 *
 * Capacity is a weight (capacity_uom 'kg', the default) or a piece count:
 *   - Weight uom, at least one piece carries the weight metric → Σ qty × metric.
 *   - Weight uom, no piece has it → count pieces instead, flagged via `fallback`.
 *   - Non-weight uom → always a piece count.
 * A partially-weighed buffer sums only the weighed pieces, so it reads LIGHTER
 * than it is. That is a real hazard while metric coverage is incomplete.
 */

import { pool } from '../../../db.js';
import { parseDependsOn } from './taskGatingService.js';

// Units we treat as weights (→ weigh the pieces). Everything else is interpreted
// as a piece count against capacity.
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
  // NULL, not 0, when there is no capacity to measure against. "Unconfigured"
  // and "empty" are different facts, and reporting the first as 0% made a buffer
  // nobody had set up look like a buffer with room to spare — which would have
  // let dispatch rank on a number that means nothing.
  const pct = capacity && capacity > 0 ? round2((load / capacity) * 100) : null;
  return { load: round2(load), capacity, pct, fallback };
}

/**
 * ok / warn / block for a load pct against a buffer's warn/block thresholds.
 * A null pct (no capacity configured) is 'ok': an unmeasured buffer must never
 * block work, and the caller can tell the two apart by checking pct itself.
 */
export function statusFor(pct, warnPct, blockPct) {
  if (pct == null) return 'ok';
  const p = Number(pct) || 0;
  if (blockPct != null && p >= Number(blockPct)) return 'block';
  if (warnPct != null && p >= Number(warnPct)) return 'warn';
  return 'ok';
}

/**
 * The stock location a buffer measures.
 *
 * fab_buffers.stock_location_id is a COPY, taken from fab_resources at config
 * time — and a machine's WIP area is auto-provisioned on its first task start,
 * so a buffer configured before the machine ever ran holds NULL forever. That is
 * not hypothetical: every buffer in the fixture was configured that way and all
 * six stored NULL while the machine went on to get a real location.
 *
 * So resolve live, by the code wipInventoryService assigns, and treat the stored
 * column as a hint rather than the answer.
 */
async function bufferLocationId(exec, companyId, buffer) {
  if (buffer.stock_location_id) return buffer.stock_location_id;
  if (!buffer.resource_id) return null;
  const [[loc]] = await exec.query(
    `SELECT id FROM fab_stock_locations
      WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, `WIP-M${buffer.resource_id}`.slice(0, 20)],
  );
  return loc?.id ?? null;
}

/**
 * Aggregate the WIP standing at a stock location, in the shape deriveLoad wants.
 *
 * This replaced a sum over fab_buffer_contents on 2026-08-05. That table was a
 * second, parallel record of the same physical fact: wipInventoryService already
 * moves a WIP piece from machine to machine on task start, inside the task's own
 * transaction and with a fab_stock_ledger row for every move, while
 * fab_buffer_contents was an append-only placement log with no drain except a
 * manual operator tap. Keeping both meant two truths that diverged the moment
 * someone forgot to tap Move — and the divergence only ever grew, because
 * placeOutput fired on every task stop and nothing ever closed a row.
 */
async function loadAtLocation(exec, companyId, locationId, weightMetricKey) {
  if (!locationId) return { weightSum: 0, qtySum: 0, cnt: 0, weightCnt: 0 };
  const [[agg]] = await exec.query(
    `SELECT SUM(p.qty * v.metric_value) AS weightSum,
            SUM(p.qty)                  AS qtySum,
            COUNT(*)                    AS cnt,
            COUNT(v.metric_value)       AS weightCnt
       FROM fab_stock_pieces p
       LEFT JOIN fab_item_metric_values v
              ON v.item_id = p.wip_item_id
             AND v.company_id = p.company_id
             AND v.metric_key = ?
             AND v.deleted_at IS NULL
      WHERE p.company_id = ? AND p.stock_location_id = ?
        AND p.status = 'wip' AND p.deleted_at IS NULL`,
    [weightMetricKey || 'unit_weight_kg', companyId, locationId],
  );
  return agg;
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
    `SELECT id, resource_id, stock_location_id, capacity_value, capacity_uom,
            weight_metric_key, warn_pct, block_pct
       FROM fab_buffers WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [bufferId, companyId],
  );
  if (!buffer) throw new Error(`Buffer ${bufferId} not found for company ${companyId}`);

  const locId = await bufferLocationId(exec, companyId, buffer);
  const agg = await loadAtLocation(exec, companyId, locId, buffer.weight_metric_key);

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


/*
 * snapshot() wrote a fab_buffer_level_snapshots row. Removed 2026-08-05 along
 * with the table: its only writer was placeOutput (gone with
 * fab_buffer_contents) and its only reader was analytics' input-buffer column,
 * which now derives the same figure live from fab_stock_pieces. The table held
 * zero rows in every environment, so that column had never displayed anything.
 *
 * A load is no longer a fact that has to be recorded when it changes — it is
 * a count of what is standing at a location, correct whenever it is asked for.
 */

/*
 * placeOutput() and moveContent() lived here until 2026-08-05, together with
 * computeContentWeight(). They maintained fab_buffer_contents: placeOutput
 * appended a row on every task stop, moveContent was the only thing that ever
 * set moved_out_at, and it was reachable only from a manual "Move" tap.
 *
 * The table has gone. What a machine is holding is now read from
 * fab_stock_pieces at that machine's WIP location, which wipInventoryService
 * already maintains transactionally on every task start with a ledger row per
 * move. One record of where the steel is, not two that drift apart.
 */



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
