/**
 * linkService.js — linked copies: rows of ONE order line that are "the same design"
 * (init.sql §59, CF_ERP_LINKED_COPIES_PLAN.md).
 *
 * A copy of a row is linked to the row it was copied from, row by row down the subtree: both carry
 * the same `cf_item_details.link_group`. What a person does to one member can then be done to all
 * of them — a value, a child's quantity, a removed child, an uploaded drawing — and a member that
 * is changed on its own stops being a member.
 *
 * LINKED = THE STORED KEY **AND** AN EQUAL DESIGN. The key alone is never trusted: the design
 * FINGERPRINT of every row is worked out, in memory, from the one bulk load the Values screen
 * already makes (orderValuesService.loadContext), and two rows are linked only while their keys
 * AND their fingerprints agree. Nothing stores a fingerprint — values are written by five paths,
 * and one that forgot to refresh a stored hash would fan a change out to rows that are no longer
 * the same. Computed on read, a forgotten path shows as a broken link; it can never be a wrong
 * fan-out.
 *
 * THE FINGERPRINT — fp = sha1(JSON([own, children])), first 20 hex, bottom-up and memoised.
 *   own IN   classification, template definition, the stock bar it is cut from (cut_stock_id);
 *            every applicable item-level value whose rule is entered / defaulted / fixed /
 *            inherited, as [code, normalised value]; a value a formula gives and a person may type
 *            over ONLY when a person typed over it; the register drawings linked to the row (root
 *            ids, sorted — a new revision of the same sheet is the same drawing).
 *   own OUT  calculated and roll-up values; values a FLOW asks for (origin 'flow' — how it is made,
 *            not what it is); records.NOT_DESIGN_SPECS (the drawing mark, what cutting and nesting
 *            work out, what the drawing says, planning values); tables; name, short name, code,
 *            status, flow; and everything on the row's OWN BOM line — its quantity, line number,
 *            position, description, line flow, notes.
 *   children the sorted multiset of [child key, quantity] over the row's live lines: a child row
 *            of the order by its own fingerprint, a catalog item by its id, a selection not chosen
 *            yet by its definition. Cut pieces are skipped — they are worked out, and shared.
 * So a row's quantity IN ITS PARENT does not break the row's link — but it is part of the PARENT's
 * design (decision D2): changing a child's quantity, adding or removing a child breaks that row
 * and its linked ancestors, never its siblings.
 *
 * SUBSTANCE (suggestions and seeding only): two rows fresh from a template with nothing typed are
 * trivially equal, so only a row with a typed design value, or a drawing, or a child with substance
 * is ever SUGGESTED for linking. Copies are linked regardless.
 *
 * ROUND TRIPS (production is ~49 ms each). Everything is read with the line's values context
 * (8 reads) plus ONE more for the drawings linked to its rows and the cut places. readLinks and
 * settleLine handed a context ask nothing more; settleLine writes at most one UPDATE per 500 rows
 * whose key moves, and asks ONE cheap question first when it has no context (a line with no
 * linked row at all is left alone for one round trip).
 */
import { createHash, randomBytes } from 'crypto';
import { NOT_DESIGN_SPECS } from './records.js';
import { isWorkedDefault } from './resolutionService.js';
import { loadContext, resolveRecord, labelOfRecord } from './orderValuesService.js';

const ID_CHUNK = 500;
const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const subjectKey = (type, id) => `${type}:${id}`;
const q6 = (n) => Number(Number(n).toFixed(6));

/** A group's key: base36 time + 10 random characters. Opaque — nothing reads meaning from it. */
export function newGroupKey() {
  const rnd = [...randomBytes(10)].map((b) => (b % 36).toString(36)).join('');
  return `${Date.now().toString(36)}${rnd}`.slice(0, 32);
}

/** The order's own rows of this line (temporary items it owns), deleted ones left out. */
export const isOwnRow = (ctx, rec) => !!rec && !rec.is_deleted && rec.record_kind === 'item' && rec.item_type === 'temporary' && Number(rec.owner_order_line_id) === Number(ctx.line.id);

/**
 * What the fingerprint needs beyond the values context, in ONE round trip: the live register
 * drawings linked to each row (by root — the sheet, whatever its revision) and the classification
 * nodes cut pieces are filed under. → { roots: Map(recordId -> [rootId sorted]), cutNodes: Set }
 */
export async function loadDesignExtras(db, companyId, recordIds) {
  const ids = [...new Set(recordIds.map(Number))];
  const out = { roots: new Map(), cutNodes: new Set() };
  const [rows] = await db.query(
    `SELECT 'd' AS k, l.subject_id AS a, COALESCE(d.root_id, d.id) AS b
       FROM cf_drawing_links l
       JOIN cf_drawings d ON d.id = l.drawing_id AND d.deleted_at IS NULL AND d.status IN ('draft', 'issued')
      WHERE l.company_id = ? AND l.subject_type = 'master_record' AND l.deleted_at IS NULL AND l.subject_id IN (?)
      UNION ALL
     SELECT 'p', p.blanks_node_id, p.offcut_node_id FROM cf_cut_places p WHERE p.company_id = ?`,
    [companyId, ids.length ? ids : [0], companyId],
  );
  for (const r of rows) {
    if (r.k === 'p') { for (const n of [r.a, r.b]) if (n != null) out.cutNodes.add(Number(n)); continue; }
    const id = Number(r.a);
    if (!out.roots.has(id)) out.roots.set(id, []);
    if (!out.roots.get(id).includes(Number(r.b))) out.roots.get(id).push(Number(r.b));
  }
  for (const list of out.roots.values()) list.sort((a, b) => a - b);
  return out;
}

/** The context's design extras, read once and kept on it. */
async function extrasOf(db, ctx) {
  if (!ctx.designExtras) {
    const own = [...ctx.records.values()].filter((r) => isOwnRow(ctx, r)).map((r) => r.id);
    ctx.designExtras = await loadDesignExtras(db, ctx.companyId, own);
  }
  return ctx.designExtras;
}

/** A cut piece: a temporary item filed under a cut place's blanks (or offcut) node, or anything below it. */
function isCutPiece(ctx, rec, cutNodes) {
  if (rec?.classification_id == null) return false;
  if (ctx.cutPieceNodes?.has(Number(rec.classification_id))) return true;   // a test's own classification
  if (!cutNodes.size) return false;
  return (ctx.chains.get(rec.classification_id) ?? []).some((n) => cutNodes.has(Number(n.id)));
}

/** One value as the fingerprint reads it: a number to the spec's decimals, an option's id, yes/no, a date, trimmed text. */
function normalised(s) {
  const raw = s.value?.raw;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    const d = Number.isInteger(Number(s.spec.decimals)) && s.spec.decimals != null ? Math.min(Number(s.spec.decimals), 6) : 6;
    return Number(raw.toFixed(d));
  }
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') { const t = raw.trim(); return t === '' ? null : t; }
  return JSON.stringify(raw);
}

/**
 * Whether a resolved spec is part of the row's DESIGN, and — when it is — its normalised value
 * (null = empty, which is the same as absent). → { design: boolean, value }
 * `flowRules`: Set of assignment ids made by a flow.
 */
export function designValueOf(s, flowRules) {
  if (!s.applicable || s.captureAt !== 'item') return { design: false, value: null };
  if (s.spec.dataType === 'table') return { design: false, value: null };
  if (NOT_DESIGN_SPECS.has(String(s.spec.code).toUpperCase())) return { design: false, value: null };
  if (flowRules.has(s.rule.assignmentId)) return { design: false, value: null };
  const vr = s.rule.valueRule;
  if (!['entered', 'defaulted', 'fixed', 'inherited'].includes(vr)) return { design: false, value: null };
  if (isWorkedDefault(s.rule)) {
    // Calculated, but a person may type over it: design only when somebody did (typed EQUAL to the answer is the answer).
    const typed = s.derived?.source === 'typed' || (!s.derived && s.value?.source === 'entered');
    return { design: true, value: typed ? normalised(s) : null, worked: true };
  }
  return { design: true, value: normalised(s) };
}

/** Whether a design value was typed on the row itself (substance) rather than taken from above. */
const typedHere = (s) => s.value?.source === 'entered' || (s.rule.valueRule === 'entered' && s.value != null) || s.derived?.source === 'typed';

/**
 * Every own row's fingerprint, pure and in memory.
 *   ctx      orderValuesService.loadContext's answer (as it stands NOW — after a write in memory too)
 *   extras   loadDesignExtras' answer ({ roots, cutNodes })
 *   opts.resolved   Map(recordId -> resolveRecord's answer) to reuse; filled for the rows worked out here
 * → { fp: Map(recordId -> fp), own: Map(recordId -> { values: Map(code -> value), kids: [[key, qty]], roots: [] }),
 *     substance: Set(recordId) }
 */
export function fingerprints(ctx, extras, { resolved = new Map() } = {}) {
  const roots = extras?.roots ?? new Map();
  const cutNodes = extras?.cutNodes ?? new Set();
  const flowRules = new Set();
  for (const list of ctx.rulesBySubject.values()) for (const r of list) if (r.origin === 'flow') flowRules.add(r.id);
  const fp = new Map();
  const own = new Map();
  const substance = new Set();
  const busy = new Set();

  const work = (id) => {
    if (fp.has(id)) return fp.get(id);
    const rec = ctx.records.get(id);
    // A cut piece is worked out and shared: it is never a design row, never linked, never suggested.
    if (!isOwnRow(ctx, rec) || busy.has(id) || isCutPiece(ctx, rec, cutNodes)) return null;
    busy.add(id);
    if (!resolved.has(id)) resolved.set(id, resolveRecord(ctx, rec));
    const r = resolved.get(id);
    const values = new Map();
    let typed = false;
    for (const s of r.specs) {
      const d = designValueOf(s, flowRules);
      if (!d.design || d.value === null) continue;
      values.set(String(s.spec.code).toUpperCase(), d.value);
      if (typedHere(s)) typed = true;
    }
    const kids = [];
    let kidSubstance = false;
    for (const l of ctx.linesByParent.get(id) ?? []) {
      const child = ctx.records.get(l.childId);
      if (!child || child.is_deleted) continue;
      let key;
      if (child.record_kind !== 'item') key = `s${l.selectionDefinitionId ?? child.id}`;
      else if (child.item_type !== 'temporary') key = `c${child.id}`;
      else if (isCutPiece(ctx, child, cutNodes)) continue;
      else if (isOwnRow(ctx, child)) { key = work(child.id) ?? `t${child.id}`; if (substance.has(child.id)) kidSubstance = true; }
      // (a row that holds itself further down — which nothing builds — falls back to its id)
      else key = `t${child.id}`;
      kids.push([key, q6(l.quantity)]);
    }
    kids.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    const drawn = roots.get(id) ?? [];
    const ownPart = [
      rec.classification_id ?? null, rec.source_definition_id ?? null, rec.cut_stock_id ?? null,
      [...values].sort((a, b) => (a[0] < b[0] ? -1 : 1)), drawn,
    ];
    const hash = createHash('sha1').update(JSON.stringify([ownPart, kids])).digest('hex').slice(0, 20);
    busy.delete(id);
    fp.set(id, hash);
    own.set(id, { values, kids, roots: drawn });
    if (typed || drawn.length || kidSubstance) substance.add(id);
    return hash;
  };
  for (const rec of ctx.records.values()) if (isOwnRow(ctx, rec)) work(rec.id);
  return { fp, own, substance };
}

/** In words, how two rows' designs differ (the first few differences). [] when they are the same design. */
export function differences(ctx, prints, aId, bId) {
  const a = prints.own.get(aId); const b = prints.own.get(bId);
  const ra = ctx.records.get(aId); const rb = ctx.records.get(bId);
  if (!a || !b) return ['one of them is not a row of this line'];
  const out = [];
  if ((ra.classification_id ?? null) !== (rb.classification_id ?? null)) out.push('they are different kinds of thing');
  else if ((ra.source_definition_id ?? null) !== (rb.source_definition_id ?? null)) out.push('they were made from different templates');
  if ((ra.cut_stock_id ?? null) !== (rb.cut_stock_id ?? null)) out.push('they are cut from different sections');
  const show = (v) => (v === undefined ? 'empty' : String(v));
  for (const code of [...new Set([...a.values.keys(), ...b.values.keys()])].sort()) {
    const x = a.values.get(code); const y = b.values.get(code);
    if (x !== y && JSON.stringify(x) !== JSON.stringify(y)) out.push(`${code} differs (${show(x)} / ${show(y)})`);
  }
  if (JSON.stringify(a.roots) !== JSON.stringify(b.roots)) out.push('they are built to different drawings');
  if (JSON.stringify(a.kids) !== JSON.stringify(b.kids)) out.push(a.kids.length !== b.kids.length ? `what is below them differs (${a.kids.length} / ${b.kids.length} lines)` : 'what is below them differs (a child, or its quantity)');
  return out;
}

/**
 * The links of a line as they stand: who is linked to whom, and who could be.
 *
 *   byRecord     Map(recordId -> { g, n }            in an effective group of n (n >= 2)
 *                                 | { same: [ids] }  not linked, but the same design as these rows (a suggestion)
 *                                 | { apart: true }) kept apart by a person
 *   groups       Map(effective key -> [ids])   the stored key; a second class of one stored key (a
 *                                              write path that forgot to settle) is `key:fp6`
 *   stored       Map(stored key -> [ids])      what is stored, effective or not (settleLine's input)
 *   suggestions  [[ids]]                       designs that are equal, have substance and are not one group
 *   fp / prints  the fingerprints
 */
export function linksOf(ctx, extras, opts = {}) {
  const prints = fingerprints(ctx, extras, opts);
  const stored = new Map();
  for (const rec of ctx.records.values()) {
    if (!isOwnRow(ctx, rec) || !rec.link_group || !prints.fp.has(rec.id)) continue;
    if (!stored.has(rec.link_group)) stored.set(rec.link_group, []);
    stored.get(rec.link_group).push(rec.id);
  }
  const groups = new Map();
  const groupOf = new Map();
  for (const [key, ids] of stored) {
    const classes = classesOf(ids, prints.fp).filter((cl) => cl.length >= 2);
    classes.forEach((cl, i) => {
      const k = i === 0 ? key : `${key}:${prints.fp.get(cl[0]).slice(0, 6)}`;
      groups.set(k, cl);
      for (const id of cl) groupOf.set(id, k);
    });
  }
  const byRecord = new Map();
  for (const [k, ids] of groups) for (const id of ids) byRecord.set(id, { g: k, n: ids.length });
  // Suggestions: equal designs with substance that are not already one group.
  const byPrint = new Map();
  for (const [id, hash] of prints.fp) {
    if (!prints.substance.has(id)) continue;
    if (!byPrint.has(hash)) byPrint.set(hash, []);
    byPrint.get(hash).push(id);
  }
  const suggestions = [];
  for (const ids of byPrint.values()) {
    const open = ids.filter((id) => !Number(ctx.records.get(id).link_apart));
    if (open.length < 2) continue;
    if (new Set(open.map((id) => groupOf.get(id) ?? `-${id}`)).size < 2) continue;   // already one group
    open.sort((a, b) => a - b);
    suggestions.push(open);
    for (const id of open) if (!byRecord.has(id)) byRecord.set(id, { same: open.filter((x) => x !== id) });
  }
  for (const rec of ctx.records.values()) {
    if (isOwnRow(ctx, rec) && Number(rec.link_apart) && !byRecord.has(rec.id)) byRecord.set(rec.id, { apart: true });
  }
  return { byRecord, groups, stored, suggestions, fp: prints.fp, prints, groupOf };
}

/** Members of one stored key by fingerprint, the largest class first (a tie: the one holding the lowest id). */
function classesOf(ids, fp) {
  const by = new Map();
  for (const id of ids) {
    const h = fp.get(id);
    if (!by.has(h)) by.set(h, []);
    by.get(h).push(id);
  }
  const out = [...by.values()].map((cl) => cl.sort((a, b) => a - b));
  out.sort((a, b) => b.length - a.length || a[0] - b[0]);
  return out;
}

/** The `links` block of the API: { rows: { id: {g,n} | {same} | {apart} }, groups: { key: [ids] } }. */
export function linksBlock(links) {
  const rows = {};
  for (const [id, v] of links.byRecord) rows[id] = v;
  const groups = {};
  for (const [k, ids] of links.groups) groups[k] = ids;
  return { rows, groups };
}

/**
 * readLinks — the links of one line. 9 round trips, or 1 with a context already loaded (0 when the
 * context already carries its design extras).
 */
export async function readLinks(db, companyId, lineId, { ctx = null } = {}) {
  const context = ctx ?? await loadContext(db, companyId, lineId);
  const extras = await extrasOf(db, context);
  return { ...linksOf(context, extras), ctx: context };
}

/**
 * settleLine — brings the STORED keys in line with the designs. For every stored group its members
 * are partitioned by fingerprint: the largest class keeps the key (a tie: the class holding the
 * lowest id), every other class of two or more gets a new key of its own, and a row alone is not
 * linked any more (NULL). One UPDATE … CASE per 500 rows whose key moves; nothing when nothing does.
 *
 *   opts.ctx   a values context to work from (as it stands in memory); it is brought up to date.
 *              Without one: ONE cheap question first — a line with no linked row is left alone.
 * → { breaks: [{ recordId, label, was, now, because }], links } — `links` is linksOf AFTER the
 *   settle (null when the line had nothing linked and no context was given).
 */
export async function settleLine(db, c, lineId, { ctx = null } = {}) {
  const companyId = c.companyId;
  if (!ctx) {
    const [[any]] = await db.query(
      "SELECT 1 AS x FROM cf_item_details WHERE company_id = ? AND owner_order_line_id = ? AND item_type = 'temporary' AND link_group IS NOT NULL AND deleted_at IS NULL LIMIT 1",
      [companyId, lineId],
    );
    if (!any) return { breaks: [], links: null };
  }
  let context = ctx;
  if (!context) {
    try { context = await loadContext(db, companyId, lineId); } catch (e) { if (e?.status === 404 || e?.code === 'NO_ITEM') return { breaks: [], links: null }; throw e; }
  }
  const extras = await extrasOf(db, context);
  const before = linksOf(context, extras);
  const moves = new Map();   // recordId -> new key | null
  const breaks = [];
  for (const [key, ids] of before.stored) {
    const classes = classesOf(ids, before.fp);
    const kept = classes[0].length >= 2 ? classes[0] : null;
    classes.forEach((cl, i) => {
      if (i === 0 && kept) return;
      const next = cl.length >= 2 ? newGroupKey() : null;
      for (const id of cl) {
        moves.set(id, next);
        const versus = kept ?? classes.find((x) => x !== cl) ?? null;
        const why = versus ? differences(context, before.prints, id, versus[0]) : [];
        breaks.push({
          recordId: id, label: labelOfRecord(context.records.get(id), context), was: key, now: next,
          because: why.length ? why.slice(0, 3).join('; ') : 'it is the only one of its design left',
        });
      }
    });
  }
  if (moves.size) {
    for (const part of chunk([...moves], ID_CHUNK)) {
      const params = [];
      const whens = part.map(([id, key]) => { params.push(id, key); return 'WHEN ? THEN ?'; }).join(' ');
      params.push(companyId, part.map(([id]) => id));
      await db.query(`UPDATE cf_item_details SET link_group = CASE master_id ${whens} END WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL`, params);
    }
    for (const [id, key] of moves) context.records.get(id).link_group = key;
  }
  return { breaks, links: moves.size ? linksOf(context, extras) : before, ctx: context };
}

/**
 * Links two or more rows by hand ({ op: 'link' }): they must be rows of this line and the SAME
 * design. They join the group one of them is already in (several groups become one), else a new
 * one; "keep apart" is cleared. → { key, recordIds } or throws { code, message }-shaped problems.
 */
export function planLink(ctx, links, recordIds) {
  const ids = [...new Set(recordIds.map(Number))];
  const recs = ids.map((id) => ctx.records.get(id));
  if (ids.length < 2) return { problem: { code: 'INVALID', message: 'Choose two or more rows to link.' } };
  const foreign = ids.filter((id, i) => !isOwnRow(ctx, recs[i]));
  if (foreign.length) {
    return { problem: { code: 'LINK_OTHER_LINE', message: `${foreign.length === 1 ? 'One of the rows is' : `${foreign.length} of the rows are`} not a row of line ${ctx.line.lineNo} of ${ctx.line.orderCode} — copies are linked inside one order line only.` } };
  }
  const first = ids[0];
  for (const id of ids.slice(1)) {
    if (links.fp.get(id) === links.fp.get(first)) continue;
    const why = differences(ctx, links.prints, first, id);
    return {
      problem: {
        code: 'LINK_NOT_EQUAL',
        message: `${labelOfRecord(recs[0], ctx)} and ${labelOfRecord(ctx.records.get(id), ctx)} are not the same design — ${why.slice(0, 4).join('; ') || 'they differ'}. Make them equal, then link them.`,
        differences: why,
      },
    };
  }
  // Every row of every effective group one of them is in comes along: they are all this design.
  const all = new Set(ids);
  const keys = [];
  for (const id of ids) {
    const g = links.groupOf.get(id);
    if (!g) continue;
    if (!keys.includes(g)) keys.push(g);
    for (const m of links.groups.get(g)) all.add(m);
  }
  const key = keys.map((k) => k.split(':')[0])[0] ?? newGroupKey();
  return { key, recordIds: [...all] };
}

/** Writes a planned link: one UPDATE. */
export async function writeLink(db, c, ctx, plan) {
  await db.query('UPDATE cf_item_details SET link_group = ?, link_apart = 0 WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL', [plan.key, c.companyId, plan.recordIds]);
  for (const id of plan.recordIds) { const r = ctx.records.get(id); if (r) { r.link_group = plan.key; r.link_apart = 0; } }
}

/** Takes one row out of its group ({ op: 'unlink' }); `keepApart` also stops it being suggested again. One UPDATE. */
export async function writeUnlink(db, c, ctx, recordId, keepApart) {
  await db.query('UPDATE cf_item_details SET link_group = NULL, link_apart = ? WHERE company_id = ? AND master_id = ? AND deleted_at IS NULL', [keepApart ? 1 : 0, c.companyId, recordId]);
  const r = ctx.records.get(recordId);
  if (r) { r.link_group = null; r.link_apart = keepApart ? 1 : 0; }
}

/**
 * The line of a link-mate that CORRESPONDS to a line of one member: the same child design at the
 * same quantity, counted from the top when a parent holds several alike. Used to repeat a child's
 * quantity change or removal on the other copies (decision D2). null when the mate has no such line.
 *   lineId    a BOM line whose parent is `parentId`       mateId   another member of the parent's group
 */
export function correspondingLine(ctx, prints, parentId, lineId, mateId) {
  const keyOf = (l) => {
    const child = ctx.records.get(l.childId);
    if (!child) return null;
    const k = child.record_kind !== 'item' ? `s${l.selectionDefinitionId ?? child.id}`
      : child.item_type !== 'temporary' ? `c${child.id}`
        : prints.fp.get(child.id) ?? `t${child.id}`;
    return `${k}|${q6(l.quantity)}`;
  };
  const mine = ctx.linesByParent.get(parentId) ?? [];
  const line = mine.find((l) => l.id === lineId);
  if (!line) return null;
  const key = keyOf(line);
  const index = mine.filter((l) => keyOf(l) === key).findIndex((l) => l.id === lineId);
  const theirs = (ctx.linesByParent.get(mateId) ?? []).filter((l) => keyOf(l) === key);
  return theirs[index] ?? null;
}

export { subjectKey as _subjectKey };
