/**
 * placeholderService.js — the code each row of an order's structure will give
 * its pieces, shown before the pieces exist.
 *
 * A row is a design with a quantity, not an item (user, 2026-09-26 — "the codes
 * can't live on the BOM as it is yet to be rolled out based on the quantity …
 * we could show a code with numbers having a placeholder"). Its pieces are coded
 * when the line is LOCKED. Until then each row shows the code its pieces will
 * get, with # where the roll-out puts a number that differs from piece to piece:
 *
 *   SO-20260926-0001-SPAN-01-#-G1-1-IS1-21   ×42
 *
 * It is the lock's own roll-out (rollOutService.rollOutPlan), coded once per DESIGN rather than
 * once per piece:
 *   - a number every piece of the row shares is printed — the only girder under
 *     its span is G1, a group of 21 identical parts is 1-21 under every parent;
 *   - a number that differs from piece to piece is # (HOLE) — the span of a
 *     line of two, the three girders of one row;
 *   - the parent's part is the parent row's placeholder, so the #s of the rows
 *     above carry down.
 * The coding rules are the piece rules lock uses, read once, and the items come
 * from one seeded memo — a handful of round trips for the whole line. Nothing is
 * written and no running number moves.
 *
 * A row the roll-out makes no piece of (a bought item, drawn from stock) has no
 * placeholder: it keeps its own catalog code. Where no coding rule applies, the
 * placeholder is lock's built-in shape ({order}-{short name}-{position}-# on top,
 * {parent}-{short name}# below) — always what lock will write.
 */
import { notFound } from '../lib/errors.js';
import { generate, HOLE } from '../modules/codegen/index.js';
import { readRulesOnce, rangesOfBoms, shortNameOf } from './codeRangeService.js';
import {
  rollOutPlan, linePositionOf, seedPieceMemo, lockedPiecesOf, lockedBothOf, builtInCode,
  layOutPieces, itemDetails, MAX_DEPTH,
} from './rollOutService.js';
import { explode } from './bomService.js';
import { requireMaster, loadMasters } from './records.js';

async function requireLine(db, companyId, lineId) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, lineId],
  );
  if (!l) throw notFound('Order line');
  return l;
}

/** One value for the whole row, or HOLE when its pieces differ. */
const sharedOr = (values) => {
  const seen = new Set(values.map((v) => (v == null ? '' : String(v))));
  return seen.size === 1 ? values[0] : HOLE;
};
const pieceSeqOf = (pieces) => sharedOr(pieces.map((p) => p.pieceSeq));

/**
 * GET /order-lines/:id/placeholders
 *
 *   { lineId, locked, position,
 *     rows: [{ bomLineId, itemId, code, pieces, seqRange }],
 *     missing: [{ bomLineId, itemId, schemeCode, missing }] }
 *
 *   rows      one per design that rolls out pieces, parents first. bomLineId is
 *             the BOM row (null for what the line itself sells); pieces is how
 *             many physical pieces the row becomes on this line. seqRange
 *             [from, to] is what the # after its short name runs over under each
 *             parent piece (two stiffener rows under one segment: 1-21 and
 *             22-24), or null when the row's number does not vary.
 *   position  the line's number among the order's lines of the same design —
 *             what lock gives it (or gave it, once locked).
 *   missing   rows whose coding rule leans on something they have not got. Their
 *             code here is the built-in shape (what lock writes where no rule
 *             applies), and lock refuses them until the rule has what it needs.
 */
export async function linePlaceholders(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const out = { lineId: line.id, locked: !!line.locked_at, position: null, rows: [], missing: [] };
  if (!line.item_id) return out;
  // A locked line rolls out as it was locked: its 'both' items stay made or
  // drawn as the lock decided (rollOutService.madeRule), not as stock stands today.
  const lockedBoth = line.locked_at ? lockedBothOf(await lockedPiecesOf(db, companyId, line.id)) : null;
  const plan = await rollOutPlan(db, companyId, line, { lockedBoth });
  const nodes = plan.nodes ?? [];
  if (!nodes.length) return out;
  out.position = await linePositionOf(db, companyId, line.id);

  const memo = await seedPieceMemo(db, companyId, line, nodes);
  const coded = await codeDesigns(readRulesOnce(db), companyId, nodes, {
    // One design per BOM line (or the line's own item): an order's rows are its
    // own temporary items, so a BOM line sits under one parent row.
    keyOf: (n) => (n.bomLineId != null ? `l${n.bomLineId}` : `i${n.itemId}`),
    draft: { orderId: line.order_id, lineNo: line.line_no, linePosition: out.position },
    memo,
    fallback: (n, parentCode) => builtInCode(n, parentCode, line, out.position, memo),
  });
  out.rows = coded.rows.map(({ bomLineId, itemId, code, seqRange, pieces }) => ({ bomLineId, itemId, code, seqRange, pieces }));
  out.missing = coded.missing;
  return out;
}

/**
 * THE SHARED CODER — one code per DESIGN of a laid-out tree (layOutPieces'
 * nodes), parents first, by the production-piece coding rules lock uses:
 *   - a number every piece of the design shares is printed (G1, IS1-21);
 *   - a number that differs from piece to piece is # (HOLE), and seqRange says
 *     what it runs over under one parent piece;
 *   - the parent's part is the parent design's code, so #s carry down.
 * Nothing is read here except through `rules` (readRulesOnce: the rules once)
 * and `memo` (seedPieceMemo: every item, definition and chain once) — no round
 * trip per row. Used by an order line's placeholders (linePlaceholders) and a
 * catalog item's or definition's BOM codes (recordBomCodes), so both print the
 * same codes for the same tree.
 *
 *   keyOf(node)              which design a piece belongs to
 *   draft                    { orderId, lineNo, linePosition } — what the rules may print
 *   fallback(n, parentCode)  the built-in shape where no rule applies (builtInCode)
 *   rootCode                 when given, the top design's code is this (a catalog
 *                            item's own code) rather than a generated one
 *
 * Returns { rows: [{ key, bomLineId, itemId, code, seqRange, pieces }], missing }.
 */
export async function codeDesigns(rules, companyId, nodes, { keyOf, draft = {}, memo, fallback, rootCode = null }) {
  const out = { rows: [], missing: [] };
  // The pieces of each design, in the order the roll-out laid them out — a
  // parent's first piece always comes before any piece of its children.
  const groups = new Map();
  for (const n of nodes) {
    const key = keyOf(n);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const placeholder = new Map(); // design key -> its text
  for (const [key, pieces] of groups) {
    const first = pieces[0];
    const parent = first.parentK != null ? nodes[first.parentK] : null;
    const parentCode = parent ? placeholder.get(keyOf(parent)) ?? null : null;
    const pieceNo = sharedOr(pieces.map((p) => p.pieceNo));
    const pieceSeq = pieceSeqOf(pieces);
    let code;
    if (!parent && rootCode != null) code = rootCode;
    else {
      const g = await generate(rules, companyId, 'production_piece', 'code', {
        draft: { ...draft, itemId: first.itemId, parentCode, pieceNo, pieceSeq, memo },
      }, { consume: false }).catch((err) => {
        if (err?.code !== 'TOKEN_MISSING') throw err;
        return { text: null, missing: err.problems ?? [err.message] };
      });
      // No rule applies (or one leans on something the row has not got): lock
      // writes its built-in shape then, so the placeholder shows that shape too.
      code = g?.text || await fallback({ ...first, pieceNo, pieceSeq }, parentCode);
      if (!g?.text && g?.missing?.length) {
        out.missing.push({ bomLineId: first.bomLineId ?? null, itemId: first.itemId, schemeCode: g.schemeCode ?? null, missing: g.missing });
      }
    }
    placeholder.set(key, code);
    // What # runs over under one parent piece: the row's own range there.
    let seqRange = null;
    if (pieceSeq === HOLE) {
      const nums = pieces.filter((p) => p.parentK === first.parentK).map((p) => Number(p.pieceSeq)).filter(Number.isFinite);
      if (nums.length) seqRange = [Math.min(...nums), Math.max(...nums)];
    }
    out.rows.push({
      key,
      bomLineId: first.bomLineId ?? null,
      itemId: first.itemId,
      code,
      seqRange,
      pieces: Number(pieces.reduce((sum, p) => sum + Number(p.quantity ?? 1), 0).toFixed(6)),
    });
  }
  return out;
}

/**
 * GET /records/:id/bom/codes — a catalog item's or a definition's BOM coded the
 * way an order codes its rows (user, 2026-10-01: "the way it is in sales order,
 * we should have the same for a catalog item — where there is code generated
 * based on quantity, position, shortname and all"). A PREVIEW: nothing is
 * minted or stored, and no running number moves — a catalog BOM is a design.
 *
 *   - The top is the record's own code; a record still without one (a draft)
 *     shows its short name, as an order's built-in top shape does.
 *   - EVERY row is coded. In an order a stock or bought catalog row is material
 *     and keeps its own catalog code; on a catalog BOM nothing is drawn from
 *     stock yet, so every row is a position and gets one.
 *   - Rows are told apart by WHERE they sit, not by what they hold: the same
 *     child twice is two rows with two codes (…-WB1, …-WB2), and a sub-BOM that
 *     hangs under both is coded once under each. So a row is keyed by its
 *     explode() node key — the key the BOM screens draw rows by.
 *
 *   { recordId, rootCode, rows: [{ key, bomLineId, itemId, code, seqRange, pieces }],
 *     missing, problems, truncated }
 *
 * Set-based: one explosion (a read per level — the BOM tab's own tree), the item
 * details, the ranges, the memo and the rules; nothing per row. `opts.tree`
 * reuses an explosion the caller already holds (the BOM sheet export).
 */
export async function recordBomCodes(db, companyId, recordId, { tree = null } = {}) {
  const record = await requireMaster(db, companyId, recordId);
  const t = tree ?? await explode(db, companyId, record.id, { rootQuantity: 1, maxDepth: MAX_DEPTH });
  const out = { recordId: record.id, rootCode: null, rows: [], missing: [], problems: [], truncated: !!t.truncated };
  const all = [];
  const mark = (n) => { n.made = true; all.push(n); n.children.forEach(mark); };
  mark(t.root);
  const detail = await itemDetails(db, companyId, all.map((n) => n.id));
  const sourceDef = new Map([...detail].map(([id, d]) => [id, d.source_definition_id]));
  const lineRanges = await rangesOfBoms(db, companyId, [...new Set(all.filter((n) => n.bom).map((n) => n.bom.id))]);
  const laid = layOutPieces(t.root, { quantity: 1, lineRanges, sourceDef, rootAsMaterial: false });
  out.problems = laid.problems;
  out.truncated = out.truncated || laid.truncated;
  const nodes = laid.nodes;
  const noLine = { order_id: null, order_code: null };
  const memo = await seedPieceMemo(db, companyId, noLine, nodes);
  if (record.code) out.rootCode = record.code;
  else {
    const defId = record.source_definition_id ?? null;
    const def = defId != null ? (memo.get(`master:${defId}`) ?? (await loadMasters(db, companyId, [defId])).get(defId) ?? null) : null;
    out.rootCode = shortNameOf(record, def) ?? `I${record.id}`;
  }
  if (!nodes.length) return out;
  const coded = await codeDesigns(readRulesOnce(db), companyId, nodes, {
    keyOf: (n) => n.design.key,
    draft: { orderId: null, lineNo: null, linePosition: null },
    memo,
    fallback: (n, parentCode) => builtInCode(n, parentCode, noLine, null, memo),
    rootCode: out.rootCode,
  });
  out.rows = coded.rows;
  out.missing = coded.missing;
  return out;
}
