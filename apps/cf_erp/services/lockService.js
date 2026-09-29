/**
 * lockService.js — LOCK: a sales line's structure rolled out into pieces, each
 * with its real code, and the line frozen (models/init.sql §25–26).
 *
 * Decided by the user 2026-09-26: "the codes can't live on the BOM as it is yet
 * to be rolled out based on the quantity. Based on the BOM and the values, the
 * items must get created after entry, and once entered and locked I don't see a
 * reason for it to change. If it changes, the whole sales order changes, so it
 * should be a new one." Lock sits right after Values and cut pieces, before
 * nesting and buying. A change after lock is a new revision of the order
 * (revisionService); locking a revision's first line retires the pieces of the
 * revisions before it, so their codes come back.
 *
 * WHAT LOCK DOES, in one transaction:
 *   1. checks, all at once: a line built from a template, on an open order, not
 *      locked or released yet; every required value filled (the Values stage's
 *      own count, read — never copied); every plate part pooled into its cut
 *      piece; the structure rolls out; every piece gets a code of its own
 *   2. brings the line's values up to date (they freeze next), in bulk
 *   3. activates the line's rows — a row has no draft life of its own; locking
 *      is what makes it real (user, 2026-09-26). No code is minted for a row.
 *   4. writes cf_order_pieces: the roll-out (rollOutService.rollOutPlan), each
 *      node coded by codeNodes with the line's position and every running
 *      number drawn for real — multi-row INSERTs, one level at a time, the new
 *      ids read back by path key (TiDB does not hand ids out contiguously)
 *   5. stamps the line: locked_at, locked_by, lock_position
 *
 * From then on frozenBy says 'locked' for the line's items, and every service
 * that refuses a released structure refuses a locked one, in one sentence
 * (records.lockedLineMessage). Nesting is the exception: it comes after lock,
 * so laying the cut pieces out on plates still works.
 *
 * ROUND TRIPS. Production is ~49 ms away, so nothing here is per piece: the
 * KEPL line (6,072 pieces) locks in a few dozen round trips — the values read,
 * the roll-out, two memo reads, the code clash check, the bulk value refresh,
 * one activation, a handful of INSERTs.
 */
import { invalid, notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { LOCKED_ORDER_STATUSES, lockedLineMessage, revisedOrderMessage, latestRevisionSql } from './records.js';
import { readLineValues, materializeLineRecords } from './orderValuesService.js';
import { refreshCutPieces } from './cutPlateService.js';
import { retireCellsOfRetiredPieces } from './workOrderService.js';
import {
  rollOutPlan, codeNodes, seedPieceMemo, siblingLines, positionAmong, lockedPiecesOf, nameOf,
} from './rollOutService.js';

const PIECE_COLUMNS = ['company_id', 'order_id', 'order_line_id', 'parent_id', 'item_id', 'bom_line_id', 'piece_no', 'piece_seq',
  'quantity', 'code', 'rule_code', 'path_key', 'depth', 'sort_order', 'created_by'];
/** Rows per INSERT: ~250 bytes a row, so a statement stays far under any packet limit. */
const INSERT_CHUNK = 1000;
/** How many examples a sentence names before "and N more". */
const NAMED = 3;
/** cutPlateService files parts and cut plates here (its own constants). */
const PARTS_CODE = 'FAB_PARTS';
const CUT_PLATE_CODE = 'CUT_PLATE';

const count = (n) => Number(n).toLocaleString('en-IN');
const plural = (n, one, many = `${one}s`) => `${count(n)} ${Number(n) === 1 ? one : many}`;
const examples = (names, total = names.length) => {
  const shown = names.slice(0, NAMED).join(', ');
  return total > NAMED ? `${shown} and ${count(total - NAMED)} more` : shown;
};
const pad2 = (n) => String(n ?? '').padStart(2, '0');
const seqOut = (s) => (s == null ? null : /^\d+$/.test(String(s)) ? Number(s) : String(s));

// --- the line -----------------------------------------------------------------

async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type,
            o.revision AS order_revision, ${latestRevisionSql('o')} AS order_latest_revision,
            (SELECT m.code FROM cf_master_records m WHERE m.id = l.item_id) AS item_code,
            (SELECT m.name FROM cf_master_records m WHERE m.id = l.item_id) AS item_name,
            (SELECT r.id FROM cf_production_releases r
              WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL LIMIT 1) AS release_id,
            (SELECT u.name FROM users u WHERE u.id = l.locked_by) AS locked_by_name
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  if (!l) throw notFound('Order line');
  return l;
}

/**
 * Refuses a change to a locked line's design, for a route that works on the
 * line rather than on one of its records — working its cut pieces out again.
 */
export async function assertLineUnlocked(db, companyId, lineId) {
  const [[l]] = await db.query(
    `SELECT l.line_no, l.locked_at, o.code AS order_code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, lineId],
  );
  if (!l) throw notFound('Order line');
  if (l.locked_at) throw invalid('LOCKED', lockedLineMessage(l.line_no, l.order_code));
}

// --- plate parts and their cut pieces ------------------------------------------------

/**
 * Of these items, the PLATE PARTS — temporary items filed under the parts
 * classification — and whether each has its cut piece: a temporary child filed
 * under the cut-plate classification. The same two places cutPlateService works
 * from (FAB_PARTS, or Fabricated › Parts; CUT_PLATE), so "has plate parts"
 * means here what it means there. Two queries.
 *
 * Returns { applies, parts: [{ id, code, name, hasCutPiece }] }. `applies` is
 * false where the company files neither — it has no cut pieces to make.
 */
export async function cutPieceGaps(db, companyId, itemIds) {
  const ids = [...new Set(itemIds.map(Number))];
  const none = { applies: false, parts: [] };
  if (!ids.length) return none;
  const [nodes] = await db.query(
    `SELECT n.id, n.code, n.name, p.name AS parent_name
       FROM cf_classification_nodes n
       LEFT JOIN cf_classification_nodes p ON p.id = n.parent_id AND p.deleted_at IS NULL
      WHERE n.company_id = ? AND n.deleted_at IS NULL AND (n.code IN (?) OR n.name = 'Parts')`,
    [companyId, [PARTS_CODE, CUT_PLATE_CODE]],
  );
  const partsNode = nodes.find((n) => n.code === PARTS_CODE)
    ?? nodes.filter((n) => n.name === 'Parts' && n.parent_name === 'Fabricated').sort((a, b) => a.id - b.id)[0];
  const cutNode = nodes.find((n) => n.code === CUT_PLATE_CODE);
  if (!partsNode || !cutNode) return none;
  const [rows] = await db.query(
    `WITH RECURSIVE pt AS (
       SELECT id FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL
       UNION ALL
       SELECT n.id FROM cf_classification_nodes n JOIN pt ON n.parent_id = pt.id WHERE n.company_id = ? AND n.deleted_at IS NULL
     ), ct AS (
       SELECT id FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL
       UNION ALL
       SELECT n.id FROM cf_classification_nodes n JOIN ct ON n.parent_id = ct.id WHERE n.company_id = ? AND n.deleted_at IS NULL
     )
     SELECT m.id, m.code, m.name,
            EXISTS (SELECT 1 FROM cf_boms b
                      JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
                      JOIN cf_master_records x ON x.id = l.child_id AND x.deleted_at IS NULL
                     WHERE b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL
                       AND x.classification_id IN (SELECT id FROM ct)) AS has_cut
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.item_type = 'temporary'
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL
        AND m.classification_id IN (SELECT id FROM pt)
      ORDER BY m.id`,
    [companyId, partsNode.id, companyId, companyId, cutNode.id, companyId, companyId, ids],
  );
  return { applies: true, parts: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, hasCutPiece: !!Number(r.has_cut) })) };
}

// --- the checks ---------------------------------------------------------------------

/**
 * Everything that decides whether the line can be locked, and what lock would
 * write. Read-only. Each check says, in words, what it found and what to do:
 *
 *   { key, ok, applies, title, detail, todo?, stageKey?, problems? }
 *
 * `problems` is every failing check's sentences, flattened — exactly what
 * lockLine refuses with.
 */
async function lockChecks(db, companyId, line) {
  const checks = [];
  const add = (c) => { checks.push({ applies: true, problems: [], ...c }); };
  const out = { checks, problems: [], plan: null, coded: null, memo: null, position: null, siblings: [] };

  // 1. The line itself: something to lock, on an order still being worked.
  const refusals = [];
  if (line.line_type !== 'custom') refusals.push(`Line ${line.line_no} sells ${line.item_code ?? line.item_name ?? 'a catalog item'} as it is, from the catalog — only a line built from a template has a structure to lock.`);
  else if (!line.item_id) refusals.push(`Line ${line.line_no} has no item yet.`);
  if (line.order_status === 'revised') refusals.push(revisedOrderMessage(line.order_code, line.order_revision, line.order_latest_revision));
  else if (LOCKED_ORDER_STATUSES.has(line.order_status)) refusals.push(`Order ${line.order_code} is ${line.order_status} — nothing on it is locked any more.`);
  if (line.release_id) refusals.push(`Line ${line.line_no} was released to production before it was locked. Take the release back first, so its tracker and its locked pieces carry the same codes.`);
  add({
    key: 'line', ok: !refusals.length, title: 'A line built from a template, on an open order',
    detail: refusals.length ? refusals[0] : `Line ${line.line_no} of ${line.order_code} sells ${line.item_name ?? 'its structure'}.`,
    problems: refusals,
  });
  if (refusals.length) { out.problems = refusals; return out; }

  // 2. Its position among the order's lines of the same design.
  out.siblings = await siblingLines(db, companyId, line.id);
  out.position = positionAmong(out.siblings, line.id);

  // 3. Values — the Values stage's own count of what is still empty.
  const values = await readLineValues(db, companyId, line.id);
  const missing = [];
  for (const g of values.groups ?? []) {
    if (!g.own) continue;
    for (const r of g.rows) for (const [spec, cell] of Object.entries(r.cells ?? {})) if (cell.missing) missing.push(`${r.code ?? r.name} · ${spec}`);
  }
  const missingOwn = Number(values.counts?.missingOwn ?? missing.length);
  add({
    key: 'values', ok: missingOwn === 0, title: 'Every required value is filled', stageKey: 'values',
    detail: missingOwn === 0
      ? `All required values of the line's own ${plural(values.counts?.own ?? 0, 'row')} are filled.`
      : `${plural(missingOwn, 'required value')} ${missingOwn === 1 ? 'is' : 'are'} still empty — ${examples([...new Set(missing)])}.`,
    todo: missingOwn === 0 ? null : 'Fill them on the Values stage. The values freeze when the line is locked.',
    problems: missingOwn === 0 ? [] : [`${plural(missingOwn, 'required value')} of line ${line.line_no} ${missingOwn === 1 ? 'is' : 'are'} still empty — ${examples([...new Set(missing)])}.`],
  });

  // 4. The roll-out. Flows and the rows' own draft status are not asked here:
  //    a row is activated by lock, and a flow is release's business.
  const plan = await rollOutPlan(db, companyId, line);
  out.plan = plan;
  const nodes = plan.nodes ?? [];
  const pieces = nodes.filter((n) => n.pieceNo).length;
  // Cut pieces: every plate part pooled into the rectangle it is cut as. Asked
  // first, because a plate part with no cut piece is also "made out of
  // nothing" to the roll-out — and the cut-piece check says why, better.
  const temporaryIds = (plan.all ?? []).filter((n) => n.kind === 'temporary').map((n) => n.id);
  const cut = await cutPieceGaps(db, companyId, temporaryIds);
  const bare = cut.parts.filter((p) => !p.hasCutPiece);
  const bareIds = new Set(bare.map((p) => Number(p.id)));
  const saidByCut = new Set((plan.fromNothing ?? []).filter((f) => bareIds.has(Number(f.id))).map((f) => f.problem));
  const structural = plan.problems.filter((p) => !saidByCut.has(p));
  add({
    key: 'structure', ok: structural.length === 0, title: 'The structure rolls out into pieces', stageKey: 'structure',
    detail: structural.length === 0
      ? `It rolls out into ${plural(nodes.length, 'piece')} — ${count(pieces)} numbered one by one, ${plural(nodes.length - pieces, 'group')} of identical parts.`
      : `${plural(structural.length, 'thing stops', 'things stop')} it rolling out.`,
    todo: structural.length ? 'Settle them on the Structure stage — once the line is locked, its structure no longer changes.' : null,
    problems: structural,
  });

  // 5. The cut pieces, as asked above.
  add({
    key: 'cut_pieces', ok: bare.length === 0, applies: cut.applies && cut.parts.length > 0, title: 'Every plate part has its cut piece', stageKey: 'cut_pieces',
    detail: !cut.applies || !cut.parts.length
      ? 'No part of this line is cut from plate.'
      : bare.length === 0
        ? `All ${plural(cut.parts.length, 'plate part')} are pooled into cut pieces.`
        : `${plural(bare.length, 'plate part')} ${bare.length === 1 ? 'has' : 'have'} no cut piece yet — ${examples([...new Set(bare.map(nameOf))])}.`,
    todo: bare.length ? 'Cut pieces are made automatically as soon as the values are complete. If they have not appeared, open the Cut pieces stage.' : null,
    problems: bare.length ? [`${plural(bare.length, 'plate part')} of line ${line.line_no} ${bare.length === 1 ? 'has' : 'have'} no cut piece yet — ${examples([...new Set(bare.map(nameOf))])}.`] : [],
  });

  // 6. Codes: what lock would write, with the position it would give — every
  //    running number handed out in turn, none drawn.
  out.memo = await seedPieceMemo(db, companyId, line, nodes);
  const coded = await codeNodes(db, companyId, line, nodes, { consume: false, memo: out.memo, linePosition: out.position, takenChunk: 5000 });
  out.coded = coded;
  const codeProblems = [];
  const holes = new Map();
  for (const m of coded.missing) {
    const key = `${m.schemeCode}\u0000${m.missing.join(', ')}`;
    if (!holes.has(key)) holes.set(key, { scheme: m.schemeCode, needs: m.missing.join(', '), names: [] });
    holes.get(key).names.push(nameOf(m.node.design));
  }
  for (const h of holes.values()) {
    codeProblems.push(`Coding rule ${h.scheme} cannot number ${plural(h.names.length, 'piece')} — it needs ${h.needs}, which ${h.names.length === 1 ? 'that piece has' : 'they have'} not got (${examples([...new Set(h.names)])}).`);
  }
  const dup = [...new Set(coded.duplicates)];
  if (dup.length) codeProblems.push(`${plural(dup.length, 'code is', 'codes are')} given to more than one piece — ${examples(dup)}. Add something to the coding rule that tells them apart: the piece number, or the piece they go into.`);
  const taken = [...new Set(coded.taken)];
  if (taken.length) codeProblems.push(`${plural(taken.length, 'code already belongs', 'codes already belong')} to a piece of another line — ${examples(taken)}. Add something to the coding rule that tells lines apart: the order number, or the line position.`);
  const builtIn = nodes.filter((n) => !n.rule).length;
  add({
    key: 'codes', ok: codeProblems.length === 0, title: 'Every piece gets a code of its own',
    detail: codeProblems.length
      ? `${plural(codeProblems.length, 'thing stops', 'things stop')} the codes being written.`
      : !nodes.length ? 'There are no pieces to code yet.'
        : builtIn === nodes.length ? `No coding rule applies, so every code is the built-in one — ${nodes[0].code} for the first.`
          : `${plural(nodes.length - builtIn, 'code')} from a coding rule${builtIn ? `, ${count(builtIn)} from the built-in shape` : ''} — ${nodes[0].code} for the first.`,
    todo: codeProblems.length ? 'Change the coding rule under Setup › Coding rules, then look again.' : null,
    problems: codeProblems,
  });

  out.problems = checks.flatMap((c) => c.problems);
  return out;
}

// --- the view the Lock stage reads ------------------------------------------------------

function lineHead(line) {
  return {
    id: line.id, lineNo: line.line_no, lineType: line.line_type, orderId: line.order_id, orderCode: line.order_code, orderStatus: line.order_status,
    quantity: Number(line.quantity), item: line.item_id ? { id: line.item_id, code: line.item_code ?? null, name: line.item_name ?? null } : null,
  };
}

const EMPTY_SUMMARY = { nodes: 0, pieces: 0, groups: 0, codes: 0, byRule: 0, builtIn: 0, duplicates: 0, duplicatePieces: 0, taken: 0, missing: 0 };

/** Laid-out nodes as the Piece codes tree reads them — the release preview's shape. */
function shapeNodes(nodes, labelOf) {
  return nodes.map((n) => {
    const out = {
      k: n.k, parentK: n.parentK, depth: n.depth, code: n.code, pieceNo: n.pieceNo, pieceSeq: n.pieceSeq,
      quantity: n.quantity, itemId: n.itemId, rule: n.rule ?? null,
    };
    if (!n.pieceNo) out.label = `${labelOf(n)} ×${Number(n.quantity)}`;
    return out;
  });
}

/** What lock WOULD write, from the checks' run — before the line is locked. */
function planView(line, run, { withNodes, locked = null }) {
  const nodes = run.plan?.nodes ?? [];
  const coded = run.coded ?? { duplicates: [], taken: [], missing: [], byRule: 0 };
  const dup = new Set(coded.duplicates);
  const taken = [...new Set(coded.taken)];
  const pieces = nodes.filter((n) => n.pieceNo).length;
  const view = {
    line: lineHead(line),
    released: line.release_id ? { id: line.release_id } : null,
    locked,
    position: run.position == null ? null : { value: run.position, text: pad2(run.position), lines: run.siblings.length },
    canLock: !locked && run.problems.length === 0,
    checks: run.checks,
    problems: run.problems,
    truncated: !!run.plan?.truncated,
    summary: nodes.length ? {
      nodes: nodes.length, pieces, groups: nodes.length - pieces, codes: new Set(nodes.map((n) => n.code)).size,
      byRule: coded.byRule, builtIn: nodes.filter((n) => !n.rule).length,
      duplicates: dup.size, duplicatePieces: nodes.filter((n) => dup.has(n.code)).length, taken: taken.length, missing: coded.missing.length,
    } : { ...EMPTY_SUMMARY },
    nodes: [],
    items: {},
    duplicates: [...dup],
    taken,
    missing: coded.missing.map((m) => ({ k: m.node.k, itemCode: m.node.design.code ?? null, schemeCode: m.schemeCode, missing: m.missing })),
  };
  if (withNodes) {
    view.nodes = shapeNodes(nodes, (n) => n.design.code ?? n.design.name);
    for (const n of nodes) {
      if (!(n.itemId in view.items)) view.items[n.itemId] = { code: n.design.code ?? null, name: n.design.name ?? null, uom: n.design.uom ?? null };
    }
  }
  return view;
}

/** A locked line: its pieces as they were written. Two queries (one without the nodes). */
async function lockedView(db, companyId, line, { withNodes }) {
  const rows = await lockedPiecesOf(db, companyId, line.id);
  const kOf = new Map(rows.map((r, i) => [Number(r.id), i]));
  const nodes = rows.map((r, i) => ({
    k: i, parentK: r.parent_id != null ? kOf.get(Number(r.parent_id)) ?? null : null, depth: r.depth, code: r.code,
    pieceNo: r.piece_no, pieceSeq: seqOut(r.piece_seq), quantity: Number(r.quantity), itemId: r.item_id, rule: r.rule_code ?? null,
  }));
  const pieces = nodes.filter((n) => n.pieceNo).length;
  const items = {};
  if (withNodes && nodes.length) {
    const [its] = await db.query(
      `SELECT m.id, m.code, m.name, i.uom FROM cf_master_records m LEFT JOIN cf_item_details i ON i.master_id = m.id
        WHERE m.company_id = ? AND m.id IN (?)`,
      [companyId, [...new Set(nodes.map((n) => n.itemId))]],
    );
    for (const r of its) items[r.id] = { code: r.code ?? null, name: r.name ?? null, uom: r.uom ?? null };
  }
  const lines = await siblingLines(db, companyId, line.id);
  return {
    line: lineHead(line),
    released: line.release_id ? { id: line.release_id } : null,
    locked: {
      at: line.locked_at, by: line.locked_by ? { id: line.locked_by, name: line.locked_by_name ?? null } : null,
      position: line.lock_position, pieces: nodes.length,
    },
    position: { value: line.lock_position, text: pad2(line.lock_position), lines: lines.length },
    canLock: false,
    checks: [],
    problems: [],
    truncated: false,
    summary: {
      ...EMPTY_SUMMARY, nodes: nodes.length, pieces, groups: nodes.length - pieces, codes: new Set(nodes.map((n) => n.code)).size,
      byRule: nodes.filter((n) => n.rule).length, builtIn: nodes.filter((n) => !n.rule).length,
    },
    nodes: withNodes ? shapeNodes(nodes, (n) => items[n.itemId]?.code ?? items[n.itemId]?.name ?? `#${n.itemId}`) : [],
    items,
    duplicates: [],
    taken: [],
    missing: [],
  };
}

/**
 * GET /order-lines/:id/lock — what locking would do, read-only: the checks, in
 * words, and the pieces exactly as lock would write them (codes, with the
 * position lock would give). Once locked: the locked pieces as written.
 * `nodes` asks for the piece tree itself — heavy on a big line, so the screen
 * asks for it only when somebody wants to look.
 */
export async function lockPlan(db, companyId, lineId, { nodes: withNodes = false } = {}) {
  const line = await requireLine(db, companyId, lineId);
  if (line.locked_at) return lockedView(db, companyId, line, { withNodes });
  return planView(line, await lockChecks(db, companyId, line), { withNodes });
}

// --- locking ----------------------------------------------------------------------

/** Every level of the tree in one or a few multi-row INSERTs; the new ids read back by path key. */
async function writePieces(db, c, line, nodes) {
  const levels = new Map();
  for (const n of nodes) {
    if (!levels.has(n.depth)) levels.set(n.depth, []);
    levels.get(n.depth).push(n);
  }
  const depths = [...levels.keys()].sort((a, b) => a - b);
  for (const [i, depth] of depths.entries()) {
    const level = levels.get(depth);
    await insertRows(db, 'cf_order_pieces', PIECE_COLUMNS, level.map((n) => [
      c.companyId, line.order_id, line.id, n.parentK != null ? nodes[n.parentK].pieceId : null, n.itemId, n.bomLineId,
      n.pieceNo, n.pieceSeq == null ? null : String(n.pieceSeq), n.quantity, n.code, n.rule ?? null, n.pathKey, n.depth, n.k + 1, c.userId,
    ]), INSERT_CHUNK);
    if (i === depths.length - 1) break;   // nothing below needs these ids
    const [back] = await db.query(
      'SELECT id, path_key FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND depth = ? AND deleted_at IS NULL',
      [c.companyId, line.id, depth],
    );
    const idOf = new Map(back.map((r) => [r.path_key, r.id]));
    for (const n of level) {
      n.pieceId = idOf.get(n.pathKey);
      if (!n.pieceId) throw new Error(`cf_erp: locked piece ${n.pathKey} of line ${line.id} vanished between insert and read-back.`);
    }
  }
}

/**
 * POST /order-lines/:id/lock — locks the line (see the header). Refuses, with
 * every problem at once (422), unless every check passes. Needs a transaction.
 * Returns the Lock stage's view of the locked line (without the piece tree).
 */
export async function lockLine(db, c, lineId) {
  const { companyId } = c;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  if (line.locked_at) {
    throw invalid('ALREADY_LOCKED', `Line ${line.line_no} of ${line.order_code} is already locked — its pieces carry their codes, and a change means a new revision.`);
  }
  // THE CUT PIECES ARE BROUGHT UP TO DATE HERE, before the checks read the
  // structure — derived when the line has plate parts and its values are
  // complete, a no-op otherwise, and never a refusal of its own: the checks
  // below say what is missing. (lockPlan must not call it — a look writes nothing.)
  await refreshCutPieces(db, c, line.id);
  const run = await lockChecks(db, companyId, line);
  if (run.problems.length) {
    throw invalid('NOT_READY', `Line ${line.line_no} of ${line.order_code} cannot be locked yet.`, { problems: run.problems, detail: { checks: run.checks } });
  }
  const { plan } = run;

  // A rule with a running number draws its numbers for real now. Everything
  // else the dry run coded is already final, so it is not coded twice.
  if (run.coded.numbered > 0) {
    const again = await codeNodes(db, companyId, line, plan.nodes, { consume: true, memo: run.memo, linePosition: run.position, takenChunk: 5000 });
    const clash = [...new Set([...again.duplicates, ...again.taken])];
    if (clash.length) throw invalid('CODE_CLASH', `${clash[0]} would be carried by two pieces — another line drew the same running number a moment ago. Lock the line again.`);
    run.coded = again;
  }

  // The values freeze next, so they are brought up to date first — in bulk.
  const own = [...new Set(plan.all.filter((n) => n.kind === 'temporary').map((n) => n.id))];
  if (own.length) await materializeLineRecords(db, c, line.id, own);

  // A row has no draft life of its own: locking the line is what activates
  // its rows and cut pieces. No code is minted for a row.
  await db.query(
    `UPDATE cf_master_records m
       JOIN cf_item_details i ON i.company_id = m.company_id AND i.master_id = m.id AND i.deleted_at IS NULL
        SET m.status = 'active'
      WHERE m.company_id = ? AND i.owner_order_line_id = ? AND i.item_type = 'temporary'
        AND m.deleted_at IS NULL AND m.status = 'draft'`,
    [companyId, line.id],
  );

  // A REVISION (init.sql §27): the first line of revision N to lock retires
  // every live piece of the revisions before it — their codes are freed, so an
  // unchanged line locks to exactly the codes it had. The checks above did not
  // count those pieces as taken (rollOutService.takenCodes). Asked on every
  // lock of a revision, since after the first there is nothing left to retire;
  // never on a first revision, which has nothing before it. One statement.
  if (Number(line.order_revision) > 1) {
    await db.query(
      `UPDATE cf_order_pieces p
         JOIN cf_sales_orders e ON e.company_id = p.company_id AND e.id = p.order_id
          SET p.deleted_at = NOW()
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND e.code_active = LOWER(?) AND e.revision < ?`,
      [companyId, line.order_code, Number(line.order_revision)],
    );
    // Their contractor work-order cells go with them (init.sql §30): a cell of a
    // retired piece is work nobody will do, and an open work order left empty
    // is cancelled. The new pieces start in-house. Two statements.
    await retireCellsOfRetiredPieces(db, companyId, { orderCode: line.order_code, beforeRevision: Number(line.order_revision) });
  }
  await writePieces(db, c, line, plan.nodes);
  await db.query(
    'UPDATE cf_sales_order_lines SET locked_at = NOW(), locked_by = ?, lock_position = ? WHERE company_id = ? AND id = ?',
    [c.userId ?? null, run.position, companyId, line.id],
  );
  const [[stamp]] = await db.query('SELECT locked_at FROM cf_sales_order_lines WHERE company_id = ? AND id = ?', [companyId, line.id]);
  return planView(line, run, {
    withNodes: false,
    locked: { at: stamp.locked_at, by: c.userId ? { id: c.userId, name: null } : null, position: run.position, pieces: plan.nodes.length },
  });
}
