/**
 * releaseService.js — release to production and the production tracker
 * (models/init.sql §13).
 *
 * Decided 2026-09-22: release is the WHOLE sales line (E1), and a step may not
 * start until the material it consumes is reserved (material gating on). The
 * tracker tree follows T1 = (c): one node per physical piece for anything that
 * has made parts of its own, identical parts grouped under their parent. Waits
 * are resolved on that tree — parent, children, siblings, ancestor.
 *
 * What is made and what is material: a temporary item, or a catalog item with a
 * flow, is MADE (a tracker node with steps); a catalog item without a flow is
 * MATERIAL (a requirement on the step that consumes it — the piece's first step
 * for now).
 *
 * The tracker is the release snapshot: it copies what it needs and never
 * follows later edits. Whether a step is READY is worked out on every read from
 * its dependencies and its material — never stored.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { LOCKED_ORDER_STATUSES } from './records.js';
import { explode } from './bomService.js';
import { resolveTiming } from './operationService.js';
import { postMovement } from './stockService.js';
import { generate } from '../modules/codegen/index.js';
import { refreshValues } from './valueService.js';
import { temporaryTree } from './instantiationService.js';

const EPS = 1e-9;
// A guard against a runaway explosion, not a statement about how big a real job
// is. 5,000 was too low to be that: one span of the KEPL bridge is 3,036 nodes
// and two spans ~6,072, so an ordinary order tripped it — and a tripped cap
// silently drops the material under everything past it, which is how the same
// bridge once asked for 18 t less steel than it contains.
//
// The real ceiling is not this number. Releasing a tracker this size writes tens
// of thousands of rows one at a time, and over TiDB at ~49 ms a round trip that
// is the constraint that will actually hurt. Batch the release writes before
// raising this again.
const MAX_NODES = 10000;
const round6 = (n) => Number(Number(n).toFixed(6));
const fmt = (n) => String(round6(n));
const blank = (v) => v == null || String(v).trim() === '';
const whole = (x) => Math.abs(x - Math.round(x)) < 1e-9;
const USABLE = "('storage','wip')";
const dateOnly = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ?? null);

async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  if (!l) throw notFound('Order line');
  return l;
}

export async function liveReleaseOfLine(db, companyId, lineId) {
  const [[r]] = await db.query('SELECT * FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [companyId, lineId]);
  return r || null;
}

async function requireRelease(db, companyId, id, { lock = false } = {}) {
  const [[r]] = await db.query(
    `SELECT r.*, o.code AS order_code, o.status AS order_status, l.line_no
       FROM cf_production_releases r
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
      WHERE r.company_id = ? AND r.id = ? AND r.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, id],
  );
  if (!r) throw notFound('Release');
  return r;
}

function assertOrderOpen(order) {
  if (LOCKED_ORDER_STATUSES.has(order.order_status)) {
    throw invalid('ORDER_LOCKED', `Order ${order.order_code} is ${order.order_status} — nothing more is recorded on it.`);
  }
}

/** The flows a release uses, with their steps and the Wait-For rules on each step. */
async function loadFlows(db, companyId, flowIds) {
  const out = new Map();
  if (!flowIds.length) return out;
  const [flows] = await db.query('SELECT id, code, name, status, revision FROM cf_operation_flows WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, flowIds]);
  const [steps] = await db.query(
    `SELECT s.id, s.flow_id, s.sequence, s.operation_id, s.step_name, o.code AS op_code, o.name AS op_name, o.status AS op_status
       FROM cf_operation_flow_steps s JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND s.flow_id IN (?) AND s.deleted_at IS NULL ORDER BY s.flow_id, s.sequence, s.id`,
    [companyId, flowIds],
  );
  const stepIds = steps.map((s) => s.id);
  const [rules] = stepIds.length ? await db.query(
    `SELECT w.*, o.code AS op_code, o.name AS op_name, dm.code AS def_code, dm.name AS def_name
       FROM cf_step_wait_rules w
       LEFT JOIN cf_operations o ON o.id = w.target_operation_id
       LEFT JOIN cf_master_records dm ON dm.id = w.target_definition_id
      WHERE w.company_id = ? AND w.flow_step_id IN (?) AND w.deleted_at IS NULL ORDER BY w.id`,
    [companyId, stepIds],
  ) : [[]];
  for (const f of flows) out.set(f.id, { ...f, steps: [] });
  for (const s of steps) out.get(s.flow_id)?.steps.push({ ...s, waits: rules.filter((w) => w.flow_step_id === s.id) });
  return out;
}

/**
 * What can be used now, per item and batch: on hand in storage and WIP areas
 * (a held batch counts for nothing), what is reserved, and what is free.
 */
export async function availability(db, companyId, itemIds) {
  const out = new Map();
  if (!itemIds.length) return out;
  const [bal] = await db.query(
    `SELECT k.item_id, k.batch_id, SUM(k.quantity) AS qty, b.code AS batch_code, b.status AS batch_status, b.received_on
       FROM cf_stock_balances k
       JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN ${USABLE}
       LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
      WHERE k.company_id = ? AND k.item_id IN (?) AND k.quantity > 0
      GROUP BY k.item_id, k.batch_id, b.code, b.status, b.received_on`,
    [companyId, itemIds],
  );
  const [res] = await db.query(
    `SELECT item_id, batch_id, SUM(quantity) AS qty FROM cf_stock_reservations
      WHERE company_id = ? AND item_id IN (?) AND status = 'active' AND deleted_at IS NULL GROUP BY item_id, batch_id`,
    [companyId, itemIds],
  );
  const reservedOf = new Map(res.map((r) => [`${r.item_id}:${r.batch_id ?? 0}`, Number(r.qty)]));
  for (const id of itemIds) out.set(id, { available: 0, reserved: 0, free: 0, batches: [] });
  for (const b of bal) {
    const entry = out.get(b.item_id);
    const usable = !b.batch_id || b.batch_status === 'available';
    const reserved = reservedOf.get(`${b.item_id}:${b.batch_id ?? 0}`) ?? 0;
    const qty = usable ? Number(b.qty) : 0;
    const free = round6(Math.max(0, qty - reserved));
    if (b.batch_id) entry.batches.push({ batchId: b.batch_id, code: b.batch_code, status: b.batch_status, receivedOn: dateOnly(b.received_on), available: qty, reserved, free });
    entry.available = round6(entry.available + qty);
    entry.free = round6(entry.free + free);
  }
  for (const r of res) { const e = out.get(r.item_id); if (e) e.reserved = round6(e.reserved + Number(r.qty)); }
  for (const e of out.values()) e.batches.sort((a, b) => String(a.receivedOn ?? '').localeCompare(String(b.receivedOn ?? '')) || a.batchId - b.batchId);
  return out;
}

// --- the release plan: what release would create, and what stops it --------------

const nameOf = (n) => n.code ?? n.name;

/** item_type, sourcing, tracked_by and the definition each temporary item came from. */
async function itemDetails(db, companyId, itemIds) {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return new Map();
  const [rows] = await db.query(
    'SELECT master_id, item_type, sourcing, tracked_by, source_definition_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?)',
    [companyId, ids],
  );
  return new Map(rows.map((r) => [r.master_id, r]));
}

/**
 * "Made out of nothing" — the nodes this order makes that have nothing under
 * them at all.
 *
 * It matters because of how material is worked out below: a requirement is
 * recorded for a CHILD that is not made, so a made node with no children
 * iterates nothing and asks for nothing. Release then succeeds, the tracker is
 * built, and the buy list proposes nothing — the plate parts of a real job were
 * `sourcing = 'make'` with no BOM, and 669 t of steel simply did not exist as
 * far as the system was concerned. A thing cannot be made out of nothing.
 *
 * The exploded tree alone must not be the answer. It stops at its depth cap, so
 * a node at the bottom of a deep structure looks childless while its BOM is
 * full, and telling somebody to give a BOM to a thing that has one is worse
 * than saying nothing. So the database is asked whether the item really has a
 * live BOM line, and only an item that truly has none is named.
 *
 * Returns one entry per (item, place), so six identical stiffeners are one
 * sentence rather than six.
 */
async function madeFromNothing(db, companyId, nodes) {
  const suspects = nodes.filter((n) => n.made === true && !n.children.length);
  if (!suspects.length) return [];
  const [rows] = await db.query(
    `SELECT b.parent_id, COUNT(l.id) AS line_count
       FROM cf_boms b
       LEFT JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL
      GROUP BY b.parent_id`,
    [companyId, [...new Set(suspects.map((n) => n.id))]],
  );
  const lines = new Map(rows.map((r) => [r.parent_id, Number(r.line_count)]));
  const seen = new Set();
  const out = [];
  for (const n of suspects) {
    if (lines.get(n.id) > 0) continue;
    const key = `${n.id}:${n.parentNode?.id ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * Checks a line's structure and builds, in memory, everything release writes:
 * tracker nodes, their steps, the dependencies and the material requirements.
 * Returns every problem at once — nothing is written here.
 */
async function buildPlan(db, companyId, line) {
  const problems = [];
  const qty = Number(line.quantity);
  const tree = await explode(db, companyId, line.item_id, { rootQuantity: qty, maxDepth: 15 });
  if (tree.truncated) problems.push('The structure is more than 15 levels deep.');

  // 1. Every design node: is it an item, is it ready, is it made or material?
  //    Where a catalog item comes from is its own field (user, 2026-09-23):
  //    stock = drawn from stock, make = made on the order that needs it, both =
  //    from stock when free stock covers it, else made. A stock order's own line
  //    is always made — that order is what puts the item in stock.
  const everyNode = [];
  const collect = (n) => { everyNode.push(n); n.children.forEach(collect); };
  collect(tree.root);
  const detail = await itemDetails(db, companyId, everyNode.map((n) => n.id));
  const sourcingOf = (n) => (n.kind === 'catalog' ? detail.get(n.id)?.sourcing ?? 'stock' : null);
  const maybe = everyNode.filter((n) => n.kind === 'catalog' && sourcingOf(n) === 'both' && n.flow);
  const freeLeft = maybe.length ? new Map([...(await availability(db, companyId, [...new Set(maybe.map((n) => n.id))]))].map(([id, v]) => [id, v.free])) : new Map();

  const all = [];
  const consider = (n, parent, count) => {
    n.parentNode = parent;
    n.needCount = round6(count);
    all.push(n);
    const where = parent ? ` under ${nameOf(parent)}` : '';
    if (n.kind === 'selection') { problems.push(`${nameOf(parent ?? n)} still has to choose its ${n.selection?.code ?? nameOf(n)} — pick the catalog item.`); return; }
    if (n.kind === 'template') { problems.push(`${nameOf(n)}${where} is a definition — a blueprint is never made or issued.`); return; }
    const sourcing = sourcingOf(n);
    if (n.kind === 'temporary') n.made = true;
    else if (n === tree.root && line.order_type === 'stock') n.made = !!n.flow;
    else if (sourcing === 'make') n.made = true;
    else if (sourcing === 'both' && n.flow) {
      const free = freeLeft.get(n.id) ?? 0;
      n.made = free + EPS < n.needCount;
      if (!n.made) freeLeft.set(n.id, round6(free - n.needCount));
      n.sourcedBy = n.made ? 'made (no free stock)' : 'stock';
    } else n.made = false;
    if (n.status === 'draft') problems.push(`${nameOf(n)} is still a draft — activate it before release.`);
    else if (n.status !== 'active') problems.push(`${nameOf(n)}${where} is ${n.status} — only active items are made or issued.`);
    if (n.made && !n.flow) {
      problems.push(n.kind === 'temporary'
        ? `${nameOf(n)} has no flow — say how it is made.`
        : `${nameOf(n)}${where} is made on the order, but has no flow — give it one, or set it to come from stock.`);
    }
    if (n.made && n.kind === 'catalog' && n.bom && n.bom.status !== 'active') problems.push(`The BOM of ${nameOf(n)} is ${n.bom.status} — activate it before release.`);
    // Only what is made here has parts that matter: the structure under an item
    // taken from stock is that item's business, not this order's.
    if (n.made) for (const kid of n.children) consider(kid, n, kid.quantity * count);
  };
  consider(tree.root, null, qty);
  for (const n of await madeFromNothing(db, companyId, all)) {
    const where = n.parentNode ? ` under ${nameOf(n.parentNode)}` : '';
    // A temporary item is always made on its order — masterRecordService refuses
    // to give one any other sourcing — so it is offered the one way out it has.
    problems.push(n.kind === 'temporary'
      ? `${nameOf(n)}${where} is made on the order, but nothing is under it — give it a BOM saying what it is made from.`
      : `${nameOf(n)}${where} is made on the order, but nothing is under it — give it a BOM, or set it to come from stock.`);
  }
  const root = tree.root;
  if (root.made === undefined) return { problems, tree };

  // 2. The flows of everything made: active, with steps, on active operations.
  const flows = await loadFlows(db, companyId, [...new Set(all.filter((n) => n.made && n.flow).map((n) => n.flow.id))]);
  for (const f of flows.values()) {
    if (f.status !== 'active') problems.push(`Flow ${f.code} is ${f.status === 'draft' ? 'still a draft' : f.status} — activate it before release.`);
    if (!f.steps.length) problems.push(`Flow ${f.code} has no steps.`);
    for (const s of f.steps) if (s.op_status !== 'active') problems.push(`Flow ${f.code} step ${s.sequence} uses ${s.op_code}, which is inactive.`);
  }

  // 3. The tracker tree (T1 = (c)): a piece per node when it has made parts,
  //    one grouped node otherwise; material becomes requirements.
  const sourceDef = new Map([...detail].map(([id, d]) => [id, d.source_definition_id]));
  for (const n of all) {
    if (n.made === false && detail.get(n.id)?.tracked_by === 'individual') {
      problems.push(`${nameOf(n)} is tracked unit by unit — no stock is kept of it yet, so it cannot be reserved. Give it a flow, or track it by quantity or batch.`);
    }
  }
  const nodes = [];
  const reqs = [];
  const counters = new Map();
  const madeKids = (d) => d.children.filter((k) => k.made);
  const addNode = (design, parentK, depth, quantity, pieceNo) => {
    const node = {
      k: nodes.length, parentK, design, itemId: design.id, bomLineId: design.lineId ?? null, pieceNo, quantity: round6(quantity),
      code: pieceNo ? `${design.code}-${pieceNo}` : null, flowId: design.flow.id, depth, childKs: [], stepKs: [],
      madeFrom: sourceDef.get(design.id) ?? null,
    };
    nodes.push(node);
    if (parentK != null) nodes[parentK].childKs.push(node.k);
    return node;
  };
  const fill = (design, node) => {
    for (const kid of design.children) {
      if (kid.made) expand(kid, node.k, node.depth + 1, kid.quantity * node.quantity);
      else if (kid.made === false) reqs.push({ nodeK: node.k, itemId: kid.id, bomLineId: kid.lineId, quantity: round6(kid.quantity * node.quantity), design: kid });
    }
  };
  const expand = (design, parentK, depth, count) => {
    if (nodes.length > MAX_NODES) return;
    if (!design.flow) return; // the missing flow is already a problem; nothing to lay out
    if (madeKids(design).length) {
      if (!whole(count)) { problems.push(`${nameOf(design)} is made piece by piece, so it needs a whole number — ${fmt(count)} were asked for.`); return; }
      for (let i = 0; i < Math.round(count); i++) {
        const no = (counters.get(design.id) ?? 0) + 1;
        counters.set(design.id, no);
        fill(design, addNode(design, parentK, depth, 1, no));
      }
    } else fill(design, addNode(design, parentK, depth, count, null));
  };
  if (root.made) expand(root, null, 0, qty);
  else if (line.order_type === 'stock') problems.push(`${nameOf(root)} has no flow — say how it is made, because a stock order is what makes it.`);
  else reqs.push({ nodeK: null, itemId: root.id, bomLineId: null, quantity: round6(qty), design: root });
  // Hitting the cap stops `expand` mid-tree, so everything past it was never
  // walked and its material was never asked for. The counts that survive are
  // not a smaller answer, they are a WRONG one — this bridge came out 18 t of
  // steel short and said nothing. Release refuses either way, but releaseCheck
  // shows these figures on screen, so they have to arrive labelled.
  const truncated = nodes.length > MAX_NODES;
  if (truncated) {
    problems.push(`The tracker would have more than ${MAX_NODES} nodes — release a smaller line.`);
    problems.push('Because of that, the piece and material figures below are incomplete — the rest of the structure was never worked out. Do not order from them.');
  }
  return { problems, tree, flows, nodes, reqs, truncated };
}

/** "P001-G01-1", or "P001-G01-WEB01 ×1 for P001-G01-1" for grouped parts. */
function nodeLabelOf(nodes) {
  const label = (n) => n.code ?? `${n.design.code ?? n.design.name} ×${fmt(n.quantity)}${n.parentK != null ? ` for ${label(nodes[n.parentK])}` : ''}`;
  return label;
}

const bySequence = (steps) => {
  const groups = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && last[0].sequence === s.sequence) last.push(s); else groups.push([s]);
  }
  return groups;
};

/** Steps, dependencies and the step each requirement gates — then a check that nothing waits in a circle. */
function planSteps(plan) {
  const { nodes, flows, reqs, problems } = plan;
  const label = nodeLabelOf(nodes);
  const steps = [];
  for (const node of nodes) {
    for (const fs of flows.get(node.flowId)?.steps ?? []) {
      const s = { k: steps.length, nodeK: node.k, fs, flowStepId: fs.id, operationId: fs.operation_id, sequence: fs.sequence, stepName: fs.step_name, quantity: node.quantity };
      steps.push(s);
      node.stepKs.push(s.k);
    }
    node.groups = bySequence(node.stepKs.map((k) => steps[k]));
  }
  /** The other steps of this piece running the same operation, in flow order. */
  const passesOf = (s) => nodes[s.nodeK].stepKs.map((k) => steps[k]).filter((x) => x.operationId === s.operationId);
  // A flow may run one operation several times, so the operation's name alone
  // no longer names a step on a piece. Say which pass, or use the step's own
  // name where it was given one.
  const stepLabel = (s) => {
    const passes = passesOf(s);
    if (passes.length < 2) return `${label(nodes[s.nodeK])} ${s.fs.op_name}`;
    const which = s.stepName || `${s.fs.op_name} (pass ${passes.indexOf(s) + 1} of ${passes.length})`;
    return `${label(nodes[s.nodeK])} ${which}`;
  };
  for (const r of reqs) if (r.nodeK != null) r.stepK = nodes[r.nodeK].stepKs[0] ?? null;

  const deps = [];
  // Flow order: every step waits for the steps of the previous sequence number.
  for (const node of nodes) {
    for (let g = 1; g < node.groups.length; g++) {
      for (const s of node.groups[g]) for (const p of node.groups[g - 1]) deps.push({ stepK: s.k, targetStepK: p.k, required: 'done', origin: 'flow' });
    }
  }
  // Wait-For rules, resolved on the tree.
  const named = new Map();
  //
  // A wait rule names an OPERATION, not a step: the target is a relative node
  // (its parent, its children …) whose flow is not known when the rule is
  // written, and a step id means nothing outside its own flow. Since
  // 2026-09-24 a flow may run one operation more than once — weld, crane-turn,
  // weld — so "at SAW Welding" has to say WHICH pass. It is read off the
  // status the rule already carries, because that is what the words mean:
  //
  //   done    -> the LAST pass.  "Finished welding" is not true while another
  //                              weld pass is still to come.
  //   started -> the FIRST pass. "Started welding" is true as soon as the
  //                              first pass begins.
  //
  // Each is the safe end of its range: the strictest instant for `done`, the
  // earliest for `started`. waitText() in flowService.js prints the same
  // choice in the sentence the flow screen and the tracker show.
  const occurrenceFor = (requiredStatus) => (requiredStatus === 'started' ? 'first' : 'last');
  const stepOn = (node, operationId, requiredStatus) => {
    // stepKs is in flow order (sequence, then id), so passes is too.
    const passes = node.stepKs.map((k) => steps[k]).filter((x) => x.operationId === operationId);
    if (!passes.length) return null;
    return occurrenceFor(requiredStatus) === 'first' ? passes[0] : passes[passes.length - 1];
  };
  for (const s of steps) {
    const node = nodes[s.nodeK];
    for (const w of s.fs.waits) {
      let targets = [];
      if (w.relation === 'parent') targets = node.parentK != null ? [nodes[node.parentK]] : [];
      else if (w.relation === 'children') targets = node.childKs.map((k) => nodes[k]);
      else if (w.relation === 'siblings') targets = node.parentK != null ? nodes[node.parentK].childKs.filter((k) => k !== node.k).map((k) => nodes[k]) : [];
      else {
        let p = node.parentK != null ? nodes[node.parentK] : null;
        while (p && p.madeFrom !== w.target_definition_id) p = p.parentK != null ? nodes[p.parentK] : null;
        targets = p ? [p] : [];
      }
      if (w.target_definition_id && w.relation !== 'ancestor') targets = targets.filter((t) => t.madeFrom === w.target_definition_id);
      if (!targets.length) continue; // the rule finds nothing here, so it does not apply
      const plural = w.relation === 'children' || w.relation === 'siblings';
      const hits = [];
      for (const t of targets) {
        if (w.target_operation_id) {
          const ts = stepOn(t, w.target_operation_id, w.required_status);
          if (!ts) {
            if (!plural) problems.push(`${stepLabel(s)} waits for ${label(t)} to ${w.required_status === 'started' ? 'start' : 'finish'} ${w.op_name} (${w.op_code}), but flow ${flows.get(t.flowId)?.code} has no ${w.op_code}.`);
            continue;
          }
          deps.push({ stepK: s.k, targetStepK: ts.k, required: w.required_status, origin: 'rule', ruleId: w.id });
        } else {
          deps.push({ stepK: s.k, targetNodeK: t.k, required: w.required_status === 'done' ? 'complete' : 'started', origin: 'rule', ruleId: w.id });
        }
        hits.push(t);
      }
      if (plural && !hits.length) problems.push(`${stepLabel(s)} waits for its ${w.relation} at ${w.op_name} (${w.op_code}), but none of them has that step.`);
      if (w.relation === 'children') {
        const set = named.get(node.k) ?? new Set();
        hits.forEach((t) => set.add(t.k));
        named.set(node.k, set);
      }
    }
  }
  // The default: a parent's first steps wait for each child none of its rules names.
  for (const node of nodes) {
    const set = named.get(node.k) ?? new Set();
    for (const ck of node.childKs) {
      if (set.has(ck)) continue;
      for (const s of node.groups[0] ?? []) deps.push({ stepK: s.k, targetNodeK: ck, required: 'complete', origin: 'default' });
    }
  }
  plan.steps = steps;
  plan.deps = deps;
  const cycle = findCycle(nodes, steps, deps);
  if (cycle) {
    const chain = cycle.slice(0, 6).map((k) => stepLabel(steps[k]));
    problems.push(`These steps would wait for each other, so none could start: ${chain.join(' waits for ')}${cycle.length > 6 ? ' …' : ''} waits for ${chain[0]}. Change a wait rule so one of them goes first.`);
  }
  return plan;
}

/** A circle of waits, as step keys, or null. Waiting for a whole piece means all its steps; for it to start, its first ones. */
function findCycle(nodes, steps, deps) {
  const edges = steps.map(() => []);
  for (const d of deps) {
    if (d.targetStepK != null) edges[d.stepK].push(d.targetStepK);
    else {
      const t = nodes[d.targetNodeK];
      const targets = d.required === 'complete' ? t.stepKs : (t.groups[0] ?? []).map((x) => x.k);
      edges[d.stepK].push(...targets);
    }
  }
  const color = new Uint8Array(steps.length);
  for (let start = 0; start < steps.length; start++) {
    if (color[start]) continue;
    const stack = [[start, 0]];
    color[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      if (i < edges[v].length) {
        top[1] += 1;
        const w = edges[v][i];
        if (color[w] === 0) { color[w] = 1; stack.push([w, 0]); } else if (color[w] === 1) {
          const at = stack.findIndex(([x]) => x === w);
          return stack.slice(at).map(([x]) => x);
        }
      } else { color[v] = 2; stack.pop(); }
    }
  }
  return null;
}

/** The plan for a line, with the line-level checks first. */
async function planFor(db, companyId, line) {
  const problems = [];
  if (line.order_status !== 'confirmed') problems.push(`Order ${line.order_code} is ${line.order_status} — only a confirmed order is released to production.`);
  if (await liveReleaseOfLine(db, companyId, line.id)) problems.push(`Line ${line.line_no} is already released.`);
  if (!line.item_id) problems.push('The line has no item yet.');
  if (problems.length) return { problems, nodes: [], steps: [], deps: [], reqs: [] };
  const plan = await buildPlan(db, companyId, line);
  if (plan.nodes) planSteps(plan);
  plan.problems.unshift(...problems);
  return plan;
}

/** Material needed, per item: how much in all, how much is free now, how much is short. */
async function materialSummary(db, companyId, reqs) {
  const need = new Map();
  for (const r of reqs) {
    const e = need.get(r.itemId) ?? { item: { id: r.itemId, code: r.design.code, name: r.design.name, uom: r.design.uom }, required: 0 };
    e.required = round6(e.required + r.quantity);
    need.set(r.itemId, e);
  }
  const av = await availability(db, companyId, [...need.keys()]);
  return [...need.values()].map((e) => {
    const a = av.get(e.item.id);
    return { ...e, free: a.free, short: round6(Math.max(0, e.required - a.free)) };
  });
}

/**
 * Can the coding rule number these pieces? A rule that leans on the parent's
 * code, or on a piece number, has nothing to work with at the top of the tree
 * or on a grouped card — and finding that out halfway through a release is too
 * late. One dry run per SHAPE of piece (four at most) catches it here instead,
 * without numbering anything.
 */
async function codeRuleProblems(db, companyId, line, nodes) {
  const seen = new Map();
  for (const n of nodes) {
    const shape = `${n.parentK != null ? 'child' : 'top'}:${n.pieceNo ? 'piece' : 'group'}`;
    if (!seen.has(shape)) seen.set(shape, n);
  }
  const problems = [];
  for (const n of seen.values()) {
    const g = await generate(db, companyId, 'production_piece', 'code', {
      draft: {
        itemId: n.itemId, orderId: line.order_id, lineNo: line.line_no,
        parentCode: n.parentK != null ? 'PARENT' : null, pieceNo: n.pieceNo,
      },
    }, { consume: false }).catch(() => null);
    if (g && g.text === null && (g.missing ?? []).length) {
      problems.push(`Coding rule ${g.schemeCode} cannot number ${nameOf(n.design)}: it needs ${g.missing.join(', ')}, which ${n.pieceNo ? 'this piece has not got' : 'a grouped card has not got'}. Make that part of the rule optional, or use something every piece has.`);
    }
  }
  return problems;
}

/**
 * What releasing a line would create, and what stops it — nothing is written.
 * { ok, problems, summary: { pieces, groups, steps, waits, requirements }, materials }
 */
export async function releaseCheck(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const plan = await planFor(db, companyId, line);
  const nodes = plan.nodes ?? [];
  // Finished work has to land somewhere nameable. When one area is obvious it
  // is offered as the default; when it is not, the screen asks rather than the
  // release failing on the day the last step is recorded.
  const finished = await finishedArea(db, companyId, line, null);
  const codeTrouble = await codeRuleProblems(db, companyId, line, plan.nodes ?? []);
  const [areas] = await db.query(
    "SELECT id, code, name, purpose FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND purpose <> 'quarantine' ORDER BY purpose = ? DESC, code",
    [companyId, line.order_type === 'stock' ? 'storage' : 'dispatch'],
  );
  return {
    line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, quantity: Number(line.quantity) },
    ok: plan.problems.length + codeTrouble.length === 0,
    problems: [...plan.problems, ...codeTrouble],
    finishedArea: finished.area ? { id: finished.area.id, code: finished.area.code, name: finished.area.name, purpose: finished.area.purpose } : null,
    needsFinishedArea: !finished.area,
    finishedAreaProblem: finished.problem,
    areas,
    summary: {
      pieces: nodes.filter((n) => n.pieceNo).length,
      groups: nodes.filter((n) => !n.pieceNo).length,
      steps: (plan.steps ?? []).length,
      waits: (plan.deps ?? []).filter((d) => d.origin !== 'flow').length,
      requirements: (plan.reqs ?? []).length,
    },
    truncated: !!plan.truncated,
    materials: await materialSummary(db, companyId, plan.reqs ?? []),
  };
}

/**
 * Where a release's finished work goes (Idea A, user 2026-09-23). Given one,
 * it is checked; otherwise the single active dispatch area is used for a
 * customer order and the single active storage area for a stock order. When
 * that is ambiguous or missing, the caller is told to say which — finished
 * steel has to land somewhere nameable.
 */
export async function finishedArea(db, companyId, line, givenId) {
  const purpose = line.order_type === 'stock' ? 'storage' : 'dispatch';
  if (!blank(givenId)) {
    const [[a]] = await db.query(
      "SELECT id, code, name, purpose, status FROM cf_stocking_areas WHERE company_id = ? AND id = ? AND deleted_at IS NULL",
      [companyId, Number(givenId)],
    );
    if (!a) return { area: null, problem: 'That stocking area does not exist.' };
    if (a.status !== 'active') return { area: null, problem: `${a.code} is inactive.` };
    // The purpose is not decoration: what is made for a customer is earmarked
    // on the DISPATCH shelf and only stock standing there is protected from
    // being issued elsewhere, so a storage area would leave it unguarded.
    if (a.purpose !== purpose) {
      return {
        area: null,
        problem: purpose === 'dispatch'
          ? `${a.code} is a ${a.purpose} area. What is made for a customer waits on a dispatch area, where it is held for its line until it ships.`
          : `${a.code} is a ${a.purpose} area. A stock order puts what it makes into storage, for anybody to use.`,
      };
    }
    return { area: a, problem: null };
  }
  const [rows] = await db.query(
    "SELECT id, code, name, purpose FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND purpose = ? ORDER BY code",
    [companyId, purpose],
  );
  if (rows.length === 1) return { area: rows[0], problem: null };
  const what = purpose === 'dispatch' ? 'dispatch area' : 'storage area';
  return {
    area: null,
    problem: rows.length
      ? `Say where finished work goes — there are ${rows.length} ${what}s (${rows.map((a) => a.code).join(', ')}).`
      : `Say where finished work goes — there is no active ${what} to put it in.`,
  };
}

/** Releases a whole sales line (E1): writes the tracker tree, its steps, dependencies and material requirements. */
export async function releaseLine(db, c, lineId, input = {}) {
  const line = await requireLine(db, c.companyId, lineId, { lock: true });
  await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, line.order_id]);
  const plan = await planFor(db, c.companyId, line);
  if (plan.problems.length) throw invalid('NOT_READY', `Line ${line.line_no} of ${line.order_code} cannot be released yet.`, { problems: plan.problems });
  // Release freezes the line's items, so bring their values up to date first.
  if (line.line_type === 'custom') {
    const ids = await temporaryTree(db, c.companyId, line.item_id);
    if (ids.length) await refreshValues(db, c, ids);
  }
  const [[root]] = await db.query('SELECT revision FROM cf_master_records WHERE id = ?', [line.item_id]);
  const finished = await finishedArea(db, c.companyId, line, input.finishedAreaId);
  if (finished.problem) throw invalid('NO_FINISHED_AREA', finished.problem);
  const [r] = await db.query(
    `INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, item_revision, quantity, finished_area_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, line.order_id, line.id, line.item_id, root?.revision ?? null, Number(line.quantity), finished.area.id,
      blank(input.notes) ? null : String(input.notes), c.userId],
  );
  const releaseId = r.insertId;
  // Every piece of work in progress carries a code, at every level of the tree
  // (user, 2026-09-23) — from the code generator when a rule says how, and from
  // the shape below when none does. Parents are laid out before their children,
  // so a rule can build a child's code out of its parent's.
  const minted = new Set();
  for (const n of plan.nodes) {
    const parentCode = n.parentK != null ? plan.nodes[n.parentK].code : null;
    let g = null;
    try {
      g = await generate(db, c.companyId, 'production_piece', 'code', {
        draft: { itemId: n.itemId, orderId: line.order_id, lineNo: line.line_no, parentCode, pieceNo: n.pieceNo },
      }, { consume: true });
    } catch (err) {
      // A rule that leans on something this piece has not got — say which piece,
      // rather than leaving a code-generator message with no context.
      if (err?.code !== 'TOKEN_MISSING') throw err;
      throw invalid('TOKEN_MISSING', `${nameOf(n.design)} cannot be numbered: ${err.message}`, { problems: err.problems ?? [] });
    }
    // The fallback has to stay unique across orders, so a grouped node with no
    // parent — a line making one lot of something — carries its line with it.
    const own = n.design.code ?? n.design.name;
    n.code = g?.text || (n.pieceNo ? `${own}-${n.pieceNo}`
      : parentCode ? `${parentCode}/${own}`
        : `${line.order_code}/${line.line_no}-${own}`);
    // Two pieces called the same thing is not an identity — and it surfaces far
    // later, as a duplicate lot on the day one of them is finished.
    if (minted.has(n.code)) {
      throw invalid('CODE_CLASH', `The coding rule gives more than one piece the code ${n.code}. Add something that tells them apart — the piece number, or the piece it is part of.`);
    }
    minted.add(n.code);
    const [[clash]] = await db.query(
      'SELECT id FROM cf_production_items WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1',
      [c.companyId, n.code],
    );
    if (clash) {
      throw invalid('CODE_CLASH', `${n.code} is already the code of a piece on another release. Add something to the rule that tells orders apart — the order number, or a running number.`);
    }
    const [x] = await db.query(
      `INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, bom_line_id, piece_no, quantity, code, flow_id, flow_revision, depth, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, releaseId, n.parentK != null ? plan.nodes[n.parentK].id : null, n.itemId, n.bomLineId, n.pieceNo, n.quantity, n.code,
        n.flowId, plan.flows.get(n.flowId)?.revision ?? null, n.depth, n.k + 1, c.userId],
    );
    n.id = x.insertId;
  }
  for (const s of plan.steps) {
    const [x] = await db.query(
      `INSERT INTO cf_production_steps (company_id, production_item_id, flow_step_id, operation_id, sequence, step_name, quantity, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, plan.nodes[s.nodeK].id, s.flowStepId, s.operationId, s.sequence, s.stepName, s.quantity, c.userId],
    );
    s.id = x.insertId;
  }
  if (plan.deps.length) {
    await db.query(
      'INSERT INTO cf_step_dependencies (company_id, step_id, target_step_id, target_item_id, required, origin, wait_rule_id, created_by) VALUES ?',
      [plan.deps.map((d) => [c.companyId, plan.steps[d.stepK].id, d.targetStepK != null ? plan.steps[d.targetStepK].id : null,
        d.targetNodeK != null ? plan.nodes[d.targetNodeK].id : null, d.required, d.origin, d.ruleId ?? null, c.userId])],
    );
  }
  if (plan.reqs.length) {
    await db.query(
      'INSERT INTO cf_material_requirements (company_id, release_id, production_item_id, step_id, item_id, bom_line_id, quantity, created_by) VALUES ?',
      [plan.reqs.map((q) => [c.companyId, releaseId, q.nodeK != null ? plan.nodes[q.nodeK].id : null, q.stepK != null ? plan.steps[q.stepK].id : null,
        q.itemId, q.bomLineId ?? null, q.quantity, c.userId])],
    );
  }
  return getRelease(db, c.companyId, releaseId);
}

/** Takes a release back — only while nothing has started and nothing was issued. Its reservations are let go. */
export async function unrelease(db, c, releaseId) {
  const rel = await requireRelease(db, c.companyId, releaseId, { lock: true });
  assertOrderOpen(rel);
  const [[{ started }]] = await db.query(
    `SELECT COUNT(*) AS started FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL
        AND (s.state <> 'pending' OR s.qty_good > 0 OR s.qty_scrap > 0 OR s.started_at IS NOT NULL)`,
    [c.companyId, releaseId],
  );
  if (Number(started)) throw conflict('STARTED', `Work has started on line ${rel.line_no} of ${rel.order_code} (${started} step${Number(started) === 1 ? '' : 's'}) — a started release is not taken back.`);
  const [[{ issued }]] = await db.query('SELECT COALESCE(SUM(issued), 0) AS issued FROM cf_material_requirements WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL', [c.companyId, releaseId]);
  if (Number(issued) > EPS) throw conflict('ISSUED', `Material was already issued to line ${rel.line_no} of ${rel.order_code} — a release with issues is not taken back.`);
  await db.query(
    `UPDATE cf_stock_reservations v JOIN cf_material_requirements q ON q.id = v.requirement_id
        SET v.status = 'released', v.closed_at = NOW()
      WHERE v.company_id = ? AND q.release_id = ? AND v.status = 'active'`,
    [c.companyId, releaseId],
  );
  const pieces = 'SELECT id FROM cf_production_items WHERE company_id = ? AND release_id = ?';
  await db.query(
    `UPDATE cf_step_dependencies SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL
        AND step_id IN (SELECT id FROM cf_production_steps WHERE production_item_id IN (${pieces}))`,
    [c.companyId, c.companyId, releaseId],
  );
  await db.query('UPDATE cf_material_requirements SET deleted_at = NOW() WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL', [c.companyId, releaseId]);
  await db.query(`UPDATE cf_production_steps SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL AND production_item_id IN (${pieces})`, [c.companyId, c.companyId, releaseId]);
  await db.query('UPDATE cf_production_items SET deleted_at = NOW() WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL', [c.companyId, releaseId]);
  await db.query('UPDATE cf_production_releases SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, releaseId]);
  return { ok: true, orderId: rel.order_id };
}

// --- reading the tracker: status is worked out, never stored ------------------------

async function loadTracker(db, companyId, releaseIds) {
  if (!releaseIds.length) return null;
  const [releases] = await db.query(
    `SELECT r.*, o.code AS order_code, o.title AS order_title, o.status AS order_status, o.order_type, o.committed_date AS order_committed,
            l.line_no, l.committed_date AS line_committed, l.made_qty, l.delivered_qty, m.code AS item_code, m.name AS item_name, u.name AS released_by,
            fa.code AS finished_area_code, fa.name AS finished_area_name,
            (SELECT COALESCE(SUM(v.quantity), 0) FROM cf_stock_reservations v
              WHERE v.company_id = r.company_id AND v.order_line_id = r.order_line_id AND v.status = 'active' AND v.deleted_at IS NULL) AS ready_to_ship
       FROM cf_production_releases r
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       JOIN cf_master_records m ON m.id = r.item_id
       LEFT JOIN cf_stocking_areas fa ON fa.id = r.finished_area_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.company_id = ? AND r.id IN (?) AND r.deleted_at IS NULL ORDER BY o.code, l.line_no`,
    [companyId, releaseIds],
  );
  const ids = releases.map((r) => r.id);
  if (!ids.length) return null;
  const [items] = await db.query(
    `SELECT pi.*, m.code AS item_code, m.name AS item_name, i.uom, f.code AS flow_code, f.name AS flow_name
       FROM cf_production_items pi
       JOIN cf_master_records m ON m.id = pi.item_id
       JOIN cf_item_details i ON i.master_id = pi.item_id
       JOIN cf_operation_flows f ON f.id = pi.flow_id
      WHERE pi.company_id = ? AND pi.release_id IN (?) AND pi.deleted_at IS NULL ORDER BY pi.release_id, pi.sort_order`,
    [companyId, ids],
  );
  const itemIds = items.map((x) => x.id);
  const [steps] = itemIds.length ? await db.query(
    `SELECT s.*, o.code AS op_code, o.name AS op_name, mc.code AS machine_code, mc.name AS machine_name
       FROM cf_production_steps s
       JOIN cf_operations o ON o.id = s.operation_id
       LEFT JOIN cf_machines mc ON mc.id = s.machine_id
      WHERE s.company_id = ? AND s.production_item_id IN (?) AND s.deleted_at IS NULL ORDER BY s.production_item_id, s.sequence, s.id`,
    [companyId, itemIds],
  ) : [[]];
  const stepIds = steps.map((s) => s.id);
  const [deps] = stepIds.length ? await db.query('SELECT * FROM cf_step_dependencies WHERE company_id = ? AND step_id IN (?) AND deleted_at IS NULL ORDER BY id', [companyId, stepIds]) : [[]];
  const [reqs] = await db.query(
    `SELECT q.*, m.code AS item_code, m.name AS item_name, i.uom, i.tracked_by
       FROM cf_material_requirements q
       JOIN cf_master_records m ON m.id = q.item_id
       JOIN cf_item_details i ON i.master_id = q.item_id
      WHERE q.company_id = ? AND q.release_id IN (?) AND q.deleted_at IS NULL ORDER BY q.id`,
    [companyId, ids],
  );
  const reqIds = reqs.map((q) => q.id);
  const [reservations] = reqIds.length ? await db.query(
    `SELECT v.*, b.code AS batch_code, b.status AS batch_status FROM cf_stock_reservations v
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND v.requirement_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY v.id`,
    [companyId, reqIds],
  ) : [[]];
  const free = await availability(db, companyId, [...new Set(reqs.map((q) => q.item_id))]);
  return { releases, items, steps, deps, reqs, reservations, free };
}

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};
const sum = (rows) => round6(rows.reduce((t, r) => t + Number(r.quantity), 0));

/** Works out every step's status from its recorded state, its waits and its material. */
function evaluate(data) {
  const { items, steps, deps, reqs, reservations, free } = data;
  const itemById = new Map(items.map((x) => [x.id, x]));
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const stepsOf = groupBy(steps, 'production_item_id');
  // A numbered piece is called by its code; a grouped node is still called what
  // it is ("stiffener ×6 for segment 1"). Both carry a code — the label is the
  // sentence a person reads, not the identity.
  const label = (it) => (it.piece_no ? it.code : `${it.item_code} ×${fmt(it.quantity)}${it.parent_id ? ` for ${label(itemById.get(it.parent_id))}` : ''}`);
  const started = (s) => !!s.started_at || s.state === 'in_progress' || s.state === 'done';
  const own = (id) => stepsOf.get(id) ?? [];
  const pieceStarted = (id) => own(id).some(started);
  const pieceComplete = (id) => own(id).length > 0 && own(id).every((s) => s.state === 'done');

  const resByReq = groupBy(reservations, 'requirement_id');
  for (const q of reqs) {
    const res = resByReq.get(q.id) ?? [];
    const usable = res.filter((v) => !v.batch_id || v.batch_status === 'available');
    q._res = res;
    q._reserved = sum(res);
    q._usable = sum(usable);
    q._short = round6(Math.max(0, Number(q.quantity) - Number(q.issued) - q._usable));
    q._covered = q._short <= EPS;
  }
  const reqsByStep = groupBy(reqs.filter((q) => q.step_id), 'step_id');
  const depsByStep = groupBy(deps, 'step_id');

  // A flow may run the same operation more than once (weld, crane-turn, weld),
  // so on a piece that repeats one, "SAW Welding" no longer names a single
  // step and the work queue would show the passes as two identical rows. Name
  // the pass — or use the step's own name, where somebody gave it one. Nothing
  // changes for the ordinary piece that does each operation once.
  for (const it of items) {
    const ss = own(it.id);   // already in flow order: sequence, then id
    const total = new Map();
    for (const s of ss) total.set(s.operation_id, (total.get(s.operation_id) ?? 0) + 1);
    const seen = new Map();
    for (const s of ss) {
      const n = (seen.get(s.operation_id) ?? 0) + 1;
      seen.set(s.operation_id, n);
      const of = total.get(s.operation_id) ?? 1;
      s._opLabel = of < 2 ? s.op_name : (s.step_name || `${s.op_name} (pass ${n} of ${of})`);
    }
  }

  // A step works on its whole quantity at once (E2, answered 2026-09-23: "if I
  // say x pieces are required for that step, then all x need to come before
  // the step"). What runs on its own is each PIECE: one girder's fit-up waits
  // for that girder's parts, never for another girder's.
  for (const s of steps) {
    const waits = [];
    const blockers = [];
    for (const d of depsByStep.get(s.id) ?? []) {
      let met;
      let text;
      if (d.target_step_id) {
        const t = stepById.get(d.target_step_id);
        met = d.required === 'started' ? started(t) : t.state === 'done';
        const verb = d.required === 'started' ? 'start' : 'finish';
        text = t.production_item_id === s.production_item_id
          ? `${t._opLabel ?? t.op_name} (${t.op_code}) to ${verb} first`
          : `${label(itemById.get(t.production_item_id))} to ${verb} ${t._opLabel ?? t.op_name} (${t.op_code})`;
      } else {
        const it = itemById.get(d.target_item_id);
        met = d.required === 'started' ? pieceStarted(it.id) : pieceComplete(it.id);
        text = `${label(it)} to ${d.required === 'started' ? 'start' : 'be complete'}`;
      }
      waits.push({ origin: d.origin, met, text: `Waits for ${text}.` });
      if (!met) blockers.push({ kind: 'wait', text: `Waiting for ${text}.` });
    }
    const materials = reqsByStep.get(s.id) ?? [];
    for (const q of materials) {
      if (q._covered) continue;
      const held = q._reserved - q._usable > EPS ? ` (${fmt(q._reserved - q._usable)} reserved on a held batch)` : '';
      const freeNow = free?.get(q.item_id)?.free ?? 0;
      const none = freeNow + EPS < q._short ? ` — ${freeNow > EPS ? `only ${fmt(freeNow)}` : 'none'} free now` : '';
      blockers.push({ kind: 'material', text: `${q.item_code}: ${fmt(q._short)} ${q.uom} still to reserve of ${fmt(q.quantity)}${held}${none}.` });
    }
    s._waits = waits;
    s._blockers = blockers;
    s._requirementIds = materials.map((q) => q.id);
    s._status = s.state === 'done' ? 'done' : s.state === 'on_hold' ? 'on_hold' : s.state === 'in_progress' ? 'in_progress' : blockers.length ? 'not_ready' : 'ready';
  }
  for (const it of items) {
    const ss = own(it.id);
    it._label = label(it);
    it._status = !ss.length ? 'not_ready'
      : ss.every((s) => s._status === 'done') ? 'complete'
        : ss.some((s) => s._status === 'on_hold') ? 'on_hold'
          : ss.some((s) => s._status === 'in_progress' || s._status === 'done') ? 'in_progress'
            : ss.some((s) => s._status === 'ready') ? 'ready' : 'not_ready';
  }
  return { label, stepsOf, itemById };
}

const shapeStep = (s, pieceLabel) => ({
  id: s.id,
  sequence: s.sequence,
  operation: { id: s.operation_id, code: s.op_code, name: s.op_name },
  stepName: s.step_name,
  label: `${pieceLabel} · ${s._opLabel ?? s.op_name}`,
  quantity: Number(s.quantity),
  qtyGood: Number(s.qty_good),
  qtyScrap: Number(s.qty_scrap),
  state: s.state,
  status: s._status,
  machine: s.machine_id ? { id: s.machine_id, code: s.machine_code, name: s.machine_name } : null,
  startedAt: s.started_at,
  finishedAt: s.finished_at,
  waits: s._waits,
  blockers: s._blockers,
  requirementIds: s._requirementIds,
});

function shapeRequirement(q, data, ev) {
  const step = q.step_id ? data.steps.find((s) => s.id === q.step_id) : null;
  const piece = q.production_item_id ? ev.itemById.get(q.production_item_id) : null;
  return {
    id: q.id,
    item: { id: q.item_id, code: q.item_code, name: q.item_name, uom: q.uom, trackedBy: q.tracked_by },
    quantity: Number(q.quantity),
    issued: Number(q.issued),
    reserved: q._reserved,
    usableReserved: q._usable,
    short: q._short,
    covered: q._covered,
    piece: piece ? { id: piece.id, label: piece._label } : null,
    step: step ? { id: step.id, label: `${piece?._label ?? ''} · ${step._opLabel ?? step.op_name}`, status: step._status } : null,
    reservations: q._res.map((v) => ({ id: v.id, quantity: Number(v.quantity), batch: v.batch_id ? { id: v.batch_id, code: v.batch_code, status: v.batch_status } : null })),
    free: data.free.get(q.item_id)?.free ?? 0,
  };
}

function shapeReleases(data) {
  const ev = evaluate(data);
  const itemsByRelease = groupBy(data.items, 'release_id');
  const reqsByRelease = groupBy(data.reqs, 'release_id');
  return data.releases.map((r) => {
    const items = itemsByRelease.get(r.id) ?? [];
    const steps = items.flatMap((it) => ev.stepsOf.get(it.id) ?? []);
    const reqs = reqsByRelease.get(r.id) ?? [];
    const count = (st) => steps.filter((s) => s._status === st).length;
    const done = count('done');
    return {
      id: r.id,
      order: { id: r.order_id, code: r.order_code, title: r.order_title, status: r.order_status, type: r.order_type },
      line: { id: r.order_line_id, lineNo: r.line_no, committedDate: dateOnly(r.line_committed ?? r.order_committed) },
      item: { id: r.item_id, code: r.item_code, name: r.item_name, revision: r.item_revision },
      quantity: Number(r.quantity),
      releasedAt: r.created_at,
      releasedBy: r.released_by ?? null,
      finishedArea: r.finished_area_id ? { id: r.finished_area_id, code: r.finished_area_code, name: r.finished_area_name } : null,
      // What the line owes, what has been made into stock, what has left the
      // yard, and what is standing there with its name on it (Idea A).
      finished: {
        quantity: Number(r.quantity),
        made: Number(r.made_qty ?? 0),
        delivered: Number(r.delivered_qty ?? 0),
        readyToShip: round6(Number(r.ready_to_ship ?? 0)),
      },
      status: steps.length && done === steps.length ? 'complete' : steps.some((s) => s.started_at || s.state !== 'pending') ? 'in_progress' : 'not_started',
      progress: {
        steps: steps.length, done, inProgress: count('in_progress'), ready: count('ready'), notReady: count('not_ready'), onHold: count('on_hold'),
        pieces: items.length, complete: items.filter((it) => it._status === 'complete').length,
        materials: reqs.length, materialsCovered: reqs.filter((q) => q._covered).length,
      },
      canUnrelease: !steps.some((s) => s.started_at || s.state !== 'pending' || Number(s.qty_good) > 0) && !reqs.some((q) => Number(q.issued) > EPS),
      items: items.map((it) => ({
        id: it.id,
        parentId: it.parent_id,
        depth: it.depth,
        label: it._label,
        code: it.code,
        item: { id: it.item_id, code: it.item_code, name: it.item_name, uom: it.uom },
        pieceNo: it.piece_no,
        quantity: Number(it.quantity),
        flow: { id: it.flow_id, code: it.flow_code, name: it.flow_name, revision: it.flow_revision },
        status: it._status,
        steps: (ev.stepsOf.get(it.id) ?? []).map((s) => shapeStep(s, it._label)),
      })),
      requirements: reqs.map((q) => shapeRequirement(q, data, ev)),
    };
  });
}

/** One release: its tracker tree with every step's status, and its material. */
export async function getRelease(db, companyId, releaseId) {
  const data = await loadTracker(db, companyId, [Number(releaseId)]);
  if (!data) throw notFound('Release');
  return shapeReleases(data)[0];
}

/** Every release of an order, and which of its lines are not released yet. */
export async function orderProduction(db, companyId, orderId) {
  const [rels] = await db.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
  const data = await loadTracker(db, companyId, rels.map((r) => r.id));
  const releases = data ? shapeReleases(data) : [];
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, l.quantity, m.code AS item_code, m.name AS item_name FROM cf_sales_order_lines l
       LEFT JOIN cf_master_records m ON m.id = l.item_id
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no`,
    [companyId, orderId],
  );
  const released = new Set(releases.map((r) => r.line.id));
  return {
    releases,
    unreleased: lines.filter((l) => !released.has(l.id)).map((l) => ({ id: l.id, lineNo: l.line_no, quantity: Number(l.quantity), item: { code: l.item_code, name: l.item_name } })),
  };
}

async function openReleaseIds(db, companyId, { includeClosed = false } = {}) {
  const [rows] = await db.query(
    `SELECT r.id FROM cf_production_releases r JOIN cf_sales_orders o ON o.id = r.order_id AND o.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL${includeClosed ? '' : " AND o.status = 'confirmed'"}`,
    [companyId],
  );
  return rows.map((r) => r.id);
}

const contains = (term, ...texts) => texts.some((t) => t && String(t).toLowerCase().includes(term));

/**
 * The work queue: every step of every release on a confirmed order.
 * q: { status?: open (default) | ready | in_progress | not_ready | on_hold | done | all, orderId?, operationId?, search?, includeClosed? }
 */
export async function listTrackerSteps(db, companyId, q = {}) {
  const data = await loadTracker(db, companyId, await openReleaseIds(db, companyId, { includeClosed: String(q.includeClosed) === '1' }));
  if (!data) return [];
  let rows = shapeReleases(data).flatMap((r) => r.items.flatMap((it) => it.steps.map((s) => ({
    ...s, release: { id: r.id }, order: r.order, line: r.line, piece: { id: it.id, label: it.label, itemCode: it.item.code, depth: it.depth },
  }))));
  const status = blank(q.status) ? 'open' : String(q.status);
  if (status === 'open') rows = rows.filter((s) => s.status !== 'done');
  else if (status !== 'all') rows = rows.filter((s) => s.status === status);
  if (!blank(q.orderId)) rows = rows.filter((s) => s.order.id === Number(q.orderId));
  if (!blank(q.operationId)) rows = rows.filter((s) => s.operation.id === Number(q.operationId));
  if (!blank(q.search)) {
    const term = String(q.search).trim().toLowerCase();
    rows = rows.filter((s) => contains(term, s.piece.label, s.order.code, s.operation.code, s.operation.name, s.machine?.code));
  }
  return rows;
}

/** Material across open releases. q: { show?: short (default) | all, search? } */
export async function listTrackerMaterials(db, companyId, q = {}) {
  const data = await loadTracker(db, companyId, await openReleaseIds(db, companyId));
  if (!data) return [];
  let rows = shapeReleases(data).flatMap((r) => r.requirements.map((m) => ({ ...m, release: { id: r.id }, order: r.order, line: r.line })));
  if (String(q.show ?? 'short') === 'short') rows = rows.filter((m) => !m.covered);
  if (!blank(q.search)) {
    const term = String(q.search).trim().toLowerCase();
    rows = rows.filter((m) => contains(term, m.item.code, m.item.name, m.order.code, m.piece?.label));
  }
  return rows;
}

/** For the nav badges and Home. */
export async function trackerCounts(db, companyId) {
  const data = await loadTracker(db, companyId, await openReleaseIds(db, companyId));
  if (!data) return { readySteps: 0, inProgress: 0, onHold: 0, materialShort: 0, releases: 0 };
  evaluate(data);
  const stepStatus = new Map(data.steps.map((s) => [s.id, s._status]));
  return {
    readySteps: data.steps.filter((s) => s._status === 'ready').length,
    inProgress: data.steps.filter((s) => s._status === 'in_progress').length,
    onHold: data.steps.filter((s) => s._status === 'on_hold').length,
    materialShort: data.reqs.filter((q) => !q._covered && stepStatus.get(q.step_id) !== 'done').length,
    releases: data.releases.length,
  };
}

// --- the shop floor -----------------------------------------------------------------

async function requireStep(db, companyId, stepId) {
  const [[s]] = await db.query(
    `SELECT s.*, pi.release_id, r.order_id, o.code AS order_code, o.status AS order_status, op.code AS op_code, op.name AS op_name
       FROM cf_production_steps s
       JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
       JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_operations op ON op.id = s.operation_id
      WHERE s.company_id = ? AND s.id = ? AND s.deleted_at IS NULL FOR UPDATE`,
    [companyId, Number(stepId)],
  );
  if (!s) throw notFound('Step');
  assertOrderOpen(s);
  return s;
}

/** The step as its release sees it: status, blockers, label. */
async function evaluatedStep(db, companyId, step) {
  const rel = await getRelease(db, companyId, step.release_id);
  for (const it of rel.items) for (const s of it.steps) if (s.id === step.id) return { rel, s };
  throw notFound('Step');
}

async function logEvent(db, c, stepId, event, { good = 0, scrap = 0, machineId = null, note = null } = {}) {
  await db.query(
    'INSERT INTO cf_step_events (company_id, step_id, event, qty_good, qty_scrap, machine_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, stepId, event, good, scrap, machineId, note, c.userId],
  );
}

/** Starts a ready step. input: { machineId? } — a machine must be one its operation's rules let do it. */
export async function startStep(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  const { s } = await evaluatedStep(db, c.companyId, step);
  if (s.status !== 'ready') {
    const why = s.status === 'not_ready' ? s.blockers.map((b) => b.text) : [`It is ${s.status.replace('_', ' ')}.`];
    throw invalid('NOT_READY', `${s.label} cannot start yet.`, { problems: why });
  }
  let machineId = null;
  if (!blank(input.machineId)) {
    const [[m]] = await db.query('SELECT * FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.machineId)]);
    if (!m) throw invalid('INVALID', 'That machine does not exist.');
    if (m.status !== 'active') throw invalid('INVALID', `${m.code} is inactive.`);
    const rule = await resolveTiming(db, c.companyId, step.operation_id, m);
    if (!rule || !rule.eligible) throw invalid('NOT_ELIGIBLE', `${m.code} is not set up to do ${step.op_name} (${step.op_code}).`);
    machineId = m.id;
  }
  await db.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = NOW(), machine_id = ? WHERE company_id = ? AND id = ?", [machineId, c.companyId, step.id]);
  await logEvent(db, c, step.id, 'start', { machineId, note: blank(input.note) ? null : String(input.note).slice(0, 500) });
  return getRelease(db, c.companyId, step.release_id);
}

/**
 * Records work on a started step. input: { good?, scrap?, note? } — quantities
 * are added to what is recorded; the step is done when the good ones reach its
 * quantity. Scrapped pieces do not count: they are made again.
 */
export async function recordProgress(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.state !== 'in_progress') throw invalid('NOT_STARTED', step.state === 'done' ? 'This step is already done.' : step.state === 'on_hold' ? 'This step is on hold — resume it first.' : 'Start the step first.');
  const good = blank(input.good) ? 0 : Number(input.good);
  const scrap = blank(input.scrap) ? 0 : Number(input.scrap);
  if (!Number.isFinite(good) || !Number.isFinite(scrap) || good < 0 || scrap < 0) throw invalid('INVALID', 'Good and scrapped are numbers, zero or more.');
  if (good + scrap <= EPS) throw invalid('INVALID', 'Record at least one good or scrapped piece.');
  const left = round6(Number(step.quantity) - Number(step.qty_good));
  if (good > left + EPS) throw invalid('TOO_MANY', `Only ${fmt(left)} more good ${left === 1 ? 'piece is' : 'pieces are'} needed at this step.`);
  const newGood = round6(Number(step.qty_good) + good);
  const done = newGood >= Number(step.quantity) - EPS;
  await db.query(
    `UPDATE cf_production_steps SET qty_good = ?, qty_scrap = qty_scrap + ?, state = ?, finished_at = ${done ? 'NOW()' : 'NULL'} WHERE company_id = ? AND id = ?`,
    [newGood, round6(scrap), done ? 'done' : 'in_progress', c.companyId, step.id],
  );
  await logEvent(db, c, step.id, 'progress', { good: round6(good), scrap: round6(scrap), note: blank(input.note) ? null : String(input.note).slice(0, 500) });
  if (done) await stockFinished(db, c, step.production_item_id);
  return getRelease(db, c.companyId, step.release_id);
}

/**
 * A finished piece becomes stock (Idea A, user 2026-09-23).
 *
 * When the last step of the piece a LINE SELLS is done, that quantity is
 * received into the release's finished-goods area. For a customer order it is
 * then earmarked for the line, so nothing else can take it and the line can be
 * shipped; a stock order's output is free stock — putting it on the shelf for
 * anyone is the whole point of a stock order.
 *
 * Parts below the top (a web, a segment) put nothing in stock: they are work in
 * progress, and the tracker is where their progress lives. `stocked_qty` is the
 * guard, so the same piece is never received twice.
 */
async function stockFinished(db, c, productionItemId) {
  const [[it]] = await db.query(
    `SELECT pi.*, r.order_id, r.order_line_id, r.finished_area_id, o.order_type, o.code AS order_code, l.line_no,
            m.code AS item_code, m.name AS item_name, i.tracked_by
       FROM cf_production_items pi
       JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       JOIN cf_master_records m ON m.id = pi.item_id
       JOIN cf_item_details i ON i.master_id = pi.item_id
      WHERE pi.company_id = ? AND pi.id = ? AND pi.deleted_at IS NULL FOR UPDATE`,
    [c.companyId, productionItemId],
  );
  if (!it || it.parent_id) return null;                       // only the piece the line sells
  const quantity = round6(Number(it.quantity) - Number(it.stocked_qty));
  if (quantity <= EPS) return null;                           // already in stock
  const [steps] = await db.query(
    "SELECT state FROM cf_production_steps WHERE company_id = ? AND production_item_id = ? AND deleted_at IS NULL",
    [c.companyId, it.id],
  );
  if (!steps.length || steps.some((s) => s.state !== 'done')) return null;
  // Releases made before the area was asked for, and any the obvious answer has
  // reached since, resolve it now rather than refusing a finished piece.
  let areaId = it.finished_area_id;
  if (!areaId) {
    const resolved = await finishedArea(db, c.companyId, { order_type: it.order_type }, null);
    if (!resolved.area) {
      throw invalid('NO_FINISHED_AREA', `${it.code ?? it.item_code} is finished, but nothing says where finished work goes. ${resolved.problem}`);
    }
    areaId = resolved.area.id;
    await db.query('UPDATE cf_production_releases SET finished_area_id = ? WHERE company_id = ? AND id = ?', [areaId, c.companyId, it.release_id]);
  }
  // A unit-tracked piece is counted as a quantity for now (the user's "quantity
  // for now"); giving each unit its own number and history is a phase of its own.
  //
  // It still arrives as a LOT with its own code, whatever the item is counted
  // by, so what is standing on the dispatch shelf can be named and traced back
  // to the piece that made it (user, 2026-09-23).
  const lot = await generate(db, c.companyId, 'stock_lot', 'code', {
    draft: { itemId: it.item_id, pieceCode: it.code, orderCode: it.order_code, source: 'production' },
  }, { consume: true });
  // With no rule the piece's own code names the lot — unless a piece of that
  // code has already been made, in which case the lot says which one it is.
  let lotCode = lot?.text || it.code || null;
  if (!lot?.text && lotCode) {
    const [[taken]] = await db.query('SELECT id FROM cf_stock_batches WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, lotCode]);
    if (taken) lotCode = `${lotCode}-${it.id}`;
  }
  const movement = await postMovement(db, c, {
    movementType: 'receipt',
    toAreaId: areaId,
    reference: `${it.order_code}/${it.line_no}`,
    notes: `Made on ${it.order_code} line ${it.line_no}`,
    lines: [{
      itemId: it.item_id,
      quantity,
      batch: { code: lotCode, supplierRef: it.code ?? null, productionItemId: it.id },
    }],
  }, { fromProduction: true });
  await db.query('UPDATE cf_production_items SET stocked_qty = stocked_qty + ? WHERE company_id = ? AND id = ?', [quantity, c.companyId, it.id]);
  await db.query('UPDATE cf_sales_order_lines SET made_qty = made_qty + ? WHERE company_id = ? AND id = ?', [quantity, c.companyId, it.order_line_id]);
  if (it.order_type !== 'stock') {
    const [[leg]] = await db.query(
      'SELECT batch_id FROM cf_stock_ledger WHERE company_id = ? AND movement_id = ? ORDER BY id LIMIT 1',
      [c.companyId, movement.id],
    );
    await db.query(
      `INSERT INTO cf_stock_reservations (company_id, requirement_id, order_line_id, item_id, batch_id, quantity, status, created_by)
       VALUES (?, NULL, ?, ?, ?, ?, 'active', ?)`,
      [c.companyId, it.order_line_id, it.item_id, leg?.batch_id ?? null, quantity, c.userId],
    );
  }
  return movement;
}

/** Puts a step on hold, with the reason. */
export async function holdStep(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  if (!['pending', 'in_progress'].includes(step.state)) throw invalid('INVALID', step.state === 'done' ? 'A done step is not put on hold.' : 'This step is already on hold.');
  if (blank(input.note)) throw invalid('INVALID', 'Say why it is on hold.');
  // The earlier state comes from the row read above: MySQL and TiDB differ on
  // whether a later assignment in one UPDATE sees an earlier one.
  await db.query("UPDATE cf_production_steps SET held_from = ?, state = 'on_hold' WHERE company_id = ? AND id = ?", [step.state, c.companyId, step.id]);
  await logEvent(db, c, step.id, 'hold', { note: String(input.note).slice(0, 500) });
  return getRelease(db, c.companyId, step.release_id);
}

/** Takes a step off hold, back to where it was. */
export async function resumeStep(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.state !== 'on_hold') throw invalid('INVALID', 'This step is not on hold.');
  await db.query('UPDATE cf_production_steps SET state = ?, held_from = NULL WHERE company_id = ? AND id = ?', [step.held_from ?? 'pending', c.companyId, step.id]);
  await logEvent(db, c, step.id, 'resume', { note: blank(input.note) ? null : String(input.note).slice(0, 500) });
  return getRelease(db, c.companyId, step.release_id);
}

/** What was recorded on a step, oldest first. */
export async function stepHistory(db, companyId, stepId) {
  const [rows] = await db.query(
    `SELECT e.*, m.code AS machine_code, u.name AS user_name FROM cf_step_events e
       LEFT JOIN cf_machines m ON m.id = e.machine_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.company_id = ? AND e.step_id = ? ORDER BY e.id`,
    [companyId, Number(stepId)],
  );
  return rows.map((e) => ({
    id: e.id, event: e.event, good: Number(e.qty_good), scrap: Number(e.qty_scrap),
    machine: e.machine_id ? { id: e.machine_id, code: e.machine_code } : null, note: e.note, at: e.created_at, by: e.user_name ?? null,
  }));
}

// --- material: reservations and issues ------------------------------------------------

async function requireRequirement(db, companyId, reqId) {
  const [[q]] = await db.query(
    `SELECT q.*, r.order_id, o.code AS order_code, o.status AS order_status, l.line_no,
            m.code AS item_code, m.name AS item_name, i.uom, i.tracked_by
       FROM cf_material_requirements q
       JOIN cf_production_releases r ON r.id = q.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       JOIN cf_master_records m ON m.id = q.item_id
       JOIN cf_item_details i ON i.master_id = q.item_id
      WHERE q.company_id = ? AND q.id = ? AND q.deleted_at IS NULL FOR UPDATE`,
    [companyId, Number(reqId)],
  );
  if (!q) throw notFound('Requirement');
  assertOrderOpen(q);
  return q;
}

async function activeReservations(db, companyId, reqId) {
  const [rows] = await db.query(
    `SELECT v.*, b.code AS batch_code, b.status AS batch_status FROM cf_stock_reservations v
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND v.requirement_id = ? AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY v.id FOR UPDATE`,
    [companyId, reqId],
  );
  return rows;
}

/** One item's free stock is claimed one transaction at a time (stock movements take the same lock). */
export async function lockItemStock(db, companyId, itemId) {
  await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id = ? FOR UPDATE', [companyId, itemId]);
}

/** Reserves what is free for one requirement, oldest batch first. input: { quantity?, batchId? } */
async function reserveOne(db, c, q, input = {}) {
  const have = sum(await activeReservations(db, c.companyId, q.id));
  const remaining = round6(Number(q.quantity) - Number(q.issued) - have);
  if (remaining <= EPS) return { reserved: 0, short: 0, message: `${q.item_code} is already covered here — ${fmt(q.issued)} issued, ${fmt(have)} reserved.` };
  let want = remaining;
  if (!blank(input.quantity)) {
    const n = Number(input.quantity);
    if (!Number.isFinite(n) || n <= 0) throw invalid('INVALID', 'Quantity must be more than zero.');
    if (n > remaining + EPS) throw invalid('TOO_MANY', `Only ${fmt(remaining)} ${q.uom} more ${remaining === 1 ? 'is' : 'are'} needed here.`);
    want = round6(n);
  }
  const av = (await availability(db, c.companyId, [q.item_id])).get(q.item_id);
  const rows = [];
  if (q.tracked_by === 'batch') {
    let batches = av.batches.filter((b) => b.status === 'available' && b.free > EPS);
    if (!blank(input.batchId)) {
      batches = batches.filter((b) => b.batchId === Number(input.batchId));
      if (!batches.length) throw invalid('NOT_FREE', `That batch has nothing free of ${q.item_code}.`);
    }
    for (const b of batches) {
      if (want <= EPS) break;
      const take = round6(Math.min(want, b.free));
      rows.push({ batchId: b.batchId, quantity: take });
      want = round6(want - take);
    }
  } else if (av.free > EPS) {
    const take = round6(Math.min(want, av.free));
    rows.push({ batchId: null, quantity: take });
    want = round6(want - take);
  }
  for (const r of rows) {
    await db.query('INSERT INTO cf_stock_reservations (company_id, requirement_id, item_id, batch_id, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [c.companyId, q.id, q.item_id, r.batchId, r.quantity, c.userId]);
  }
  const reserved = sum(rows);
  return {
    reserved, short: want,
    message: reserved > EPS ? null : `No free stock of ${q.item_code} — ${fmt(av.available)} ${q.uom} usable on hand, ${fmt(av.reserved)} already reserved.`,
  };
}

export async function reserveRequirement(db, c, reqId, input = {}) {
  const q = await requireRequirement(db, c.companyId, reqId);
  await lockItemStock(db, c.companyId, q.item_id);
  const out = await reserveOne(db, c, q, input);
  if (out.reserved <= EPS) throw invalid('NOT_FREE', out.message);
  return getRelease(db, c.companyId, q.release_id);
}

/** Reserves whatever is free for every requirement of a release; says what is still short. */
export async function reserveRelease(db, c, releaseId) {
  const rel = await requireRelease(db, c.companyId, releaseId, { lock: true });
  assertOrderOpen(rel);
  const [reqs] = await db.query('SELECT id FROM cf_material_requirements WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL ORDER BY id', [c.companyId, releaseId]);
  let reserved = 0;
  const short = new Map();
  for (const { id: reqId } of reqs) {
    const q = await requireRequirement(db, c.companyId, reqId);
    await lockItemStock(db, c.companyId, q.item_id);
    const out = await reserveOne(db, c, q);
    if (out.reserved > EPS) reserved += 1;
    if (out.short > EPS) short.set(q.item_id, { code: q.item_code, uom: q.uom, short: round6((short.get(q.item_id)?.short ?? 0) + out.short) });
  }
  return { release: await getRelease(db, c.companyId, releaseId), reserved, short: [...short.values()] };
}

/** Lets a reservation go. Allowed on a closed order too, so leftover claims can be freed. */
export async function releaseReservation(db, c, reservationId) {
  const [[v]] = await db.query(
    `SELECT v.*, q.release_id FROM cf_stock_reservations v JOIN cf_material_requirements q ON q.id = v.requirement_id
      WHERE v.company_id = ? AND v.id = ? AND v.deleted_at IS NULL FOR UPDATE`,
    [c.companyId, Number(reservationId)],
  );
  if (!v) throw notFound('Reservation');
  if (v.status !== 'active') throw invalid('INVALID', 'This reservation is no longer active.');
  await db.query("UPDATE cf_stock_reservations SET status = 'released', closed_at = NOW() WHERE company_id = ? AND id = ?", [c.companyId, v.id]);
  return getRelease(db, c.companyId, v.release_id);
}

/**
 * Issues a requirement's reserved stock to its order: one stock issue per area
 * it is taken from (WIP areas first — stock already moved beside a machine),
 * each reservation falling by what was taken.
 */
export async function issueRequirement(db, c, reqId) {
  const q = await requireRequirement(db, c.companyId, reqId);
  await lockItemStock(db, c.companyId, q.item_id);
  const res = await activeReservations(db, c.companyId, q.id);
  if (!res.length) throw invalid('NOTHING_RESERVED', `Nothing is reserved here yet — reserve ${q.item_code} first; only reserved stock is issued.`);
  const byArea = new Map();
  const skipped = [];
  let total = 0;
  for (const v of res) {
    if (v.batch_id && v.batch_status !== 'available') { skipped.push(`batch ${v.batch_code} is ${v.batch_status === 'on_hold' ? 'on hold' : 'rejected'}`); continue; }
    let need = Number(v.quantity);
    const [bal] = await db.query(
      `SELECT k.stocking_area_id, k.quantity FROM cf_stock_balances k
         JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN ${USABLE}
        WHERE k.company_id = ? AND k.item_id = ? AND k.batch_key = ? AND k.quantity > 0
        ORDER BY (a.purpose = 'wip') DESC, k.quantity DESC, a.code`,
      [c.companyId, q.item_id, v.batch_id ?? 0],
    );
    for (const b of bal) {
      if (need <= EPS) break;
      const take = round6(Math.min(need, Number(b.quantity)));
      if (!byArea.has(b.stocking_area_id)) byArea.set(b.stocking_area_id, []);
      byArea.get(b.stocking_area_id).push({ itemId: q.item_id, batchId: v.batch_id, quantity: take });
      need = round6(need - take);
    }
    const taken = round6(Number(v.quantity) - need);
    if (taken > EPS) {
      const left = round6(Number(v.quantity) - taken);
      await db.query(
        `UPDATE cf_stock_reservations SET quantity = ?, status = ?, closed_at = ${left <= EPS ? 'NOW()' : 'NULL'} WHERE company_id = ? AND id = ?`,
        [left <= EPS ? 0 : left, left <= EPS ? 'consumed' : 'active', c.companyId, v.id],
      );
      total = round6(total + taken);
    }
    if (need > EPS) skipped.push(`${fmt(need)} ${q.uom}${v.batch_code ? ` of batch ${v.batch_code}` : ''} is not in a storage or WIP area`);
  }
  if (total <= EPS) throw invalid('NOT_THERE', `Nothing could be issued — ${skipped.join('; ')}.`);
  // The reservations fell first, so the issues below do not trip over them.
  for (const [areaId, lines] of byArea) {
    await postMovement(db, c, {
      movementType: 'issue', orderId: q.order_id, fromAreaId: areaId, lines,
      reference: `${q.order_code}/${q.line_no}`, notes: `Material for line ${q.line_no} of ${q.order_code}`,
    });
  }
  await db.query('UPDATE cf_material_requirements SET issued = issued + ? WHERE company_id = ? AND id = ?', [total, c.companyId, q.id]);
  return getRelease(db, c.companyId, q.release_id);
}
