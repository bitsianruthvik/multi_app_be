/**
 * trackerTreeService.js — the Tracker as a PROGRESS TREE (Production › Tracker,
 * user 2026-09-30: "Tracker is the tree with elaborated code … to the right give
 * an update of what all operations done and how much not done. At higher
 * levels, give a sense of how much completed").
 *
 *   order › line › the frozen piece codes (SO-…-SPAN-01-1 › G2 › 3 › TF1)
 *
 * Every node carries its OWN operations (one entry per production step, in flow
 * order) and, over its whole subtree, a completion 0–1, the number of blocked
 * pieces under it and the first blocked reason.
 *
 * WHAT THE DATA CAN SAY AT PIECE LEVEL. The tree is release's tree
 * (cf_production_items, each carrying the code lock froze on cf_order_pieces):
 * one node per physical piece for anything with made parts of its own, ONE
 * grouped node carrying the count for identical leaf parts. A step belongs to
 * one node and carries that node's quantity, so
 *   - a piece node (quantity 1) is exact: its step is done or not, per piece
 *     (basis 'piece'). The KEPL line is all piece nodes — every part has its
 *     cut plate under it.
 *   - a grouped node (quantity n > 1) knows only "k of n done" for the group —
 *     the floor records a count on the step, never which piece numbers
 *     (cf_work_sessions and cf_step_events name the step, not a piece code) —
 *     so it says basis 'row'.
 *
 * STATES of one operation entry: done · running (in progress with a live
 * session on a machine, or started from the tracker, which keeps no sessions)
 * · partial (some done, or started and paused) · blocked (on hold, or nothing
 * left to wait for but material not reserved) · todo (waiting for earlier work,
 * or ready — `ready: true`). Waiting for earlier work is the normal state of a
 * step, not a block.
 *
 * COMPLETION of a subtree: the operations done weighted by their planned
 * minutes (est_minutes, the step's total) when EVERY step under it has one,
 * else by count (one per piece per operation). `weight` says which.
 *
 * COST. The same reads and the same evaluate() as the tracker (so a step is
 * never "ready" here and "waiting" there): one read of the released lines, the
 * tracker's reads, and at most two small ones (live sessions of the steps in
 * progress, the note of the steps on hold). The tree is built in memory and
 * then PRUNED — a big line returns its top levels with child counts, and
 * /tracker/tree/children fills a branch in when it is opened.
 */
import { invalid, notFound } from '../lib/errors.js';
import { evaluatedTracker, shapeStep } from './releaseService.js';

const round6 = (n) => Number(Number(n).toFixed(6));
const fmt = (n) => String(round6(n));
const blank = (v) => v == null || String(v).trim() === '';
const short = (text, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Levels returned by default: order, line, the top piece and the level under it
 * (KEPL: 2 spans, 110 girders / diaphragms / splice sets — the next level is 1,536
 * nodes, so it comes a branch at a time).
 */
export const DEFAULT_DEPTH = 4;
/** The most nodes a filtered read (search, only blocked) returns. */
export const FILTER_CAP = 3000;
/** The most matches a search returns. */
export const SEARCH_CAP = 300;

export const BASIS_NOTE = {
  piece: 'Counted for this piece.',
  row: 'Counted for the group: the floor records how many of the group are done, not which ones.',
};

// --- reading -----------------------------------------------------------------------

/** Every released line of the company (for the picker), and the release ids a read covers. */
async function releasedLines(db, companyId) {
  const [rows] = await db.query(
    `SELECT r.id AS release_id, r.order_id, r.order_line_id, r.quantity, o.code AS order_code, o.title AS order_title, o.status AS order_status,
            p.name AS customer_name, l.line_no, m.name AS item_name
       FROM cf_production_releases r
       JOIN cf_sales_orders o ON o.id = r.order_id AND o.deleted_at IS NULL
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       JOIN cf_master_records m ON m.id = r.item_id
       LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY o.code, l.line_no`,
    [companyId],
  );
  return rows;
}

function pickerOf(lines) {
  const orders = new Map();
  for (const r of lines) {
    if (!orders.has(r.order_id)) {
      orders.set(r.order_id, { id: r.order_id, code: r.order_code, title: r.order_title ?? null, customer: r.customer_name ?? null, status: r.order_status, open: r.order_status === 'confirmed', lines: [] });
    }
    orders.get(r.order_id).lines.push({ id: r.order_line_id, lineNo: r.line_no, releaseId: r.release_id, itemName: r.item_name });
  }
  return [...orders.values()];
}

/** The live sessions of the steps in progress, and which of them ever had one. Skipped when nothing is in progress. */
async function sessionsOf(db, companyId, stepIds) {
  const open = new Set();
  const any = new Set();
  if (!stepIds.length) return { open, any };
  const [rows] = await db.query(
    `SELECT step_id, MAX(ended_at IS NULL) AS open_now FROM cf_work_sessions
      WHERE company_id = ? AND step_id IN (?) AND deleted_at IS NULL GROUP BY step_id`,
    [companyId, stepIds],
  );
  for (const r of rows) { any.add(r.step_id); if (Number(r.open_now)) open.add(r.step_id); }
  return { open, any };
}

/** The latest hold note of each step on hold. Skipped when nothing is on hold. */
async function holdNotesOf(db, companyId, stepIds) {
  const notes = new Map();
  if (!stepIds.length) return notes;
  const [rows] = await db.query(
    "SELECT step_id, note FROM cf_step_events WHERE company_id = ? AND step_id IN (?) AND event = 'hold' ORDER BY id DESC",
    [companyId, stepIds],
  );
  for (const r of rows) if (!notes.has(r.step_id)) notes.set(r.step_id, r.note ?? '');
  return notes;
}

// --- the tree ------------------------------------------------------------------------

/** One step as an operation entry on its node. */
function operationOf(s, ctx) {
  const total = round6(Number(s.quantity));
  const done = s._status === 'done' ? total : round6(Math.min(Number(s.qty_good) || 0, total));
  let state;
  let reason = null;
  if (s._status === 'done') state = 'done';
  else if (s._status === 'on_hold') {
    state = 'blocked';
    const note = ctx.holds.get(s.id);
    reason = short(`On hold${note ? `: ${note}` : ''}`);
  } else if (s._status === 'not_ready' && s._blockers.length && s._blockers.every((b) => b.kind === 'material')) {
    // Nothing left to wait for but its material: it would be ready now.
    state = 'blocked';
    const q = (ctx.reqsByStep.get(s.id) ?? []).find((r) => !r._covered);
    reason = short(q
      ? `Needs ${q._lot ? `${q._lot.lotNo} · ` : ''}${q.item_code} — ${fmt(q._short)} ${q.uom} to reserve`
      : 'Material not reserved');
  } else if (s._status === 'in_progress') {
    state = ctx.sessions.open.has(s.id) || !ctx.sessions.any.has(s.id) ? 'running' : 'partial';
  } else state = done > 0 ? 'partial' : 'todo';
  // `name` only when it is not the operation's own (a pass, a named step) — the
  // names travel once per read in `operations`; a diaphragm has eleven steps.
  const op = { stepId: s.id, operationId: s.operation_id, done, total, state };
  const label = s._opLabel ?? s.op_name;
  if (label !== s.op_name) op.name = label;
  if (state === 'todo' && s._status === 'ready') op.ready = true;
  if (reason) op.reason = reason;
  return op;
}

const emptyAgg = () => ({ cntT: 0, cntD: 0, minT: 0, minD: 0, minKnown: true, steps: 0, stepsDone: 0, pieces: 0, blocked: 0, running: 0, first: null, byOp: new Map() });

function addOp(agg, s, op) {
  agg.steps += 1;
  if (op.state === 'done') agg.stepsDone += 1;
  if (op.state === 'running') agg.running += 1;
  agg.cntT += op.total;
  agg.cntD += op.done;
  const est = s.est_minutes == null ? null : Number(s.est_minutes);
  if (est == null) agg.minKnown = false;
  else { agg.minT += est; agg.minD += op.total > 0 ? est * (op.done / op.total) : 0; }
  const b = agg.byOp.get(s.operation_id) ?? { operationId: s.operation_id, done: 0, total: 0 };
  b.done = round6(b.done + op.done);
  b.total = round6(b.total + op.total);
  agg.byOp.set(s.operation_id, b);
}

function mergeAgg(into, from) {
  into.cntT += from.cntT; into.cntD += from.cntD; into.minT += from.minT; into.minD += from.minD;
  into.minKnown = into.minKnown && from.minKnown;
  into.steps += from.steps; into.stepsDone += from.stepsDone; into.pieces += from.pieces;
  into.blocked += from.blocked; into.running += from.running;
  if (!into.first && from.first) into.first = from.first;
  for (const [k, v] of from.byOp) {
    const b = into.byOp.get(k) ?? { operationId: v.operationId, done: 0, total: 0 };
    b.done = round6(b.done + v.done);
    b.total = round6(b.total + v.total);
    into.byOp.set(k, b);
  }
}

function completionOf(agg) {
  if (!agg.steps) return { completion: null, weight: null };
  if (agg.minKnown && agg.minT > 0) return { completion: Number((agg.minD / agg.minT).toFixed(4)), weight: 'minutes' };
  return { completion: agg.cntT > 0 ? Number((agg.cntD / agg.cntT).toFixed(4)) : null, weight: 'count' };
}

/**
 * The whole tree of some releases, in memory, in display order (depth-first).
 * Returns { nodes, byId, childrenOf, data }. Every node is shaped; pruning is
 * the caller's.
 */
export async function buildTree(db, companyId, lines) {
  const releaseIds = lines.map((r) => r.release_id);
  const data = releaseIds.length ? await evaluatedTracker(db, companyId, releaseIds) : null;
  const nodes = [];
  const byId = new Map();
  const childrenOf = new Map();
  const root = emptyAgg();
  if (!data) return { nodes, byId, childrenOf, data, root, operations: {} };

  const inProgress = data.steps.filter((s) => s._status === 'in_progress').map((s) => s.id);
  const onHold = data.steps.filter((s) => s._status === 'on_hold').map((s) => s.id);
  const sessions = await sessionsOf(db, companyId, inProgress);
  const holds = await holdNotesOf(db, companyId, onHold);
  const reqsByStep = new Map();
  for (const q of data.reqs) {
    if (!q.step_id) continue;
    if (!reqsByStep.has(q.step_id)) reqsByStep.set(q.step_id, []);
    reqsByStep.get(q.step_id).push(q);
  }
  const ctx = { sessions, holds, reqsByStep };

  // Raw nodes: order › line › pieces.
  const raw = new Map();       // id -> { node fields, agg, kids: [] }
  const push = (n) => { raw.set(n.id, n); if (n.parentId) raw.get(n.parentId).kids.push(n.id); };
  const released = new Map(data.releases.map((r) => [r.id, r]));
  for (const l of lines) {
    const r = released.get(l.release_id);
    if (!r) continue;
    const oid = `o${l.order_id}`;
    if (!raw.has(oid)) {
      push({ id: oid, parentId: null, kind: 'order', code: l.order_code, name: l.order_title || l.customer_name || null, qty: null, orderId: l.order_id, kids: [], agg: emptyAgg(), ops: [] });
    }
    push({ id: `l${l.order_line_id}`, parentId: oid, kind: 'line', code: `Line ${l.line_no}`, name: l.item_name, qty: round6(Number(l.quantity)), orderId: l.order_id, lineId: l.order_line_id, releaseId: l.release_id, kids: [], agg: emptyAgg(), ops: [] });
  }
  const lineOfRelease = new Map(lines.map((l) => [l.release_id, l]));
  // Items come in (release, sort_order) — release writes them depth-first, so a parent precedes its children.
  for (const it of data.items) {
    const l = lineOfRelease.get(it.release_id);
    if (!l) continue;
    const quantity = round6(Number(it.quantity));
    const n = {
      id: `p${it.id}`, parentId: it.parent_id ? `p${it.parent_id}` : `l${l.order_line_id}`, kind: 'piece',
      code: it.code ?? it._label, name: it.item_name, qty: quantity, pieceNo: it.piece_no ?? null,
      basis: quantity > 1 ? 'row' : 'piece', itemId: it.item_id, lineId: l.order_line_id, releaseId: it.release_id,
      kids: [], agg: emptyAgg(),
      ops: (data.stepsOf.get(it.id) ?? []).map((s) => ({ s, op: operationOf(s, ctx) })),
    };
    if (!raw.has(n.parentId)) continue;   // an orphan cannot be placed; never expected
    push(n);
  }

  // Depth-first order and levels.
  const order = [];
  const walk = (id, level) => {
    const stack = [[id, level]];
    while (stack.length) {
      const [x, lv] = stack.pop();
      const n = raw.get(x);
      n.level = lv;
      order.push(n);
      for (let i = n.kids.length - 1; i >= 0; i--) stack.push([n.kids[i], lv + 1]);
    }
  };
  for (const n of raw.values()) if (!n.parentId) walk(n.id, 0);

  // Roll up, children before parents.
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    const own = emptyAgg();
    for (const { s, op } of n.ops) addOp(own, s, op);
    const blockedOp = n.ops.find(({ op }) => op.state === 'blocked')?.op ?? null;
    if (n.kind === 'piece') own.pieces = 1;
    if (blockedOp) { own.blocked = 1; own.first = { at: n.code, reason: blockedOp.reason ?? 'Blocked' }; }
    n.ownBlocked = !!blockedOp;
    for (const k of n.kids) mergeAgg(own, raw.get(k).agg);
    n.agg = own;
  }

  for (const n of order) {
    const { completion, weight } = completionOf(n.agg);
    const out = {
      id: n.id, parentId: n.parentId, kind: n.kind, level: n.level, code: n.code, name: n.name ?? null, qty: n.qty,
      ops: n.ops.map(({ op }) => op),
      completion, weight,
      blocked: !!n.ownBlocked,
      blockedCount: n.agg.blocked,
      blockedReason: n.agg.first ? n.agg.first.reason : null,
      blockedAt: n.agg.first && n.agg.first.at !== n.code ? n.agg.first.at : null,
      running: n.agg.running,
      childCount: n.kids.length,
    };
    if (n.kind === 'piece') { out.pieceNo = n.pieceNo; out.basis = n.basis; out.itemId = n.itemId; }
    if (n.kind !== 'order') { out.lineId = n.lineId; out.releaseId = n.releaseId; }
    if (n.kind !== 'piece') out.orderId = n.orderId;
    if (n.kids.length) {
      out.pieces = n.agg.pieces;
      out.steps = n.agg.steps;
      out.stepsDone = n.agg.stepsDone;
      out.byOperation = [...n.agg.byOp.values()];
    }
    nodes.push(out);
    byId.set(out.id, out);
    childrenOf.set(out.id, n.kids);
  }
  for (const n of raw.values()) if (!n.parentId) mergeAgg(root, n.agg);
  // Operation names once per read: byOperation carries ids only (it is on every parent).
  const operations = {};
  for (const s of data.steps) if (!operations[s.operation_id]) operations[s.operation_id] = { code: s.op_code, name: s.op_name };
  return { nodes, byId, childrenOf, data, root, operations };
}

// --- pruning -----------------------------------------------------------------------

/** Marks whether each returned node's children all came with it. */
function finish(list, childrenOf) {
  const ids = new Set(list.map((n) => n.id));
  return list.map((n) => ({ ...n, childrenIncluded: n.childCount === 0 || (childrenOf.get(n.id) ?? []).every((k) => ids.has(k)) }));
}

/** The figures over everything read: the roll-up of every order. */
function summaryOf(tree) {
  const a = tree.root;
  const { completion, weight } = completionOf(a);
  return {
    orders: tree.nodes.filter((n) => n.kind === 'order').length,
    lines: tree.nodes.filter((n) => n.kind === 'line').length,
    pieces: a.pieces, blockedPieces: a.blocked, runningSteps: a.running, steps: a.steps, stepsDone: a.stepsDone, completion, weight,
  };
}

const intOr = (v, d) => (blank(v) ? d : Math.max(1, Math.min(50, Math.floor(Number(v)) || d)));

/**
 * GET /tracker/tree?orderId=&lineId=&depth=&search=&onlyBlocked=&includeClosed=
 *   default: every released line of a confirmed order (includeClosed=1: every
 *   released line); orderId / lineId narrow it and may name a closed order.
 *   depth = levels returned (order = 1, line = 2, top piece = 3 …), default 4.
 *   search matches a piece's code or name (and an order's code): the matches
 *   and their ancestors. onlyBlocked=1: only branches with something blocked,
 *   to every level. Both cap at FILTER_CAP nodes.
 */
export async function trackerTree(db, companyId, q = {}) {
  const all = await releasedLines(db, companyId);
  const orderId = blank(q.orderId) ? null : Number(q.orderId);
  const lineId = blank(q.lineId) ? null : Number(q.lineId);
  if ((orderId != null && !Number.isInteger(orderId)) || (lineId != null && !Number.isInteger(lineId))) throw invalid('orderId and lineId are numbers.');
  const includeClosed = String(q.includeClosed) === '1';
  let lines = all;
  if (lineId != null) lines = all.filter((l) => l.order_line_id === lineId);
  else if (orderId != null) lines = all.filter((l) => l.order_id === orderId);
  else if (!includeClosed) lines = all.filter((l) => l.order_status === 'confirmed');
  const tree = await buildTree(db, companyId, lines);
  const depth = intOr(q.depth, DEFAULT_DEPTH);
  const term = blank(q.search) ? '' : String(q.search).trim().toLowerCase();
  const onlyBlocked = String(q.onlyBlocked) === '1';

  let list;
  let truncated = false;
  let matches = null;
  if (!term && !onlyBlocked) {
    list = tree.nodes.filter((n) => n.level < depth);
  } else {
    const keep = new Set();
    const addWithAncestors = (n) => {
      let x = n;
      while (x && !keep.has(x.id)) { keep.add(x.id); x = x.parentId ? tree.byId.get(x.parentId) : null; }
    };
    if (term) {
      matches = [];
      for (const n of tree.nodes) {
        if (onlyBlocked && !n.blockedCount) continue;
        const hit = (n.code && String(n.code).toLowerCase().includes(term)) || (n.kind === 'piece' && n.name && n.name.toLowerCase().includes(term));
        if (!hit) continue;
        if (matches.length >= SEARCH_CAP) { truncated = true; break; }
        matches.push(n.id);
        addWithAncestors(n);
      }
    } else {
      for (const n of tree.nodes) {
        if (!n.blockedCount) continue;
        if (keep.size >= FILTER_CAP) { truncated = true; break; }
        keep.add(n.id);
      }
    }
    list = tree.nodes.filter((n) => keep.has(n.id));
    if (list.length > FILTER_CAP) { list = list.slice(0, FILTER_CAP); truncated = true; }
  }
  const matchSet = new Set(matches ?? []);
  const out = finish(list, tree.childrenOf).map((n) => (matchSet.has(n.id) ? { ...n, match: true } : n));
  return {
    scope: { orderId, lineId, includeClosed },
    orders: pickerOf(all),
    summary: summaryOf(tree),
    depth,
    search: term || null,
    onlyBlocked,
    total: tree.nodes.length,
    returned: out.length,
    truncated,
    basisNote: BASIS_NOTE,
    operations: tree.operations,
    nodes: out,
  };
}

/** The release(s) a node id belongs to: o<order>, l<line>, p<production item>. */
async function linesOfNode(db, companyId, nodeId) {
  const m = /^([olp])(\d+)$/.exec(String(nodeId ?? ''));
  if (!m) throw invalid('nodeId is o<order id>, l<line id> or p<piece id>.');
  const idNum = Number(m[2]);
  const all = await releasedLines(db, companyId);
  if (m[1] === 'o') return { kind: 'o', lines: all.filter((l) => l.order_id === idNum) };
  if (m[1] === 'l') return { kind: 'l', lines: all.filter((l) => l.order_line_id === idNum) };
  const [[it]] = await db.query('SELECT release_id FROM cf_production_items WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, idNum]);
  return { kind: 'p', lines: it ? all.filter((l) => l.release_id === it.release_id) : [] };
}

/** GET /tracker/tree/children?nodeId=&depth= — a branch: the node's descendants up to `depth` levels below it (default 1). */
export async function trackerTreeChildren(db, companyId, q = {}) {
  const { lines } = await linesOfNode(db, companyId, q.nodeId);
  const tree = await buildTree(db, companyId, lines);
  const node = tree.byId.get(String(q.nodeId));
  if (!node) throw notFound('Tracker node');
  const depth = intOr(q.depth, 1);
  const list = [];
  const stack = [...(tree.childrenOf.get(node.id) ?? [])].reverse();
  while (stack.length) {
    const n = tree.byId.get(stack.pop());
    list.push(n);
    if (n.level - node.level < depth) stack.push(...[...(tree.childrenOf.get(n.id) ?? [])].reverse());
  }
  return { node: finish([node], tree.childrenOf)[0], operations: tree.operations, nodes: finish(list, tree.childrenOf) };
}

/** GET /tracker/tree/node?nodeId=p… — one piece: its node and every step in full, as the tracker shapes them (waits, blockers, actions). */
export async function trackerTreeNode(db, companyId, q = {}) {
  if (!/^p\d+$/.test(String(q.nodeId ?? ''))) throw invalid('nodeId is p<piece id>.');
  const { lines } = await linesOfNode(db, companyId, q.nodeId);
  const tree = await buildTree(db, companyId, lines);
  const node = tree.byId.get(String(q.nodeId));
  if (!node) throw notFound('Tracker piece');
  const itemId = Number(String(q.nodeId).slice(1));
  const it = tree.data.itemById.get(itemId);
  const line = lines.find((l) => l.release_id === node.releaseId);
  // The chain from the order down, for the breadcrumb.
  const path = [];
  for (let x = tree.byId.get(node.parentId); x; x = x.parentId ? tree.byId.get(x.parentId) : null) path.unshift({ id: x.id, kind: x.kind, code: x.code });
  return {
    node: finish([node], tree.childrenOf)[0],
    operations: tree.operations,
    path,
    order: line ? { id: line.order_id, code: line.order_code } : null,
    line: line ? { id: line.order_line_id, lineNo: line.line_no } : null,
    steps: (tree.data.stepsOf.get(itemId) ?? []).map((s) => shapeStep(s, it._label)),
  };
}
