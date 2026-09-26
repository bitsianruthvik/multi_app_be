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
import { frozenBy } from './records.js';
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
const MAX_DEPTH = 25;
const fmt = (n) => String(Number(Number(n).toFixed(6)));
const isCount = (q) => Number.isFinite(q) && q > 1 - EPS && Math.abs(q - Math.round(q)) < EPS;

/** 24 for one piece, "24-26" for several — the shape the `range` and `piece.seq` tokens print. */
export const seqValue = (start, count) => (count === 1 ? start : `${start}-${start + count - 1}`);

// ---- short names ---------------------------------------------------------------

const namedShort = (record) => (record?.short_name ? String(record.short_name).toUpperCase() : null);

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
            rel.id AS owner_release_id,
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
 * memo) is still there. Used here per refresh, and by release per tree.
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

/** A row about to be added, counted as if it were already there (see refreshRangeCodes). */
function withInsert(lines, insert) {
  if (!lines.length) return lines;               // no rows yet, so nothing after it to move
  const phantom = {
    id: `insert:${insert.lineNo}`, bom_id: lines[0].bom_id, parent_id: lines[0].parent_id, bom_type: lines[0].bom_type,
    line_no: insert.lineNo, quantity: insert.quantity, shortName: insert.shortName ?? null, child_item_type: null,
  };
  const at = lines.findIndex((l) => l.line_no > insert.lineNo);
  return at < 0 ? [...lines, phantom] : [...lines.slice(0, at), phantom, ...lines.slice(at)];
}

/** Clears the moving codes first, then writes the new ones — after checking every new code is free. */
async function writeCodes(db, companyId, plans) {
  const ids = plans.map((p) => p.id);
  const seen = new Map();
  for (const p of plans) {
    const key = p.to.toLowerCase();
    if (seen.has(key)) {
      throw invalid('CODE_CLASH', `Renumbering would give two pieces the code ${p.to} (now ${seen.get(key).from ?? 'no code'} and ${p.from ?? 'no code'}). Give one of them a short name of its own.`);
    }
    seen.set(key, p);
  }
  const [taken] = await db.query(
    'SELECT id, code FROM cf_master_records WHERE company_id = ? AND code_active IN (?) AND id NOT IN (?)',
    [companyId, [...seen.keys()], ids],
  );
  if (taken.length) {
    const clash = seen.get(String(taken[0].code).toLowerCase());
    throw invalid('CODE_CLASH',
      `Renumbering would give ${clash?.from ?? 'a piece'} the code ${taken[0].code}, which another record already has. Change that record's code, or give this row's child a short name of its own.`,
      { problems: taken.map((t) => `${t.code} is taken`) });
  }
  // Two rows of one parent can trade numbers — reordering them does exactly
  // that — and uq_cmr_code is checked row by row, not at the end of the
  // statement. So the old codes are cleared first and the new ones written
  // after; neither is ever seen outside this transaction.
  await db.query('UPDATE cf_master_records SET code = NULL WHERE company_id = ? AND id IN (?)', [companyId, ids]);
  await db.query(
    `UPDATE cf_master_records SET code = CASE id ${plans.map(() => 'WHEN ? THEN ?').join(' ')} END
      WHERE company_id = ? AND id IN (?)`,
    [...plans.flatMap((p) => [p.id, p.to]), companyId, ids],
  );
}

function whyNoCode(g, data) {
  const missing = g?.missing ?? [];
  if (missing.includes('range') && data.range?.reason) return `Its row has no range: ${data.range.reason} Its code is kept as it was.`;
  return `Coding rule ${g?.schemeCode ?? '?'} needs ${missing.join(', ') || 'a value'}, which it has not got — its code is kept as it was.`;
}

/**
 * Regenerates the codes of one level: the temporary children on these rows
 * whose coding rule reads `needs`. Returns the ids whose code moved.
 */
async function recodeLevel(db, c, lines, needs, rules, out) {
  const { companyId } = c;
  const ranges = rangesOf(lines);
  const linesOf = new Map();
  for (const l of lines) {
    if (l.child_item_type !== 'temporary' || l.bom_type !== 'custom') continue;
    if (!linesOf.has(l.child_id)) linesOf.set(l.child_id, []);
    linesOf.get(l.child_id).push(l);
  }
  if (!linesOf.size) return [];
  const masters = await loadPlacedItems(db, companyId, [...linesOf.keys()]);
  const chains = new Map();
  for (const m of masters.values()) {
    // Memoised for the transaction (tree.js): the children of one parent
    // nearly always share one Variant, so this is one query or none.
    if (m.classification_id != null && !chains.has(m.classification_id)) chains.set(m.classification_id, await ancestors(db, companyId, m.classification_id));
  }

  const plans = [];
  for (const [id, placed] of linesOf) {
    const m = masters.get(id);
    if (!m) continue;
    out.checked += 1;
    // Release freezes the structure, and that is exactly when codes start being
    // painted on steel; a closed, lost or cancelled order is frozen too.
    const frozen = frozenBy(m);
    if (frozen) { out.frozen = out.frozen ?? frozen.reason; continue; }
    const line = placed[0];
    const placements = Math.max(placed.length, Number(m.placements) || 0);
    const hasOwner = !!m.owner_order_line_id;
    const data = {
      master: m,
      def: m.def_id ? { id: m.def_id, code: m.def_code, name: m.def_name, short_name: m.def_short_name } : null,
      chain: m.classification_id != null ? chains.get(m.classification_id) ?? [] : [],
      specs: new Map(),
      owner: hasOwner && m.owner_line_row_id != null && m.owner_order_id != null
        ? { line_no: m.owner_line_no, position: m.owner_line_position, order_code: m.owner_order_code, order_title: m.owner_order_title }
        : null,
      place: hasOwner
        ? { line_id: line.id, bom_id: line.bom_id, line_no: line.line_no, position: line.position, quantity: line.quantity, role: line.role, parent_id: line.parent_id, parent_code: line.parent_code, parent_name: line.parent_name }
        : null,
      range: placements > 1 ? sharedBy(placements) : ranges.get(line.id) ?? null,
      asked: new Set(),
    };
    const codeFor = () => generate(rules, companyId, 'item', 'code', { draft: { [PLACED]: data } }, { consume: false });
    let g = await codeFor();
    // No rule codes it, or its code does not read what moved: nothing to do.
    if (!g || !data.asked.has(needs)) continue;
    if (placements > 1) { out.skipped.push({ id, code: m.code, why: data.range.reason }); continue; }
    if (g.number != null) {
      out.skipped.push({ id, code: m.code, why: `Coding rule ${g.schemeCode} also draws a running number, and a number is never drawn twice — its code is kept as it was.` });
      continue;
    }
    // Specification values are read only for the items that need them, and
    // only once it is known their code depends on what moved.
    if ([...data.asked].some((k) => k.startsWith('spec:'))) {
      data.specs = effectiveByCode(await resolve(db, companyId, { master: m }));
      data.asked = new Set();
      g = await codeFor();
    }
    if (!g?.text) { out.skipped.push({ id, code: m.code, why: whyNoCode(g, data) }); continue; }
    if (g.text !== m.code) plans.push({ id, from: m.code, to: g.text });
  }
  if (!plans.length) return [];
  await writeCodes(db, companyId, plans);
  out.changed.push(...plans);
  return plans.map((p) => p.id);
}

/**
 * Brings the codes that print a range back in line after a parent's rows
 * moved — an earlier row of the same short name changed quantity, or a row was
 * added, removed or reordered.
 *
 * What it touches: the parent's TEMPORARY children whose coding rule reads
 * `range` — regenerated, and written only when the text changed — and then,
 * level by level, the temporary items under any child whose code moved and
 * whose rule builds on `parent.code`, because those carry the old code inside
 * their own. A code that cannot be regenerated (its row no longer has a range)
 * is left as it was and named in `skipped`.
 *
 * What it never touches: anything on a line released to production, or on an
 * order that is closed, lost or cancelled. Release freezes the structure, and
 * that is exactly when codes start being painted on steel. Nor catalog items,
 * nor a piece shared by several parents, nor a rule that also draws a running
 * number.
 *
 * `insert` — { lineNo, quantity, shortName } — counts a row that is about to be
 * added as if it were there already. bomService.addLine passes it when a row
 * goes in AMONG existing rows: the rows after it move first, so the new row's
 * first code cannot meet the stale code one of them still carries. Anybody
 * creating a temporary item among existing rows should do the same.
 *
 * Batched, because production is ~49 ms a round trip: per level of the tree
 * that moved, one query for the rows and one for their items; the coding rules
 * are read once per call, not once per item; then one query to check the new
 * codes are free and two to write them.
 *
 * Returns { parentId, checked, changed: [{ id, from, to }], skipped: [{ id, code, why }], frozen }.
 */
export async function refreshRangeCodes(db, c, parentId, { insert = null } = {}) {
  const out = { parentId, checked: 0, changed: [], skipped: [], frozen: null };
  const rules = readRulesOnce(db);
  let lines = await linesOfParents(db, c.companyId, [parentId]);
  if (insert) lines = withInsert(lines, insert);
  for (let depth = 0; lines.length && depth < MAX_DEPTH; depth++) {
    const moved = await recodeLevel(db, c, lines, depth === 0 ? 'range' : 'parent.code', rules, out);
    if (!moved.length) break;
    lines = await linesOfParents(db, c.companyId, moved);
  }
  return out;
}
