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
 * The tree itself — what is made, what is material, how it is numbered — is
 * rollOutService's, the one copy lock and release share. Since 2026-09-26 a
 * line built from a template is LOCKED before it is released: lock rolls it out
 * and writes every piece's code (cf_order_pieces), and release lays the same
 * tree out again and takes each node's code from there by path key. It never
 * makes a code for a locked line. What release adds is its own: the production
 * steps, the waits between them and the material each one consumes.
 *
 * A standard line (a catalog item sold as it is) has no structure of its own to
 * lock, and is coded here at release, as before.
 *
 * The tracker is the release snapshot: it copies what it needs and never
 * follows later edits. Whether a step is READY is worked out on every read from
 * its dependencies and its material — never stored.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { LOCKED_ORDER_STATUSES, revisedOrderMessage, latestRevisionSql } from './records.js';
import { resolveTiming } from './operationService.js';
import { estimatorForLine } from './timeEstimateService.js';
import { cellOwnersOfLine } from './workOrderService.js';
import { postMovement } from './stockService.js';
import { generate } from '../modules/codegen/index.js';
import {
  availability, availabilityRows, shapeAvailability, rollOutPlan, codeNodes, seedPieceMemo, linePositionOf, takenCodes,
  lockedPiecesOf, lockedBothOf, attachLockedCodes, unmatchedProblem, nameOf,
} from './rollOutService.js';

// availability moved to rollOutService with the made rule it serves; the
// services that read it from here keep working.
export { availability };

const EPS = 1e-9;
const round6 = (n) => Number(Number(n).toFixed(6));
const fmt = (n) => String(round6(n));
const blank = (v) => v == null || String(v).trim() === '';
const USABLE = "('storage','wip')";
const dateOnly = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ?? null);

/** Release's words for a line built from a template that has not been locked. */
export const lockFirst = (line) => `Line ${line.line_no} of ${line.order_code} is not locked. Lock the line first — it comes after the values and cut pieces.`;

async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type,
            o.revision AS order_revision, ${latestRevisionSql('o')} AS order_latest_revision
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
    `SELECT r.*, o.code AS order_code, o.status AS order_status, l.line_no,
            o.revision AS order_revision, ${latestRevisionSql('o')} AS order_latest_revision
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
    throw invalid('ORDER_LOCKED', order.order_status === 'revised' ? revisedOrderMessage(order.order_code, order.order_revision, order.order_latest_revision)
      : `Order ${order.order_code} is ${order.order_status} — nothing more is recorded on it.`);
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

// --- the release plan: what release would create, and what stops it --------------

/**
 * The roll-out (rollOutService.rollOutPlan) with release's own checks on top:
 * how each made thing is made, and whether it may be issued. Returns every
 * problem at once — nothing is written here.
 *
 *   lockedBoth      a locked line's 'both' decisions, taken at lock (madeRule)
 *   rowsMayBeDraft  a line not locked yet: its rows are drafts until lock
 *                   activates them, so a draft row is not a problem to report
 *                   — "lock the line first" is the one thing to say
 */
async function buildPlan(db, companyId, line, { lockedBoth = null, rowsMayBeDraft = false } = {}) {
  const plan = await rollOutPlan(db, companyId, line, { lockedBoth });
  const { problems, all, detail, tree } = plan;
  if (tree.root.made === undefined) return plan;

  for (const n of all) {
    if (n.made === undefined) continue;   // a selection or a definition — already a problem
    const where = n.parentNode ? ` under ${nameOf(n.parentNode)}` : '';
    // A row is activated when its line is locked; a locked line's rows are active.
    if (n.kind === 'temporary' && !rowsMayBeDraft) {
      if (n.status === 'draft') problems.push(`${nameOf(n)} is still a draft — activate it before release.`);
      else if (n.status !== 'active') problems.push(`${nameOf(n)}${where} is ${n.status} — only active items are made or issued.`);
    }
    if (n.made && !n.flow) {
      problems.push(n.kind === 'temporary'
        ? `${nameOf(n)} has no flow — say how it is made.`
        : `${nameOf(n)}${where} is made on the order, but has no flow — give it one, or set it to come from stock.`);
    }
    if (n.made === false && detail.get(n.id)?.tracked_by === 'individual') {
      problems.push(`${nameOf(n)} is tracked unit by unit — no stock is kept of it yet, so it cannot be reserved. Give it a flow, or track it by quantity or batch.`);
    }
  }
  if (!tree.root.made && line.order_type === 'stock') problems.push(`${nameOf(tree.root)} has no flow — say how it is made, because a stock order is what makes it.`);

  // The flows of everything made: active, with steps, on active operations.
  plan.flows = await loadFlows(db, companyId, [...new Set(all.filter((n) => n.made && n.flow).map((n) => n.flow.id))]);
  for (const f of plan.flows.values()) {
    if (f.status !== 'active') problems.push(`Flow ${f.code} is ${f.status === 'draft' ? 'still a draft' : f.status} — activate it before release.`);
    if (!f.steps.length) problems.push(`Flow ${f.code} has no steps.`);
    for (const s of f.steps) if (s.op_status !== 'active') problems.push(`Flow ${f.code} step ${s.sequence} uses ${s.op_code}, which is inactive.`);
  }
  return plan;
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
  // The nest: every other cut-plate node of a nest group waits for its gate's
  // first step — the one holding the group's plates — to start ("raw plate
  // from the nest"). A node's first steps, like the default below.
  for (const w of plan.nestWaits ?? []) {
    const gateStep = nodes[w.gateK].stepKs[0];
    if (gateStep == null) continue;
    for (const s of nodes[w.nodeK].groups[0] ?? []) deps.push({ stepK: s.k, targetStepK: gateStep, required: 'started', origin: 'nest' });
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

// --- raw plate from the nest ----------------------------------------------------------
//
// RAW PLATE COMES FROM THE NEST, NOT FROM THE CUT PLATES' PLATE LINES
// (2026-09-30, prod KEPL line 210001: the buy list asked for 14.71 of one plate
// where the nest uses 9, and missed a size the nest uses 6 of).
//
// A cut plate's BOM holds ONE raw-plate line with a fractional "plates per
// piece". That is right for a line nobody has nested: it is the only answer
// there is. Once a nest is saved it is wrong three ways — a cut plate nested
// across several plate sizes books all of them on one size, the fraction never
// adds up to whole plates, and a re-nest changes the lots while the frozen
// plate line stays where it was. The nest itself is the truth: ONE LOT IS ONE
// PHYSICAL PLATE drawn from stock once.
//
// So, for a line with live plate lots:
//   * every CATALOG lot is one requirement — item = the lot's plate, quantity 1
//     (a whole plate), bom_line_id NULL. An OFFCUT lot draws a drop already in
//     the yard, which is not a catalog stock item and cannot be bought or
//     reserved, so it asks for nothing (nesting never proposes one today).
//   * lots that share a cut plate form a NEST GROUP (a cut plate spread over
//     three plate sizes ties those three lots together; one cut plate over 24
//     lots is a group of 24). Each group has ONE gate: the cut plate with the
//     most pieces placed across the group, a tie going to the one the tracker
//     lists first (lowest sort order); of that cut plate's nodes, the first.
//     Every lot requirement of the group sits on the gate's first step.
//   * every OTHER node of every cut plate in the group waits for the gate's
//     first step to START (cf_step_dependencies, origin 'nest', init.sql §34).
//     Every piece on a lot is cut from that one plate in one CNC program, so
//     nothing on a lot starts cutting before its plate is reserved and the
//     gate has started.
//     WHY A GROUP AND NOT A GATE PER LOT (asked for per lot, 2026-09-30): the
//     placements say which cut plate sits on a lot, not which of its NODES, so
//     a node of a cut plate on lots A and B has to wait for both lots' gates —
//     and when the gate of A is itself on B while the gate of B is on A, the two
//     gates wait for each other and nothing can ever start (local KEPL line: a
//     three-gate circle). One gate per group has the same meaning — nothing on
//     a lot starts before its plate is there — with no gate waiting for another.
//   * the raw-plate line of every cut plate that is on the nest makes NO
//     requirement (it would count the steel twice). That line is the cut
//     plate's selection line (SEL Plate, which is how cutPlateService writes
//     it), or any line naming a plate a lot uses. A cut plate NOT on the nest
//     (NEST_MANUAL) keeps its plate line, fraction and all.
//   * a nest that does not lay out exactly the pieces the line makes of a cut
//     plate is a release problem: buying from it would buy the wrong plates.
// A line with no live lots is released exactly as before.
//
// A lot requirement is told apart by bom_line_id NULL with a production item
// (every other requirement under a piece has its BOM line; a bought line's has
// neither). The tracker names its lot by laying the same rule over the lots
// again (lotGates): the lots cannot change while the line is released —
// nestingService refuses a released line — so the answer is the one release
// wrote. No column was added for it.

/** The live plate lots of some lines, with how many pieces of each cut plate sit on each. Map(lineId -> Map(lotId -> lot)). One query. */
async function lotsOfLines(db, companyId, lineIds) {
  const out = new Map();
  if (!lineIds.length) return out;
  const [rows] = await db.query(
    `SELECT pl.order_line_id, pl.id AS lot_id, pl.lot_no, pl.source, pl.plate_item_id,
            m.code AS plate_code, m.name AS plate_name, i.uom, i.tracked_by,
            np.cut_plate_id, COUNT(np.id) AS pieces
       FROM cf_plate_lots pl
       JOIN cf_master_records m ON m.id = pl.plate_item_id
       LEFT JOIN cf_item_details i ON i.master_id = pl.plate_item_id
       LEFT JOIN cf_nest_placements np ON np.company_id = pl.company_id AND np.plate_lot_id = pl.id AND np.deleted_at IS NULL
      WHERE pl.company_id = ? AND pl.order_line_id IN (?) AND pl.deleted_at IS NULL
      GROUP BY pl.order_line_id, pl.id, pl.lot_no, pl.source, pl.plate_item_id, m.code, m.name, i.uom, i.tracked_by, np.cut_plate_id
      ORDER BY pl.id, np.cut_plate_id`,
    [companyId, lineIds],
  );
  for (const r of rows) {
    if (!out.has(r.order_line_id)) out.set(r.order_line_id, new Map());
    const lots = out.get(r.order_line_id);
    if (!lots.has(r.lot_id)) {
      lots.set(r.lot_id, {
        id: r.lot_id, lotNo: r.lot_no, source: r.source, plateItemId: r.plate_item_id,
        plate: { id: r.plate_item_id, code: r.plate_code, name: r.plate_name, uom: r.uom, trackedBy: r.tracked_by },
        byCutPlate: new Map(),
      });
    }
    if (r.cut_plate_id != null) lots.get(r.lot_id).byCutPlate.set(Number(r.cut_plate_id), Number(r.pieces));
  }
  return out;
}

/**
 * The nest groups and their gates — the one rule release and the tracker share.
 * firstOf(cutPlateId) -> { key, order } of that cut plate's first node, or null
 * when the plan has none. Returns
 *   gates   [{ lot, gate }] for every CATALOG lot, in lot-id order (gate null
 *           when nothing on the lot's group is in the plan)
 *   groups  [{ gate, cutPlates: [cutPlateId], lots: [lot] }] — every lot, offcuts too
 */
export function lotGates(lots, firstOf) {
  const sorted = [...lots.values()].sort((a, b) => a.id - b.id);
  // Union-find over lots, joined by the cut plates they share.
  const parent = new Map(sorted.map((l) => [l.id, l.id]));
  const root = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const lotOfCutPlate = new Map();
  for (const lot of sorted) {
    for (const [cp, pieces] of lot.byCutPlate) {
      if (!(pieces > 0)) continue;
      if (lotOfCutPlate.has(cp)) {
        const a = root(lotOfCutPlate.get(cp)); const b = root(lot.id);
        if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
      } else lotOfCutPlate.set(cp, lot.id);
    }
  }
  const byRoot = new Map();
  for (const lot of sorted) {
    const r = root(lot.id);
    if (!byRoot.has(r)) byRoot.set(r, { lots: [], pieces: new Map() });
    const g = byRoot.get(r);
    g.lots.push(lot);
    for (const [cp, n] of lot.byCutPlate) if (n > 0) g.pieces.set(cp, (g.pieces.get(cp) ?? 0) + n);
  }
  const groups = [];
  const gateOfLot = new Map();
  for (const g of byRoot.values()) {
    let best = null;
    for (const [cp, pieces] of g.pieces) {
      const f = firstOf(cp);
      if (!f) continue;
      if (!best || pieces > best.pieces || (pieces === best.pieces && f.order < best.order)) best = { pieces, order: f.order, key: f.key };
    }
    const gate = best ? best.key : null;
    groups.push({ gate, cutPlates: [...g.pieces.keys()].sort((a, b) => a - b), lots: g.lots });
    for (const lot of g.lots) gateOfLot.set(lot.id, gate);
  }
  const gates = sorted.filter((l) => l.source === 'catalog').map((lot) => ({ lot, gate: gateOfLot.get(lot.id) }));
  return { gates, groups };
}

/** Replaces a nested line's raw-plate requirements with one whole plate per catalog lot (see above). */
async function nestMaterial(db, companyId, line, plan) {
  const nodes = plan.nodes ?? [];
  if (!nodes.length) return;
  const lots = (await lotsOfLines(db, companyId, [line.id])).get(line.id);
  if (!lots?.size) return;
  const placed = new Map();                        // cutPlateId -> pieces on the nest
  const lotPlates = new Set();
  for (const lot of lots.values()) {
    lotPlates.add(Number(lot.plateItemId));
    for (const [cp, n] of lot.byCutPlate) placed.set(cp, (placed.get(cp) ?? 0) + n);
  }
  const first = new Map();                         // cutPlateId -> first node k
  const need = new Map();                          // cutPlateId -> pieces the plan makes
  for (const n of nodes) {
    if (!placed.has(Number(n.itemId))) continue;
    if (!first.has(Number(n.itemId))) first.set(Number(n.itemId), n.k);
    need.set(Number(n.itemId), round6((need.get(Number(n.itemId)) ?? 0) + n.quantity));
  }
  const nameOfItem = (id) => nodes[first.get(id)]?.design?.code ?? nodes[first.get(id)]?.design?.name ?? `cut plate ${id}`;
  for (const [cp, n] of placed) {
    const want = need.get(cp) ?? 0;
    if (Math.abs(want - n) > EPS) {
      plan.problems.push(want
        ? `${nameOfItem(cp)}: the line makes ${fmt(want)} but the saved nest lays out ${fmt(n)} — nest the line again, so the plates bought are the plates cut.`
        : `The saved nest lays out ${fmt(n)} of cut plate ${cp}, which this line no longer makes — nest the line again, so the plates bought are the plates cut.`);
    }
  }
  const { gates, groups } = lotGates(lots, (cp) => (first.has(cp) ? { key: first.get(cp), order: first.get(cp) } : null));
  // Every other node of every cut plate in a group waits for its gate to start (planSteps writes the step waits).
  const nodesOf = new Map();                       // cutPlateId -> [node k]
  for (const n of nodes) if (placed.has(Number(n.itemId))) { if (!nodesOf.has(Number(n.itemId))) nodesOf.set(Number(n.itemId), []); nodesOf.get(Number(n.itemId)).push(n.k); }
  plan.nestWaits = [];
  for (const g of groups) {
    if (g.gate == null) continue;
    for (const cp of g.cutPlates) for (const k of nodesOf.get(cp) ?? []) if (k !== g.gate) plan.nestWaits.push({ nodeK: k, gateK: g.gate });
  }
  const byGate = new Map();                        // node k -> [lot requirement]
  for (const { lot, gate } of gates) {
    if (gate == null) { plan.problems.push(`Nest ${lot.lotNo} holds nothing this line makes — nest the line again.`); continue; }
    if (lot.plate.trackedBy === 'individual') {
      plan.problems.push(`${lot.plate.code ?? lot.plate.name} is tracked unit by unit — no stock is kept of it yet, so nest ${lot.lotNo}'s plate cannot be reserved. Track it by quantity or batch.`);
    }
    if (!byGate.has(gate)) byGate.set(gate, []);
    byGate.get(gate).push({
      nodeK: gate, itemId: Number(lot.plateItemId), bomLineId: null, quantity: 1,
      design: { id: Number(lot.plateItemId), code: lot.plate.code, name: lot.plate.name, uom: lot.plate.uom, kind: 'catalog' },
      lot: { id: lot.id, lotNo: lot.lotNo },
    });
  }
  // A cut plate's own raw-plate line, now that the nest says which plates.
  const isPlateLine = (r) => r.nodeK != null && placed.has(Number(nodes[r.nodeK].itemId))
    && (r.design?.selection != null || lotPlates.has(Number(r.itemId)));
  // Each lot's requirement takes the place of its gate's plate line, so the
  // material list keeps the tree's order; any left over go at the end.
  const reqs = [];
  for (const r of plan.reqs) {
    if (!isPlateLine(r)) { reqs.push(r); continue; }
    const mine = byGate.get(r.nodeK);
    if (mine) { reqs.push(...mine); byGate.delete(r.nodeK); }
  }
  for (const k of [...byGate.keys()].sort((a, b) => a - b)) reqs.push(...byGate.get(k));
  plan.reqs = reqs;
}

/**
 * The plan for a line, with the line-level checks first. A locked line's plan
 * carries its locked codes (by path key) and follows the lock's own
 * made-or-stock decisions; a node the lock did not roll out is a problem.
 */
async function planFor(db, companyId, line) {
  const problems = [];
  if (line.order_status === 'revised') problems.push(revisedOrderMessage(line.order_code, line.order_revision, line.order_latest_revision));
  else if (line.order_status !== 'confirmed') problems.push(`Order ${line.order_code} is ${line.order_status} — only a confirmed order is released to production.`);
  if (await liveReleaseOfLine(db, companyId, line.id)) problems.push(`Line ${line.line_no} is already released.`);
  if (!line.item_id) problems.push('The line has no item yet.');
  if (line.line_type === 'custom' && !line.locked_at) problems.push(lockFirst(line));
  if (problems.length) return { problems, nodes: [], steps: [], deps: [], reqs: [] };
  const pieces = line.locked_at ? await lockedPiecesOf(db, companyId, line.id) : null;
  const plan = await buildPlan(db, companyId, line, { lockedBoth: pieces ? lockedBothOf(pieces) : null });
  if (pieces) {
    for (const u of attachLockedCodes(plan.nodes ?? [], pieces)) plan.problems.push(unmatchedProblem(u, plan.nodes));
  }
  // Before planSteps: it attaches every requirement, the nest's too, to its node's first step.
  await nestMaterial(db, companyId, line, plan);
  if (plan.nodes) planSteps(plan);
  plan.lockedPieces = pieces;
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
 * without numbering anything. Only a line coded at release needs it: a locked
 * line's codes were made, and checked, at lock.
 */
async function codeRuleProblems(db, companyId, line, nodes, linePosition) {
  const seen = new Map();
  for (const n of nodes) {
    const shape = `${n.parentK != null ? 'child' : 'top'}:${n.pieceNo ? 'piece' : 'group'}`;
    if (!seen.has(shape)) seen.set(shape, n);
  }
  const problems = [];
  for (const n of seen.values()) {
    const g = await generate(db, companyId, 'production_piece', 'code', {
      draft: {
        itemId: n.itemId, orderId: line.order_id, lineNo: line.line_no, linePosition,
        parentCode: n.parentK != null ? 'PARENT' : null, pieceNo: n.pieceNo, pieceSeq: n.pieceSeq,
      },
    }, { consume: false }).catch(() => null);
    if (g && g.text === null && (g.missing ?? []).length) {
      problems.push(`Coding rule ${g.schemeCode} cannot number ${nameOf(n.design)}: it needs ${g.missing.join(', ')}, which ${n.pieceNo ? 'this piece has not got' : 'a grouped card has not got'}. Make that part of the rule optional, or use something every piece has.`);
    }
  }
  return problems;
}

// --- the preview: what release would write, read cheaply ------------------------------

/** What a node with no locked piece shows in a preview — it has no code, and none is made up. */
const NO_LOCKED_PIECE = '(no locked piece)';

/**
 * The plan release would lay out, every node coded as release would code it —
 * nothing written. A locked line shows its LOCKED codes, found by path key; a
 * line not locked yet shows the codes lock would write now, at the position
 * lock would give it.
 *
 * ~30 round trips on the KEPL line (6,072 pieces).
 */
async function codedPreview(db, companyId, line) {
  if (line.locked_at) {
    const pieces = await lockedPiecesOf(db, companyId, line.id);
    const plan = await buildPlan(db, companyId, line, { lockedBoth: lockedBothOf(pieces) });
    const nodes = plan.nodes ?? [];
    const unmatched = attachLockedCodes(nodes, pieces);
    for (const u of unmatched) { plan.problems.push(unmatchedProblem(u, nodes)); u.node.code = NO_LOCKED_PIECE; }
    const codes = [...new Set(nodes.map((n) => n.code).filter((c) => c !== NO_LOCKED_PIECE))];
    const coded = {
      duplicates: [], missing: [], numbered: 0, taken: await takenCodes(db, companyId, line.id, codes),
      byRule: nodes.filter((n) => n.rule).length,
    };
    return { plan, nodes, coded, linePosition: line.lock_position, locked: { at: line.locked_at, pieces: pieces.length } };
  }
  const custom = line.line_type === 'custom';
  const plan = await buildPlan(db, companyId, line, { rowsMayBeDraft: custom });
  if (custom) plan.problems.unshift(lockFirst(line));
  const nodes = plan.nodes ?? [];
  const memo = await seedPieceMemo(db, companyId, line, nodes);
  const linePosition = await linePositionOf(db, companyId, line.id);
  const coded = await codeNodes(db, companyId, line, nodes, { consume: false, memo, linePosition, takenChunk: 5000 });
  return { plan, nodes, coded, linePosition, locked: null };
}

/**
 * What release would write for a line's pieces: the tracker tree laid out as
 * release lays it out, and every piece's code — the locked one, for a locked
 * line; for a line not locked yet, the one lock would write now (nothing
 * written, no running number drawn). It does not ask whether the line may be
 * released today; releaseCheck answers that.
 *
 *   { line, problems, linePosition, nodes: [{ k, parentK, depth, code, pieceNo, pieceSeq, itemId, itemCode, bomLineId, quantity, pathKey }],
 *     duplicates, taken, missing, byRule }
 */
export async function previewReleaseCodes(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const { plan, nodes, coded, linePosition } = await codedPreview(db, companyId, line);
  return {
    line: { id: line.id, lineNo: line.line_no, orderCode: line.order_code, quantity: Number(line.quantity), locked: !!line.locked_at },
    linePosition,
    problems: plan.problems,
    nodes: nodes.map((n) => ({
      k: n.k, parentK: n.parentK, depth: n.depth, code: n.code, pieceNo: n.pieceNo, pieceSeq: n.pieceSeq,
      itemId: n.itemId, itemCode: n.design.code, bomLineId: n.bomLineId, quantity: n.quantity, pathKey: n.pathKey,
    })),
    duplicates: coded.duplicates,
    taken: coded.taken,
    missing: coded.missing.map((m) => ({ k: m.node.k, itemCode: m.node.design.code, schemeCode: m.schemeCode, missing: m.missing })),
    byRule: coded.byRule,
  };
}

/**
 * The Piece codes card — GET /order-lines/:id/release-preview. previewReleaseCodes,
 * shaped to be READ by a person before the line is released:
 *
 *   { line: { id, lineNo, orderId, orderCode, orderStatus, quantity, item: { id, code, name } },
 *     released: null | { id, releasedAt, pieces },
 *     locked: null | { at, pieces },
 *     problems, truncated,
 *     summary: { nodes, pieces, groups, codes, byRule, builtIn, duplicates, duplicatePieces, taken, missing },
 *     nodes: [{ k, parentK, depth, code, pieceNo, pieceSeq, quantity, itemId, rule, label? }],
 *     items: { [itemId]: { code, name, uom } },
 *     duplicates, taken, missing: [{ k, itemCode, schemeCode, missing }] }
 *
 *   - A node is a numbered PIECE (pieceNo set) or a GROUP of identical parts
 *     under its parent piece (no pieceNo; quantity says how many), which shares
 *     one code. A group's `label` says what it is — "<item> ×6".
 *   - Nodes are in the order release writes them: a parent before its children,
 *     siblings as the rows are shown. `k` is the node's place in that list.
 *   - Item code, name and unit come once per item in `items`, not once per node.
 *   - `rule` is the coding rule that chose the node's code; null means none
 *     applied and the built-in shape did. A node listed in `missing` has a rule
 *     with a hole — its code here is the built-in one, and lock refuses.
 *   - duplicates: codes given to more than one node; taken: codes a piece of
 *     another line already carries.
 *   - `problems` are what still stops release, as releaseCheck words them (bar
 *     the order's status). A line built from a template names the lock first.
 *
 * A line already released lays nothing out and says so: its tracker holds the
 * real pieces and their codes.
 */
export async function releasePreview(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const base = {
    line: {
      id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, orderStatus: line.order_status,
      quantity: Number(line.quantity), item: line.item_id ? { id: line.item_id, code: null, name: null } : null,
    },
    released: null,
    locked: null,
    problems: [],
    truncated: false,
    summary: { nodes: 0, pieces: 0, groups: 0, codes: 0, byRule: 0, builtIn: 0, duplicates: 0, duplicatePieces: 0, taken: 0, missing: 0 },
    nodes: [],
    items: {},
    duplicates: [],
    taken: [],
    missing: [],
  };
  const live = await liveReleaseOfLine(db, companyId, line.id);
  if (live) {
    const [[{ pieces }]] = await db.query(
      'SELECT COUNT(*) AS pieces FROM cf_production_items WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL',
      [companyId, live.id],
    );
    return { ...base, released: { id: live.id, releasedAt: live.created_at, pieces: Number(pieces) } };
  }
  if (!line.item_id) return { ...base, problems: ['The line has no item yet.'] };

  const { plan, nodes, coded, locked } = await codedPreview(db, companyId, line);
  const root = plan.tree?.root;
  const dup = new Set(coded.duplicates);
  const taken = [...new Set(coded.taken)];
  const pieces = nodes.filter((n) => n.pieceNo).length;
  const items = {};
  for (const n of nodes) {
    if (!(n.itemId in items)) items[n.itemId] = { code: n.design.code ?? null, name: n.design.name ?? null, uom: n.design.uom ?? null };
  }
  return {
    ...base,
    line: { ...base.line, item: { id: line.item_id, code: root?.code ?? null, name: root?.name ?? null } },
    locked,
    problems: plan.problems,
    truncated: !!plan.truncated,
    summary: {
      nodes: nodes.length,
      pieces,
      groups: nodes.length - pieces,
      codes: new Set(nodes.map((n) => n.code)).size,
      byRule: coded.byRule,
      builtIn: nodes.filter((n) => !n.rule).length,
      duplicates: dup.size,
      duplicatePieces: nodes.filter((n) => dup.has(n.code)).length,
      taken: taken.length,
      missing: coded.missing.length,
    },
    nodes: nodes.map((n) => {
      const out = {
        k: n.k, parentK: n.parentK, depth: n.depth, code: n.code, pieceNo: n.pieceNo, pieceSeq: n.pieceSeq,
        quantity: n.quantity, itemId: n.itemId, rule: n.rule ?? null,
      };
      if (!n.pieceNo) out.label = `${n.design.code ?? n.design.name} ×${fmt(n.quantity)}`;
      return out;
    }),
    items,
    duplicates: [...dup],
    taken,
    missing: coded.missing.map((m) => ({ k: m.node.k, itemCode: m.node.design.code, schemeCode: m.schemeCode, missing: m.missing })),
  };
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
  // A locked line's codes were made, and checked, at lock; only a line coded here needs the dry run.
  const codeTrouble = nodes.length && !line.locked_at
    ? await codeRuleProblems(db, companyId, line, nodes, await linePositionOf(db, companyId, line.id))
    : [];
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

// --- writing a release in bulk --------------------------------------------------------
//
// The KEPL line is 6,072 nodes and 16,972 steps. Written a row a statement that
// was ~23,000 round trips — 20–30 minutes at TiDB's ~49 ms, long after the
// browser gave up. Written a depth level at a time and a chunk of steps at a
// time, it is a fixed handful whatever the size. TiDB does not hand out
// AUTO_INCREMENT ids contiguously, so every new id is READ BACK by a key that is
// unique within the release — never worked out from insertId.

const ITEM_COLUMNS = ['company_id', 'release_id', 'parent_id', 'item_id', 'bom_line_id', 'piece_no', 'quantity', 'code',
  'flow_id', 'flow_revision', 'depth', 'sort_order', 'order_piece_id', 'created_by'];
const STEP_COLUMNS = ['company_id', 'production_item_id', 'flow_step_id', 'operation_id', 'sequence', 'step_name', 'quantity',
  'est_setup_minutes', 'est_work_minutes', 'est_minutes', 'work_order_id', 'created_by'];
const WRITE_CHUNK = 2000;

/**
 * The tracker tree, one depth level at a time — parents first, so a child's row
 * carries its parent's id. Each node's id is read back by its sort_order
 * (k + 1, unique within the release). One INSERT (per 2,000 rows) and one read
 * per level.
 */
async function writeItems(db, c, releaseId, plan) {
  const levels = new Map();
  for (const n of plan.nodes) {
    if (!levels.has(n.depth)) levels.set(n.depth, []);
    levels.get(n.depth).push(n);
  }
  for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
    const level = levels.get(depth);
    await insertRows(db, 'cf_production_items', ITEM_COLUMNS, level.map((n) => [
      c.companyId, releaseId, n.parentK != null ? plan.nodes[n.parentK].id : null, n.itemId, n.bomLineId, n.pieceNo, n.quantity, n.code,
      n.flowId, plan.flows.get(n.flowId)?.revision ?? null, n.depth, n.k + 1, n.lockedPieceId ?? null, c.userId,
    ]), WRITE_CHUNK);
    const [back] = await db.query(
      'SELECT id, sort_order FROM cf_production_items WHERE company_id = ? AND release_id = ? AND depth = ? AND deleted_at IS NULL',
      [c.companyId, releaseId, depth],
    );
    const idOf = new Map(back.map((r) => [Number(r.sort_order), r.id]));
    for (const n of level) {
      n.id = idOf.get(n.k + 1);
      if (!n.id) throw new Error(`cf_erp: production item ${n.k + 1} of release ${releaseId} vanished between insert and read-back.`);
    }
  }
}

/**
 * Every step, in plan order, 2,000 rows a statement; the ids read back in one
 * query by (production item, flow step) — a piece runs each step of its flow
 * once, so the pair is unique within the release. Each step carries its
 * estimated minutes (copied, so the tracker never follows a later change) and
 * the contractor work order its (piece, operation) cell sits on.
 */
async function writeSteps(db, c, releaseId, plan, estimate, owners) {
  if (!plan.steps.length) return;
  const keyOf = (itemId, flowStepId) => `${itemId}:${flowStepId}`;
  const rows = plan.steps.map((s) => {
    const node = plan.nodes[s.nodeK];
    const t = estimate(node.bomLineId, node.itemId, s.operationId);
    const work = t?.work ?? null;
    const setup = work != null ? t.setup ?? 0 : t?.setup ?? null;
    const total = work != null ? Number(((setup ?? 0) + work * Number(s.quantity)).toFixed(3)) : null;
    const workOrderId = node.lockedPieceId != null ? owners.get(`${node.lockedPieceId}:${s.operationId}`) ?? null : null;
    return [c.companyId, node.id, s.flowStepId, s.operationId, s.sequence, s.stepName, s.quantity, setup, work, total, workOrderId, c.userId];
  });
  const keys = new Set(plan.steps.map((s) => keyOf(plan.nodes[s.nodeK].id, s.flowStepId)));
  if (keys.size !== plan.steps.length) throw new Error(`cf_erp: release ${releaseId} would run one flow step twice on one piece — the steps cannot be told apart.`);
  await insertRows(db, 'cf_production_steps', STEP_COLUMNS, rows, WRITE_CHUNK);
  const [back] = await db.query(
    `SELECT s.id, s.production_item_id, s.flow_step_id FROM cf_production_steps s
       JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.company_id = ? AND pi.release_id = ? AND pi.deleted_at IS NULL AND s.company_id = ? AND s.deleted_at IS NULL`,
    [c.companyId, releaseId, c.companyId],
  );
  const idOf = new Map(back.map((r) => [keyOf(r.production_item_id, r.flow_step_id), r.id]));
  for (const s of plan.steps) {
    s.id = idOf.get(keyOf(plan.nodes[s.nodeK].id, s.flowStepId));
    if (!s.id) throw new Error(`cf_erp: a production step of release ${releaseId} vanished between insert and read-back.`);
  }
}

/** Releases a whole sales line (E1): writes the tracker tree, its steps, dependencies and material requirements. */
export async function releaseLine(db, c, lineId, input = {}) {
  const line = await requireLine(db, c.companyId, lineId, { lock: true });
  await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, line.order_id]);
  const plan = await planFor(db, c.companyId, line);
  if (plan.problems.length) throw invalid('NOT_READY', `Line ${line.line_no} of ${line.order_code} cannot be released yet.`, { problems: plan.problems });
  // A line built from a template was brought up to date and frozen when it was
  // LOCKED (lockService), so there is nothing to refresh here.
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
  // (user, 2026-09-23). A locked line's codes are the ones lock wrote — planFor
  // attached them by path key, and refused a node the lock never rolled out —
  // so here they are only checked against every OTHER line's pieces. A standard
  // line is coded now, by the same coder lock uses.
  if (line.locked_at) {
    const taken = await takenCodes(db, c.companyId, line.id, [...new Set(plan.nodes.map((n) => n.code))]);
    if (taken.length) {
      throw invalid('CODE_CLASH', `${taken[0]} is already the code of a piece of another line — line ${line.line_no}'s pieces were locked with it. Two lines carry one code; the other line has to change.`, { problems: taken.map((t) => `${t} is taken`) });
    }
  } else {
    const memo = await seedPieceMemo(db, c.companyId, line, plan.nodes);
    const linePosition = await linePositionOf(db, c.companyId, line.id);
    const coded = await codeNodes(db, c.companyId, line, plan.nodes, { consume: true, memo, linePosition, takenChunk: 1000 });
    if (coded.duplicates.length) {
      throw invalid('CODE_CLASH', `The coding rule gives more than one piece the code ${coded.duplicates[0]}. Add something that tells them apart — the piece number, or the piece it is part of.`);
    }
    if (coded.taken.length) {
      throw invalid('CODE_CLASH', `${coded.taken[0]} is already the code of a piece on another release. Add something to the rule that tells orders apart — the order number, or a running number.`);
    }
  }
  // The time each step is expected to take — the Times tab's numbers (a typed
  // override, else the formula on the machine type's chart), copied here so the
  // tracker never follows a later change — and the contractor work order its
  // (piece, operation) cell sits on (init.sql §30). A fixed number of reads.
  const estimate = await estimatorForLine(db, c.companyId, line.id,
    plan.steps.map((s) => ({ bomLineId: plan.nodes[s.nodeK].bomLineId, itemId: plan.nodes[s.nodeK].itemId, operationId: s.operationId })));
  const owners = line.locked_at ? await cellOwnersOfLine(db, c.companyId, line.id) : new Map();
  await writeItems(db, c, releaseId, plan);
  await writeSteps(db, c, releaseId, plan, estimate, owners);
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
    `SELECT s.*, o.code AS op_code, o.name AS op_name, mc.code AS machine_code, mc.name AS machine_name,
            wo.code AS wo_code, wo.status AS wo_status, wo.contractor_id AS wo_contractor_id, wp.name AS wo_contractor_name
       FROM cf_production_steps s
       JOIN cf_operations o ON o.id = s.operation_id
       LEFT JOIN cf_machines mc ON mc.id = s.machine_id
       LEFT JOIN cf_work_orders wo ON wo.id = s.work_order_id
       LEFT JOIN cf_parties wp ON wp.id = wo.contractor_id
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
  await nameLots(db, companyId, releases, items, reqs);
  return { releases, items, steps, deps, reqs, reservations, free };
}

/**
 * Which plate lot each of the nest's requirements is (q._lot = { id, lotNo }) —
 * release's own rule (lotGates) laid over the line's lots again, then matched
 * in lot-id order within each (gated piece, plate). Exact, because a released
 * line's nest cannot change (see "raw plate from the nest"). One query, and
 * only when a release has such requirements.
 */
async function nameLots(db, companyId, releases, items, reqs) {
  const isLot = (q) => q.bom_line_id == null && q.production_item_id != null;
  const lotReqs = reqs.filter(isLot);
  if (!lotReqs.length) return;
  const byRelease = groupBy(lotReqs, 'release_id');
  const lotsOf = await lotsOfLines(db, companyId, releases.filter((r) => byRelease.has(r.id)).map((r) => r.order_line_id));
  const itemsOf = groupBy(items, 'release_id');
  for (const r of releases) {
    const mine = byRelease.get(r.id);
    const lots = lotsOf.get(r.order_line_id);
    if (!mine || !lots) continue;
    const first = new Map();                       // cut plate item -> its first production item
    for (const it of itemsOf.get(r.id) ?? []) {
      const f = first.get(it.item_id);
      if (!f || it.sort_order < f.order) first.set(it.item_id, { key: it.id, order: it.sort_order });
    }
    const queue = new Map();                       // "piece:plate" -> lots in id order
    for (const { lot, gate } of lotGates(lots, (cp) => first.get(cp) ?? null).gates) {
      if (gate == null) continue;
      const k = `${gate}:${lot.plateItemId}`;
      if (!queue.has(k)) queue.set(k, []);
      queue.get(k).push(lot);
    }
    for (const q of [...mine].sort((a, b) => a.id - b.id)) {
      const lot = queue.get(`${q.production_item_id}:${q.item_id}`)?.shift();
      if (lot) q._lot = { id: lot.id, lotNo: lot.lotNo };
    }
  }
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
  // A row has no code of its own any more (2026-09-26), so a group names its item.
  const label = (it) => (it.piece_no ? it.code : `${it.item_code ?? it.item_name} ×${fmt(it.quantity)}${it.parent_id ? ` for ${label(itemById.get(it.parent_id))}` : ''}`);
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
          : `${label(itemById.get(t.production_item_id))} to ${verb} ${t._opLabel ?? t.op_name} (${t.op_code})${d.origin === 'nest' ? ', which holds the plate they are both cut from' : ''}`;
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
      blockers.push({ kind: 'material', text: `${q._lot ? `${q._lot.lotNo} · ` : ''}${q.item_code}: ${fmt(q._short)} ${q.uom} still to reserve of ${fmt(q.quantity)}${held}${none}.` });
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
  // A step on a contractor work order (init.sql §30): the tracker shows it in place of the machine.
  workOrder: s.work_order_id ? { id: s.work_order_id, code: s.wo_code, status: s.wo_status, contractorId: s.wo_contractor_id, contractorName: s.wo_contractor_name } : null,
  workOrderId: s.work_order_id ?? null,
  workOrderCode: s.work_order_id ? s.wo_code : null,
  contractorName: s.work_order_id ? s.wo_contractor_name : null,
  estSetupMinutes: s.est_setup_minutes == null ? null : Number(s.est_setup_minutes),
  estWorkMinutes: s.est_work_minutes == null ? null : Number(s.est_work_minutes),
  estMinutes: s.est_minutes == null ? null : Number(s.est_minutes),
  startedAt: s.started_at,
  finishedAt: s.finished_at,
  waits: s._waits,
  blockers: s._blockers,
  requirementIds: s._requirementIds,
});

function shapeRequirement(q, data, ev) {
  // By id through a map built once per read — a find per requirement was ~50M comparisons on the KEPL line.
  if (!data.stepById) data.stepById = new Map(data.steps.map((s) => [s.id, s]));
  const step = q.step_id ? data.stepById.get(q.step_id) ?? null : null;
  const piece = q.production_item_id ? ev.itemById.get(q.production_item_id) : null;
  return {
    id: q.id,
    item: { id: q.item_id, code: q.item_code, name: q.item_name, uom: q.uom, trackedBy: q.tracked_by },
    // The nest's whole plate (see "raw plate from the nest"); null for any other requirement.
    lot: q._lot ?? null,
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

export async function openReleaseIds(db, companyId, { includeClosed = false } = {}) {
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
  // The Tracker's one "In-house only" filter: steps on no contractor work order.
  if (String(q.inHouse) === '1') rows = rows.filter((s) => !s.workOrder);
  if (!blank(q.workOrderId)) rows = rows.filter((s) => s.workOrder?.id === Number(q.workOrderId));
  if (!blank(q.search)) {
    const term = String(q.search).trim().toLowerCase();
    rows = rows.filter((s) => contains(term, s.piece.label, s.order.code, s.operation.code, s.operation.name, s.machine?.code, s.workOrder?.code, s.workOrder?.contractorName));
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
    rows = rows.filter((m) => contains(term, m.item.code, m.item.name, m.order.code, m.piece?.label, m.lot?.lotNo));
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

/**
 * The tracker's raw rows with every step's status worked out — for a reader
 * that needs readiness without the shaped tree (the machine log's queue,
 * floorService). Same reads and the same evaluate() as getRelease, so a step
 * is never "ready" in one screen and "waiting" in another. Each step row gains
 * _status, _blockers (plain sentences), _opLabel; each item _label. null when
 * no release matches.
 */
export async function evaluatedTracker(db, companyId, releaseIds) {
  const data = await loadTracker(db, companyId, releaseIds);
  if (!data) return null;
  const ev = evaluate(data);
  return { ...data, ...ev };
}

// --- the shop floor -----------------------------------------------------------------

/**
 * When a floor event happened, as epoch SECONDS, or null for "now" (the old
 * behaviour, NOW() in SQL). Given as a Date, epoch milliseconds, or an ISO
 * date-time that carries its zone (Z or ±hh:mm) — a bare wall-clock time is
 * ambiguous here; the machine log converts the plant clock before calling.
 * Not in the future (a minute of clock skew allowed), not before the release
 * was made (release_epoch, read by requireStep with UNIX_TIMESTAMP so the
 * comparison is the same on every host).
 */
export function readAt(raw, releaseEpoch) {
  if (raw == null || raw === '') return null;
  let ms;
  if (raw instanceof Date) ms = raw.getTime();
  else if (typeof raw === 'number') ms = raw;
  else {
    const s = String(raw).trim();
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) throw invalid('INVALID', 'The time needs its zone (for example 2026-09-29T10:30:00+05:30).');
    ms = Date.parse(s);
  }
  if (!Number.isFinite(ms)) throw invalid('INVALID', 'That is not a date and time.');
  const sec = Math.floor(ms / 1000);
  if (sec > Math.floor(Date.now() / 1000) + 60) throw invalid('IN_FUTURE', 'That time is in the future.');
  if (releaseEpoch != null && sec < Number(releaseEpoch)) throw invalid('BEFORE_RELEASE', 'That time is before the job was released to production.');
  return sec;
}

async function requireStep(db, companyId, stepId) {
  const [[s]] = await db.query(
    `SELECT s.*, pi.release_id, r.order_id, UNIX_TIMESTAMP(r.created_at) AS release_epoch, o.code AS order_code, o.status AS order_status, op.code AS op_code, op.name AS op_name
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

/**
 * One history row. `at` (epoch seconds) = when it happened, NULL = when it was
 * written (created_at) — the tracker's own calls leave it NULL as before. The
 * machine log also stamps who (operator), where from (source), its session,
 * and whether the step was ready (before_ready) — init.sql §32.
 */
async function logEvent(db, c, stepId, event, {
  good = 0, scrap = 0, machineId = null, note = null, at = null, operatorId = null, source = null, sessionId = null, beforeReady = false,
} = {}) {
  await db.query(
    `INSERT INTO cf_step_events (company_id, step_id, event, qty_good, qty_scrap, machine_id, note, created_by, at, operator_id, source, session_id, before_ready)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${at == null ? 'NULL' : 'FROM_UNIXTIME(?)'}, ?, ?, ?, ?)`,
    [c.companyId, stepId, event, good, scrap, machineId, note, c.userId, ...(at == null ? [] : [at]), operatorId, source, sessionId, beforeReady ? 1 : 0],
  );
}

/**
 * Starts a ready step. input: { machineId?, note?, at?, allowNotReady? } — a
 * machine must be one its operation's rules let do it. `at` back-dates the
 * start (readAt: not in the future, not before the release). allowNotReady is
 * the machine log's exception (user, 2026-09-30: readiness is not a gate for
 * logging ACTUALS — a worker who really did the job records it): a step still
 * waiting starts anyway and its start event is flagged before_ready. A step in
 * progress, done or on hold is refused either way.
 */
export async function startStep(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  const at = readAt(input.at, step.release_epoch);
  const { s } = await evaluatedStep(db, c.companyId, step);
  const beforeReady = s.status === 'not_ready' && !!input.allowNotReady;
  if (s.status !== 'ready' && !beforeReady) {
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
  await db.query(
    `UPDATE cf_production_steps SET state = 'in_progress', started_at = ${at == null ? 'NOW()' : 'FROM_UNIXTIME(?)'}, machine_id = ? WHERE company_id = ? AND id = ?`,
    [...(at == null ? [] : [at]), machineId, c.companyId, step.id],
  );
  await logEvent(db, c, step.id, 'start', { machineId, note: blank(input.note) ? null : String(input.note).slice(0, 500), at, beforeReady });
  return getRelease(db, c.companyId, step.release_id);
}

/**
 * Records work on a started step. input: { good?, scrap?, note? } — quantities
 * are added to what is recorded; the step is done when the good ones reach its
 * quantity. Scrapped pieces do not count: they are made again. `at` (readAt)
 * back-dates the event, and the step's finished_at when this completes it.
 */
export async function recordProgress(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  const at = readAt(input.at, step.release_epoch);
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
    `UPDATE cf_production_steps SET qty_good = ?, qty_scrap = qty_scrap + ?, state = ?, finished_at = ${!done ? 'NULL' : at == null ? 'NOW()' : 'FROM_UNIXTIME(?)'} WHERE company_id = ? AND id = ?`,
    [newGood, round6(scrap), done ? 'done' : 'in_progress', ...(done && at != null ? [at] : []), c.companyId, step.id],
  );
  await logEvent(db, c, step.id, 'progress', { good: round6(good), scrap: round6(scrap), note: blank(input.note) ? null : String(input.note).slice(0, 500), at });
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
export async function stockFinished(db, c, productionItemId) {
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
    `SELECT e.*, m.code AS machine_code, u.name AS user_name, op.name AS operator_name FROM cf_step_events e
       LEFT JOIN cf_machines m ON m.id = e.machine_id LEFT JOIN users u ON u.id = e.created_by
       LEFT JOIN cf_operators op ON op.id = e.operator_id
      WHERE e.company_id = ? AND e.step_id = ? ORDER BY e.id`,
    [companyId, Number(stepId)],
  );
  return rows.map((e) => ({
    id: e.id, event: e.event, good: Number(e.qty_good), scrap: Number(e.qty_scrap),
    machine: e.machine_id ? { id: e.machine_id, code: e.machine_code } : null, note: e.note,
    // When it happened (a back-dated entry says so); recordedAt is when it was typed in.
    at: e.at ?? e.created_at, recordedAt: e.created_at, by: e.user_name ?? null,
    operator: e.operator_id ? { id: e.operator_id, name: e.operator_name } : null,
    source: e.source ?? 'tracker', beforeReady: !!Number(e.before_ready ?? 0),
  }));
}

// --- material: reservations and issues ------------------------------------------------

/** A requirement with what reserving and issuing it need to know — the same columns and row locks for one requirement or a whole release. */
const REQUIREMENT_SQL = `SELECT q.*, r.order_id, o.code AS order_code, o.status AS order_status, l.line_no,
            m.code AS item_code, m.name AS item_name, i.uom, i.tracked_by
       FROM cf_material_requirements q
       JOIN cf_production_releases r ON r.id = q.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       JOIN cf_master_records m ON m.id = q.item_id
       JOIN cf_item_details i ON i.master_id = q.item_id`;

async function requireRequirement(db, companyId, reqId) {
  const [[q]] = await db.query(
    `${REQUIREMENT_SQL}
      WHERE q.company_id = ? AND q.id = ? AND q.deleted_at IS NULL FOR UPDATE`,
    [companyId, Number(reqId)],
  );
  if (!q) throw notFound('Requirement');
  assertOrderOpen(q);
  return q;
}

const ACTIVE_RESERVATIONS_SQL = `SELECT v.*, b.code AS batch_code, b.status AS batch_status FROM cf_stock_reservations v
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id`;

async function activeReservations(db, companyId, reqId) {
  const [rows] = await db.query(
    `${ACTIVE_RESERVATIONS_SQL}
      WHERE v.company_id = ? AND v.requirement_id = ? AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY v.id FOR UPDATE`,
    [companyId, reqId],
  );
  return rows;
}

/** One item's free stock is claimed one transaction at a time (stock movements take the same lock). */
export async function lockItemStock(db, companyId, itemId) {
  await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id = ? FOR UPDATE', [companyId, itemId]);
}

/*
 * Reserving is two pure halves, shared by reserveOne (one requirement) and
 * reserveRelease (all of them), so both follow exactly one rule.
 */

/** How much more a requirement needs, given what it has reserved: { done } (the answer — nothing more is needed) or { want }. */
function wanted(q, have, input = {}) {
  const remaining = round6(Number(q.quantity) - Number(q.issued) - have);
  if (remaining <= EPS) return { done: { reserved: 0, short: 0, message: `${q.item_code} is already covered here — ${fmt(q.issued)} issued, ${fmt(have)} reserved.` } };
  let want = remaining;
  if (!blank(input.quantity)) {
    const n = Number(input.quantity);
    if (!Number.isFinite(n) || n <= 0) throw invalid('INVALID', 'Quantity must be more than zero.');
    if (n > remaining + EPS) throw invalid('TOO_MANY', `Only ${fmt(remaining)} ${q.uom} more ${remaining === 1 ? 'is' : 'are'} needed here.`);
    want = round6(n);
  }
  return { want };
}

/** What to claim of `want` from an item's availability() entry, oldest batch first: { rows: [{ batchId, quantity }], result }. */
function takeFrom(q, want, av, input = {}) {
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
  const reserved = sum(rows);
  return {
    rows,
    result: {
      reserved, short: want,
      message: reserved > EPS ? null : `No free stock of ${q.item_code} — ${fmt(av.available)} ${q.uom} usable on hand, ${fmt(av.reserved)} already reserved.`,
    },
  };
}

// A material claim: requirement_id set, order_line_id left NULL (see stockFinished for the other kind).
const RESERVATION_COLUMNS = ['company_id', 'requirement_id', 'item_id', 'batch_id', 'quantity', 'created_by'];
const reservationRow = (c, q, r) => [c.companyId, q.id, q.item_id, r.batchId, r.quantity, c.userId];

/** Reserves what is free for one requirement, oldest batch first. input: { quantity?, batchId? } */
async function reserveOne(db, c, q, input = {}) {
  const have = sum(await activeReservations(db, c.companyId, q.id));
  const w = wanted(q, have, input);
  if (w.done) return w.done;
  const av = (await availability(db, c.companyId, [q.item_id])).get(q.item_id);
  const { rows, result } = takeFrom(q, w.want, av, input);
  await insertRows(db, 'cf_stock_reservations', RESERVATION_COLUMNS, rows.map((r) => reservationRow(c, q, r)));
  return result;
}

export async function reserveRequirement(db, c, reqId, input = {}) {
  const q = await requireRequirement(db, c.companyId, reqId);
  await lockItemStock(db, c.companyId, q.item_id);
  const out = await reserveOne(db, c, q, input);
  if (out.reserved <= EPS) throw invalid('NOT_FREE', out.message);
  return getRelease(db, c.companyId, q.release_id);
}

/**
 * availability() for many items, read once and kept current in memory as claims
 * are made — what reading it again after every claim would return. Every entry
 * is worked out by the same shapeAvailability, from that item's rows.
 */
function freeStock(bal, res) {
  const balOf = groupBy(bal, 'item_id');
  const resOf = groupBy(res.map((r) => ({ ...r })), 'item_id');
  const cache = new Map();
  return {
    of(itemId) {
      if (!cache.has(itemId)) cache.set(itemId, shapeAvailability([itemId], balOf.get(itemId) ?? [], resOf.get(itemId) ?? []).get(itemId));
      return cache.get(itemId);
    },
    claim(itemId, batchId, quantity) {
      if (!resOf.has(itemId)) resOf.set(itemId, []);
      const rows = resOf.get(itemId);
      const row = rows.find((r) => (r.batch_id ?? 0) === (batchId ?? 0));
      // What the database's SUM would say: DECIMAL(18,6), so exact at six places.
      if (row) row.qty = round6(Number(row.qty) + quantity);
      else rows.push({ item_id: itemId, batch_id: batchId, qty: quantity });
      cache.delete(itemId);
    },
  };
}

/**
 * Reserves whatever is free for every requirement of a release; says what is still short.
 *
 * In requirement-id order with the rules of reserving one at a time — each claim
 * changes what is free for the next requirement of the same item — but every
 * read is made once: the requirements with their row locks, the items' stock
 * locks (in item-id order, so two of these cannot deadlock each other), the
 * reservations already held, and the items' free stock, which is then kept
 * current in memory (freeStock). The new reservations go in with insertRows.
 * ~17 round trips for the KEPL line's 2,952 requirements, getRelease included
 * (was ~16,000). scripts/cf_kepl/reserve_batch_test.mjs holds the golden snapshot.
 */
export async function reserveRelease(db, c, releaseId) {
  const rel = await requireRelease(db, c.companyId, releaseId, { lock: true });
  assertOrderOpen(rel);
  const [ids] = await db.query('SELECT id FROM cf_material_requirements WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL ORDER BY id', [c.companyId, releaseId]);
  let reserved = 0;
  const short = new Map();
  if (ids.length) {
    const [found] = await db.query(
      `${REQUIREMENT_SQL}
      WHERE q.company_id = ? AND q.id IN (?) AND q.deleted_at IS NULL ORDER BY q.id FOR UPDATE`,
      [c.companyId, ids.map((r) => r.id)],
    );
    const byId = new Map(found.map((q) => [q.id, q]));
    // One at a time, a requirement the join cannot find stopped the loop with notFound — after reserving the ones before it.
    const missingAt = ids.findIndex((r) => !byId.has(r.id));
    const reqs = (missingAt < 0 ? ids : ids.slice(0, missingAt)).map((r) => byId.get(r.id));
    reqs.forEach(assertOrderOpen);
    if (reqs.length) {
      const itemIds = [...new Set(reqs.map((q) => q.item_id))].sort((a, b) => a - b);
      await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?) ORDER BY master_id FOR UPDATE', [c.companyId, itemIds]);
      const [held] = await db.query(
        `${ACTIVE_RESERVATIONS_SQL}
      WHERE v.company_id = ? AND v.requirement_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY v.id FOR UPDATE`,
        [c.companyId, reqs.map((q) => q.id)],
      );
      const heldOf = groupBy(held, 'requirement_id');
      const { bal, res } = await availabilityRows(db, c.companyId, itemIds);
      const stock = freeStock(bal, res);
      const writes = [];
      for (const q of reqs) {
        const w = wanted(q, sum(heldOf.get(q.id) ?? []));
        let out = w.done;
        if (!out) {
          const took = takeFrom(q, w.want, stock.of(q.item_id));
          for (const r of took.rows) {
            stock.claim(q.item_id, r.batchId, r.quantity);
            writes.push(reservationRow(c, q, r));
          }
          out = took.result;
        }
        if (out.reserved > EPS) reserved += 1;
        if (out.short > EPS) short.set(q.item_id, { code: q.item_code, uom: q.uom, short: round6((short.get(q.item_id)?.short ?? 0) + out.short) });
      }
      await insertRows(db, 'cf_stock_reservations', RESERVATION_COLUMNS, writes, 2000);
    }
    if (missingAt >= 0) throw notFound('Requirement');
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
