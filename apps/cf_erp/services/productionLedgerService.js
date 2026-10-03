/**
 * productionLedgerService.js — stock follows the steel up and down the BOM
 * (CF_ERP_WIP_LEDGER_PLAN.md, init.sql §45).
 *
 *   Pieces JOIN their parent when the joining step STARTS.
 *   A piece SPLITS into its children when the splitting step is DONE.
 *   The top piece goes to finished stock when its flow is done (stockFinished).
 *
 * Every tracker node is a LOT of its own (cf_stock_batches.production_item_id)
 * in the company's one production WIP area. Bought material (plates, bolts)
 * leaves storage from its reservation when the step that needs it starts — a
 * plate when its cutting is DONE (cutting is a split).
 *
 * RECONCILED, NEVER REPLAYED. Each step remembers what it has posted
 * (ledger_in: joined at its start, ledger_out: split at its done). After any
 * change to steps, `ledgerOnSteps` works out what each step's state SAYS the
 * ledger should hold and posts only the difference — so a correction (a step
 * put back, a count lowered) is the exact reverse, by the same code. One
 * function, called by every path that writes a step (tracker, floor screens,
 * machine log).
 *
 * HOW A STEP IS RECOGNISED — no setup:
 *   cut     the first step of a CUT-PLATE node: its plate is cut. A nest
 *           group's GATE (releaseService.lotGates) cuts every plate of the group
 *           into all the group's cut pieces + its offcuts; a cut plate not on a
 *           nest cuts its own plate requirement into itself; any other node of a
 *           nested cut plate is made by its gate (nothing of its own).
 *   join    a node's first step (not a cut plate), and any later step that waits
 *           on one of its children (a re-join after a dismantle).
 *   split   a step a child waits on with required 'done' (dismantling).
 *   loose   a requirement on a step that is not a cut — consumed at its start.
 *
 * A START NEEDS ITS INPUTS ONE LEVEL BELOW (no deadlock): children lying in WIP
 * as themselves, bought material reserved. A made child not there yet, or
 * material not reserved, refuses the start in words (user decision: steel never
 * comes from nowhere). Value is material only: a join carries the sum of what
 * went in; a split hands each child back what it brought (anything bought into
 * the container on the way is shared by value); a cut shares the plate's value
 * by weight, the rest is cutting loss.
 */
import { invalid } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { lotsOfLines, lotGates } from './releaseService.js';
import { unitKgOf, lotPlateKg } from './valuationService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
const fmt = (n) => Number(Number(n).toFixed(3));
const groupBy = (rows, k) => { const m = new Map(); for (const r of rows) { const key = r[k]; if (!m.has(key)) m.set(key, []); m.get(key).push(r); } return m; };

export const WIP_AREA_CODE = 'PROD-WIP';
export const OFFCUT_NODE_CODE = 'OFFCUT';
const CUT_PLATE_NODE_CODE = 'CUT_PLATE';

// --- where WIP lives ------------------------------------------------------------

/** The company's production WIP area, made on first need (user: ONE area per company). */
export async function wipArea(db, c) {
  const [[a]] = await db.query("SELECT * FROM cf_stocking_areas WHERE company_id = ? AND code = ? AND deleted_at IS NULL", [c.companyId, WIP_AREA_CODE]);
  if (a) return a;
  await db.query(
    "INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status, created_by) VALUES (?, ?, 'Production (work in progress)', 'wip', 'active', ?)",
    [c.companyId, WIP_AREA_CODE, c.userId ?? null],
  );
  const [[made]] = await db.query("SELECT * FROM cf_stocking_areas WHERE company_id = ? AND code = ? AND deleted_at IS NULL", [c.companyId, WIP_AREA_CODE]);
  return made;
}

// --- the writer: one movement, every line, a fixed number of statements --------

/**
 * Posts one 'transform' movement. legs: [{ areaId, itemId, batchId, delta, unitCost?, value? }].
 * Balances are locked and checked together; a leg taking more than is there
 * refuses the whole movement. Returns the movement id.
 */
export async function writeTransform(db, c, { reference, notes, orderId = null, orderLineId = null, legs }) {
  // A value-only leg (quantity 0) is how a late child's value reaches a container that already stands.
  const moving = legs.filter((l) => Math.abs(l.delta) > EPS || (l.value != null && Math.abs(l.value) > 0.005));
  if (!moving.length) return null;
  // Net by area/item/batch to check stock once.
  const net = new Map();
  for (const l of moving) {
    const k = `${l.areaId}:${l.itemId}:${l.batchId ?? 0}`;
    net.set(k, { ...l, delta: round6((net.get(k)?.delta ?? 0) + l.delta) });
  }
  const keys = [...net.values()];
  const [have] = await db.query(
    `SELECT stocking_area_id, item_id, batch_key, quantity FROM cf_stock_balances
      WHERE company_id = ? AND (stocking_area_id, item_id, batch_key) IN (${keys.map(() => '(?, ?, ?)').join(', ')}) FOR UPDATE`,
    [c.companyId, ...keys.flatMap((l) => [l.areaId, l.itemId, l.batchId ?? 0])],
  );
  const qtyOf = new Map(have.map((r) => [`${r.stocking_area_id}:${r.item_id}:${r.batch_key}`, Number(r.quantity)]));
  for (const l of keys) {
    const now = qtyOf.get(`${l.areaId}:${l.itemId}:${l.batchId ?? 0}`) ?? 0;
    if (now + l.delta < -EPS) {
      throw invalid('NOT_ENOUGH', `${l.label ?? `Item ${l.itemId}`}: only ${fmt(now)} in stock where it should be — ${fmt(-l.delta)} cannot be taken.`);
    }
  }
  const [r] = await db.query(
    `INSERT INTO cf_stock_movements (company_id, code, movement_type, movement_date, order_id, order_line_id, reference, notes, created_by)
     VALUES (?, NULL, 'transform', CURDATE(), ?, ?, ?, ?, ?)`,
    [c.companyId, orderId, orderLineId, reference ? String(reference).slice(0, 100) : null, notes ?? null, c.userId ?? null],
  );
  const movementId = r.insertId;
  await db.query('UPDATE cf_stock_movements SET code = ? WHERE id = ?', [`TF-${String(movementId).padStart(6, '0')}`, movementId]);
  await insertRows(db, 'cf_stock_ledger',
    ['company_id', 'movement_id', 'line_no', 'stocking_area_id', 'item_id', 'batch_id', 'quantity', 'unit_cost', 'value', 'notes', 'created_by'],
    moving.map((l, i) => [c.companyId, movementId, i + 1, l.areaId, l.itemId, l.batchId ?? null, round6(l.delta),
      l.unitCost ?? null, l.value == null ? null : round2(l.value), l.note ?? null, c.userId ?? null]));
  // One upsert for every balance the movement touches (uq_csk_stock: area, item, batch_key).
  await db.query(
    `INSERT INTO cf_stock_balances (company_id, stocking_area_id, item_id, batch_id, quantity, last_movement_id) VALUES ${keys.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), last_movement_id = VALUES(last_movement_id)`,
    keys.flatMap((l) => [c.companyId, l.areaId, l.itemId, l.batchId ?? null, round6(l.delta), movementId]),
  );
  return movementId;
}

// --- reading a release once -------------------------------------------------------

async function releaseContext(db, companyId, releaseId) {
  const [[rel]] = await db.query(
    `SELECT r.*, o.code AS order_code FROM cf_production_releases r JOIN cf_sales_orders o ON o.id = r.order_id
      WHERE r.company_id = ? AND r.id = ?`, [companyId, releaseId]);
  const [items] = await db.query(
    `SELECT pi.id, pi.parent_id, pi.item_id, pi.quantity, pi.code, pi.sort_order, pi.depth, m.code AS item_code, m.name AS item_name, m.classification_id
       FROM cf_production_items pi JOIN cf_master_records m ON m.id = pi.item_id
      WHERE pi.company_id = ? AND pi.release_id = ? AND pi.deleted_at IS NULL ORDER BY pi.sort_order, pi.id`,
    [companyId, releaseId],
  );
  const [steps] = await db.query(
    `SELECT s.id, s.production_item_id, s.sequence FROM cf_production_steps s
       JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL`,
    [companyId, releaseId],
  );
  const [reqs] = await db.query(
    `SELECT id, production_item_id, step_id, item_id, bom_line_id, quantity, issued
       FROM cf_material_requirements WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL`,
    [companyId, releaseId],
  );
  const [cutNode] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL", [companyId, CUT_PLATE_NODE_CODE]);
  const cutClass = new Set(cutNode.map((n) => n.id));
  const byId = new Map(items.map((i) => [i.id, { ...i, quantity: Number(i.quantity), children: [], steps: [] }]));
  for (const i of byId.values()) if (i.parent_id && byId.has(i.parent_id)) byId.get(i.parent_id).children.push(i);
  for (const s of steps) byId.get(s.production_item_id)?.steps.push(s);
  for (const i of byId.values()) i.steps.sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const stepNode = new Map(steps.map((s) => [s.id, s.production_item_id]));
  // Dependencies between steps of a node and its children (both ways).
  const stepIds = steps.map((s) => s.id);
  const [deps] = stepIds.length ? await db.query(
    `SELECT step_id, target_step_id, target_item_id, required FROM cf_step_dependencies
      WHERE company_id = ? AND deleted_at IS NULL AND step_id IN (?)`, [companyId, stepIds]) : [[]];
  const isCutNode = (n) => cutClass.has(n.classification_id);
  // Nest groups: lots of this line, gate = a production item id.
  const lots = (await lotsOfLines(db, companyId, [rel.order_line_id])).get(rel.order_line_id) ?? new Map();
  const firstNodeOf = new Map();
  for (const i of byId.values()) if (isCutNode(i) && !firstNodeOf.has(i.item_id)) firstNodeOf.set(i.item_id, i);
  const { groups } = lotGates(lots, (cp) => (firstNodeOf.has(cp) ? { key: firstNodeOf.get(cp).id, order: firstNodeOf.get(cp).sort_order } : null));
  const nestedCutPlates = new Set(groups.flatMap((g) => g.cutPlates));
  return { rel, byId, stepNode, deps, reqs, isCutNode, groups, nestedCutPlates };
}

/** What a step is, in the ledger's terms. */
function kindOf(ctx, step) {
  const node = ctx.byId.get(step.production_item_id);
  const first = node.steps[0]?.id === step.id;
  const childIds = new Set(node.children.map((ch) => ch.id));
  const childStepIds = new Set(node.children.flatMap((ch) => ch.steps.map((s) => s.id)));
  if (node && ctx.isCutNode(node) && first) {
    const gate = ctx.groups.find((g) => g.gate === node.id);
    if (gate) return { cut: 'nest', gate };
    if (ctx.nestedCutPlates.has(node.item_id)) return { cut: 'by_gate' };
    return { cut: 'own' };
  }
  const waitsOnChild = ctx.deps.some((d) => d.step_id === step.id && ((d.target_step_id && childStepIds.has(d.target_step_id)) || (d.target_item_id && childIds.has(d.target_item_id))));
  const childWaitsDone = ctx.deps.some((d) => d.target_step_id === step.id && d.required === 'done' && childStepIds.has(d.step_id));
  return { join: first || (waitsOnChild && !first), split: childWaitsDone };
}

const started = (s) => s.state === 'in_progress' || s.state === 'done' || (s.state === 'on_hold' && s.held_from === 'in_progress');

// --- lots ---------------------------------------------------------------------------

/** Each node's own lot (created on first need). Map productionItemId -> batch row. */
async function nodeLots(db, c, nodes) {
  const ids = nodes.map((n) => n.id);
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query('SELECT * FROM cf_stock_batches WHERE company_id = ? AND production_item_id IN (?) AND deleted_at IS NULL ORDER BY id', [c.companyId, ids]);
  for (const r of rows) if (!out.has(r.production_item_id)) out.set(r.production_item_id, r);
  const missing = nodes.filter((n) => !out.has(n.id));
  if (missing.length) {
    const tag = `~wip~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await insertRows(db, 'cf_stock_batches', ['company_id', 'item_id', 'code', 'received_on', 'supplier_ref', 'production_item_id', 'created_by'],
      missing.map((n) => [c.companyId, n.item_id, `${tag}~${n.id}`, new Date().toISOString().slice(0, 10), n.code ?? null, n.id, c.userId ?? null]));
    const [made] = await db.query('SELECT * FROM cf_stock_batches WHERE company_id = ? AND code LIKE ?', [c.companyId, `${tag}~%`]);
    // The lot is named by the piece (its code), or the piece and its node when a code is shared (grouped parts).
    for (const b of made) {
      const n = missing.find((x) => x.id === b.production_item_id);
      let code = n.code ? `${n.code}` : `${n.item_code ?? 'PIECE'}-${n.id}`;
      const [[taken]] = await db.query('SELECT id FROM cf_stock_batches WHERE company_id = ? AND code_active = LOWER(?) AND id <> ?', [c.companyId, code, b.id]);
      if (taken) code = `${code}-${n.id}`;
      await db.query('UPDATE cf_stock_batches SET code = ? WHERE id = ?', [code, b.id]);
      out.set(n.id, { ...b, code });
    }
  }
  return out;
}

/** WIP balance of each node lot. Map batchId -> qty. */
async function balancesOf(db, companyId, areaId, batchIds) {
  if (!batchIds.length) return new Map();
  const [rows] = await db.query('SELECT batch_id, quantity FROM cf_stock_balances WHERE company_id = ? AND stocking_area_id = ? AND batch_id IN (?)', [companyId, areaId, batchIds]);
  return new Map(rows.map((r) => [r.batch_id, Number(r.quantity)]));
}

/** A lot's value per unit (NULL = not costed). */
const unitOf = (b) => (b?.unit_cost == null ? null : Number(b.unit_cost));

// --- bought material: from its reservation -----------------------------------------

/**
 * What consuming a requirement's outstanding quantity takes: from its active
 * reservations, each from a usable area that holds it (WIP first, then
 * storage). Refuses when the reservations do not cover it. Returns legs + the
 * reservation updates to make.
 */
async function takeRequirement(db, c, req, qty, label) {
  const [res] = await db.query(
    `SELECT v.id, v.batch_id, v.quantity, b.unit_cost FROM cf_stock_reservations v LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND v.requirement_id = ? AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY v.id FOR UPDATE`,
    [c.companyId, req.id],
  );
  const reserved = res.reduce((t, r) => t + Number(r.quantity), 0);
  if (reserved + EPS < qty) {
    throw invalid('MATERIAL_NOT_RESERVED', `${label} needs ${fmt(qty)} — only ${fmt(reserved)} is in stock and reserved for it. Receive and reserve it before starting.`);
  }
  let left = qty;
  const legs = [];
  const resWrites = [];
  for (const r of res) {
    if (left <= EPS) break;
    const take = Math.min(left, Number(r.quantity));
    const [areas] = await db.query(
      `SELECT k.stocking_area_id, k.quantity FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN ('storage','wip')
        WHERE k.company_id = ? AND k.item_id = ? AND k.batch_key = ? AND k.quantity > 0 ORDER BY a.purpose = 'wip' DESC, k.id`,
      [c.companyId, req.item_id, r.batch_id ?? 0],
    );
    let need = take;
    for (const a of areas) {
      if (need <= EPS) break;
      const t = Math.min(need, Number(a.quantity));
      let unit = r.batch_id ? unitOf(r) : null;
      if (unit == null && !r.batch_id) {
        const [[pool]] = await db.query('SELECT avg_unit_cost FROM cf_item_costs WHERE company_id = ? AND item_id = ? AND owner_key = 0', [c.companyId, req.item_id]);
        unit = pool?.avg_unit_cost == null ? null : Number(pool.avg_unit_cost);
      }
      legs.push({ areaId: a.stocking_area_id, itemId: req.item_id, batchId: r.batch_id ?? null, delta: -t, unitCost: unit, value: unit == null ? null : -t * unit, label, reservationId: r.id });
      need = round6(need - t);
    }
    if (need > EPS) throw invalid('NOT_ENOUGH', `${label}: it is reserved but not on the shelf — ${fmt(need)} cannot be found in storage.`);
    resWrites.push({ id: r.id, rest: round6(Number(r.quantity) - take) });
    left = round6(left - take);
  }
  return { legs, resWrites };
}

async function writeReservations(db, companyId, resWrites) {
  for (const w of resWrites) {
    if (w.rest <= EPS) await db.query("UPDATE cf_stock_reservations SET quantity = 0, status = 'consumed', closed_at = NOW() WHERE company_id = ? AND id = ?", [companyId, w.id]);
    else await db.query('UPDATE cf_stock_reservations SET quantity = ? WHERE company_id = ? AND id = ?', [w.rest, companyId, w.id]);
  }
}

// --- offcuts ------------------------------------------------------------------------

/** The catalog item an offcut of this steel is a piece of — made on first need. */
async function offcutItem(db, c, { thickness, grade, material }) {
  const [[node]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, OFFCUT_NODE_CODE]);
  if (!node) return null;
  const code = `OFC-${fmt(thickness)}-${String(grade ?? '').replace(/\s+/g, '')}`.toUpperCase().slice(0, 100);
  const [[have]] = await db.query("SELECT m.id FROM cf_master_records m WHERE m.company_id = ? AND m.code = ? AND m.deleted_at IS NULL", [c.companyId, code]);
  if (have) return have.id;
  const [r] = await db.query(
    "INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, 'item', ?, ?, 'OFC', ?, 'active', ?)",
    [c.companyId, code, `Offcut ${fmt(thickness)} mm ${[grade, material].filter(Boolean).join(' ')}`.trim(), node.id, c.userId ?? null],
  );
  await db.query(
    "INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'batch', 'nos', 'stock')",
    [r.insertId, c.companyId],
  );
  // Its steel, on the item, never changing (THICKNESS, GRADE as text; the specs exist on every steel tenant).
  const [specs] = await db.query("SELECT id, code, data_type FROM cf_specifications WHERE company_id = ? AND code IN ('THICKNESS','GRADE','MATERIAL') AND deleted_at IS NULL", [c.companyId]);
  for (const s of specs) {
    const v = s.code === 'THICKNESS' ? thickness : s.code === 'GRADE' ? grade : material;
    if (v == null) continue;
    let optionId = null;
    if (s.data_type === 'option') {
      const [[o]] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND (value = ? OR label = ?) AND deleted_at IS NULL LIMIT 1', [c.companyId, s.id, String(v), String(v)]);
      optionId = o?.id ?? null;
      if (!optionId) continue;
    }
    await db.query(
      "INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, value_text, option_id, source, created_by) VALUES (?, ?, 'master', ?, ?, ?, ?, 'entered', ?)",
      [c.companyId, s.id, r.insertId, s.data_type === 'number' ? Number(v) : null, s.data_type === 'text' ? String(v) : null, optionId, c.userId ?? null],
    );
  }
  return r.insertId;
}

// --- the reconciler --------------------------------------------------------------------

/**
 * After steps changed: post what their states now say the ledger should hold.
 * Steps of several releases may be passed; each release is read once.
 */
export async function ledgerOnSteps(db, c, stepIds) {
  const ids = [...new Set((stepIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return { movements: 0 };
  const [steps] = await db.query(
    `SELECT s.id, s.production_item_id, s.sequence, s.state, s.held_from, s.quantity, s.qty_good, s.ledger_in, s.ledger_out, pi.release_id
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE s.company_id = ? AND s.id IN (?) AND s.deleted_at IS NULL ORDER BY s.id FOR UPDATE`,
    [c.companyId, ids],
  );
  let movements = 0;
  for (const [releaseId, mine] of groupBy(steps, 'release_id')) {
    const ctx = await releaseContext(db, c.companyId, releaseId);
    const area = await wipArea(db, c);
    // Reverses first (undo before do), then forwards in tree order (children before parents).
    const work = [];
    for (const s of mine) {
      const node = ctx.byId.get(s.production_item_id);
      const k = kindOf(ctx, s);
      const qty = node.quantity;
      // Bought material on a step that is not a cut is consumed at its start —
      // on a join step with the children, on any other step on its own.
      const loose = !k.cut ? ctx.reqs.filter((r) => r.step_id === s.id) : [];
      const wantIn = (k.join || loose.length) && started(s) ? qty : 0;
      const wantOut = (k.split || k.cut) && s.state === 'done' ? qty : 0;
      if (Math.abs(wantIn - Number(s.ledger_in)) > EPS) {
        work.push({ s, node, k, op: 'join', d: round6(wantIn - Number(s.ledger_in)), loose, looseOnly: !k.join });
      }
      if (Math.abs(wantOut - Number(s.ledger_out)) > EPS) work.push({ s, node, k, op: k.cut ? 'cut' : 'split', d: round6(wantOut - Number(s.ledger_out)) });
    }
    work.sort((a, b) => (Math.sign(a.d) - Math.sign(b.d)) || (b.node.depth - a.node.depth));
    for (const w of work) {
      const moved = w.op === 'join' ? await joinStep(db, c, ctx, area, w)
        : w.op === 'split' ? await splitStep(db, c, ctx, area, w)
          : await cutStep(db, c, ctx, area, w);
      if (moved) movements += 1;
    }
    // Pieces made by this work whose parent has already started go straight in.
    const made = work.filter((w) => w.d > 0 && (w.op === 'cut' || (w.op === 'join' && !w.looseOnly)))
      .flatMap((w) => (w.op === 'cut' && w.k.cut === 'nest'
        ? [...ctx.byId.values()].filter((n) => ctx.isCutNode(n) && w.k.gate.cutPlates.includes(n.item_id))
        : [w.node]));
    movements += await lateJoins(db, c, ctx, area, made);
  }
  return { movements };
}

const nameOfNode = (n) => n.code ?? n.item_code ?? n.item_name ?? `piece ${n.id}`;

/** Join (d > 0) or undo a join (d < 0) at a step's start. */
async function joinStep(db, c, ctx, area, { s, node, d, loose, looseOnly }) {
  const ref = `${ctx.rel.order_code} · ${nameOfNode(node)}`;
  if (d > 0) {
    const legs = [];
    const joins = [];
    const resWrites = [];
    const reqWrites = [];
    if (!looseOnly) {
      // Made children, lying in WIP as themselves.
      const kids = node.children;
      const lots = await nodeLots(db, c, kids);
      const bal = await balancesOf(db, c.companyId, area.id, [...lots.values()].map((b) => b.id));
      for (const ch of kids) {
        const lot = lots.get(ch.id);
        const have = bal.get(lot.id) ?? 0;
        // A made child not there yet (the floor recorded this start before the
        // child's own work — the machine log allows it) is NOT a refusal: the
        // parent starts with what is there, and the child joins it the moment it
        // is made (lateJoins). Only bought material refuses a start.
        const take = Math.min(have, ch.quantity);
        if (take <= EPS) continue;
        const unit = unitOf(lot);
        legs.push({ areaId: area.id, itemId: ch.item_id, batchId: lot.id, delta: -take, unitCost: unit, value: unit == null ? null : -take * unit, label: nameOfNode(ch) });
        joins.push({ child: ch, req: null, itemId: ch.item_id, batchId: lot.id, areaId: area.id, qty: take, value: unit == null ? null : take * unit });
      }
    }
    // Bought material on this step.
    for (const r of loose) {
      const want = round6(Number(r.quantity) - Number(r.issued));
      if (want <= EPS) continue;
      const t = await takeRequirement(db, c, r, want, `${nameOfNode(node)} — material ${r.item_id}`);
      legs.push(...t.legs);
      resWrites.push(...t.resWrites);
      for (const l of t.legs) joins.push({ child: null, req: r, itemId: r.item_id, batchId: l.batchId, areaId: l.areaId, qty: -l.delta, value: l.value == null ? null : -l.value });
      reqWrites.push({ id: r.id, add: want });
    }
    if (!legs.length && looseOnly) {
      await db.query('UPDATE cf_production_steps SET ledger_in = ledger_in + ? WHERE company_id = ? AND id = ?', [d, c.companyId, s.id]);
      return false;
    }
    const inValue = joins.some((j) => j.value == null) && joins.length ? null : joins.reduce((t, j) => t + (j.value ?? 0), 0);
    let lotOut = null;
    if (!looseOnly) {
      lotOut = (await nodeLots(db, c, [node])).get(node.id);
      // A re-join: the container already exists, its value is what is inside it.
      legs.push({ areaId: area.id, itemId: node.item_id, batchId: lotOut.id, delta: node.quantity, unitCost: inValue == null ? null : round4(inValue / node.quantity), value: inValue, label: nameOfNode(node) });
    } else {
      // Material into a node that already stands: its lot takes the value on.
      lotOut = (await nodeLots(db, c, [node])).get(node.id);
    }
    const movementId = await writeTransform(db, c, { reference: ref, notes: `${looseOnly ? 'Material for' : 'Joined into'} ${nameOfNode(node)} (step started)`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs });
    await writeReservations(db, c.companyId, resWrites);
    for (const w of reqWrites) await db.query('UPDATE cf_material_requirements SET issued = issued + ? WHERE company_id = ? AND id = ?', [w.add, c.companyId, w.id]);
    if (joins.length) {
      await insertRows(db, 'cf_wip_joins', ['company_id', 'parent_item_id', 'step_id', 'child_item_id', 'requirement_id', 'item_id', 'batch_id', 'area_id', 'quantity', 'value', 'joined_movement_id', 'created_by'],
        joins.map((j) => [c.companyId, node.id, s.id, j.child?.id ?? null, j.req?.id ?? null, j.itemId, j.batchId ?? null, j.areaId, j.qty, j.value == null ? null : round2(j.value), movementId, c.userId ?? null]));
    }
    await setLotCost(db, c, lotOut, area);
    if (!looseOnly) await db.query('UPDATE cf_production_steps SET ledger_in = ledger_in + ? WHERE company_id = ? AND id = ?', [d, c.companyId, s.id]);
    else await db.query('UPDATE cf_production_steps SET ledger_in = ledger_in + ? WHERE company_id = ? AND id = ?', [d, c.companyId, s.id]);
    return true;
  }
  // Undo: everything this step joined goes back where it came from.
  const [rows] = await db.query('SELECT * FROM cf_wip_joins WHERE company_id = ? AND step_id = ? AND left_movement_id IS NULL AND deleted_at IS NULL', [c.companyId, s.id]);
  const legs = [];
  const lot = (await nodeLots(db, c, [node])).get(node.id);
  if (!looseOnly) {
    const bal = await balancesOf(db, c.companyId, area.id, [lot.id]);
    if ((bal.get(lot.id) ?? 0) + EPS < node.quantity) throw invalid('MOVED_ON', `${nameOfNode(node)} has already moved on (into its parent, or to finished stock) — its start cannot be undone.`);
    const total = rows.reduce((t, r) => t + (r.value == null ? 0 : Number(r.value)), 0);
    legs.push({ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: -node.quantity, unitCost: unitOf(lot), value: -total, label: nameOfNode(node) });
  }
  for (const r of rows) legs.push({ areaId: r.area_id, itemId: r.item_id, batchId: r.batch_id, delta: Number(r.quantity), value: r.value == null ? null : Number(r.value), label: `item ${r.item_id}` });
  const movementId = await writeTransform(db, c, { reference: ref, notes: `Start of ${nameOfNode(node)} undone — back where it came from`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs });
  for (const r of rows.filter((x) => x.requirement_id)) {
    await db.query('UPDATE cf_material_requirements SET issued = GREATEST(issued - ?, 0) WHERE company_id = ? AND id = ?', [Number(r.quantity), c.companyId, r.requirement_id]);
    await db.query("INSERT INTO cf_stock_reservations (company_id, requirement_id, item_id, batch_id, quantity, status, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?)",
      [c.companyId, r.requirement_id, r.item_id, r.batch_id, Number(r.quantity), c.userId ?? null]);
  }
  if (rows.length) await db.query('UPDATE cf_wip_joins SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, rows.map((r) => r.id)]);
  await db.query('UPDATE cf_production_steps SET ledger_in = 0 WHERE company_id = ? AND id = ?', [c.companyId, s.id]);
  return !!movementId;
}

/** A dismantle (d > 0): the children that joined the container come out with the value they brought; undo (d < 0) puts them back. */
async function splitStep(db, c, ctx, area, { s, node, d }) {
  const ref = `${ctx.rel.order_code} · ${nameOfNode(node)}`;
  const lot = (await nodeLots(db, c, [node])).get(node.id);
  if (d > 0) {
    const [inside] = await db.query('SELECT * FROM cf_wip_joins WHERE company_id = ? AND parent_item_id = ? AND left_movement_id IS NULL AND deleted_at IS NULL', [c.companyId, node.id]);
    const kids = inside.filter((r) => r.child_item_id);
    if (!kids.length) return false;
    const bal = await balancesOf(db, c.companyId, area.id, [lot.id]);
    if ((bal.get(lot.id) ?? 0) + EPS < node.quantity) throw invalid('MOVED_ON', `${nameOfNode(node)} is not in work in progress — it cannot be taken apart.`);
    const total = (bal.get(lot.id) ?? 0) * (unitOf(lot) ?? 0);
    const brought = kids.reduce((t, r) => t + (r.value == null ? 0 : Number(r.value)), 0);
    // What else went in on the way (bolts for a trial assembly) is shared by value.
    const extra = Math.max(0, total - brought);
    const legs = [{ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: -node.quantity, unitCost: unitOf(lot), value: -total, label: nameOfNode(node) }];
    for (const r of kids) {
      const share = brought > 0 && r.value != null ? Number(r.value) / brought : 1 / kids.length;
      legs.push({ areaId: area.id, itemId: r.item_id, batchId: r.batch_id, delta: Number(r.quantity), value: (r.value == null ? 0 : Number(r.value)) + extra * share, label: `item ${r.item_id}` });
    }
    const movementId = await writeTransform(db, c, { reference: ref, notes: `${nameOfNode(node)} taken apart (step done)`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs });
    await db.query('UPDATE cf_wip_joins SET left_movement_id = ?, left_step_id = ? WHERE company_id = ? AND id IN (?)', [movementId, s.id, c.companyId, inside.map((r) => r.id)]);
    for (const r of kids) {
      const back = legs.find((l) => l.batchId === r.batch_id && l.delta > 0);
      if (back?.value != null) await db.query('UPDATE cf_stock_batches SET unit_cost = ? WHERE company_id = ? AND id = ?', [round4(back.value / Number(r.quantity)), c.companyId, r.batch_id]);
    }
    await db.query('UPDATE cf_production_steps SET ledger_out = ledger_out + ? WHERE company_id = ? AND id = ?', [d, c.companyId, s.id]);
    return true;
  }
  // Undo a dismantle: what left at this step goes back in.
  const [left] = await db.query('SELECT * FROM cf_wip_joins WHERE company_id = ? AND left_step_id = ? AND deleted_at IS NULL', [c.companyId, s.id]);
  const kids = left.filter((r) => r.child_item_id);
  const legs = [];
  let total = 0;
  const lots = await nodeLots(db, c, kids.map((r) => ctx.byId.get(r.child_item_id)).filter(Boolean));
  const bal = await balancesOf(db, c.companyId, area.id, [...lots.values()].map((b) => b.id));
  for (const r of kids) {
    const b = lots.get(r.child_item_id);
    if ((bal.get(b.id) ?? 0) + EPS < Number(r.quantity)) throw invalid('MOVED_ON', `${nameOfNode(ctx.byId.get(r.child_item_id))} has moved on since it was taken out — the dismantle cannot be undone.`);
    const v = (unitOf(b) ?? 0) * Number(r.quantity);
    total += v;
    legs.push({ areaId: area.id, itemId: r.item_id, batchId: r.batch_id, delta: -Number(r.quantity), value: -v, label: `item ${r.item_id}` });
  }
  legs.push({ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: node.quantity, unitCost: round4(total / node.quantity), value: total, label: nameOfNode(node) });
  await writeTransform(db, c, { reference: ref, notes: `Dismantle of ${nameOfNode(node)} undone`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs });
  if (left.length) await db.query('UPDATE cf_wip_joins SET left_movement_id = NULL, left_step_id = NULL WHERE company_id = ? AND id IN (?)', [c.companyId, left.map((r) => r.id)]);
  await db.query('UPDATE cf_stock_batches SET unit_cost = ? WHERE company_id = ? AND id = ?', [round4(total / node.quantity), c.companyId, lot.id]);
  await db.query('UPDATE cf_production_steps SET ledger_out = 0 WHERE company_id = ? AND id = ?', [c.companyId, s.id]);
  return true;
}

/** A plate cut (d > 0): plates out, cut pieces (+ offcuts) in, value by weight; undo while nothing has moved on. */
async function cutStep(db, c, ctx, area, { s, node, k, d }) {
  const ref = `${ctx.rel.order_code} · cut ${nameOfNode(node)}`;
  if (k.cut === 'by_gate') {
    // Made by its group's gate: nothing of its own to post.
    await db.query('UPDATE cf_production_steps SET ledger_out = ? WHERE company_id = ? AND id = ?', [d > 0 ? node.quantity : 0, c.companyId, s.id]);
    return false;
  }
  // The outputs: the gate's group's cut-plate nodes, or this node alone.
  const outs = k.cut === 'nest'
    ? [...ctx.byId.values()].filter((n) => ctx.isCutNode(n) && k.gate.cutPlates.includes(n.item_id))
    : [node];
  const lotIds = k.cut === 'nest' ? k.gate.lots.map((l) => l.id) : [];
  const lots = await nodeLots(db, c, outs);
  if (d > 0) {
    const reqs = ctx.reqs.filter((r) => r.step_id === s.id);
    const legs = [];
    const resWrites = [];
    for (const r of reqs) {
      const want = round6(Number(r.quantity) - Number(r.issued));
      if (want <= EPS) continue;
      const t = await takeRequirement(db, c, r, want, `${nameOfNode(node)} — plate ${r.item_id}`);
      legs.push(...t.legs);
      resWrites.push(...t.resWrites);
    }
    const plateValue = legs.some((l) => l.value == null) && legs.length ? null : -legs.reduce((t, l) => t + (l.value ?? 0), 0);
    // Weights: each output piece, each offcut, the plates.
    const kg = await unitKgOf(db, c.companyId, outs.map((n) => n.item_id));
    const [offcuts] = lotIds.length ? await db.query("SELECT * FROM cf_offcuts WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL AND status = 'planned'", [c.companyId, lotIds]) : [[]];
    let plateKg = 0;
    if (lotIds.length) {
      const [pl] = await db.query('SELECT * FROM cf_plate_lots WHERE company_id = ? AND id IN (?)', [c.companyId, lotIds]);
      plateKg = pl.reduce((t, l) => t + lotPlateKg(l), 0);
    } else {
      const pk = await unitKgOf(db, c.companyId, reqs.map((r) => r.item_id));
      plateKg = reqs.reduce((t, r) => t + (pk.get(r.item_id) ?? 0) * Number(r.quantity), 0);
    }
    const share = (w) => (plateValue == null || !(plateKg > 0) || w == null ? null : plateValue * Math.min(1, w / plateKg));
    for (const n of outs) {
      const w = kg.get(n.item_id) == null ? null : kg.get(n.item_id) * n.quantity;
      const v = outs.length === 1 && !offcuts.length && plateKg <= 0 ? plateValue : share(w);
      legs.push({ areaId: area.id, itemId: n.item_id, batchId: lots.get(n.id).id, delta: n.quantity, unitCost: v == null ? null : round4(v / n.quantity), value: v, label: nameOfNode(n) });
    }
    // Offcuts: each a stock piece of its steel's Offcut item, carrying its outline (cf_offcuts).
    const made = [];
    for (const o of offcuts) {
      const itemId = await offcutItem(db, c, { thickness: Number(o.thickness_mm), grade: o.grade, material: o.material });
      if (!itemId) continue;                                  // no Offcuts variant set up: the offcut stays planned
      const v = share(o.weight_kg == null ? null : Number(o.weight_kg));
      // Its lot: the one an earlier cut of this plate made (a cut undone and done
      // again), else a new one named by the order and the offcut — offcut numbers
      // (N-001-A) repeat from line to line, lot codes may not.
      let batchId = o.batch_id ?? null;
      if (batchId) await db.query('UPDATE cf_stock_batches SET unit_cost = ? WHERE company_id = ? AND id = ?', [v == null ? null : round4(v), c.companyId, batchId]);
      else {
        let code = `${ctx.rel.order_code}-${o.offcut_no}`;
        const [[taken]] = await db.query('SELECT id FROM cf_stock_batches WHERE company_id = ? AND code_active = LOWER(?)', [c.companyId, code]);
        if (taken) code = `${code}-${o.id}`;
        const [b] = await db.query(
          'INSERT INTO cf_stock_batches (company_id, item_id, code, received_on, supplier_ref, unit_cost, owner_party_id, notes, created_by) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)',
          [c.companyId, itemId, code, o.offcut_no, v == null ? null : round4(v), o.owner_party_id ?? null, `Offcut ${o.offcut_no} of ${ctx.rel.order_code} — outline in cf_offcuts #${o.id}`, c.userId ?? null],
        );
        batchId = b.insertId;
      }
      legs.push({ areaId: area.id, itemId, batchId, delta: 1, unitCost: v == null ? null : round4(v), value: v, label: o.offcut_no });
      made.push({ id: o.id, batchId });
    }
    await writeTransform(db, c, { reference: ref, notes: `Plate${lotIds.length > 1 ? 's' : ''} cut: ${outs.length} cut piece row${outs.length === 1 ? '' : 's'}${made.length ? `, ${made.length} offcut${made.length === 1 ? '' : 's'}` : ''}`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs });
    await writeReservations(db, c.companyId, resWrites);
    for (const r of reqs) await db.query('UPDATE cf_material_requirements SET issued = quantity WHERE company_id = ? AND id = ?', [c.companyId, r.id]);
    for (const m of made) await db.query("UPDATE cf_offcuts SET status = 'available', batch_id = ? WHERE company_id = ? AND id = ?", [m.batchId, c.companyId, m.id]);
    for (const n of outs) await setLotCost(db, c, lots.get(n.id), area);
    await db.query('UPDATE cf_production_steps SET ledger_out = ? WHERE company_id = ? AND id = ?', [node.quantity, c.companyId, s.id]);
    return true;
  }
  // Undo a cut — only while every cut piece and offcut is still lying where the cut put it.
  const [mv] = await db.query(
    "SELECT l.* FROM cf_stock_ledger l JOIN cf_stock_movements m ON m.id = l.movement_id WHERE m.company_id = ? AND m.movement_type = 'transform' AND m.reference = ? ORDER BY m.id DESC, l.line_no",
    [c.companyId, ref],
  );
  const lastId = mv[0]?.movement_id;
  const legsOf = mv.filter((l) => l.movement_id === lastId);
  const ins = legsOf.filter((l) => Number(l.quantity) > 0);
  const bal = await balancesOf(db, c.companyId, area.id, ins.map((l) => l.batch_id));
  for (const l of ins) if ((bal.get(l.batch_id) ?? 0) + EPS < Number(l.quantity)) throw invalid('MOVED_ON', 'Pieces from this cut have already moved on — the cut cannot be undone.');
  const legs = legsOf.map((l) => ({ areaId: l.stocking_area_id, itemId: l.item_id, batchId: l.batch_id, delta: -Number(l.quantity), unitCost: l.unit_cost == null ? null : Number(l.unit_cost), value: l.value == null ? null : -Number(l.value), label: `item ${l.item_id}` }));
  await writeTransform(db, c, { reference: ref, notes: 'Cut undone — plates back on the shelf', orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs });
  const reqs = ctx.reqs.filter((r) => r.step_id === s.id);
  for (const r of reqs) {
    const back = legsOf.filter((l) => Number(l.quantity) < 0 && l.item_id === r.item_id);
    for (const l of back) {
      await db.query("INSERT INTO cf_stock_reservations (company_id, requirement_id, item_id, batch_id, quantity, status, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?)",
        [c.companyId, r.id, r.item_id, l.batch_id, -Number(l.quantity), c.userId ?? null]);
    }
    await db.query('UPDATE cf_material_requirements SET issued = 0 WHERE company_id = ? AND id = ?', [c.companyId, r.id]);
  }
  // Back to planned; the lot is kept (empty) so cutting again reuses it.
  if (lotIds.length) await db.query("UPDATE cf_offcuts SET status = 'planned' WHERE company_id = ? AND plate_lot_id IN (?) AND status = 'available'", [c.companyId, lotIds]);
  await db.query('UPDATE cf_production_steps SET ledger_out = 0 WHERE company_id = ? AND id = ?', [c.companyId, s.id]);
  return true;
}

/**
 * LATE CHILDREN. A child made after its parent already started (the floor log
 * recorded the parent first) joins that parent now: the child's lot leaves
 * WIP, the parent's lot takes its value (a value-only leg — the parent's
 * quantity was counted when it started). Not a child that LEFT the parent at
 * a dismantle — that one is outside on purpose until the re-join.
 */
async function lateJoins(db, c, ctx, area, nodes) {
  let moved = 0;
  for (const n of nodes) {
    const parent = n.parent_id ? ctx.byId.get(n.parent_id) : null;
    if (!parent) continue;
    const lots = await nodeLots(db, c, [n, parent]);
    const bal = await balancesOf(db, c.companyId, area.id, [lots.get(n.id).id, lots.get(parent.id).id]);
    const mine = bal.get(lots.get(n.id).id) ?? 0;
    if (mine <= EPS || (bal.get(lots.get(parent.id).id) ?? 0) <= EPS) continue;
    const [[hist]] = await db.query(
      'SELECT SUM(left_movement_id IS NOT NULL) AS left_n, COALESCE(SUM(IF(left_movement_id IS NULL, quantity, 0)), 0) AS inside FROM cf_wip_joins WHERE company_id = ? AND parent_item_id = ? AND child_item_id = ? AND deleted_at IS NULL',
      [c.companyId, parent.id, n.id],
    );
    if (Number(hist?.left_n ?? 0) > 0) continue;
    const take = Math.min(mine, round6(n.quantity - Number(hist?.inside ?? 0)));
    if (take <= EPS) continue;
    const lot = lots.get(n.id);
    const unit = unitOf(lot);
    const value = unit == null ? null : take * unit;
    const joinStepRow = parent.steps[0];
    const movementId = await writeTransform(db, c, {
      reference: `${ctx.rel.order_code} · ${nameOfNode(parent)}`, notes: `${nameOfNode(n)} made after ${nameOfNode(parent)} started — joined it now`,
      orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id,
      legs: [
        { areaId: area.id, itemId: n.item_id, batchId: lot.id, delta: -take, unitCost: unit, value: value == null ? null : -value, label: nameOfNode(n) },
        { areaId: area.id, itemId: parent.item_id, batchId: lots.get(parent.id).id, delta: 0, value, label: nameOfNode(parent) },
      ],
    });
    await insertRows(db, 'cf_wip_joins', ['company_id', 'parent_item_id', 'step_id', 'child_item_id', 'requirement_id', 'item_id', 'batch_id', 'area_id', 'quantity', 'value', 'joined_movement_id', 'created_by'],
      [[c.companyId, parent.id, joinStepRow.id, n.id, null, n.item_id, lot.id, area.id, take, value == null ? null : round2(value), movementId, c.userId ?? null]]);
    await setLotCost(db, c, lots.get(parent.id), area);
    moved += 1;
  }
  return moved;
}

/** A node lot's cost = its WIP value / quantity, read back from the ledger it now holds. */
async function setLotCost(db, c, lot, area) {
  if (!lot) return;
  const [[r]] = await db.query(
    'SELECT SUM(quantity) AS q, SUM(value) AS v, SUM(value IS NULL) AS unpriced FROM cf_stock_ledger WHERE company_id = ? AND batch_id = ? AND stocking_area_id = ?',
    [c.companyId, lot.id, area.id],
  );
  const q = Number(r?.q ?? 0);
  const unit = q > EPS && Number(r.unpriced) === 0 ? round4(Number(r.v ?? 0) / q) : (q > EPS ? null : unitOf(lot));
  await db.query('UPDATE cf_stock_batches SET unit_cost = ? WHERE company_id = ? AND id = ?', [unit, c.companyId, lot.id]);
}
