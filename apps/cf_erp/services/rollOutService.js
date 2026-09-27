/**
 * rollOutService.js — what one sales line rolls out into: the tree of pieces,
 * the rule that says what is made, the numbers each piece carries and the code
 * each one gets. Nothing here writes.
 *
 * Decided 2026-09-26: a BOM row is a DESIGN with a quantity, not a piece. The
 * pieces exist only once the line is LOCKED (lockService writes them to
 * cf_order_pieces, with their codes), and release lays its tracker out over the
 * same tree and takes every code from there. So the tree has ONE definition,
 * here, used by:
 *
 *   lockService       rolls the line out and writes cf_order_pieces
 *   releaseService    lays the tracker out again and looks each node's code up
 *                     by path key; it never makes a code for a locked line
 *   placeholders      the code a row will print, with # where the roll-out puts
 *                     a number (rendered per design from rollOutPlan's nodes)
 *
 * THE TREE (T1 = (c), decided 2026-09-22): one node per physical piece for a
 * design that has made parts of its own; one GROUPED node, carrying the count,
 * for a design that has none — six identical stiffeners are one node of 6
 * under their parent piece. Material (what is not made) is not a node but a
 * requirement on the node that consumes it.
 *
 * FLOWS DO NOT SHAPE IT. Stages run lines → structure → values → cut pieces →
 * LOCK → nesting → buying → production, so a row may still have no flow when
 * its line is locked. Every made design rolls out whatever its flow; release is
 * where a missing flow is refused.
 *
 * NUMBERS. piece.no counts one design's pieces across the whole line.
 * piece.seq numbers a row's pieces under ONE parent piece, carrying on across
 * rows of the same short name (codeRangeService's ranges), so a drilled copy of
 * 3 after 23 plain stiffeners is 24, 25, 26; a group shows its range, "1-4".
 *
 * PATH KEYS. Each node's name for where it sits, independent of ids handed out
 * in order: the chain from the top of <bom line id>.<ordinal>, the ordinal
 * being the piece's place among its OWN row's pieces under one parent piece (a
 * group has none; the line's own item is L). "L.1/3861.1/3862.1/3863.1/4071".
 * A frozen structure lays out identically every time, so release finds each
 * locked piece again by it.
 */
import { invalid, notFound } from '../lib/errors.js';
import { loadMasters } from './records.js';
import { LEAF_DEPTH } from './tree.js';
import { explode } from './bomService.js';
import { generate } from '../modules/codegen/index.js';
import { rangesOfBoms, seqValue, readRulesOnce, shortNameOf } from './codeRangeService.js';

const EPS = 1e-9;
/** explode()'s depth cap: the Structure tab, the Values stage and the roll-out stop at the same place. */
export const MAX_DEPTH = 15;
// A guard against a runaway explosion, not a statement about how big a real job
// is: one span of the KEPL bridge is 3,036 nodes and two spans 6,072. A tripped
// cap silently drops everything past it, which is how the same bridge once
// asked for 18 t less steel than it contains — so hitting it is always a problem.
export const MAX_NODES = 10000;
const USABLE = "('storage','wip')";
const round6 = (n) => Number(Number(n).toFixed(6));
const fmt = (n) => String(round6(n));
const whole = (x) => Math.abs(x - Math.round(x)) < 1e-9;
const dateOnly = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ?? null);

/** How a node is named in a sentence. A row has no code any more, so its name. */
export const nameOf = (n) => n.code ?? n.name;

// --- free stock --------------------------------------------------------------------

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

// --- the made rule — one copy ----------------------------------------------------

/**
 * Is a node MADE on the order, or drawn as material? The one rule the roll-out,
 * release and the order's stages all ask (processService.splitLine takes it
 * from here), so a stage can never call "made" what release calls "material".
 *
 *   temporary item               made: it exists only for its order
 *   a stock order's own item     made when it has a flow — that order is what
 *                                puts it in stock
 *   catalog item, sourcing make  made
 *   catalog item, sourcing both  made when free stock does not cover what is
 *                                needed, else taken from stock. Free stock is
 *                                used up in the order the tree is walked.
 *   anything else                material
 *
 * The 'both' decision depends on stock at the moment it is asked, so a LOCKED
 * line does not ask again: `lockedBoth` is the set of BOM lines the lock rolled
 * pieces out for, and a 'both' node is made exactly when its line is in it. What
 * the lock decided is what release makes.
 *
 * Whether it has a flow does not decide it (bar a stock order's own item): a
 * row is made whether or not somebody has said how yet, and release refuses a
 * made node with no flow in words.
 *
 * Returns decide(node, needed, isRoot) -> { made, sourcedBy? }.
 */
export function madeRule({ orderType, sourcingOf, free = new Map(), lockedBoth = null }) {
  const left = new Map(free);
  return (n, needed, isRoot) => {
    if (n.kind === 'temporary') return { made: true };
    if (isRoot && orderType === 'stock') return { made: !!n.flow };
    const sourcing = sourcingOf(n);
    if (sourcing === 'make') return { made: true };
    if (sourcing === 'both') {
      if (lockedBoth) {
        const made = lockedBoth.has(Number(n.lineId ?? 0));
        return { made, sourcedBy: made ? 'made (decided at lock)' : 'stock (decided at lock)' };
      }
      const f = left.get(n.id) ?? 0;
      const made = f + EPS < needed;
      if (!made) left.set(n.id, round6(f - needed));
      return { made, sourcedBy: made ? 'made (no free stock)' : 'stock' };
    }
    return { made: false };
  };
}

/** item_type, sourcing, tracked_by and the definition each temporary item came from. */
export async function itemDetails(db, companyId, itemIds) {
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
 * It matters because of how material is worked out: a requirement is recorded
 * for a CHILD that is not made, so a made node with no children asks for
 * nothing. The plate parts of a real job were `sourcing = 'make'` with no BOM,
 * and 669 t of steel simply did not exist as far as the system was concerned.
 *
 * The exploded tree alone must not be the answer: it stops at its depth cap, so
 * a node at the bottom of a deep structure looks childless while its BOM is
 * full. The database is asked whether the item really has a live BOM line, and
 * only one that truly has none is named — once per (item, place).
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

// --- the tree -----------------------------------------------------------------

/**
 * The roll-out of one sales line: explode its structure, decide what is made,
 * and lay the made part out as pieces and groups, each numbered and keyed.
 * Nothing is written and no code is made.
 *
 *   line: { id, order_id, order_code, order_type, line_no, item_id, quantity }
 *         — the row shape release reads
 *   opts.lockedBoth   the BOM lines a lock rolled out pieces for (madeRule)
 *
 * Returns
 *   problems  what stops the STRUCTURE rolling out, in words: a selection not
 *             chosen, a definition where an item belongs, a catalog item that
 *             is not active, something made out of nothing, a piece-by-piece
 *             design asked for a part of a piece, a structure too big to lay out.
 *             Not flows, not drafts of the line's own rows — release adds those.
 *   fromNothing  [{ id, problem }] — which of those sentences is "made out of
 *             nothing", and for which item, so a caller with a better reason
 *             (a plate part whose cut piece is not made yet) can say that instead
 *   nodes     [{ k, parentK, depth, design, itemId, bomLineId, pieceNo, pieceSeq,
 *               ordinal, pathKey, quantity, flowId, madeFrom, childKs }]
 *             in the order they are written: a parent before its children,
 *             siblings as the rows are shown. `design` is the explode() node.
 *   reqs      [{ nodeK, itemId, bomLineId, quantity, design }] — the material
 *   tree, all (every design node considered), detail (item details by id), truncated
 */
export async function rollOutPlan(db, companyId, line, { lockedBoth = null } = {}) {
  const problems = [];
  const qty = Number(line.quantity);
  const tree = await explode(db, companyId, line.item_id, { rootQuantity: qty, maxDepth: MAX_DEPTH });
  if (tree.truncated) problems.push(`The structure is more than ${MAX_DEPTH} levels deep.`);

  // 1. Every design node: is it an item, is it made or material, is it usable?
  const everyNode = [];
  const collect = (n) => { everyNode.push(n); n.children.forEach(collect); };
  collect(tree.root);
  const detail = await itemDetails(db, companyId, everyNode.map((n) => n.id));
  const sourcingOf = (n) => (n.kind === 'catalog' ? detail.get(n.id)?.sourcing ?? 'stock' : null);
  const maybe = lockedBoth ? [] : everyNode.filter((n) => n.kind === 'catalog' && sourcingOf(n) === 'both');
  const free = maybe.length
    ? new Map([...(await availability(db, companyId, [...new Set(maybe.map((n) => n.id))]))].map(([id, v]) => [id, v.free]))
    : new Map();
  const decide = madeRule({ orderType: line.order_type, sourcingOf, free, lockedBoth });

  const all = [];
  const consider = (n, parent, count) => {
    n.parentNode = parent;
    n.needCount = round6(count);
    all.push(n);
    const where = parent ? ` under ${nameOf(parent)}` : '';
    if (n.kind === 'selection') { problems.push(`${nameOf(parent ?? n)} still has to choose its ${n.selection?.code ?? nameOf(n)} — pick the catalog item.`); return; }
    if (n.kind === 'template') { problems.push(`${nameOf(n)}${where} is a definition — a blueprint is never made or issued.`); return; }
    const d = decide(n, n.needCount, n === tree.root);
    n.made = d.made;
    if (d.sourcedBy) n.sourcedBy = d.sourcedBy;
    // A catalog item is shared setup: it has to be active to be made or issued.
    // A row of the line (a temporary item) has no draft life of its own — lock
    // is what activates it — so its status is release's business, not this.
    if (n.kind === 'catalog') {
      if (n.status === 'draft') problems.push(`${nameOf(n)}${where} is still a draft in the catalog — activate it.`);
      else if (n.status !== 'active') problems.push(`${nameOf(n)}${where} is ${n.status} — only active items are made or issued.`);
      if (n.made && n.bom && n.bom.status !== 'active') problems.push(`The BOM of ${nameOf(n)} is ${n.bom.status} — activate it.`);
    }
    // Only what is made here has parts that matter: the structure under an item
    // taken from stock is that item's business, not this order's.
    if (n.made) for (const kid of n.children) consider(kid, n, kid.quantity * count);
  };
  consider(tree.root, null, qty);
  // Kept beside the sentences, so a caller that knows a better reason for one of
  // them — a plate part whose cut piece is not made yet — can say that instead.
  const fromNothing = [];
  for (const n of await madeFromNothing(db, companyId, all)) {
    const where = n.parentNode ? ` under ${nameOf(n.parentNode)}` : '';
    // A temporary item is always made on its order, so it has the one way out.
    const problem = n.kind === 'temporary'
      ? `${nameOf(n)}${where} is made on the order, but nothing is under it — give it a BOM saying what it is made from.`
      : `${nameOf(n)}${where} is made on the order, but nothing is under it — give it a BOM, or set it to come from stock.`;
    problems.push(problem);
    fromNothing.push({ id: n.id, problem });
  }
  const root = tree.root;
  if (root.made === undefined) return { problems, fromNothing, tree, all, detail, nodes: [], reqs: [], truncated: false };

  // 2. The layout: a piece per node when it has made parts, one grouped node
  //    otherwise; material becomes requirements.
  const sourceDef = new Map([...detail].map(([id, d]) => [id, d.source_definition_id]));
  const nodes = [];
  const reqs = [];
  const counters = new Map();   // piece.no: one counter per DESIGN across the whole line
  // piece.seq (user, 2026-09-26): under each parent piece a row's pieces are
  // numbered start … end of that row's range; rows of the same short name share
  // one count, and it starts again under the next parent piece. The line's own
  // item is not on a BOM row: its pieces are 1 … n on the order line.
  const lineRanges = await rangesOfBoms(db, companyId, [...new Set(all.filter((n) => n.made && n.bom).map((n) => n.bom.id))]);
  const rangeOfRow = (d) => (d.lineId != null ? lineRanges.get(d.lineId) ?? null : null);
  const seqOfPiece = (d, i) => {
    if (d.lineId == null) return i + 1;
    const r = rangeOfRow(d);
    return r?.start != null ? r.start + i : null;
  };
  const seqOfGroup = (d, count) => {
    if (!whole(count)) return null;
    const start = d.lineId == null ? 1 : rangeOfRow(d)?.start;
    return start != null ? seqValue(start, Math.round(count)) : null;
  };
  // Children in the order the rows are shown (line number, then line id), so
  // the numbers are the same on every run whatever order explode() used.
  const shown = new WeakMap();
  const inShownOrder = (d) => {
    let kids = shown.get(d);
    if (!kids) {
      kids = [...d.children].sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0) || (a.lineId ?? 0) - (b.lineId ?? 0));
      shown.set(d, kids);
    }
    return kids;
  };
  const madeKids = (d) => d.children.filter((k) => k.made);
  const addNode = (design, parentK, depth, quantity, pieceNo, pieceSeq, ordinal) => {
    const parent = parentK != null ? nodes[parentK] : null;
    const step = `${design.lineId ?? 'L'}${ordinal != null ? `.${ordinal}` : ''}`;
    const node = {
      k: nodes.length, parentK, design, itemId: design.id, bomLineId: design.lineId ?? null,
      pieceNo, pieceSeq, ordinal, pathKey: parent ? `${parent.pathKey}/${step}` : step,
      quantity: round6(quantity), code: null, flowId: design.flow?.id ?? null, depth, childKs: [], stepKs: [],
      madeFrom: sourceDef.get(design.id) ?? null,
    };
    nodes.push(node);
    if (parent) parent.childKs.push(node.k);
    return node;
  };
  const fill = (design, node) => {
    for (const kid of inShownOrder(design)) {
      if (kid.made) expand(kid, node.k, node.depth + 1, kid.quantity * node.quantity);
      else if (kid.made === false) reqs.push({ nodeK: node.k, itemId: kid.id, bomLineId: kid.lineId, quantity: round6(kid.quantity * node.quantity), design: kid });
    }
  };
  const expand = (design, parentK, depth, count) => {
    if (nodes.length > MAX_NODES) return;
    if (madeKids(design).length) {
      if (!whole(count)) { problems.push(`${nameOf(design)} is made piece by piece, so it needs a whole number — ${fmt(count)} were asked for.`); return; }
      for (let i = 0; i < Math.round(count); i++) {
        const no = (counters.get(design.id) ?? 0) + 1;
        counters.set(design.id, no);
        fill(design, addNode(design, parentK, depth, 1, no, seqOfPiece(design, i), i + 1));
      }
    } else fill(design, addNode(design, parentK, depth, count, null, seqOfGroup(design, count), null));
  };
  if (root.made) expand(root, null, 0, qty);
  else if (line.order_type !== 'stock') reqs.push({ nodeK: null, itemId: root.id, bomLineId: null, quantity: round6(qty), design: root });
  // Hitting the cap stops `expand` mid-tree, so everything past it was never
  // walked and its material never asked for — not a smaller answer, a WRONG one.
  const truncated = nodes.length > MAX_NODES;
  if (truncated) {
    problems.push(`The line would roll out into more than ${MAX_NODES} pieces — split it into smaller lines.`);
    problems.push('Because of that, the piece and material figures below are incomplete — the rest of the structure was never worked out. Do not order from them.');
  }
  return { problems, fromNothing, tree, all, detail, nodes, reqs, truncated };
}

// --- the line's position among lines of the same design ---------------------------

/**
 * The line's number among its order's LIVE lines that sell the same design, by
 * line number — SPAN-01, SPAN-02 (the `line.position` piece token). Given at
 * lock and stored (lock_position); a trial line deleted before then leaves no
 * gap. If a locked live line already holds that number, the next free one.
 *
 * In a REVISION (init.sql §27) the order row is the revision's own, so these
 * are the revision's lines — the revision it replaced counts for nothing. But a
 * line copied from a LOCKED line keeps that line's number (`kept_position`)
 * while no locked line of the revision holds it: drop span 1 from a revision
 * and span 2 is still SPAN-02, so it locks to exactly the codes it had. A
 * number a copied line will take back is not free for any other line either.
 *
 * siblings: the live lines of the order with the same design, each
 * { id, line_no, locked_at, lock_position, kept_position }, in line-number order.
 */
export function positionAmong(siblings, lineId) {
  const me = siblings.find((s) => Number(s.id) === Number(lineId));
  if (me?.locked_at && me.lock_position != null) return Number(me.lock_position);
  const rank = siblings.findIndex((s) => Number(s.id) === Number(lineId)) + 1 || siblings.length + 1;
  const others = siblings.filter((s) => Number(s.id) !== Number(lineId));
  const held = new Set(others.filter((s) => s.locked_at && s.lock_position != null).map((s) => Number(s.lock_position)));
  if (me?.kept_position != null && !held.has(Number(me.kept_position))) return Number(me.kept_position);
  for (const s of others) if (!s.locked_at && s.kept_position != null) held.add(Number(s.kept_position));
  let p = rank;
  while (held.has(p)) p += 1;
  return p;
}

/**
 * The live lines of an order that sell the same design as this one, in line
 * order — one query. `kept_position` is the position of the locked line a
 * revision's line was copied from (positionAmong).
 */
export async function siblingLines(db, companyId, lineId) {
  const [rows] = await db.query(
    `SELECT s.id, s.line_no, s.locked_at, s.lock_position,
            IF(pv.locked_at IS NOT NULL, pv.lock_position, NULL) AS kept_position
       FROM cf_sales_order_lines l
       JOIN cf_sales_order_lines s ON s.company_id = l.company_id AND s.order_id = l.order_id
                                  AND s.design_id = l.design_id AND s.deleted_at IS NULL
       LEFT JOIN cf_sales_order_lines pv ON pv.company_id = s.company_id AND pv.id = s.revises_line_id
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL
      ORDER BY s.line_no, s.id`,
    [companyId, lineId],
  );
  if (!rows.length) throw notFound('Order line');
  return rows;
}

/**
 * The line's position: lock_position once it is locked, else the one lock would
 * give it now. One query.
 */
export async function linePositionOf(db, companyId, lineId) {
  return positionAmong(await siblingLines(db, companyId, lineId), lineId);
}

// --- the code generator's memo ----------------------------------------------------

/**
 * tree.ancestors, started from many classification nodes in ONE round trip:
 * the same recursive walk, each row remembering which chain it belongs to.
 * CHAIN_HOPS is tree.js's MAX_CHAIN - 1: the same guard against a loop.
 */
const CHAIN_HOPS = LEAF_DEPTH + 2;
const CHAINS_SQL = `
  WITH RECURSIVE chain AS (
    SELECT n.*, n.id AS chain_of, CAST(0 AS SIGNED) AS hop
      FROM cf_classification_nodes n
     WHERE n.company_id = ? AND n.id IN (?) AND n.deleted_at IS NULL
     UNION ALL
    SELECT p.*, c.chain_of, c.hop + 1
      FROM chain c
      JOIN cf_classification_nodes p
        ON p.company_id = c.company_id AND p.id = c.parent_id AND p.deleted_at IS NULL
     WHERE c.hop < ?
  )
  SELECT * FROM chain`;

async function chainsOf(db, companyId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(CHAINS_SQL, [companyId, ids, CHAIN_HOPS]);
  for (const id of ids) out.set(id, []);
  for (const row of rows) out.get(row.chain_of)?.push(row);
  for (const chain of out.values()) {
    chain.sort((a, b) => b.hop - a.hop);   // root first, whatever order the engine returned
    for (const row of chain) { delete row.hop; delete row.chain_of; }
  }
  return out;
}

/**
 * The code generator's memo for a whole roll-out, filled before the first piece
 * is coded (codegenProvider.pieceContext: one roll-out, one memo). Each piece
 * asks for its item, the item's template definition, the order and the item's
 * classification chain; asked piece by piece that was 235 round trips on the
 * KEPL line. Here it is two: every item and definition in one read, every chain
 * in another. The order's code is the one the caller already read.
 *
 * Only answers go in; anything not read here pieceContext reads itself, so the
 * seed makes coding cheaper, never different. `madeFrom` is each node's template.
 */
export async function seedPieceMemo(db, companyId, line, nodes) {
  const memo = new Map();
  if (!nodes.length) return memo;
  const itemIds = [...new Set(nodes.map((n) => n.itemId))];
  const wanted = [...new Set([...itemIds, ...nodes.map((n) => n.madeFrom).filter((id) => id != null)])];
  const masters = await loadMasters(db, companyId, wanted);
  for (const id of wanted) memo.set(`master:${id}`, masters.get(id) ?? null);
  memo.set(`order:${line.order_id}`, { code: line.order_code });
  const classIds = [...new Set(itemIds.map((id) => masters.get(id)?.classification_id).filter((id) => id != null))];
  for (const [id, chain] of await chainsOf(db, companyId, classIds)) memo.set(`chain:${id}`, chain);
  return memo;
}

// --- coding the pieces ---------------------------------------------------------

const PEEK_NUMBER = /^\s*SELECT\s+next_value\s+FROM\s+cf_code_sequences\b/i;

/**
 * A preview draws no running number; the code generator only PEEKS at the next
 * one. Left alone, every piece of a rule with a running number would show the
 * same next number. This hands the numbers out in turn instead, per rule and
 * prefix, from the one the database says is next — the order a consuming run
 * draws them in. Nothing is written. It sits OUTSIDE readRulesOnce, which would
 * otherwise answer every peek from its cache with the first number.
 */
function numbersInTurn(db) {
  const next = new Map();
  const query = async (sql, params) => {
    if (!PEEK_NUMBER.test(sql) || /\bFOR\s+UPDATE\b/i.test(sql)) return db.query(sql, params);
    const key = JSON.stringify(params ?? []);
    if (!next.has(key)) {
      const [[row]] = await db.query(sql, params);
      next.set(key, row ? Number(row.next_value) : 1);
    }
    const n = next.get(key);
    next.set(key, n + 1);
    return [[{ next_value: n }], []];
  };
  return new Proxy(db, { get: (target, prop) => (prop === 'query' ? query : Reflect.get(target, prop)) });
}

const pad2 = (n) => String(n ?? '').padStart(2, '0');

/**
 * The built-in code, for a piece no coding rule applies to — the house shape,
 * built from SHORT NAMES and never from a row's code (a row has none):
 *   the top    {order code}-{short name}-{line position, 2 digits}-{piece seq}
 *   below      {parent code}-{short name}{piece seq}
 * The top carries the order code, so two orders making the same thing cannot
 * collide (ARCHITECTURE.md §13); everything below carries its parent's code.
 * Exported for placeholderService, which prints the same shape with # holes.
 */
export async function builtInCode(n, parentCode, line, linePosition, memo) {
  const item = await memo.get(`master:${n.itemId}`);
  const def = item?.source_definition_id != null ? await memo.get(`master:${item.source_definition_id}`) : null;
  const short = shortNameOf(item ?? { name: n.design.name }, def) ?? `I${n.itemId}`;
  const seq = n.pieceSeq ?? n.pieceNo ?? '';
  if (n.parentK == null) {
    return [line.order_code, short, pad2(linePosition ?? 1), seq].filter((x) => x != null && String(x) !== '').join('-');
  }
  return `${parentCode}-${short}${seq}`;
}

/**
 * Codes held by a piece of ANOTHER line — a live release's tracker piece, or a
 * locked piece — asked `chunk` codes at a time. The line's own release and its
 * own locked pieces are not "another". Nor are the locked pieces of an EARLIER
 * REVISION of the line's order (init.sql §27): locking this line retires them
 * (lockService.lockLine), and an unchanged line is meant to get their codes.
 */
export async function takenCodes(db, companyId, lineId, codes, chunk = 5000) {
  const out = [];
  for (let i = 0; i < codes.length; i += chunk) {
    const part = codes.slice(i, i + chunk);
    const [rows] = await db.query(
      `SELECT pi.code FROM cf_production_items pi
        WHERE pi.company_id = ? AND pi.code IN (?) AND pi.deleted_at IS NULL
          AND pi.release_id NOT IN (SELECT r.id FROM cf_production_releases r WHERE r.company_id = ? AND r.order_line_id = ? AND r.deleted_at IS NULL)
       UNION
       SELECT op.code FROM cf_order_pieces op
        WHERE op.company_id = ? AND op.code_live IN (?) AND op.order_line_id <> ?
          AND op.order_id NOT IN (SELECT e.id FROM cf_sales_order_lines ml
                                    JOIN cf_sales_orders me ON me.company_id = ml.company_id AND me.id = ml.order_id
                                    JOIN cf_sales_orders e ON e.company_id = me.company_id AND e.code_active = me.code_active
                                                          AND e.revision < me.revision
                                   WHERE ml.company_id = ? AND ml.id = ?)`,
      [companyId, part, companyId, lineId, companyId, part, lineId, companyId, lineId],
    );
    out.push(...rows.map((r) => r.code));
  }
  return out;
}

/**
 * Every piece's code, parents first so a rule can build a child's code out of
 * its parent's — from the code generator where a rule applies, the built-in
 * shape where none does. `consume` draws a running number for real; without it
 * the numbers are peeked and handed out in turn, so a preview shows exactly the
 * codes a consuming run would write. Writes nothing but the codes onto the nodes.
 *
 *   linePosition   the line's position (linePositionOf) — `line.position`
 *   memo           the generator's memo, filled by seedPieceMemo (one read of
 *                  every item, definition and chain instead of one per piece)
 *
 * Returns { duplicates, taken, missing, byRule, numbered } — codes given to two
 * pieces, codes another line's piece already carries, rules with a hole (a
 * consuming run throws on the first), how many a rule coded, and how many drew
 * a running number. Each node also carries `rule`, the coding rule that chose
 * it (null where the built-in shape did).
 */
export async function codeNodes(db, companyId, line, nodes, { consume, memo = new Map(), linePosition = null, takenChunk = 5000 }) {
  const rules = consume ? readRulesOnce(db) : numbersInTurn(readRulesOnce(db));
  const seen = new Set();
  const out = { duplicates: [], taken: [], missing: [], byRule: 0, numbered: 0 };
  for (const n of nodes) {
    const parentCode = n.parentK != null ? nodes[n.parentK].code : null;
    let g = null;
    try {
      g = await generate(rules, companyId, 'production_piece', 'code', {
        draft: { itemId: n.itemId, orderId: line.order_id, lineNo: line.line_no, linePosition, parentCode, pieceNo: n.pieceNo, pieceSeq: n.pieceSeq, memo },
      }, { consume });
    } catch (err) {
      // A rule that leans on something this piece has not got — say which piece.
      if (err?.code !== 'TOKEN_MISSING') throw err;
      throw invalid('TOKEN_MISSING', `${nameOf(n.design)} cannot be numbered: ${err.message}`, { problems: err.problems ?? [] });
    }
    n.rule = g?.schemeCode ?? null;
    if (g?.number != null) out.numbered += 1;
    if (g?.text) out.byRule += 1;
    else if (g?.missing?.length) out.missing.push({ node: n, schemeCode: g.schemeCode, missing: g.missing });
    n.code = g?.text || await builtInCode(n, parentCode, line, linePosition, memo);
    // Two pieces called the same thing is not an identity — and it surfaces far
    // later, as a duplicate lot on the day one of them is finished.
    if (seen.has(n.code)) out.duplicates.push(n.code);
    else seen.add(n.code);
  }
  out.taken = await takenCodes(db, companyId, line.id, [...seen], takenChunk);
  return out;
}

// --- the locked pieces ------------------------------------------------------------

/** A locked line's pieces, in roll-out order. One query. */
export async function lockedPiecesOf(db, companyId, lineId) {
  const [rows] = await db.query(
    `SELECT id, parent_id, item_id, bom_line_id, piece_no, piece_seq, quantity, code, rule_code, path_key, depth, sort_order, created_at
       FROM cf_order_pieces
      WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL
      ORDER BY sort_order, id`,
    [companyId, lineId],
  );
  return rows;
}

/** The BOM lines a lock rolled pieces out for — what madeRule reads for a locked line's 'both' items. */
export const lockedBothOf = (pieces) => new Set(pieces.filter((p) => p.bom_line_id != null).map((p) => Number(p.bom_line_id)));

/**
 * Gives each node of a laid-out tree the code its locked piece carries, found by
 * path key — never a new one. Returns the nodes that have NO locked piece, or
 * whose locked piece is a different item or count: the tree has changed since
 * the lock, which only a new revision may do.
 */
export function attachLockedCodes(nodes, pieces) {
  const byPath = new Map(pieces.map((p) => [p.path_key, p]));
  const unmatched = [];
  for (const n of nodes) {
    const p = byPath.get(n.pathKey);
    if (!p || Number(p.item_id) !== Number(n.itemId) || Math.abs(Number(p.quantity) - Number(n.quantity)) > 1e-6) {
      n.code = null;
      n.rule = null;
      unmatched.push({ node: n, piece: p ?? null });
      continue;
    }
    n.code = p.code;
    n.rule = p.rule_code ?? null;
    n.lockedPieceId = p.id;
  }
  return unmatched;
}

/** The words for a node the lock did not roll out — shared by release and its preview. */
export function unmatchedProblem(u, nodes) {
  const n = u.node;
  const under = n.parentK != null ? ` under ${nodes[n.parentK].code ?? nameOf(nodes[n.parentK].design)}` : '';
  if (!u.piece) return `${nameOf(n.design)}${under} has no locked piece — the structure changed after the line was locked. A change after lock means a new revision.`;
  return `${nameOf(n.design)}${under} was locked as ${Number(u.piece.quantity)} of another item — the structure changed after the line was locked. A change after lock means a new revision.`;
}
