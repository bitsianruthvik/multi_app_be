/**
 * codeRangeService.js — running piece numbers per parent: which pieces a BOM
 * row covers under its parent, and keeping the codes built from that true.
 *
 * Decided by the user 2026-09-26. When a sub-assembly repeats exactly it goes
 * on ONE row with a quantity; when a copy differs slightly, the row is copied
 * and the copy changed. Numbering follows where each piece comes UNDER ITS
 * PARENT:
 *
 *     under one parent, rows in the order they are shown
 *       IS  x23  (plain)          -> pieces  1 … 23
 *       IS  x3   (copy, drilled)  -> pieces 24 … 26
 *       TF  x1                    -> 1       its own short name, its own count
 *
 *   - Rows share a count when their child has the same SHORT NAME (compared
 *     without case), under the same parent, in the order the rows are shown. A
 *     copy keeps its short name, so it carries on the count; a renamed short
 *     name starts a count of its own.
 *   - The count starts again at 1 under every parent.
 *   - A quantity that is not a whole number is not a count of pieces (2.5 m² of
 *     plate), so that row has NO range — said in words, never rounded — and
 *     neither has any row after it in the same group, whose numbers would have
 *     to be counted on from it.
 *
 * The ROW carries its range — the `range` token, "…-IS24-26" — and each
 * physical piece gets its own number when the line is released — `piece.seq`,
 * "…-IS24", worked out in releaseService from the same ranges.
 *
 * WHICH SHORT NAME. The one the code prints: codegenProvider's
 * record.shortName, which is the child's own, else its template definition's,
 * else the first word of its name (shortNameOf, below — codegenProvider uses
 * this very function). Not cf_master_records.short_name on its own: a temporary
 * item is born without one and prints its definition's, so on the KEPL order
 * 183 of the 208 temporary items have none of their own, and grouping on the
 * bare column would count TF and IS as one kind.
 *
 * WHICH ORDER. bomGraph.linesOfBom and linesOfBoms — and so explode(), which
 * the BOM tab, an order's Structure tab and release all draw from — put a
 * BOM's lines in `l.line_no, l.id` order. DISPLAY_ORDER below is the same, so
 * the numbers are the ones people see. (uq_cbl_line_no makes line_no unique
 * among a BOM's live lines, so in practice it is line-number order.)
 *
 * Imports no other cf_erp service that could import it back: codegenProvider
 * imports this file for the `range` token, bomService for its hooks and
 * releaseService for piece numbers.
 */
import { invalid } from '../lib/errors.js';
import { ancestors } from './tree.js';
import { resolve, effectiveByCode } from './resolutionService.js';
import { generate } from '../modules/codegen/index.js';

/**
 * How codegenProvider recognises an item this service has already loaded: a
 * draft carrying this key becomes a context straight from the data, with the
 * one BOM line the item sits on. A Symbol, so nothing that arrives as JSON —
 * the rules screen's preview — can pose as one.
 */
export const PLACED = Symbol('cf_erp.placedItem');

const EPS = 1e-9;
const fmt = (n) => String(Number(Number(n).toFixed(6)));
const isCount = (q) => Number.isFinite(q) && q > 1 - EPS && Math.abs(q - Math.round(q)) < EPS;

/** 24 for one piece, "24-26" for several — the shape the `range` and `piece.seq` tokens print. */
export const seqValue = (start, count) => (count === 1 ? start : `${start}-${start + count - 1}`);

// ---- short names ---------------------------------------------------------------

/**
 * A record's own short name. NULL is "not set yet" — fall back. An EMPTY one
 * was set to none on purpose (user, 2026-09-26) and stops the fallback: it
 * prints nothing, and its rows share one count under their parent.
 */
const namedShort = (record) => (record?.short_name == null ? null : String(record.short_name).toUpperCase());

/** Last resort: the first word of the name, so a rule still renders before anybody fills the field in. */
const wordShort = (record) => {
  const word = String(record?.name ?? '').trim().split(/[\s/,-]+/)[0] ?? '';
  const letters = word.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return letters ? letters.slice(0, 8) : null;
};

/**
 * "Use the short name of the catalog item OR TEMPLATE DEFINITION" (user,
 * 2026-09-23) — so a temporary item with no short name of its own takes its
 * template's, and only then falls back to a word of its name. Asking the
 * fallback first would mean the template's short name was never reached: a
 * temporary item is always named after something.
 */
export function shortNameOf(record, def = null) {
  return namedShort(record) ?? namedShort(def) ?? wordShort(record) ?? wordShort(def);
}

const shortOfLine = (l) => shortNameOf(
  { short_name: l.child_short_name, name: l.child_name },
  { short_name: l.def_short_name, name: l.def_name },
);

// ---- the rows ------------------------------------------------------------------

/** The order every BOM screen shows a parent's rows in (see the header). */
const DISPLAY_ORDER = 'l.line_no, l.id';

/**
 * A parent's live rows with what each child is called — its own short name,
 * its template's, and both names for the fallback — and the parent's code,
 * which is what a child's code is built on.
 */
const linesSql = (where, extraColumns = '') => `
  SELECT l.id, l.bom_id, b.parent_id, b.bom_type, l.line_no, l.position, l.quantity, l.role, l.child_id,
         p.code AS parent_code, p.name AS parent_name,
         ch.code AS child_code, ch.name AS child_name, ch.short_name AS child_short_name,
         ch.record_kind AS child_record_kind, ci.item_type AS child_item_type,
         sd.name AS def_name, sd.short_name AS def_short_name${extraColumns}
    FROM cf_bom_lines l
    JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
    JOIN cf_master_records p ON p.id = b.parent_id AND p.deleted_at IS NULL
    JOIN cf_master_records ch ON ch.id = l.child_id
    LEFT JOIN cf_item_details ci ON ci.master_id = l.child_id AND ci.deleted_at IS NULL
    LEFT JOIN cf_master_records sd ON sd.id = ci.source_definition_id AND sd.deleted_at IS NULL
   WHERE l.company_id = ? AND l.deleted_at IS NULL AND ${where}
   ORDER BY l.bom_id, ${DISPLAY_ORDER}`;

async function linesOfParents(db, companyId, parentIds) {
  if (!parentIds.length) return [];
  const [rows] = await db.query(linesSql('b.parent_id IN (?)'), [companyId, [...new Set(parentIds)]]);
  return rows;
}

const noRange = (base, reason) => ({ ...base, start: null, end: null, count: null, text: null, reason });

/**
 * Each row's range, from rows already in display order. Several BOMs may be
 * mixed in; each counts on its own. Pure — release and the code generator call
 * it on rows they already hold. Returns lineId -> range:
 *
 *   { lineId, bomId, lineNo, shortName, quantity, start, end, count, text, reason }
 *
 * where text is "1-23" (or "24" for one piece) and reason, when start is null,
 * says in words why the row has no range.
 */
export function rangesOf(lines) {
  const out = new Map();
  const groups = new Map();
  for (const l of lines) {
    const shortName = l.shortName ?? shortOfLine(l);
    const key = `${l.bom_id}\u0000${String(shortName ?? '').toUpperCase()}`;
    let group = groups.get(key);
    if (!group) { group = { next: 1, brokenBy: null }; groups.set(key, group); }
    const quantity = Number(l.quantity);
    const base = { lineId: l.id, bomId: l.bom_id, lineNo: l.line_no, shortName, quantity };
    if (group.brokenBy) {
      const b = group.brokenBy;
      out.set(l.id, noRange(base, `It comes after line ${b.lineNo} (${fmt(b.quantity)} ${shortName}), which is not a whole number of pieces, so the numbers after it cannot be counted.`));
      continue;
    }
    if (!isCount(quantity)) {
      group.brokenBy = { lineNo: l.line_no, quantity };
      out.set(l.id, noRange(base, `${fmt(quantity)} is not a whole number of pieces — an area or a length is not counted — so this row has no range.`));
      continue;
    }
    const count = Math.round(quantity);
    const start = group.next;
    group.next = start + count;
    out.set(l.id, { ...base, start, end: start + count - 1, count, text: String(seqValue(start, count)), reason: null });
  }
  return out;
}

/**
 * THE function: each row's range under one parent (one BOM), in display order.
 *
 *   { parentId, bomId, lines: [{ lineId, lineNo, childId, childCode, childKind,
 *                               shortName, quantity, start, end, count, text, reason }] }
 *
 * One query.
 */
export async function rangesOfParent(db, companyId, parentId) {
  const lines = await linesOfParents(db, companyId, [parentId]);
  const ranges = rangesOf(lines);
  return {
    parentId,
    bomId: lines[0]?.bom_id ?? null,
    lines: lines.map((l) => ({
      ...ranges.get(l.id),
      childId: l.child_id,
      childCode: l.child_code,
      childKind: l.child_record_kind === 'item' ? l.child_item_type : 'definition',
    })),
  };
}

/** The same for many parents at once — lineId -> range. One query. */
export async function rangesOfParents(db, companyId, parentIds) {
  return rangesOf(await linesOfParents(db, companyId, parentIds));
}

/** The same keyed by BOM — lineId -> range, for the whole exploded tree release works on. One query. */
export async function rangesOfBoms(db, companyId, bomIds) {
  if (!bomIds.length) return new Map();
  const [rows] = await db.query(linesSql('l.bom_id IN (?)'), [companyId, [...new Set(bomIds)]]);
  return rangesOf(rows);
}

const sharedBy = (n) => ({
  start: null, end: null, count: null, text: null,
  reason: `It sits on ${n} BOM lines — a piece shared by several parents has no single place to count from.`,
});

/**
 * The range of the line a placed temporary item sits on — `place` is
 * bomGraph.placementOf's answer — for the `range` token. One query.
 *
 * A temporary item that sits on more than one line (a blank several parts are
 * cut from) has no single place to count from, so it has no range either.
 */
export async function rangeOfPlacement(db, companyId, itemId, place) {
  const [rows] = await db.query(
    linesSql('l.bom_id = ?', `,
         (SELECT COUNT(*) FROM cf_bom_lines x
            JOIN cf_boms bx ON bx.id = x.bom_id AND bx.deleted_at IS NULL AND bx.bom_type = 'custom'
           WHERE x.company_id = l.company_id AND x.child_id = ? AND x.deleted_at IS NULL) AS placements`),
    [itemId, companyId, place.bom_id],
  );
  const placements = Number(rows[0]?.placements ?? 1);
  if (placements > 1) return sharedBy(placements);
  return rangesOf(rows).get(place.line_id) ?? null;
}

/**
 * piece.seq of a production piece already written — the number release gave
 * it, worked out again from the same rows: its row's first number plus how
 * many of its row's pieces come before it under the same parent piece; a
 * grouped card's whole range; the order line's own pieces 1 … n. The
 * structure of a live release is frozen, so the rows are still the ones it was
 * numbered from. Two queries at most.
 *
 * piece: { release_id, parent_id, bom_line_id, piece_no, quantity, sort_order }
 */
export async function savedPieceSeq(db, companyId, piece) {
  const q = Number(piece.quantity);
  if (piece.bom_line_id == null) {
    if (piece.piece_no != null) return piece.piece_no;
    return isCount(q) ? seqValue(1, Math.round(q)) : null;
  }
  const [rows] = await db.query(
    linesSql('l.bom_id = (SELECT x.bom_id FROM cf_bom_lines x WHERE x.company_id = ? AND x.id = ?)'),
    [companyId, companyId, piece.bom_line_id],
  );
  const r = rangesOf(rows).get(piece.bom_line_id);
  if (!r || r.start == null) return null;
  if (piece.piece_no == null) return isCount(q) ? seqValue(r.start, Math.round(q)) : null;
  const [[{ earlier }]] = await db.query(
    `SELECT COUNT(*) AS earlier FROM cf_production_items
      WHERE company_id = ? AND release_id = ? AND bom_line_id = ? AND parent_id <=> ? AND sort_order < ? AND deleted_at IS NULL`,
    [companyId, piece.release_id, piece.bom_line_id, piece.parent_id, piece.sort_order],
  );
  return r.start + Number(earlier);
}

// ---- keeping the codes true ------------------------------------------------------

/**
 * The items of one level, loaded once for all of them: records.loadMaster's
 * row (so frozenBy and resolve() read exactly what they always read), plus
 * what the code generator's context needs — the template definition, the owner
 * line and order — and how many BOM lines the item sits on. One query.
 */
async function loadPlacedItems(db, companyId, ids) {
  const [rows] = await db.query(
    `SELECT m.*,
            i.item_type, i.tracked_by, i.uom, i.sourcing, i.source_definition_id, i.owner_order_line_id,
            d.definition_type, d.selection_mode, d.candidate_classification_id,
            so.id AS owner_order_id, so.code AS owner_order_code, so.status AS owner_order_status, so.title AS owner_order_title,
            ol.id AS owner_line_row_id, ol.line_no AS owner_line_no, ol.position AS owner_line_position,
            ol.locked_at AS owner_line_locked_at, rel.id AS owner_release_id,
            sd.id AS def_id, sd.code AS def_code, sd.name AS def_name, sd.short_name AS def_short_name,
            (SELECT COUNT(*) FROM cf_bom_lines x
               JOIN cf_boms bx ON bx.id = x.bom_id AND bx.deleted_at IS NULL AND bx.bom_type = 'custom'
              WHERE x.company_id = m.company_id AND x.child_id = m.id AND x.deleted_at IS NULL) AS placements
       FROM cf_master_records m
       LEFT JOIN cf_item_details i       ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
       LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
       LEFT JOIN cf_sales_orders so      ON so.id = ol.order_id
       LEFT JOIN cf_production_releases rel ON rel.order_line_id = ol.id AND rel.deleted_at IS NULL
       LEFT JOIN cf_master_records sd    ON sd.id = i.source_definition_id AND sd.company_id = m.company_id AND sd.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
    [companyId, ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

const RULE_READ = /^\s*SELECT\b[\s\S]*\bFROM\s+cf_code_(?:schemes|scheme_conditions|scheme_segments|sequences)\b/i;

/**
 * generate() reads the coding rules the same way for every record of a batch —
 * the active rules, their conditions, the chosen rule's pattern. Answer each of
 * those reads once per batch; pass everything else straight through, including
 * a running number drawn for real (SELECT … FOR UPDATE, then UPDATE). A Proxy,
 * so whatever else rides on the connection (the transaction's classification
 * memo) is still there. Used by nameNewItems, and by release per tree.
 */
export function readRulesOnce(db) {
  const seen = new Map();
  const query = (sql, params) => {
    if (!RULE_READ.test(sql) || /\bFOR\s+UPDATE\b/i.test(sql)) return db.query(sql, params);
    const key = `${sql}\u0000${JSON.stringify(params ?? [])}`;
    if (!seen.has(key)) seen.set(key, db.query(sql, params));
    return seen.get(key);
  };
  return new Proxy(db, { get: (target, prop) => (prop === 'query' ? query : Reflect.get(target, prop)) });
}

/**
 * NAMES FOR ROWS JUST CREATED IN BULK — the batched template copy
 * (instantiationService). A row of an order's BOM is a design with a quantity,
 * not an item: it gets NO code (user, 2026-09-26 — "the codes can't live on the
 * BOM as it is yet to be rolled out based on the quantity"). Codes are given to
 * the pieces at LOCK. What a row does get is its name, as finishCreate names a
 * record: a naming rule's name, else the fallback (its template's name).
 *
 *   - In the order the per-item copy created them — depth first, a parent before
 *     its children, siblings in line order — so a naming rule that draws a
 *     running number hands the numbers out as it always did.
 *   - Loaded ONCE for the tree (loadPlacedItems, the lines that hold them, the
 *     rules via readRulesOnce), written at the end in a few statements.
 *   - Specification values are resolved only for a row whose naming rule prints
 *     one: a dry pass says which tokens the rule reads.
 *
 *   rootId        the first new row
 *   parentId      the record it was put under (a template added to a Custom
 *                 BOM), or null when it is what the order line sells
 *   ids           every new row — only these are named
 *   fallbackName  Map(id -> name) when no naming rule applies
 *
 * Every new row leaves with its name and NO code — the placeholder code the
 * caller wrote to read the ids back is cleared. Returns { named }.
 */
export async function nameNewItems(db, c, { rootId, parentId = null, ids, fallbackName = new Map() }) {
  const { companyId } = c;
  const rules = readRulesOnce(db);
  const newIds = new Set([...ids].map(Number));
  const chains = new Map();
  const chainOf = async (clsId) => {
    if (clsId == null) return [];
    if (!chains.has(clsId)) chains.set(clsId, await ancestors(db, companyId, clsId));
    return chains.get(clsId);
  };

  const all = [...newIds];
  const masters = new Map();
  for (let i = 0; i < all.length; i += 500) for (const [k, v] of await loadPlacedItems(db, companyId, all.slice(i, i + 500))) masters.set(k, v);
  const holders = [...(parentId == null ? [] : [parentId]), ...all];
  const lines = [];
  for (let i = 0; i < holders.length; i += 500) lines.push(...await linesOfParents(db, companyId, holders.slice(i, i + 500)));
  const ranges = rangesOf(lines);
  const linesUnder = new Map(); // parent id -> its lines, in the order they are shown
  for (const l of lines) {
    if (!linesUnder.has(l.parent_id)) linesUnder.set(l.parent_id, []);
    linesUnder.get(l.parent_id).push(l);
  }
  for (const list of linesUnder.values()) list.sort((a, b) => a.line_no - b.line_no || a.id - b.id);
  const nameOf = new Map();
  const written = []; // [id, name], in creation order

  const first = parentId == null
    ? [{ id: Number(rootId), line: null }]
    : (linesUnder.get(Number(parentId)) ?? []).filter((l) => Number(l.child_id) === Number(rootId)).map((l) => ({ id: Number(rootId), line: l }));
  const stack = [...first].reverse();
  let steps = 0;
  while (stack.length) {
    const x = stack.pop();
    if ((steps += 1) > newIds.size + 1) throw new Error('cf_erp: nameNewItems walked more rows than it was given — the structure loops.');
    const m = masters.get(x.id);
    if (m) {
      const parentName = x.line ? (nameOf.has(Number(x.line.parent_id)) ? nameOf.get(Number(x.line.parent_id)) : x.line.parent_name) : null;
      const data = {
        master: m,
        def: m.def_id ? { id: m.def_id, code: m.def_code, name: m.def_name, short_name: m.def_short_name } : null,
        chain: await chainOf(m.classification_id),
        specs: new Map(),
        owner: m.owner_line_row_id != null && m.owner_order_id != null
          ? { line_no: m.owner_line_no, position: m.owner_line_position, order_code: m.owner_order_code, order_title: m.owner_order_title }
          : null,
        place: x.line
          ? { line_id: x.line.id, bom_id: x.line.bom_id, line_no: x.line.line_no, position: x.line.position, quantity: x.line.quantity, role: x.line.role, parent_id: x.line.parent_id, parent_code: null, parent_name: parentName }
          : null,
        range: x.line ? ranges.get(x.line.id) ?? null : null,
        asked: new Set(),
      };
      const draft = { draft: { [PLACED]: data } };
      const dry = await generate(rules, companyId, 'item', 'name', draft, { consume: false });
      if (dry && [...data.asked].some((k) => k.startsWith('spec:'))) {
        data.specs = effectiveByCode(await resolve(db, companyId, { master: data.master }));
      }
      data.asked = new Set();
      // A naming rule that cannot be rendered stops the copy, as it stops finishCreate.
      const g = dry ? await generate(rules, companyId, 'item', 'name', draft, { consume: true }) : null;
      const name = g?.text ?? fallbackName.get(x.id) ?? null;
      if (!name) throw invalid('NAME_REQUIRED', 'Give the item a name — no naming rule applies to it.');
      nameOf.set(x.id, name);
      written.push([x.id, name]);
    }
    const kids = (linesUnder.get(x.id) ?? []).filter((l) => newIds.has(Number(l.child_id)));
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: Number(kids[i].child_id), line: kids[i] });
  }

  // Every name at once, and every placeholder code cleared.
  for (let i = 0; i < written.length; i += 100) {
    const part = written.slice(i, i + 100);
    const params = [];
    const names = part.map(([id, name]) => { params.push(id, name); return 'WHEN ? THEN ?'; }).join(' ');
    params.push(companyId, part.map(([id]) => id));
    await db.query(`UPDATE cf_master_records SET name = CASE id ${names} END, code = NULL WHERE company_id = ? AND id IN (?)`, params);
  }
  return { named: written.length };
}
