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
 * (ledger_in: joined at its start, ledger_out: split at its done, ledger_scrap /
 * ledger_remade: its scrapped pieces and those made again). After any change to
 * steps, `ledgerOnSteps` works out what each step's state SAYS the ledger
 * should hold and posts only the difference — so a correction (a step put back,
 * a count lowered) is the exact reverse, by the same code. One function, called
 * by every path that writes a step (tracker, floor screens, machine log).
 *
 * HOW A STEP IS RECOGNISED — no setup:
 *   cut     the first step of a CUT-PIECE node (a plate blank or a section
 *           blank — filed under a blanks place of Setup › Cutting, cf_cut_places):
 *           its plate or bar is cut. A nest
 *           group's GATE (releaseService.lotGates) cuts every plate of the group
 *           into all the group's cut pieces + its offcuts; a cut plate not on a
 *           nest cuts its own plate requirement into itself; any other node of a
 *           nested cut plate is made by its gate (nothing of its own).
 *   join    a node's first step (not a cut plate), and any later step that waits
 *           on one of its children (a re-join after a dismantle).
 *   split   a step a child waits on with required 'done' (dismantling).
 *   loose   a requirement on a step that is not a cut — consumed at its start.
 *   scrap   any started step with qty_scrap (see below).
 *
 * A START NEEDS ITS INPUTS ONE LEVEL BELOW (no deadlock): children lying in WIP
 * as themselves, bought material reserved. A made child not there yet, or
 * material not reserved, refuses the start in words (user decision: steel never
 * comes from nowhere). Value is material only: a join carries the sum of what
 * went in; a split hands each child back what it brought (anything bought into
 * the container on the way is shared by value).
 *
 * SECTIONS (CF_ERP_CUT_FROM_PLAN.md §11.3). A bar lot (cf_plate_lots kind 'bar')
 * is cut like a plate lot: its gate's cut takes the stock bar off its
 * reservation (or, for a bar from an offcut, the offcut stock piece itself) and
 * makes the section blanks of its group plus a BAR OFFCUT stock piece of an
 * item "OFC-<profile>-<grade>" filed under the section offcut place, its length
 * on the batch and on cf_offcuts. Weight: a bar weighs its length × the stock
 * bar's weight per mm, a section blank its section area × length × density.
 *
 * INVENTORY v2 (2026-10-16, init.sql §67 — the user's rules):
 *   A CUT accounts for the whole plate: plate weight = parts + offcuts + KERF
 *   (burnt: a cf_stock_losses row, never stock) + SCRAP (the skeleton, strips
 *   and bits: "Steel scrap (kg)" into the SCRAP area). Value in = value out:
 *   parts and offcuts at the plate's ₹/kg, scrap at the scrap rate (0 when not
 *   set), kerf and the scrap write-down as loss rows — SUM(ledger value) +
 *   SUM(loss value) = 0 for every production movement. Kerf: the nest lot's
 *   stored cut length × its kerf; else the stored kerf area; else the parts'
 *   outlines on the plate × the kerf of its thickness band (a bar: one saw kerf
 *   per piece).
 *   SCRAP AT A STEP: its qty_scrap pieces leave the node's lot into scrap (their
 *   kg) — only the good ones go on. Pieces made again come back into the lot
 *   when the step's good count needs them (a 'remake' loss row, negative: their
 *   material is not recorded). ledger_scrap / ledger_remade remember it.
 *   OWNER: lots made from a customer's plate or lot — WIP node lots, offcuts,
 *   scrap, and so the finished piece — are the customer's (owner on the lot,
 *   owner_party_id on every ledger row). Per owner, value in = value out.
 *   UNITS: every movement keeps the per-piece records of individual items in
 *   step (unitService.syncUnits).
 */
import { invalid } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { lotsOfLines, lotGates } from './releaseService.js';
import { unitKgOf, lotPlateKg } from './valuationService.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { poolLegs } from './stockService.js';
import { syncUnits } from './unitService.js';
import {
  scrapArea, scrapItem, scrapRate, scrapPerKg, customerScrapLots, writeLosses, reverseLosses,
} from './scrapService.js';
import { hasV67, missingV67 } from '../lib/schemaV67.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
const fmt = (n) => Number(Number(n).toFixed(3));
const groupBy = (rows, k) => { const m = new Map(); for (const r of rows) { const key = r[k]; if (!m.has(key)) m.set(key, []); m.get(key).push(r); } return m; };

export const WIP_AREA_CODE = 'PROD-WIP';
/** The code plate offcuts were found by before Setup › Cutting; only a fallback now, when no place is set. */
export const OFFCUT_NODE_CODE = 'OFFCUT';
const FALLBACK_DENSITY = 7850;

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
 * Posts one 'transform' movement. legs: [{ areaId, itemId, batchId, delta, unitCost?, value?, ownerPartyId?, note? }].
 * Balances are locked and checked together; a leg taking more than is there
 * refuses the whole movement. Returns the movement id.
 *
 *   ownerPartyId  the lot's owner, written onto the ledger row (§67). Left
 *                 undefined on a lot leg, it is read from the lot (one UPDATE).
 *   losses        [{ kind, itemId, kg, value, … }] — value that leaves stock
 *                 without becoming stock (scrapService.writeLosses).
 *   units         options for unitService.syncUnits (reason, parentLot, fresh,
 *                 restore), or false to leave the per-piece records alone.
 * Loose legs (no lot) carry their value into / out of the item's average.
 */
export async function writeTransform(db, c, { reference, notes, orderId = null, orderLineId = null, legs, losses = null, units = {} }) {
  // A value-only leg (quantity 0) is how a late child's value reaches a container that already stands.
  const moving = legs.filter((l) => Math.abs(l.delta) > EPS || (l.value != null && Math.abs(l.value) > 0.005));
  if (!moving.length && !(losses ?? []).length) return null;
  // Net by area/item/batch to check stock once.
  const net = new Map();
  for (const l of moving) {
    const k = `${l.areaId}:${l.itemId}:${l.batchId ?? 0}`;
    net.set(k, { ...l, delta: round6((net.get(k)?.delta ?? 0) + l.delta) });
  }
  const keys = [...net.values()];
  if (keys.length) {
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
  }
  const [r] = await db.query(
    `INSERT INTO cf_stock_movements (company_id, code, movement_type, movement_date, order_id, order_line_id, reference, notes, created_by)
     VALUES (?, NULL, 'transform', CURDATE(), ?, ?, ?, ?, ?)`,
    [c.companyId, orderId, orderLineId, reference ? String(reference).slice(0, 100) : null, notes ?? null, c.userId ?? null],
  );
  const movementId = r.insertId;
  await db.query('UPDATE cf_stock_movements SET code = ? WHERE id = ?', [`TF-${String(movementId).padStart(6, '0')}`, movementId]);
  if (moving.length) {
    const base = ['company_id', 'movement_id', 'line_no', 'stocking_area_id', 'item_id', 'batch_id', 'quantity', 'unit_cost', 'value', 'notes', 'created_by'];
    const rowOf = (l, i) => [c.companyId, movementId, i + 1, l.areaId, l.itemId, l.batchId ?? null, round6(l.delta),
      l.unitCost ?? null, l.value == null ? null : round2(l.value), l.note ?? null, c.userId ?? null];
    let withOwner = hasV67();
    if (withOwner) {
      try {
        await insertRows(db, 'cf_stock_ledger', [...base, 'owner_party_id'], moving.map((l, i) => [...rowOf(l, i), l.ownerPartyId ?? null]));
      } catch (e) {
        if (!missingV67(e)) throw e;
        withOwner = false;
      }
    }
    if (!withOwner) await insertRows(db, 'cf_stock_ledger', base, moving.map(rowOf));
    // A lot leg whose owner the caller did not know: read it from the lot (one statement).
    if (withOwner && moving.some((l) => l.batchId && l.ownerPartyId === undefined)) {
      await db.query(
        `UPDATE cf_stock_ledger l JOIN cf_stock_batches b ON b.company_id = l.company_id AND b.id = l.batch_id
            SET l.owner_party_id = b.owner_party_id
          WHERE l.company_id = ? AND l.movement_id = ? AND l.batch_id IS NOT NULL`,
        [c.companyId, movementId],
      );
    }
    // One upsert for every balance the movement touches (uq_csk_stock: area, item, batch_key).
    await db.query(
      `INSERT INTO cf_stock_balances (company_id, stocking_area_id, item_id, batch_id, quantity, last_movement_id) VALUES ${keys.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), last_movement_id = VALUES(last_movement_id)`,
      keys.flatMap((l) => [c.companyId, l.areaId, l.itemId, l.batchId ?? null, round6(l.delta), movementId]),
    );
    // Loose stock (no lot) moves its value through the item's average, as postMovement does.
    await poolLegs(db, c.companyId, moving.filter((l) => !l.batchId && Math.abs(l.delta) > EPS), movementId);
  }
  if (hasV67()) {
    try {
      if ((losses ?? []).length) await writeLosses(db, c, movementId, losses.map((x) => ({ orderId, orderLineId, ...x })));
      if (units !== false) {
        await syncUnits(db, c, { movementId, movementType: 'transform', batchIds: moving.map((l) => l.batchId).filter(Boolean), ...(units ?? {}) });
      }
    } catch (e) {
      if (!missingV67(e)) throw e;
    }
  }
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
  // A cut node is a blank of either kind, wherever Setup › Cutting files them.
  const places = await cutPlaces(db, companyId);
  const cutClass = new Set([...places.plate.blanksIds, ...places.section.blanksIds]);
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
  return { rel, byId, stepNode, deps, reqs, isCutNode, groups, nestedCutPlates, places };
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

/**
 * Each node's own lot (created on first need). Map productionItemId -> batch row.
 * Set-based: one read, and for new lots one insert, one read back, one read of
 * the codes already taken and one update naming them.
 */
async function nodeLots(db, c, nodes) {
  const ids = nodes.map((n) => n.id);
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query('SELECT * FROM cf_stock_batches WHERE company_id = ? AND production_item_id IN (?) AND deleted_at IS NULL ORDER BY id', [c.companyId, ids]);
  for (const r of rows) if (!out.has(r.production_item_id)) out.set(r.production_item_id, r);
  const missing = [...new Map(nodes.filter((n) => !out.has(n.id)).map((n) => [n.id, n])).values()];
  if (missing.length) {
    const tag = `~wip~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await insertRows(db, 'cf_stock_batches', ['company_id', 'item_id', 'code', 'received_on', 'supplier_ref', 'production_item_id', 'created_by'],
      missing.map((n) => [c.companyId, n.item_id, `${tag}~${n.id}`, new Date().toISOString().slice(0, 10), n.code ?? null, n.id, c.userId ?? null]));
    const [made] = await db.query('SELECT * FROM cf_stock_batches WHERE company_id = ? AND code LIKE ?', [c.companyId, `${tag}~%`]);
    // The lot is named by the piece (its code), or the piece and its node when a code is shared (grouped parts).
    const nodeOf = new Map(missing.map((n) => [n.id, n]));
    const want = made.map((b) => { const n = nodeOf.get(b.production_item_id); return { b, n, code: n.code ? `${n.code}` : `${n.item_code ?? 'PIECE'}-${n.id}` }; });
    const [taken] = await db.query('SELECT code_active FROM cf_stock_batches WHERE company_id = ? AND code_active IN (?) AND id NOT IN (?)',
      [c.companyId, want.map((w) => w.code.toLowerCase()), made.map((b) => b.id)]);
    const used = new Set(taken.map((t) => t.code_active));
    for (const w of want) {
      if (used.has(w.code.toLowerCase())) w.code = `${w.code}-${w.n.id}`;
      used.add(w.code.toLowerCase());
    }
    if (want.length) {
      await db.query(`UPDATE cf_stock_batches SET code = CASE id ${want.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
        [...want.flatMap((w) => [w.b.id, w.code]), c.companyId, want.map((w) => w.b.id)]);
    }
    for (const w of want) out.set(w.n.id, { ...w.b, code: w.code });
  }
  return out;
}

/**
 * Makes lots a customer's (§35 / §67 rule c): a lot made from their material is
 * theirs, for this order. Only lots still ours change; in-memory rows follow.
 */
async function claimLots(db, c, lotRows, partyId, orderId) {
  const list = lotRows.filter((b) => b && partyId && !b.owner_party_id);
  if (!list.length) return;
  await db.query('UPDATE cf_stock_batches SET owner_party_id = ?, owner_order_id = ? WHERE company_id = ? AND id IN (?) AND owner_party_id IS NULL',
    [partyId, orderId ?? null, c.companyId, list.map((b) => b.id)]);
  for (const b of list) { b.owner_party_id = partyId; b.owner_order_id = orderId ?? null; }
}

/** The first customer among owners (one order has one customer), or null. */
const customerOf = (owners) => owners.find((o) => o != null) ?? null;

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
 * reservation updates to make. Each leg carries its lot's owner.
 */
async function takeRequirement(db, c, req, qty, label) {
  const [res] = await db.query(
    `SELECT v.id, v.batch_id, v.quantity, b.unit_cost, b.owner_party_id FROM cf_stock_reservations v LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND v.requirement_id = ? AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY v.id FOR UPDATE`,
    [c.companyId, req.id],
  );
  const reserved = res.reduce((t, r) => t + Number(r.quantity), 0);
  if (reserved + EPS < qty) {
    // §56: the refusal says what the material is waiting on — the requisition, the purchase order and its date.
    // Read only here, on the way out (materialReadyService is imported when asked for: it reads release's planned material).
    let waiting = '';
    try {
      const [[rel]] = await db.query(
        'SELECT r.order_line_id FROM cf_material_requirements q JOIN cf_production_releases r ON r.id = q.release_id WHERE q.company_id = ? AND q.id = ?',
        [c.companyId, req.id],
      );
      const { materialWaitWords } = await import('./materialReadyService.js');
      const words = rel ? await materialWaitWords(db, c.companyId, rel.order_line_id, [req.item_id]) : [];
      if (words.length) waiting = ` It is waiting on — ${words.join(' ')}`;
    } catch { /* the refusal below is what matters; it is said without the detail */ }
    throw invalid('MATERIAL_NOT_RESERVED', `${label} needs ${fmt(qty)} — only ${fmt(reserved)} is in stock and reserved for it. Receive and reserve it before starting.${waiting}`, { detail: { itemId: req.item_id, requirementId: req.id } });
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
      legs.push({ areaId: a.stocking_area_id, itemId: req.item_id, batchId: r.batch_id ?? null, delta: -t, unitCost: unit, value: unit == null ? null : -t * unit, label, reservationId: r.id,
        ownerPartyId: r.batch_id ? (r.owner_party_id ?? null) : null });
      need = round6(need - t);
    }
    if (need > EPS) throw invalid('NOT_ENOUGH', `${label}: it is reserved but not on the shelf — ${fmt(need)} cannot be found in storage.`);
    resWrites.push({ id: r.id, rest: round6(Number(r.quantity) - take) });
    left = round6(left - take);
  }
  return { legs, resWrites };
}

async function writeReservations(db, companyId, resWrites) {
  const done = resWrites.filter((w) => w.rest <= EPS).map((w) => w.id);
  if (done.length) await db.query("UPDATE cf_stock_reservations SET quantity = 0, status = 'consumed', closed_at = NOW() WHERE company_id = ? AND id IN (?)", [companyId, done]);
  const part = resWrites.filter((w) => w.rest > EPS);
  if (part.length) {
    await db.query(`UPDATE cf_stock_reservations SET quantity = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...part.flatMap((w) => [w.id, w.rest]), companyId, part.map((w) => w.id)]);
  }
}

// --- offcuts ------------------------------------------------------------------------

/** The catalog item an offcut of this steel is a piece of — made on first need. */
async function offcutItem(db, c, { thickness, grade, material }, places = null) {
  let node = places?.plate?.offcutNodeId ? { id: places.plate.offcutNodeId } : null;
  if (!node) [[node]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, OFFCUT_NODE_CODE]);
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

/** The steel of records, one query: Map id -> { CODE: row } (value_number, value_text, option_id, option_value, spec_id). */
async function steelValues(db, companyId, ids, codes) {
  const list = [...new Set(ids.filter((x) => x != null).map(Number))];
  const out = new Map(list.map((id) => [id, {}]));
  if (!list.length) return out;
  const [rows] = await db.query(
    `SELECT v.subject_id, UPPER(s.code) AS code, s.id AS spec_id, v.value_number, v.value_text, v.option_id, o.value AS option_value
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL AND s.code IN (?)`,
    [companyId, list, codes],
  );
  for (const r of rows) out.get(Number(r.subject_id))[r.code] = r;
  return out;
}
const numOf = (r) => (r?.value_number == null ? null : Number(r.value_number));
const textOf = (r) => (r ? (r.option_value ?? r.value_text ?? null) : null);
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** kg per mm of a stock bar: section area × density, else its weight over its length. */
const barKgPerMm = (v) => {
  const area = numOf(v.SECTION_AREA);
  const dens = numOf(v.DENSITY) > 0 ? numOf(v.DENSITY) : FALLBACK_DENSITY;
  if (area > 0) return (area * dens) / 1e9;
  return numOf(v.WEIGHT) > 0 && numOf(v.LENGTH) > 0 ? numOf(v.WEIGHT) / numOf(v.LENGTH) : null;
};

const SECTION_STEEL = ['THICKNESS', 'WIDTH', 'DEPTH', 'SECTION_AREA', 'GRADE', 'IMPACT_CLASS', 'MATERIAL', 'DENSITY'];

/**
 * The item a bar offcut of this section is a piece of — "OFC-<profile>-<grade>"
 * (e.g. OFC-ISA75X75X8-E350BO) under the section offcut place of Setup ›
 * Cutting, made on first need with the stock bar's steel and no length: each
 * piece's length is on its batch and its cf_offcuts row. No place set = null,
 * and the offcut stays planned (as a plate offcut does).
 */
async function sectionOffcutItem(db, c, places, stockItemId) {
  const nodeId = places?.section?.offcutNodeId;
  if (!nodeId || !stockItemId) return null;
  const [[stock]] = await db.query('SELECT id, code, name FROM cf_master_records WHERE company_id = ? AND id = ?', [c.companyId, stockItemId]);
  if (!stock) return null;
  const v = (await steelValues(db, c.companyId, [stockItemId], SECTION_STEEL)).get(Number(stockItemId));
  const word = String(stock.name ?? stock.code ?? 'SEC').trim().split(/\s+/)[0];
  const dims = [numOf(v.DEPTH), numOf(v.WIDTH), numOf(v.THICKNESS)].filter((x) => x != null).map(fmt);
  const code = `OFC-${word}${dims.join('X')}-${textOf(v.GRADE) ?? ''}${textOf(v.IMPACT_CLASS) ?? ''}`.replace(/\s+/g, '').toUpperCase().slice(0, 100);
  const [[have]] = await db.query('SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, code]);
  if (have) return have.id;
  const name = `Bar offcut ${word} ${dims.join(' x ')} ${[textOf(v.GRADE), textOf(v.IMPACT_CLASS)].filter(Boolean).join(' ')}`.replace(/\s+/g, ' ').trim();
  const [r] = await db.query(
    "INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, 'item', ?, ?, 'OFC', ?, 'active', ?)",
    [c.companyId, code, name, nodeId, c.userId ?? null],
  );
  await db.query(
    "INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'batch', 'nos', 'stock')",
    [r.insertId, c.companyId],
  );
  const rows = SECTION_STEEL.map((k) => v[k]).filter(Boolean)
    .map((x) => [c.companyId, x.spec_id, 'master', r.insertId, x.value_number, x.value_text, x.option_id, 'entered', c.userId ?? null]);
  if (rows.length) await insertRows(db, 'cf_spec_values', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'value_text', 'option_id', 'source', 'created_by'], rows);
  return r.insertId;
}

/** Kilograms of each output of a cut: a section blank by section area × length × density; anything else as before (unitKgOf). */
async function outputKg(db, c, ctx, nodes) {
  const kg = await unitKgOf(db, c.companyId, nodes.map((n) => n.item_id));
  const sectionIds = nodes.filter((n) => ctx.places.section.blanksIds.has(Number(n.classification_id))).map((n) => n.item_id);
  if (sectionIds.length) {
    const v = await steelValues(db, c.companyId, sectionIds, ['SECTION_AREA', 'LENGTH', 'DENSITY']);
    for (const id of sectionIds) {
      const x = v.get(Number(id));
      const area = numOf(x.SECTION_AREA); const len = numOf(x.LENGTH);
      const dens = numOf(x.DENSITY) > 0 ? numOf(x.DENSITY) : FALLBACK_DENSITY;
      if (area > 0 && len > 0) kg.set(id, Math.round(((area * len * dens) / 1e9) * 1000) / 1000);
    }
  }
  return kg;
}

/**
 * Bars of a cut that come from an OFFCUT (section nesting claimed it at accept,
 * cf_offcuts 'used'): the offcut stock piece itself goes into the cut — no
 * requirement was raised for it, because nothing is bought. Legs taking each
 * offcut out of wherever it lies (WIP first, then storage), at its value.
 */
async function offcutBarLegs(db, c, lots) {
  const fromOffcuts = lots.filter((l) => l.kind === 'bar' && l.source === 'offcut');
  if (!fromOffcuts.length) return [];
  const offIds = fromOffcuts.map((l) => Number(parseJson(l.waste_json)?.offcutId)).filter(Boolean);
  const [offRows] = offIds.length ? await db.query(
    'SELECT o.id, o.offcut_no, o.batch_id, b.item_id, b.unit_cost, b.owner_party_id FROM cf_offcuts o LEFT JOIN cf_stock_batches b ON b.id = o.batch_id WHERE o.company_id = ? AND o.id IN (?)',
    [c.companyId, offIds],
  ) : [[]];
  const legs = [];
  for (const l of fromOffcuts) {
    const o = offRows.find((x) => x.id === Number(parseJson(l.waste_json)?.offcutId));
    const label = `Offcut ${o?.offcut_no ?? '?'} (bar ${l.lot_no})`;
    if (!o?.batch_id) throw invalid('NOT_ENOUGH', `${label} is not a stock piece yet, so bar ${l.lot_no} cannot be cut from it — cut the bar it comes from first, or nest the line again without it.`);
    const [[at]] = await db.query(
      `SELECT k.stocking_area_id FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN ('storage','wip')
        WHERE k.company_id = ? AND k.item_id = ? AND k.batch_key = ? AND k.quantity >= 1 ORDER BY a.purpose = 'wip' DESC, k.id LIMIT 1`,
      [c.companyId, o.item_id, o.batch_id],
    );
    if (!at) throw invalid('NOT_ENOUGH', `${label} is not in stock, so bar ${l.lot_no} cannot be cut from it — put it back in stock, or nest the line again without it.`);
    const unit = o.unit_cost == null ? null : Number(o.unit_cost);
    legs.push({ areaId: at.stocking_area_id, itemId: o.item_id, batchId: o.batch_id, delta: -1, unitCost: unit, value: unit == null ? null : -unit, label, ownerPartyId: o.owner_party_id ?? null, plateLotId: l.id });
  }
  return legs;
}

// --- the reconciler --------------------------------------------------------------------

/** Rank of an operation on one node: what is made comes first, then scrap, then pieces made again. */
const RANK = { cut: 0, join: 0, split: 1, scrap: 2 };

/**
 * After steps changed: post what their states now say the ledger should hold.
 * Steps of several releases may be passed; each release is read once.
 */
export async function ledgerOnSteps(db, c, stepIds) {
  const ids = [...new Set((stepIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return { movements: 0 };
  let steps;
  try {
    [steps] = await db.query(
      `SELECT s.id, s.production_item_id, s.sequence, s.state, s.held_from, s.quantity, s.qty_good, s.qty_scrap, s.ledger_in, s.ledger_out,
              s.ledger_scrap, s.ledger_remade, pi.release_id
         FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
        WHERE s.company_id = ? AND s.id IN (?) AND s.deleted_at IS NULL ORDER BY s.id FOR UPDATE`,
      [c.companyId, ids],
    );
  } catch (e) {
    if (!missingV67(e)) throw e;
    // A database without §67: scrap is not followed (as before).
    [steps] = await db.query(
      `SELECT s.id, s.production_item_id, s.sequence, s.state, s.held_from, s.quantity, s.qty_good, 0 AS qty_scrap, s.ledger_in, s.ledger_out,
              0 AS ledger_scrap, 0 AS ledger_remade, pi.release_id
         FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
        WHERE s.company_id = ? AND s.id IN (?) AND s.deleted_at IS NULL ORDER BY s.id FOR UPDATE`,
      [c.companyId, ids],
    );
  }
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
      // Scrap (and pieces made again): a step not started has scrapped nothing.
      const wantScrap = started(s) ? Number(s.qty_scrap ?? 0) : 0;
      const posted = Number(s.ledger_scrap ?? 0);
      const remadeNow = Math.max(0, Math.min(posted, round6(Number(s.qty_good ?? 0) + posted - Number(s.quantity ?? qty))));
      if (Math.abs(wantScrap - posted) > EPS || Math.abs(remadeNow - Number(s.ledger_remade ?? 0)) > EPS) {
        const down = wantScrap < Number(s.ledger_scrap ?? 0) - EPS;
        work.push({ s, node, k, op: 'scrap', d: down ? -1 : 1, wantScrap });
      }
    }
    work.sort((a, b) => (Math.sign(a.d) - Math.sign(b.d)) || (b.node.depth - a.node.depth)
      || (a.d < 0 ? RANK[b.op] - RANK[a.op] : RANK[a.op] - RANK[b.op]));
    for (const w of work) {
      const moved = w.op === 'join' ? await joinStep(db, c, ctx, area, w)
        : w.op === 'split' ? await splitStep(db, c, ctx, area, w)
          : w.op === 'cut' ? await cutStep(db, c, ctx, area, w)
            : await scrapStep(db, c, ctx, area, w);
      movements += Number(moved || 0);
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
    const parentLot = new Map();
    let lotOut = null;
    if (!looseOnly) {
      // Made children, lying in WIP as themselves (and the container, one read).
      const kids = node.children;
      const lots = await nodeLots(db, c, [...kids, node]);
      lotOut = lots.get(node.id);
      const bal = await balancesOf(db, c.companyId, area.id, kids.map((ch) => lots.get(ch.id).id));
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
        legs.push({ areaId: area.id, itemId: ch.item_id, batchId: lot.id, delta: -take, unitCost: unit, value: unit == null ? null : -take * unit, label: nameOfNode(ch), ownerPartyId: lot.owner_party_id ?? null });
        joins.push({ child: ch, req: null, itemId: ch.item_id, batchId: lot.id, areaId: area.id, qty: take, value: unit == null ? null : take * unit });
        parentLot.set(lot.id, lotOut.id);
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
    if (!lotOut) lotOut = (await nodeLots(db, c, [node])).get(node.id);
    // A customer's piece or material inside makes the container theirs (§67 rule c).
    await claimLots(db, c, [lotOut], customerOf(legs.map((l) => l.ownerPartyId)), ctx.rel.order_id);
    if (!looseOnly) {
      // A re-join: the container already exists, its value is what is inside it.
      legs.push({ areaId: area.id, itemId: node.item_id, batchId: lotOut.id, delta: node.quantity, unitCost: inValue == null ? null : round4(inValue / node.quantity), value: inValue, label: nameOfNode(node), ownerPartyId: lotOut.owner_party_id ?? null });
    } else {
      // Material into a node that already stands: its lot takes the value on.
      legs.push({ areaId: area.id, itemId: node.item_id, batchId: lotOut.id, delta: 0, value: inValue, label: nameOfNode(node), ownerPartyId: lotOut.owner_party_id ?? null });
    }
    const movementId = await writeTransform(db, c, {
      reference: ref, notes: `${looseOnly ? 'Material for' : 'Joined into'} ${nameOfNode(node)} (step started)`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs,
      units: { reason: 'joined', parentLot },
    });
    await writeReservations(db, c.companyId, resWrites);
    if (reqWrites.length) {
      await db.query(`UPDATE cf_material_requirements SET issued = issued + CASE id ${reqWrites.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
        [...reqWrites.flatMap((w) => [w.id, w.add]), c.companyId, reqWrites.map((w) => w.id)]);
    }
    if (joins.length) {
      await insertRows(db, 'cf_wip_joins', ['company_id', 'parent_item_id', 'step_id', 'child_item_id', 'requirement_id', 'item_id', 'batch_id', 'area_id', 'quantity', 'value', 'joined_movement_id', 'created_by'],
        joins.map((j) => [c.companyId, node.id, s.id, j.child?.id ?? null, j.req?.id ?? null, j.itemId, j.batchId ?? null, j.areaId, j.qty, j.value == null ? null : round2(j.value), movementId, c.userId ?? null]));
    }
    await setLotCost(db, c, lotOut, area);
    await db.query('UPDATE cf_production_steps SET ledger_in = ledger_in + ? WHERE company_id = ? AND id = ?', [d, c.companyId, s.id]);
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
    legs.push({ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: -node.quantity, unitCost: unitOf(lot), value: -total, label: nameOfNode(node), ownerPartyId: lot.owner_party_id ?? null });
  } else if (rows.length) {
    const total = rows.reduce((t, r) => t + (r.value == null ? 0 : Number(r.value)), 0);
    legs.push({ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: 0, value: -total, label: nameOfNode(node), ownerPartyId: lot.owner_party_id ?? null });
  }
  for (const r of rows) legs.push({ areaId: r.area_id, itemId: r.item_id, batchId: r.batch_id, delta: Number(r.quantity), value: r.value == null ? null : Number(r.value), label: `item ${r.item_id}` });
  const movementId = await writeTransform(db, c, {
    reference: ref, notes: `Start of ${nameOfNode(node)} undone — back where it came from`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs,
    units: { reason: new Map([[lot.id, 'undone']]), restore: 'joined' },
  });
  const back = rows.filter((x) => x.requirement_id);
  if (back.length) {
    await db.query(`UPDATE cf_material_requirements SET issued = GREATEST(issued - CASE id ${back.map(() => 'WHEN ? THEN ?').join(' ')} END, 0) WHERE company_id = ? AND id IN (?)`,
      [...back.flatMap((r) => [r.requirement_id, Number(r.quantity)]), c.companyId, [...new Set(back.map((r) => r.requirement_id))]]);
    await insertRows(db, 'cf_stock_reservations', ['company_id', 'requirement_id', 'item_id', 'batch_id', 'quantity', 'status', 'created_by'],
      back.map((r) => [c.companyId, r.requirement_id, r.item_id, r.batch_id, Number(r.quantity), 'active', c.userId ?? null]));
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
    const legs = [{ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: -node.quantity, unitCost: unitOf(lot), value: -total, label: nameOfNode(node), ownerPartyId: lot.owner_party_id ?? null }];
    for (const r of kids) {
      const share = brought > 0 && r.value != null ? Number(r.value) / brought : 1 / kids.length;
      legs.push({ areaId: area.id, itemId: r.item_id, batchId: r.batch_id, delta: Number(r.quantity), value: (r.value == null ? 0 : Number(r.value)) + extra * share, label: `item ${r.item_id}` });
    }
    const movementId = await writeTransform(db, c, {
      reference: ref, notes: `${nameOfNode(node)} taken apart (step done)`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs,
      units: { reason: new Map([[lot.id, 'split']]), restore: 'joined' },
    });
    await db.query('UPDATE cf_wip_joins SET left_movement_id = ?, left_step_id = ? WHERE company_id = ? AND id IN (?)', [movementId, s.id, c.companyId, inside.map((r) => r.id)]);
    const costs = kids.map((r) => ({ r, back: legs.find((l) => l.batchId === r.batch_id && l.delta > 0) })).filter((x) => x.back?.value != null);
    if (costs.length) {
      await db.query(`UPDATE cf_stock_batches SET unit_cost = CASE id ${costs.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
        [...costs.flatMap((x) => [x.r.batch_id, round4(x.back.value / Number(x.r.quantity))]), c.companyId, costs.map((x) => x.r.batch_id)]);
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
  const parentLot = new Map();
  for (const r of kids) {
    const b = lots.get(r.child_item_id);
    if ((bal.get(b.id) ?? 0) + EPS < Number(r.quantity)) throw invalid('MOVED_ON', `${nameOfNode(ctx.byId.get(r.child_item_id))} has moved on since it was taken out — the dismantle cannot be undone.`);
    const v = (unitOf(b) ?? 0) * Number(r.quantity);
    total += v;
    legs.push({ areaId: area.id, itemId: r.item_id, batchId: r.batch_id, delta: -Number(r.quantity), value: -v, label: `item ${r.item_id}`, ownerPartyId: b.owner_party_id ?? null });
    parentLot.set(r.batch_id, lot.id);
  }
  legs.push({ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: node.quantity, unitCost: round4(total / node.quantity), value: total, label: nameOfNode(node), ownerPartyId: lot.owner_party_id ?? null });
  await writeTransform(db, c, {
    reference: ref, notes: `Dismantle of ${nameOfNode(node)} undone`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs,
    units: { reason: 'joined', parentLot, restore: 'split' },
  });
  if (left.length) await db.query('UPDATE cf_wip_joins SET left_movement_id = NULL, left_step_id = NULL WHERE company_id = ? AND id IN (?)', [c.companyId, left.map((r) => r.id)]);
  await db.query('UPDATE cf_stock_batches SET unit_cost = ? WHERE company_id = ? AND id = ?', [round4(total / node.quantity), c.companyId, lot.id]);
  await db.query('UPDATE cf_production_steps SET ledger_out = 0 WHERE company_id = ? AND id = ?', [c.companyId, s.id]);
  return true;
}

// --- a cut: the whole plate accounted for --------------------------------------------

/** Where scrap goes: the area, the item, the rate and (for customers' scrap) their lots. Fixed queries. */
async function scrapTarget(db, c, ctx, customerOwners) {
  const itemId = await scrapItem(db, c, ctx.places);
  if (!itemId) return { itemId: null, area: null, rate: null, lots: new Map() };
  const area = await scrapArea(db, c);
  const { ratePerKg } = await scrapRate(db, c.companyId);
  const lots = await customerScrapLots(db, c, itemId, [...new Set(customerOwners.filter(Boolean))]
    .map((p) => ({ partyId: p, orderId: ctx.rel.order_id, orderCode: ctx.rel.order_code })));
  return { itemId, area, rate: ratePerKg, lots };
}

/**
 * The kerf burnt on each plate lot, in kg: the lot's stored cut length × its
 * kerf; else the stored kerf area; else the parts' outlines on it (placement
 * boxes) × the kerf. A bar: one saw kerf per piece × its kg per mm.
 */
function lotKerfKg(l, { kerfMm, perimeterMm, pieces, kgPerMm }) {
  if (l.kind === 'bar') return kgPerMm > 0 ? pieces * kerfMm * kgPerMm : 0;
  const w = parseJson(l.waste_json);
  const t = Number(l.thickness_mm);
  const dens = Number(l.density) > 0 ? Number(l.density) : FALLBACK_DENSITY;
  if (!(t > 0)) return 0;
  const cutLen = Number(w?.cutLength);
  const lotKerf = Number(l.kerf_mm) > 0 ? Number(l.kerf_mm) : kerfMm;
  const areaMm2 = cutLen > 0 ? cutLen * lotKerf : Number(w?.kerf) > 0 ? Number(w.kerf) : perimeterMm * lotKerf;
  return (areaMm2 * t * dens) / 1e9;
}

/** A plate cut (d > 0): plates out → cut pieces + offcuts + scrap in, kerf and write-down as losses; undo while nothing has moved on. */
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
    const inLegs = [];
    const resWrites = [];
    for (const r of reqs) {
      const want = round6(Number(r.quantity) - Number(r.issued));
      if (want <= EPS) continue;
      const t = await takeRequirement(db, c, r, want, `${nameOfNode(node)} — plate ${r.item_id}`);
      inLegs.push(...t.legs);
      resWrites.push(...t.resWrites);
    }
    const [pl] = lotIds.length ? await db.query('SELECT * FROM cf_plate_lots WHERE company_id = ? AND id IN (?)', [c.companyId, lotIds]) : [[]];
    inLegs.push(...await offcutBarLegs(db, c, pl));
    const kg = await outputKg(db, c, ctx, outs);
    const [offcuts] = lotIds.length ? await db.query("SELECT * FROM cf_offcuts WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL AND status = 'planned'", [c.companyId, lotIds]) : [[]];
    // Each offcut's item (made on first need, one per steel).
    const items = new Map();
    for (const o of offcuts) {
      const key = o.kind === 'bar' ? `bar:${o.stock_item_id}` : `plate:${Number(o.thickness_mm)}:${o.grade ?? ''}:${o.material ?? ''}`;
      if (!items.has(key)) {
        items.set(key, o.kind === 'bar'
          ? await sectionOffcutItem(db, c, ctx.places, o.stock_item_id)
          : await offcutItem(db, c, { thickness: Number(o.thickness_mm), grade: o.grade, material: o.material }, ctx.places));
      }
      o._itemId = items.get(key);
    }
    const plan = await planCut(db, c, ctx, { outs, kg, pl, inLegs, reqs, offcuts });
    // Offcut stock pieces (set-based): the lot an earlier cut of this plate made (a cut undone and done
    // again), else a new one named by the order and the offcut — offcut numbers repeat from line to line.
    const stockable = offcuts.filter((o) => o._itemId);                // no offcut place set up: the offcut stays planned (its steel is scrap)
    const fresh = stockable.filter((o) => !o.batch_id);
    if (fresh.length) {
      const want = fresh.map((o) => ({ o, code: `${ctx.rel.order_code}-${o.offcut_no}` }));
      const [taken] = await db.query('SELECT code_active FROM cf_stock_batches WHERE company_id = ? AND code_active IN (?)', [c.companyId, want.map((w) => w.code.toLowerCase())]);
      const used = new Set(taken.map((t) => t.code_active));
      for (const w of want) { if (used.has(w.code.toLowerCase())) w.code = `${w.code}-${w.o.id}`; used.add(w.code.toLowerCase()); }
      await insertRows(db, 'cf_stock_batches', ['company_id', 'item_id', 'code', 'received_on', 'supplier_ref', 'unit_cost', 'owner_party_id', 'owner_order_id', 'notes', 'created_by'],
        want.map((w) => {
          const o = w.o;
          const v = plan.offcutValue.get(o.id);
          const owner = plan.offcutOwner.get(o.id);
          return [c.companyId, o._itemId, w.code, new Date().toISOString().slice(0, 10), o.offcut_no, v == null ? null : round4(v), owner, owner ? ctx.rel.order_id : null,
            o.kind === 'bar' ? `Bar offcut ${o.offcut_no} of ${ctx.rel.order_code} — ${fmt(o.length_mm)} mm long (cf_offcuts #${o.id})` : `Offcut ${o.offcut_no} of ${ctx.rel.order_code} — outline in cf_offcuts #${o.id}`,
            c.userId ?? null];
        }));
      const [made] = await db.query('SELECT id, code_active FROM cf_stock_batches WHERE company_id = ? AND code_active IN (?)', [c.companyId, want.map((w) => w.code.toLowerCase())]);
      const idOf = new Map(made.map((b) => [b.code_active, b.id]));
      for (const w of want) w.o.batch_id = idOf.get(w.code.toLowerCase()) ?? null;
    }
    const again = stockable.filter((o) => o.batch_id && !fresh.includes(o));
    if (again.length) {
      await db.query(`UPDATE cf_stock_batches SET unit_cost = CASE id ${again.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
        [...again.flatMap((o) => { const v = plan.offcutValue.get(o.id); return [o.batch_id, v == null ? null : round4(v)]; }), c.companyId, again.map((o) => o.batch_id)]);
    }
    // The cut pieces of a customer's plate are the customer's.
    for (const [owner, nodes] of groupBy(outs.map((n) => ({ n, owner: plan.nodeOwner.get(n.id) ?? null })), 'owner')) {
      if (owner != null) await claimLots(db, c, nodes.map((x) => lots.get(x.n.id)), Number(owner), ctx.rel.order_id);
    }
    const legs = [...inLegs];
    for (const n of outs) {
      const v = plan.nodeValue.get(n.id);
      legs.push({ areaId: area.id, itemId: n.item_id, batchId: lots.get(n.id).id, delta: n.quantity, unitCost: v == null ? null : round4(v / n.quantity), value: v, label: nameOfNode(n), ownerPartyId: lots.get(n.id).owner_party_id ?? null });
    }
    for (const o of stockable) {
      const v = plan.offcutValue.get(o.id);
      legs.push({ areaId: area.id, itemId: o._itemId, batchId: o.batch_id, delta: 1, unitCost: v == null ? null : round4(v), value: v, label: o.offcut_no, ownerPartyId: plan.offcutOwner.get(o.id) ?? null });
    }
    // Offcuts that could not be stocked (no offcut place): their steel stays a loss of the cut, as before.
    legs.push(...plan.scrapLegs);
    const what = pl.length && pl.every((l) => l.kind === 'bar') ? 'Bar' : 'Plate';
    const scrapKg = plan.scrapLegs.reduce((t, l) => t + l.delta, 0);
    const kerfKg = plan.losses.filter((x) => x.kind === 'kerf').reduce((t, x) => t + (x.kg ?? 0), 0);
    const movementId = await writeTransform(db, c, {
      reference: ref,
      notes: `${what}${lotIds.length > 1 ? 's' : ''} cut: ${outs.length} cut piece row${outs.length === 1 ? '' : 's'}${stockable.length ? `, ${stockable.length} offcut${stockable.length === 1 ? '' : 's'}` : ''}`
        + `${scrapKg > EPS ? `, ${fmt(scrapKg)} kg scrap` : ''}${kerfKg > EPS ? `, ${fmt(kerfKg)} kg burnt in the kerf` : ''}`,
      orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs, losses: plan.losses,
    });
    await writeReservations(db, c.companyId, resWrites);
    if (reqs.length) await db.query('UPDATE cf_material_requirements SET issued = quantity WHERE company_id = ? AND id IN (?)', [c.companyId, reqs.map((r) => r.id)]);
    if (stockable.length) {
      await db.query(`UPDATE cf_offcuts SET status = 'available', batch_id = CASE id ${stockable.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
        [...stockable.flatMap((o) => [o.id, o.batch_id]), c.companyId, stockable.map((o) => o.id)]);
    }
    const costs = outs.map((n) => ({ id: lots.get(n.id).id, v: plan.nodeValue.get(n.id), q: n.quantity }));
    await db.query(`UPDATE cf_stock_batches SET unit_cost = CASE id ${costs.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...costs.flatMap((x) => [x.id, x.v == null ? null : round4(x.v / x.q)]), c.companyId, costs.map((x) => x.id)]);
    if (lotIds.length && hasV67()) {
      try { await db.query('UPDATE cf_plate_lots SET cut_movement_id = ? WHERE company_id = ? AND id IN (?)', [movementId, c.companyId, lotIds]); } catch (e) { if (!missingV67(e)) throw e; }
    }
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
  const ins = legsOf.filter((l) => Number(l.quantity) > 0 && l.stocking_area_id === area.id && l.batch_id);
  const bal = await balancesOf(db, c.companyId, area.id, ins.map((l) => l.batch_id));
  for (const l of ins) if ((bal.get(l.batch_id) ?? 0) + EPS < Number(l.quantity)) throw invalid('MOVED_ON', 'Pieces from this cut have already moved on — the cut cannot be undone.');
  const legs = legsOf.map((l) => ({ areaId: l.stocking_area_id, itemId: l.item_id, batchId: l.batch_id, delta: -Number(l.quantity), unitCost: l.unit_cost == null ? null : Number(l.unit_cost), value: l.value == null ? null : -Number(l.value), label: `item ${l.item_id}`, ownerPartyId: l.owner_party_id === undefined ? undefined : l.owner_party_id }));
  const undoId = await writeTransform(db, c, {
    reference: ref, notes: 'Cut undone — plates back on the shelf', orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs,
    units: { reason: 'undone' },
  });
  if (undoId && lastId && hasV67()) {
    try { await reverseLosses(db, c, lastId, undoId); } catch (e) { if (!missingV67(e)) throw e; }
  }
  const reqs = ctx.reqs.filter((r) => r.step_id === s.id);
  // Each requirement gets back what it gave (its quantity), from the plates of its item that the cut took.
  const back = [];
  const pool = legsOf.filter((x) => Number(x.quantity) < 0).map((x) => ({ itemId: x.item_id, batchId: x.batch_id, left: -Number(x.quantity) }));
  for (const r of reqs) {
    let need = Number(r.quantity);
    for (const p of pool.filter((x) => x.itemId === r.item_id && x.left > EPS)) {
      if (need <= EPS) break;
      const t = Math.min(need, p.left);
      back.push([c.companyId, r.id, r.item_id, p.batchId, round6(t), 'active', c.userId ?? null]);
      p.left = round6(p.left - t);
      need = round6(need - t);
    }
  }
  if (back.length) await insertRows(db, 'cf_stock_reservations', ['company_id', 'requirement_id', 'item_id', 'batch_id', 'quantity', 'status', 'created_by'], back);
  if (reqs.length) await db.query('UPDATE cf_material_requirements SET issued = 0 WHERE company_id = ? AND id IN (?)', [c.companyId, reqs.map((r) => r.id)]);
  // Back to planned; the lot is kept (empty) so cutting again reuses it.
  if (lotIds.length) {
    await db.query("UPDATE cf_offcuts SET status = 'planned' WHERE company_id = ? AND plate_lot_id IN (?) AND status = 'available'", [c.companyId, lotIds]);
    if (hasV67()) {
      try { await db.query('UPDATE cf_plate_lots SET cut_movement_id = NULL WHERE company_id = ? AND id IN (?)', [c.companyId, lotIds]); } catch (e) { if (!missingV67(e)) throw e; }
    }
  }
  await db.query('UPDATE cf_production_steps SET ledger_out = 0 WHERE company_id = ? AND id = ?', [c.companyId, s.id]);
  return true;
}

/**
 * Where a cut's steel and value go (§67). Per OWNER (ours, or the customer
 * whose plate it is): value in V and plate weight W give ₹/kg; each lot's
 * weight = parts placed on it + its offcuts + kerf + scrap (the remainder).
 * Parts and offcuts at ₹/kg; scrap at the scrap rate (never above ₹/kg);
 * kerf at ₹/kg as a loss; the write-down of scrap is the rest, so per owner
 * V = parts + offcuts + scrap + kerf + write-down, to the paisa.
 * A cut piece on a customer's plate is the customer's. Returns
 * { nodeValue, nodeOwner, offcutValue, offcutOwner, scrapLegs, losses }.
 */
async function planCut(db, c, ctx, { outs, kg, pl, inLegs, reqs, offcuts }) {
  const keyOf = (p) => (p == null ? 'ours' : String(p));
  const ownerOfKey = (k) => (k === 'ours' ? null : Number(k));
  // Value in, per owner.
  const value = new Map();
  for (const l of inLegs) {
    const kk = keyOf(l.ownerPartyId ?? null);
    const g = value.get(kk) ?? { v: 0, nul: false };
    if (l.value == null) g.nul = true; else g.v += -Number(l.value);
    value.set(kk, g);
  }
  // Weight in: each plate lot (a nest), or each plate taken (a cut plate cutting its own plate).
  const lotRows = [];
  let sawKerfMm = ctx.places.settings?.sawKerfMm ?? 3;
  if (pl.length) {
    const bars = pl.filter((l) => l.kind === 'bar');
    const perMm = bars.length ? await steelValues(db, c.companyId, bars.map((l) => l.plate_item_id), ['SECTION_AREA', 'DENSITY', 'WEIGHT', 'LENGTH']) : new Map();
    const [placed] = await db.query(
      `SELECT plate_lot_id, cut_plate_id, COUNT(*) AS n, SUM(2 * (COALESCE(length_mm, 0) + COALESCE(width_mm, 0))) AS perimeter
         FROM cf_nest_placements WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL GROUP BY plate_lot_id, cut_plate_id`,
      [c.companyId, pl.map((l) => l.id)],
    );
    const needBand = pl.some((l) => l.kind !== 'bar' && !(Number(l.kerf_mm) > 0) && !(Number(parseJson(l.waste_json)?.kerf) > 0));
    let band = () => 3;
    if (needBand) {
      const { cutSettingRows, pickCutSettings } = await import('./nestingService.js');
      const rows = await cutSettingRows(db, c.companyId);
      band = (t) => pickCutSettings(rows, t).kerfMm;
    }
    sawKerfMm = Number(sawKerfMm) > 0 ? Number(sawKerfMm) : 3;
    for (const l of pl) {
      const kgPerMm = l.kind === 'bar' ? barKgPerMm(perMm.get(Number(l.plate_item_id)) ?? {}) : null;
      const plateKg = l.kind === 'bar' ? (kgPerMm ?? 0) * Number(l.length_mm) : lotPlateKg(l);
      const mine = placed.filter((p) => p.plate_lot_id === l.id);
      const pieces = new Map(mine.map((p) => [Number(p.cut_plate_id), Number(p.n)]));
      const partsKg = mine.reduce((t, p) => t + Number(p.n) * (kg.get(Number(p.cut_plate_id)) ?? 0), 0);
      // Only offcuts that become stock pieces; one that cannot (no offcut place) is scrap.
      const offKg = offcuts.filter((o) => o.plate_lot_id === l.id && o._itemId).reduce((t, o) => t + Number(o.weight_kg ?? 0), 0);
      const kerfMm = l.kind === 'bar' ? (Number(l.kerf_mm) > 0 ? Number(l.kerf_mm) : sawKerfMm) : band(Number(l.thickness_mm));
      const kerfKg = lotKerfKg(l, { kerfMm, perimeterMm: mine.reduce((t, p) => t + Number(p.perimeter ?? 0), 0), pieces: mine.reduce((t, p) => t + Number(p.n), 0), kgPerMm });
      lotRows.push({ id: l.id, itemId: l.plate_item_id, owner: l.owner_party_id ?? null, plateKg, pieces, partsKg, offKg, kerfKg });
    }
  } else {
    const pk = await unitKgOf(db, c.companyId, reqs.map((r) => r.item_id));
    const n = outs[0];
    const partsKg = kg.get(n.item_id) == null ? 0 : kg.get(n.item_id) * n.quantity;
    // A cut plate cutting its own plate: kerf round its outline, when the piece says its size.
    let kerfPerPiece = 0;
    const dims = (await steelValues(db, c.companyId, [n.item_id], ['LENGTH', 'WIDTH', 'THICKNESS', 'DENSITY'])).get(Number(n.item_id)) ?? {};
    if (numOf(dims.LENGTH) > 0 && numOf(dims.WIDTH) > 0 && numOf(dims.THICKNESS) > 0) {
      const { cutSettingRows, pickCutSettings } = await import('./nestingService.js');
      const kerfMm = pickCutSettings(await cutSettingRows(db, c.companyId), numOf(dims.THICKNESS)).kerfMm;
      const dens = numOf(dims.DENSITY) > 0 ? numOf(dims.DENSITY) : FALLBACK_DENSITY;
      kerfPerPiece = (2 * (numOf(dims.LENGTH) + numOf(dims.WIDTH)) * kerfMm * numOf(dims.THICKNESS) * dens) / 1e9;
    }
    // One "lot" per owner of the plates taken.
    const byOwner = new Map();
    for (const l of inLegs) {
      const kk = keyOf(l.ownerPartyId ?? null);
      byOwner.set(kk, (byOwner.get(kk) ?? 0) + (pk.get(l.itemId) ?? 0) * -Number(l.delta));
    }
    const totalKg = [...byOwner.values()].reduce((t, x) => t + x, 0);
    for (const [kk, plateKg] of byOwner) {
      const share = totalKg > 0 ? plateKg / totalKg : 1 / byOwner.size;
      lotRows.push({ id: null, itemId: inLegs.find((l) => keyOf(l.ownerPartyId ?? null) === kk)?.itemId ?? reqs[0]?.item_id, owner: ownerOfKey(kk), plateKg,
        pieces: new Map([[Number(n.item_id), n.quantity * share]]), partsKg: partsKg * share, offKg: 0, kerfKg: kerfPerPiece * n.quantity * share });
    }
  }
  // Inputs and plates must name the same owners; if not (a plate lot not marked as theirs), one pool.
  const lotKeys = new Set(lotRows.filter((r) => r.plateKg > 0).map((r) => keyOf(r.owner)));
  if ([...value.keys()].some((kk) => !lotKeys.has(kk))) {
    const cust = customerOf([...value.keys(), ...lotRows.map((r) => keyOf(r.owner))].map(ownerOfKey));
    const all = { v: [...value.values()].reduce((t, g) => t + g.v, 0), nul: [...value.values()].some((g) => g.nul) };
    value.clear();
    value.set(keyOf(cust), all);
    for (const r of lotRows) r.owner = cust;
  }
  // ₹/kg per owner, and the scale when parts + offcuts outweigh the plate (the value still adds up).
  const weight = new Map();
  for (const r of lotRows) weight.set(keyOf(r.owner), (weight.get(keyOf(r.owner)) ?? 0) + r.plateKg);
  const rateOf = (owner) => {
    const g = value.get(keyOf(owner));
    const w = weight.get(keyOf(owner)) ?? 0;
    if (!g || g.nul) return null;
    return w > 0 ? g.v / w : null;
  };
  for (const r of lotRows) {
    r.rate = rateOf(r.owner);
    const solid = r.partsKg + r.offKg;
    r.f = r.plateKg > 0 && solid > r.plateKg ? r.plateKg / solid : 1;
    r.kerfKg = r.plateKg > 0 ? Math.max(0, Math.min(r.kerfKg, r.plateKg - solid)) : 0;
    r.scrapKg = r.plateKg > 0 ? Math.max(0, r.plateKg - solid - r.kerfKg) : 0;
  }
  // Each cut piece: its pieces on each lot at that lot's ₹/kg; the customer's when any is on their plate.
  const nodeValue = new Map();
  const nodeOwner = new Map();
  const qtyOfItem = new Map();
  for (const n of outs) qtyOfItem.set(n.item_id, (qtyOfItem.get(n.item_id) ?? 0) + n.quantity);
  const totalValueIn = [...value.values()].reduce((t, g) => t + g.v, 0);
  const anyNull = [...value.values()].some((g) => g.nul);
  const totalKgIn = lotRows.reduce((t, r) => t + r.plateKg, 0);
  for (const n of outs) {
    const per = kg.get(n.item_id);
    const on = lotRows.filter((r) => (r.pieces.get(Number(n.item_id)) ?? 0) > 0);
    const placedQty = on.reduce((t, r) => t + r.pieces.get(Number(n.item_id)), 0);
    nodeOwner.set(n.id, customerOf(on.map((r) => r.owner)) ?? (lotRows.length && lotRows.every((r) => r.owner != null) ? lotRows[0].owner : null));
    if (anyNull) { nodeValue.set(n.id, null); continue; }
    if (per == null) { nodeValue.set(n.id, null); continue; }
    if (!(totalKgIn > 0)) { nodeValue.set(n.id, outs.length === 1 && !offcuts.length ? totalValueIn : null); continue; }
    const share = n.quantity / (qtyOfItem.get(n.item_id) || n.quantity);
    let v;
    if (placedQty > 0) v = on.reduce((t, r) => t + r.pieces.get(Number(n.item_id)) * share * per * (r.rate ?? 0) * r.f, 0);
    else v = n.quantity * per * (totalValueIn / totalKgIn);
    nodeValue.set(n.id, round2(v));
  }
  const offcutValue = new Map();
  const offcutOwner = new Map();
  for (const o of offcuts) {
    const r = lotRows.find((x) => x.id === o.plate_lot_id);
    offcutOwner.set(o.id, o.owner_party_id ?? r?.owner ?? null);
    offcutValue.set(o.id, anyNull || r?.rate == null || o.weight_kg == null ? null : round2(Number(o.weight_kg) * r.rate * r.f));
  }
  // Scrap into stock, kerf and the write-down as losses — per owner.
  const owners = [...new Set(lotRows.map((r) => keyOf(r.owner)))];
  const scrapKgOf = new Map(owners.map((kk) => [kk, lotRows.filter((r) => keyOf(r.owner) === kk).reduce((t, r) => t + r.scrapKg, 0)]));
  const needScrap = [...scrapKgOf.values()].some((x) => x > 1e-3);
  const target = needScrap ? await scrapTarget(db, c, ctx, owners.map(ownerOfKey)) : { itemId: null };
  const scrapLegs = [];
  const losses = [];
  for (const kk of owners) {
    const owner = ownerOfKey(kk);
    const mine = lotRows.filter((r) => keyOf(r.owner) === kk);
    const g = value.get(kk);
    const rate = rateOf(owner);
    const nulled = anyNull || !g || g.nul || rate == null;
    const plateItem = mine[0]?.itemId ?? reqs[0]?.item_id;
    for (const r of mine) {
      if (r.kerfKg > 1e-6 || r.id) {
        losses.push({ kind: 'kerf', itemId: r.itemId ?? plateItem, ownerPartyId: owner, plateLotId: r.id, kg: round3(r.kerfKg), value: nulled ? null : round2(r.kerfKg * rate), notes: 'Burnt in the kerf', keep: !!r.id });
      }
    }
    const sKg = round3(scrapKgOf.get(kk) ?? 0);
    let sValue = 0;
    if (sKg > 1e-3 && target.itemId) {
      const perKg = scrapPerKg(target.rate, nulled ? null : rate);
      sValue = round2(sKg * perKg);
      const batchId = owner == null ? null : target.lots.get(`${owner}:${ctx.rel.order_id ?? 0}`) ?? null;
      scrapLegs.push({ areaId: target.area.id, itemId: target.itemId, batchId, delta: sKg, unitCost: perKg, value: nulled ? null : sValue, label: 'Steel scrap', ownerPartyId: owner, note: 'Plate skeleton, strips and bits' });
    }
    if (nulled) {
      if (sKg > 1e-3 && !target.itemId) losses.push({ kind: 'scrap_writedown', itemId: plateItem, ownerPartyId: owner, kg: sKg, value: null, notes: 'Scrap not stocked: no place to file the scrap item' });
      continue;
    }
    // The rest of the value in: the scrap written down to its rate (and paise of rounding).
    const partsV = outs.filter((n) => keyOf(nodeOwner.get(n.id)) === kk).reduce((t, n) => t + (nodeValue.get(n.id) ?? 0), 0);
    const offV = offcuts.filter((o) => keyOf(offcutOwner.get(o.id)) === kk && o._itemId).reduce((t, o) => t + (offcutValue.get(o.id) ?? 0), 0);
    const kerfV = losses.filter((x) => x.kind === 'kerf' && keyOf(x.ownerPartyId) === kk).reduce((t, x) => t + (x.value ?? 0), 0);
    const rest = round2(g.v - partsV - offV - kerfV - (target.itemId ? sValue : 0));
    losses.push({ kind: 'scrap_writedown', itemId: plateItem, ownerPartyId: owner, kg: target.itemId ? null : sKg, value: rest,
      notes: target.itemId ? 'Scrap written down to the scrap rate' : 'Scrap not stocked: no place to file the scrap item', keep: Math.abs(rest) >= 0.005 });
  }
  return { nodeValue, nodeOwner, offcutValue, offcutOwner, scrapLegs, losses };
}

// --- scrap at a step, and pieces made again -----------------------------------------------

/**
 * A step's scrapped pieces (qty_scrap) leave the node's lot into scrap, by
 * weight; pieces made again come back when the step's good count needs them:
 *   made again = clamp(qty_good + scrapped − quantity, 0, scrapped)
 * A count lowered is the exact reverse (made again first, then the scrap).
 * Scrap of pieces not in WIP yet (a cut not done) waits for them.
 */
async function scrapStep(db, c, ctx, area, { s, node, wantScrap }) {
  const ref = `${ctx.rel.order_code} · scrap ${nameOfNode(node)} · step ${s.id}`;
  const lot = (await nodeLots(db, c, [node])).get(node.id);
  const Q = Number(s.quantity ?? node.quantity);
  let ledgerScrap = Number(s.ledger_scrap ?? 0);
  let ledgerRemade = Number(s.ledger_remade ?? 0);
  let moved = 0;
  const remadeWant = (scr) => Math.max(0, Math.min(scr, round6(Number(s.qty_good ?? 0) + scr - Q)));
  const kgPer = (await outputKg(db, c, ctx, [node])).get(node.item_id);
  const owner = lot.owner_party_id ?? null;
  // What earlier scrap of this step moved, per piece (for an exact reverse).
  const history = async () => {
    const [rows] = await db.query(
      `SELECT l.batch_id, l.item_id, l.stocking_area_id, SUM(l.quantity) AS q, SUM(l.value) AS v, SUM(l.value IS NULL) AS nul FROM cf_stock_ledger l JOIN cf_stock_movements m ON m.id = l.movement_id
        WHERE m.company_id = ? AND m.movement_type = 'transform' AND m.reference = ? GROUP BY l.batch_id, l.item_id, l.stocking_area_id`,
      [c.companyId, ref],
    );
    return rows;
  };
  const remadeRef = `${ref} · made again`;

  // 1. Fewer pieces made again than posted (a count lowered): they leave first.
  const down = wantScrap < ledgerScrap - EPS;
  if (down) {
    const target = remadeWant(wantScrap);
    if (ledgerRemade > target + EPS) {
      const n = round6(ledgerRemade - target);
      const unit = unitOf(lot);
      await writeTransform(db, c, {
        reference: remadeRef, notes: `${fmt(n)} piece(s) made again of ${nameOfNode(node)} undone`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id,
        legs: [{ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: -n, unitCost: unit, value: unit == null ? null : -n * unit, label: nameOfNode(node), ownerPartyId: owner }],
        losses: [{ kind: 'remake', itemId: node.item_id, batchId: lot.id, ownerPartyId: owner, kg: kgPer == null ? null : n * kgPer, value: unit == null ? null : n * unit, notes: 'Made again — undone', keep: true }],
        units: { reason: 'undone' },
      });
      ledgerRemade = target;
      moved += 1;
    }
    // 2. Scrap undone: the pieces come back with the value they left with; the scrap goes back out.
    const n = round6(Math.min(ledgerScrap, ledgerScrap - wantScrap));
    if (n > EPS) {
      const h = await history();
      const lotRow = h.find((r) => r.batch_id === lot.id && r.stocking_area_id === area.id);
      const pieces = lotRow ? -Number(lotRow.q) : 0;
      const frac = pieces > EPS ? n / pieces : 0;
      const legs = [];
      for (const r of h) {
        const q = -Number(r.q) * frac;
        if (Math.abs(q) <= EPS) continue;
        legs.push({ areaId: r.stocking_area_id, itemId: r.item_id, batchId: r.batch_id ?? null, delta: round6(q), value: Number(r.nul) ? null : -Number(r.v) * frac, label: `item ${r.item_id}` });
      }
      const [[lost]] = await db.query(
        `SELECT SUM(x.value) AS v, SUM(x.value IS NULL) AS nul FROM cf_stock_losses x JOIN cf_stock_movements m ON m.id = x.movement_id
          WHERE x.company_id = ? AND m.reference = ? AND x.kind = 'scrap_writedown' AND x.deleted_at IS NULL`, [c.companyId, ref]);
      await writeTransform(db, c, {
        reference: ref, notes: `${fmt(n)} scrapped ${nameOfNode(node)} back — the scrap count was lowered`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs,
        losses: lost?.v == null ? [] : [{ kind: 'scrap_writedown', itemId: node.item_id, batchId: lot.id, ownerPartyId: owner, value: -Number(lost.v) * frac, notes: 'Scrap undone', keep: true }],
        units: { restore: 'scrapped' },
      });
      ledgerScrap = round6(ledgerScrap - n);
      moved += 1;
    }
  } else if (wantScrap > ledgerScrap + EPS) {
    // 3. More scrapped: out of the lot into scrap, by weight.
    const have = (await balancesOf(db, c.companyId, area.id, [lot.id])).get(lot.id) ?? 0;
    const take = round6(Math.min(wantScrap - ledgerScrap, have));
    if (take > EPS) {
      const unit = unitOf(lot);
      const value = unit == null ? null : round2(take * unit);
      const kgOut = kgPer == null ? null : round3(take * kgPer);
      const legs = [{ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: -take, unitCost: unit, value: value == null ? null : -value, label: nameOfNode(node), ownerPartyId: owner }];
      let sValue = 0;
      let stocked = false;
      if (kgOut > 0) {
        const t = await scrapTarget(db, c, ctx, [owner]);
        if (t.itemId) {
          const perKg = scrapPerKg(t.rate, unit == null || !(kgPer > 0) ? null : unit / kgPer);
          sValue = round2(kgOut * perKg);
          legs.push({ areaId: t.area.id, itemId: t.itemId, batchId: owner == null ? null : t.lots.get(`${owner}:${ctx.rel.order_id ?? 0}`) ?? null, delta: kgOut, unitCost: perKg,
            value: value == null ? null : sValue, label: 'Steel scrap', ownerPartyId: owner, note: `Scrapped ${nameOfNode(node)}` });
          stocked = true;
        }
      }
      await writeTransform(db, c, {
        reference: ref, notes: `${fmt(take)} ${nameOfNode(node)} scrapped${kgOut ? ` (${fmt(kgOut)} kg to scrap)` : ' (weight unknown)'}`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id, legs,
        losses: [{ kind: 'scrap_writedown', itemId: node.item_id, batchId: lot.id, ownerPartyId: owner, kg: stocked ? null : kgOut, value: value == null ? null : round2(value - sValue), notes: stocked ? 'Scrapped work written down to the scrap rate' : 'Scrapped work — weight unknown, not stocked', keep: true }],
        units: { reason: 'scrapped' },
      });
      ledgerScrap = round6(ledgerScrap + take);
      moved += 1;
    }
  }
  // 4. Pieces made again (up): back into the lot, their material not recorded (a negative loss).
  const want = remadeWant(ledgerScrap);
  if (want > ledgerRemade + EPS) {
    const n = round6(want - ledgerRemade);
    const unit = unitOf(lot);
    await writeTransform(db, c, {
      reference: remadeRef, notes: `${fmt(n)} ${nameOfNode(node)} made again in place of scrapped ones`, orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id,
      legs: [{ areaId: area.id, itemId: node.item_id, batchId: lot.id, delta: n, unitCost: unit, value: unit == null ? null : n * unit, label: nameOfNode(node), ownerPartyId: owner }],
      losses: [{ kind: 'remake', itemId: node.item_id, batchId: lot.id, ownerPartyId: owner, kg: kgPer == null ? null : -n * kgPer, value: unit == null ? null : -n * unit, notes: 'Made again — its material is not recorded', keep: true }],
      units: { fresh: new Set([lot.id]) },
    });
    ledgerRemade = want;
    moved += 1;
  }
  if (Math.abs(ledgerScrap - Number(s.ledger_scrap ?? 0)) > EPS || Math.abs(ledgerRemade - Number(s.ledger_remade ?? 0)) > EPS) {
    await db.query('UPDATE cf_production_steps SET ledger_scrap = ?, ledger_remade = ? WHERE company_id = ? AND id = ?', [ledgerScrap, ledgerRemade, c.companyId, s.id]);
  }
  return moved;
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
    await claimLots(db, c, [lots.get(parent.id)], lot.owner_party_id ?? null, ctx.rel.order_id);
    const movementId = await writeTransform(db, c, {
      reference: `${ctx.rel.order_code} · ${nameOfNode(parent)}`, notes: `${nameOfNode(n)} made after ${nameOfNode(parent)} started — joined it now`,
      orderId: ctx.rel.order_id, orderLineId: ctx.rel.order_line_id,
      legs: [
        { areaId: area.id, itemId: n.item_id, batchId: lot.id, delta: -take, unitCost: unit, value: value == null ? null : -value, label: nameOfNode(n), ownerPartyId: lot.owner_party_id ?? null },
        { areaId: area.id, itemId: parent.item_id, batchId: lots.get(parent.id).id, delta: 0, value, label: nameOfNode(parent), ownerPartyId: lots.get(parent.id).owner_party_id ?? null },
      ],
      units: { reason: 'joined', parentLot: new Map([[lot.id, lots.get(parent.id).id]]) },
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
