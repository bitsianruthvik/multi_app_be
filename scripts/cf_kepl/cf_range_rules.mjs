/**
 * cf_range_rules.mjs — switches a company's coding rules to running piece
 * numbers per parent (user, 2026-09-26), and re-codes what they reach.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/cf_range_rules.mjs              # switch, re-code, commit
 *   node scripts/cf_kepl/cf_range_rules.mjs --dry-run    # everything, then roll back
 *
 * Company from CF_BRIDGE_COMPANY (default 2), acting user CF_BRIDGE_USER.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SWITCHES
 *
 *   1. Temporary-item code rules that end in {position} straight after the
 *      short name — CFTMP-PART's {parent.code}-{record.shortName}{position} —
 *      now end in {range}: a row of 23 plain stiffeners and its copy of 3
 *      drilled ones are IS1-23 and IS24-26 under their parent, where they were
 *      IS1 and IS2. Every other part of the rule is kept as it is.
 *   2. Released pieces get the codes the user chose — "…-G1-1-IS24", the
 *      piece's own number — from three production-piece rules it writes:
 *        CFPC-TOP      what the order line sells:  {item.code}-{piece.seq}
 *                      SO-…-SPAN-01-1 and -2, the two spans (for a top piece
 *                      piece.seq IS its piece no; it also numbers a grouped
 *                      top, where piece.no is blank and would stop release)
 *        CFPC-PART     a piece inside another:     {parent.code}-{item.shortName}{piece.seq}
 *        CFPC-SEGMENT  … whose item code prints no short name (CFTMP-SEGMENT):
 *                                                  {parent.code}-{piece.seq}
 *      One such rule per item rule that prints no short name, under that item
 *      rule's own conditions, so the two cannot disagree about which items
 *      those are. Any OTHER production-piece rule that prints {piece.no} is
 *      switched to {piece.seq}.
 *
 * Rules are read with codegen.getScheme and handed back WHOLE to updateScheme,
 * as cf_recode_order.mjs does: a rule is saved as one thing — scheme,
 * conditions and pattern — so it is never half-changed, and its running-number
 * counters are kept.
 *
 * WHAT IT LEAVES ALONE, and says so
 *   - A rule conditioned on "placement = line" (CFTMP-LINE). The item a sales
 *     line sells sits on no BOM row, so it has no range: switching that rule
 *     would leave every new order line without a code.
 *   - A rule whose {position} does not follow the short name (CFTMP-SEGMENT's
 *     {parent.code}-{position}). Not the shape it was asked to switch. (Its
 *     segments are x1 rows of one kind, so it would print the same numbers.)
 *   - Anything on a line released to production or an order that is closed,
 *     lost or cancelled — refreshRangeCodes never renumbers those.
 *
 * THEN IT RE-CODES, top down, with the same refreshRangeCodes the BOM screens
 * call, and checks:
 *   - every code is unique company-wide, and fits the column;
 *   - a second run would change nothing — every item regenerates to its code,
 *     through the code generator AND through the batched refresh;
 *   - A ROW OF QUANTITY 1 KEEPS ITS CODE — unless an earlier row of its short
 *     name under the same parent holds more than one piece (the count is of
 *     pieces now, not rows: CP x2, CP x2, CP x1 is CP1-2, CP3-4, CP5), or its
 *     parent's code moved (it prints that code inside its own). Any other
 *     change fails the run;
 *   - the girder segments still end in their BOQ drawing marks (G1-1 … G4-5);
 *   - a RELEASE DRY RUN of every custom order line (releaseService.
 *     previewReleaseCodes — the tree and the codes release would write, nothing
 *     written, no number drawn): every piece coded by a rule, every code unique
 *     across the whole plan and unused by any other release, the top pieces
 *     {item code}-{piece no}, every other piece its parent's code and then its
 *     own number. A sample branch is printed.
 * A failed check rolls everything back.
 *
 * Re-runnable: a second run finds the rules in place and nothing to re-code.
 * cf_recode_order.mjs writes CFTMP-PART with {range} too, and update-cf-prod.sh
 * runs this script after it, so the runner ends in this state.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');   // registers the code-generator entities
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { generate } = await imp('apps/cf_erp/modules/codegen/index.js');
const { refreshRangeCodes, shortNameOf } = await imp('apps/cf_erp/services/codeRangeService.js');
const { previewReleaseCodes } = await imp('apps/cf_erp/services/releaseService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const DRY = process.argv.includes('--dry-run');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) || null };
const say = (...a) => console.log(...a);
const MAX_CODE = 100;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** getScheme's shape, handed straight back to updateScheme — it replaces a rule whole. */
const asBody = (full) => ({
  code: full.code, name: full.name, entityType: full.entityType, targetField: full.targetField,
  seqScope: full.seqScope, priority: full.priority, description: full.description, status: full.status,
  conditions: full.conditions.map((x) => ({ tokenKey: x.tokenKey, operator: x.operator, value: x.value })),
  segments: full.segments.map((s) => ({
    segmentType: s.segmentType, literalText: s.literalText, tokenKey: s.tokenKey,
    format: s.format, transform: s.transform, maxLength: s.maxLength, isRequired: s.isRequired,
  })),
});

/** A rule's pattern the way a person reads it: {parent.code}-{record.shortName}{range}. */
const patternOf = (full) => full.segments.map((s) => {
  if (s.segmentType === 'literal') return s.literalText;
  if (s.segmentType === 'token') return `{${s.tokenKey}${s.format ? `/${s.format}` : ''}${s.isRequired ? '' : '?'}}`;
  if (s.segmentType === 'sequence') return `{#${s.format ?? ''}}`;
  return `{date:${s.format ?? ''}}`;
}).join('');

const isToken = (s, key) => s?.segmentType === 'token' && s.tokenKey === key;
const valuesOf = (x) => (x.operator === 'in' ? String(x.value).split(',').map((v) => v.trim()) : [String(x.value).trim()]);
const reachesTemporary = (full) => full.conditions.some((x) => x.tokenKey === 'kind' && valuesOf(x).includes('temporary'));
const forLineItems = (full) => full.conditions.some((x) => x.tokenKey === 'placement' && valuesOf(x).includes('line'));

async function schemes(db, entityType) {
  const [rows] = await db.query(
    "SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type = ? AND target_field = 'code' AND deleted_at IS NULL ORDER BY code",
    [COMPANY, entityType],
  );
  const out = [];
  for (const r of rows) out.push(await codegen.getScheme(db, COMPANY, r.id));
  return out;
}

async function switchRules(db) {
  say('\n--- coding rules ------------------------------------------------------');
  const switched = [];
  for (const full of await schemes(db, 'item')) {
    const segs = full.segments;
    const last = segs[segs.length - 1];
    const prev = segs[segs.length - 2];
    const where = `${full.code.padEnd(17)} ${patternOf(full)}`;
    if (isToken(last, 'range') && isToken(prev, 'record.shortName')) { say(`   ${where}   already ends in {range}`); continue; }
    if (!isToken(last, 'position')) continue;
    if (!reachesTemporary(full)) { say(`   ${where}   left: not a temporary-item rule`); continue; }
    if (forLineItems(full)) { say(`   ${where}   left: the item a sales line sells sits on no BOM row, so it has no range`); continue; }
    if (!isToken(prev, 'record.shortName')) { say(`   ${where}   left: its {position} does not follow the short name`); continue; }
    const body = asBody(full);
    body.segments[body.segments.length - 1] = { ...body.segments[body.segments.length - 1], tokenKey: 'range' };
    const after = await codegen.updateScheme(db, COMPANY, c.userId, full.id, body);
    switched.push({ code: full.code, from: patternOf(full), to: patternOf(after) });
    say(`   ${full.code.padEnd(17)} ${patternOf(full)}  ->  ${patternOf(after)}`);
  }

  switched.push(...await ensurePieceRules(db));
  return switched;
}

// ---------------------------------------------------------------------------
// Production-piece rules
// ---------------------------------------------------------------------------

const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'upper', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });

/** One shape for a segment or a condition, whichever end it came from, so two rules can be compared (as cf_recode_order does). */
const segKey = (s) => JSON.stringify([
  s.segmentType ?? s.segment_type, s.literalText ?? s.literal_text ?? null, s.tokenKey ?? s.token_key ?? null,
  (s.format ?? '') === '' ? null : s.format, s.transform ?? 'none', s.maxLength ?? s.max_length ?? null,
  (s.isRequired ?? s.is_required ?? true) ? 1 : 0,
]);
const condKey = (x) => `${x.tokenKey ?? x.token_key} ${x.operator ?? 'eq'} ${String(x.value).trim()}`;
const sorted = (xs) => [...xs].sort();

/** Creates the rule, or replaces it whole when anything about it differs. Returns a change, or null. */
async function putScheme(db, want) {
  const [[row]] = await db.query('SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, want.code]);
  const full = row ? await codegen.getScheme(db, COMPANY, row.id) : null;
  if (full) {
    const same = full.entityType === want.entityType && full.targetField === want.targetField
      && full.seqScope === want.seqScope && full.priority === want.priority && full.status === want.status
      && full.name === want.name && (full.description ?? null) === (want.description ?? null)
      && JSON.stringify(sorted(full.conditions.map(condKey))) === JSON.stringify(sorted(want.conditions.map(condKey)))
      && JSON.stringify(full.segments.map(segKey)) === JSON.stringify(want.segments.map(segKey));
    if (same) { say(`   ${want.code.padEnd(17)} ${patternOf(full)}   unchanged`); return null; }
    const after = await codegen.updateScheme(db, COMPANY, c.userId, full.id, want);
    say(`   ${want.code.padEnd(17)} ${patternOf(full)}  ->  ${patternOf(after)}   rewritten`);
    return { code: want.code, from: patternOf(full), to: patternOf(after) };
  }
  const made = await codegen.createScheme(db, COMPANY, c.userId, want);
  say(`   ${want.code.padEnd(17)} ${patternOf(made)}   created`);
  return { code: want.code, from: null, to: patternOf(made) };
}

/**
 * The codes the user chose for released pieces (2026-09-26): "…-G1-1-IS24", the
 * piece's own number under its parent. Three shapes, told apart by the
 * production-piece conditions the code generator already weighs:
 *
 *   top of the tree (placement = line, a temporary item — the line's own):
 *       {item.code}-{piece.seq}                SO-…-SPAN-01-1, SO-…-SPAN-01-2
 *   inside another piece (placement = component):
 *       {parent.code}-{item.shortName}{piece.seq}     …-1-G1, …-G1-1-IS24
 *   inside another, where the item's own code prints no short name:
 *       {parent.code}-{piece.seq}              …-1-G1-1 (a girder segment)
 *
 * The third is derived, not typed: every active item rule for temporary items
 * placed inside another that prints no {record.shortName} gets a piece rule
 * under the same conditions. Weights: top 2, inside 1, the derived ones 1 +
 * their classification (an exact Variant is 4), so the most specific wins and
 * nothing ties. A top piece that is a catalog item (a standard line) matches
 * no top rule and keeps release's built-in code, as before — a catalog code is
 * not unique to one order.
 */
async function ensurePieceRules(db) {
  const changes = [];
  const want = (code, name, description, conditions, segments) => ({
    code, name, description, entityType: 'production_piece', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions, segments,
  });
  const top = { tokenKey: 'placement', operator: 'eq', value: 'line' };
  const inside = { tokenKey: 'placement', operator: 'eq', value: 'component' };
  const ours = new Set(['CFPC-TOP', 'CFPC-PART']);

  const change = async (w) => { const x = await putScheme(db, w); if (x) changes.push(x); };
  await change(want('CFPC-TOP', 'Released piece — what the order line sells',
    'The top of a released tree: its item code and its piece number — SO-20260924-0003-SPAN-01-1 and -2 for two spans. piece.seq is the piece number here, and it also numbers a grouped top, where piece.no is blank.',
    [{ tokenKey: 'kind', operator: 'eq', value: 'temporary' }, top],
    [tok('item.code'), lit('-'), tok('piece.seq')]));
  await change(want('CFPC-PART', 'Released piece inside another',
    'The parent piece code, the short name its item code prints, and its own number under that parent — …-G1-1-IS24 for the first of three drilled stiffeners after 23 plain ones.',
    [inside],
    [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')]));

  for (const r of await schemes(db, 'item')) {
    const placedInside = r.conditions.some((x) => x.tokenKey === 'placement' && valuesOf(x).includes('component'));
    if (r.status !== 'active' || !reachesTemporary(r) || !placedInside || r.segments.some((s) => isToken(s, 'record.shortName'))) continue;
    const code = `CFPC-${r.code.replace(/^CFTMP-/, '')}`;
    ours.add(code);
    const unsupported = r.conditions.filter((x) => !['kind', 'placement', 'classification'].includes(x.tokenKey));
    if (unsupported.length) {
      say(`   ${code.padEnd(17)} not written: ${r.code} prints no short name but is told apart by ${unsupported.map((x) => x.tokenKey).join(', ')}, which a piece rule cannot test — its pieces will print a short name`);
      continue;
    }
    await change(want(code, `Released piece of a kind coded by ${r.code}`,
      `${r.code} codes these items with no short name (${patternOf(r)}), so their pieces carry none either: the parent piece code and the piece's own number — a girder segment is …-G1-1.`,
      [...r.conditions.filter((x) => x.tokenKey !== 'placement').map((x) => ({ tokenKey: x.tokenKey, operator: x.operator, value: x.value })), inside],
      [tok('parent.code'), lit('-'), tok('piece.seq')]));
  }

  // Anybody else's production-piece rule that numbers pieces along the line.
  for (const full of await schemes(db, 'production_piece')) {
    if (ours.has(full.code) || !full.segments.some((s) => isToken(s, 'piece.no'))) continue;
    const body = asBody(full);
    body.segments = body.segments.map((s) => (s.segmentType === 'token' && s.tokenKey === 'piece.no' ? { ...s, tokenKey: 'piece.seq' } : s));
    const after = await codegen.updateScheme(db, COMPANY, c.userId, full.id, body);
    changes.push({ code: full.code, from: patternOf(full), to: patternOf(after) });
    say(`   ${full.code.padEnd(17)} ${patternOf(full)}  ->  ${patternOf(after)}`);
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Release dry run
// ---------------------------------------------------------------------------

/** The tree and codes release would write for every custom order line — nothing written. */
async function dryRunReleases(db) {
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, o.code AS order_code FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.line_type = 'custom' AND l.item_id IS NOT NULL
      ORDER BY o.code, l.line_no`,
    [COMPANY],
  );
  const out = [];
  for (const l of lines) {
    const t = counting(db);
    const started = Date.now();
    const p = await previewReleaseCodes(t.db, COMPANY, l.id);
    out.push({ line: l, p, trips: t.tally.n, ms: Date.now() - started });
  }
  return out;
}

/** One branch of a plan, printed the way a person reads the steel: span, girder, segment, stiffeners, splice set, cover plates. */
function printBranch(p) {
  const byParent = new Map();
  for (const n of p.nodes) {
    const key = n.parentK ?? -1;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  const kids = (n) => (n ? byParent.get(n.k) ?? [] : []);
  const rows = (n) => {
    const m = new Map();
    for (const k of kids(n)) { const key = k.bomLineId ?? `k${k.k}`; if (!m.has(key)) m.set(key, []); m.get(key).push(k); }
    return [...m.values()];
  };
  const suffix = (n, parent) => n.code.slice(parent.code.length);
  const tops = byParent.get(-1) ?? [];
  const span = tops[0];
  const girder = kids(span).find((n) => kids(n).length);
  const segment = kids(girder).find((n) => /^-\d+$/.test(suffix(n, girder)) && kids(n).length);
  const splice = kids(girder).find((n) => !/^-\d+$/.test(suffix(n, girder)) && kids(n).length);
  const stiffenerRows = rows(segment).filter((r) => /^-IS\d+$/.test(suffix(r[0], segment)));
  const lines = [
    ['the span, piece 1', span], ['the span, piece 2', tops[1]], ['girder line', girder], ['segment', segment],
    ...stiffenerRows.flatMap((r, i) => [[`${i ? 'drilled' : 'plain'} stiffener, first of ${r.length}`, r[0]], [`${i ? 'drilled' : 'plain'} stiffener, last of ${r.length}`, r[r.length - 1]]]),
    ['what the first stiffener is cut from', kids(stiffenerRows[0]?.[0])[0]],
    ['splice set', splice],
    ...rows(splice).map((r) => [`cover plate, first of a row of ${r.length}`, r[0]]),
  ];
  for (const [label, n] of lines) if (n) say(`      ${label.padEnd(38)} ${n.code}`);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The structure, read once: every temporary item and the one row it sits on
// ---------------------------------------------------------------------------

async function temporaryCodes(db) {
  const [rows] = await db.query(
    `SELECT m.id, m.code FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL`,
    [COMPANY],
  );
  return new Map(rows.map((r) => [r.id, r.code]));
}

/** Every live row of every Custom BOM, in display order, with what its child is called. */
async function customRows(db) {
  const [rows] = await db.query(
    `SELECT l.id, l.bom_id, b.parent_id, l.line_no, l.quantity, l.child_id,
            ch.short_name AS child_short_name, ch.name AS child_name, i.item_type AS child_item_type,
            sd.short_name AS def_short_name, sd.name AS def_name
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL AND b.bom_type = 'custom'
       JOIN cf_master_records ch ON ch.id = l.child_id
       LEFT JOIN cf_item_details i ON i.master_id = l.child_id AND i.deleted_at IS NULL
       LEFT JOIN cf_master_records sd ON sd.id = i.source_definition_id AND sd.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL
      ORDER BY l.bom_id, l.line_no, l.id`,
    [COMPANY],
  );
  const seen = new Map();          // bom|SHORT -> has an earlier row of more than one piece
  for (const r of rows) {
    r.quantity = Number(r.quantity);
    r.shortName = shortNameOf({ short_name: r.child_short_name, name: r.child_name }, { short_name: r.def_short_name, name: r.def_name });
    const key = `${r.bom_id}\u0000${String(r.shortName ?? '').toUpperCase()}`;
    r.afterMultiPiece = seen.get(key) === true;
    if (r.quantity !== 1) seen.set(key, true);
    else if (!seen.has(key)) seen.set(key, false);
  }
  return rows;
}

/** Order lines that sell a temporary item — the tops of the structures, top down from there. */
async function parentsTopDown(db) {
  const [tops] = await db.query(
    `SELECT ol.item_id FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = ol.item_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.deleted_at IS NULL ORDER BY o.code, ol.line_no`,
    [COMPANY],
  );
  const order = [];
  const seen = new Set();
  let frontier = tops.map((t) => t.item_id);
  for (let depth = 0; frontier.length && depth < 25; depth += 1) {
    const fresh = frontier.filter((id) => !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    if (!fresh.length) break;
    const [kids] = await db.query(
      `SELECT DISTINCT b.parent_id, l.child_id FROM cf_boms b
         JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
         JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`,
      [COMPANY, fresh],
    );
    const withKids = new Set(kids.map((k) => k.parent_id));
    order.push(...fresh.filter((id) => withKids.has(id)));
    frontier = [...new Set(kids.map((k) => k.child_id))];
  }
  return order;
}

/** Counts the round trips made through it (a Proxy, so the node cache still rides on the connection). */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' ? (...args) => { tally.n += 1; return target.query(...args); } : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

async function recodeAll(db, parents) {
  const result = { changed: [], skipped: [], frozen: 0, trips: [] };
  for (const id of parents) {
    const t = counting(db);
    const out = await refreshRangeCodes(t.db, c, id);
    result.changed.push(...out.changed);
    result.skipped.push(...out.skipped);
    if (out.frozen) result.frozen += 1;
    result.trips.push({ id, n: t.tally.n, checked: out.checked, changed: out.changed.length });
  }
  return result;
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? `min ${s[0]}, median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}` : 'none';
};

/**
 * Why each temporary item's code moved, or that it did not. An item on one row:
 *   multi      its row holds more than one piece, so it prints a span (IS1-21)
 *   afterMulti a row of 1 after an earlier row of its short name with more than
 *              one piece: numbered by pieces now, not rows (CP x2, CP x2, CP x1 -> CP5)
 *   parent     its parent's code moved, and it prints that code inside its own
 * A row of 1 whose code moved for none of those reasons is a fault.
 */
function classify(before, after, rows) {
  const rowOf = new Map();
  for (const r of rows) {
    if (r.child_item_type !== 'temporary') continue;
    rowOf.set(r.child_id, rowOf.has(r.child_id) ? null : r);    // null: sits on more than one row
  }
  const moved = (id) => id != null && before.get(id) !== after.get(id);
  const out = { multi: [], afterMulti: [], parent: [], keptOne: [], unexplained: [], ones: 0 };
  for (const [id, r] of rowOf) {
    if (!r) continue;
    if (r.quantity === 1) out.ones += 1;
    if (!moved(id)) { if (r.quantity === 1) out.keptOne.push(id); continue; }
    if (r.quantity !== 1) { out.multi.push(id); continue; }
    const why = [];
    if (r.afterMultiPiece) { out.afterMulti.push(id); why.push('after'); }
    if (moved(r.parent_id)) { out.parent.push(id); why.push('parent'); }
    if (!why.length) out.unexplained.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function verify(db, { before, after, rows, parents, releases }) {
  say('\n--- checks ------------------------------------------------------------');
  let bad = 0;
  const check = (okay, label, extra = '') => { if (!okay) bad += 1; say(`${okay ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`); };

  // The release dry run: what release would write, checked piece by piece.
  for (const { line, p } of releases) {
    const at = `${line.order_code} line ${line.line_no}`;
    const codes = p.nodes.map((n) => n.code);
    check(p.nodes.length > 0, `${at}: the dry run lays out a tree`, `${p.nodes.length} pieces`);
    check(new Set(codes).size === codes.length && p.duplicates.length === 0, `${at}: every piece code is unique across the whole plan`, `${codes.length} codes, ${new Set(codes).size} distinct`);
    check(p.taken.length === 0, `${at}: and none is already a piece of another release`, p.taken.slice(0, 3).join(', '));
    check(p.missing.length === 0 && p.byRule === p.nodes.length, `${at}: every piece is coded by a rule — none falls back to the built-in shape`,
      p.missing.slice(0, 3).map((m) => `${m.itemCode} needs ${m.missing.join(', ')} (${m.schemeCode})`).join('; ') || `${p.byRule} of ${p.nodes.length}`);
    const byK = new Map(p.nodes.map((n) => [n.k, n]));
    const tops = p.nodes.filter((n) => n.parentK == null);
    const topShape = tops.filter((n) => n.code !== `${n.itemCode}-${n.pieceNo}`);
    check(topShape.length === 0 && new Set(tops.map((n) => n.code)).size === tops.length,
      `${at}: the ${tops.length} top piece(s) keep {item code}-{piece no}, and are distinct`, topShape.slice(0, 2).map((n) => n.code).join(', '));
    const offShape = p.nodes.filter((n) => n.parentK != null && !(n.code.startsWith(`${byK.get(n.parentK).code}-`) && n.code.endsWith(String(n.pieceSeq))));
    check(offShape.length === 0, `${at}: every other piece is its parent piece's code, a dash, then its own number`, offShape.slice(0, 2).map((n) => n.code).join(', '));
  }

  const [dupes] = await db.query(
    `SELECT LOWER(code) AS code, COUNT(*) n FROM cf_master_records
      WHERE company_id = ? AND deleted_at IS NULL AND code IS NOT NULL GROUP BY LOWER(code) HAVING n > 1`, [COMPANY]);
  check(!dupes.length, 'every code is unique company-wide', dupes.map((d) => `${d.code} x${d.n}`).join(', '));
  const longest = Math.max(0, ...[...after.values()].map((x) => (x ?? '').length));
  check(longest <= MAX_CODE, `every code fits VARCHAR(${MAX_CODE})`, `longest is ${longest}`);
  check([...after.keys()].every((id) => after.get(id) != null || before.get(id) == null), 'no temporary item lost its code');

  let drift = 0;
  for (const [id, code] of after) {
    const g = await generate(db, COMPANY, 'item', 'code', { entityId: id }, { consume: false }).catch(() => null);
    if (g?.text !== code) { drift += 1; if (drift <= 5) say(`      drift: ${code} would become ${g?.text ?? 'nothing'}`); }
  }
  check(drift === 0, 'a second run would change nothing — every code regenerates to itself', `${after.size} items`);
  const second = await recodeAll(db, parents);
  check(second.changed.length === 0, 'and the batched refresh, run again over every parent, moves nothing', `${second.changed.length} moved`);

  // Quantity 1: the code stays, unless the count before it is of pieces or its parent moved.
  const k = classify(before, after, rows);
  const moved = (id) => id != null && before.get(id) !== after.get(id);
  const oneMoved = new Set([...k.afterMulti, ...k.parent, ...k.unexplained]).size;
  say(`      ${k.ones} temporary items sit on a row of quantity 1: ${k.keptOne.length} kept their code, ${oneMoved} moved —`);
  say(`        ${k.afterMulti.length} numbered by pieces now: an earlier row of their short name holds more than one`);
  say(`        ${k.parent.length} print a parent code that now carries its range`);
  check(k.unexplained.length === 0, 'every other row of quantity 1 kept exactly the code it had',
    k.unexplained.slice(0, 5).map((id) => `${before.get(id)} -> ${after.get(id)}`).join(', '));

  // The BOQ's own drawing marks: the proof the segment codes did not move.
  const [[markSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'DRAWING_MARK' AND deleted_at IS NULL", [COMPANY]);
  if (markSpec) {
    const [segs] = await db.query(
      `SELECT m.id, m.code, v.value_text AS mark FROM cf_master_records m
         JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'GIRDER_SEGMENT'
         JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
         LEFT JOIN cf_spec_values v ON v.subject_id = m.id AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.specification_id = ?
        WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.code`, [markSpec.id, COMPANY]);
    const off = segs.filter((s) => !s.mark || !String(s.code).endsWith(`-${s.mark}`) || moved(s.id));
    check(!off.length, `all ${segs.length} girder segments kept their codes, which end in the BOQ drawing marks`, off.map((s) => `${s.code} vs ${s.mark}`).join(', '));
  }
  return bad;
}

// ---------------------------------------------------------------------------

const conn = await pool.getConnection();
let failed = 0;
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  say(`cf_range_rules — company ${COMPANY}${DRY ? '  (dry run)' : ''}`);

  const before = await temporaryCodes(conn);
  const rows = await customRows(conn);
  const switched = await switchRules(conn);
  const parents = await parentsTopDown(conn);

  say('\n--- re-coding ---------------------------------------------------------');
  const first = await recodeAll(conn, parents);
  say(`   ${parents.length} parents refreshed top down: ${first.changed.length} codes changed, ${first.skipped.length} could not be, ${first.frozen} frozen parents left alone`);
  for (const s of first.skipped.slice(0, 5)) say(`   skipped ${s.code}: ${s.why}`);
  const busiest = [...first.trips].sort((a, b) => b.checked - a.checked || b.n - a.n)[0];
  say(`   round trips per parent: ${stats(first.trips.map((t) => t.n))}`);
  if (busiest) say(`   the parent with the most temporary children (${busiest.checked}) took ${busiest.n} round trips and moved ${busiest.changed} codes`);

  const moving = first.trips.filter((t) => t.changed).sort((a, b) => String(before.get(a.id)).localeCompare(String(before.get(b.id)), 'en', { numeric: true }));
  for (const t of moving.slice(0, 6)) say(`   ${String(before.get(t.id)).padEnd(40)} ${String(t.checked).padStart(3)} checked, ${String(t.changed).padStart(2)} moved, ${t.n} round trips`);

  const after = await temporaryCodes(conn);
  const changedIds = [...after.keys()].filter((id) => before.get(id) !== after.get(id));
  const k = classify(before, after, rows);
  const byCode = (ids) => [...ids].sort((a, b) => String(before.get(a)).localeCompare(String(before.get(b)), 'en', { numeric: true }));
  const show = (title, ids, n) => {
    say(`   ${title}`);
    for (const id of byCode(ids).slice(0, n)) say(`      ${String(before.get(id)).padEnd(44)} -> ${after.get(id)}`);
  };
  say('\n--- a sample of what moved, and what did not -----------------------------');
  if (!changedIds.length) say('   no item code moved');
  else {
    show(`${k.multi.length} rows of more than one piece now print their range:`, k.multi, 6);
    show(`${k.afterMulti.length} rows of one, numbered by pieces after an earlier multi-piece row of their short name:`, k.afterMulti, 4);
    show(`${k.parent.length} rows of one that print a parent code which moved:`, k.parent.filter((id) => !k.afterMulti.includes(id)), 3);
    // Kept rows shown beside siblings that moved, so the contrast is under one parent.
    const parentOfItem = new Map(rows.map((r) => [r.child_id, r.parent_id]));
    const movedParents = new Set(changedIds.map((id) => parentOfItem.get(id)));
    show(`${k.keptOne.length} rows of one kept their code, e.g. beside siblings that moved:`, k.keptOne.filter((id) => movedParents.has(parentOfItem.get(id))), 4);
  }

  say('\n--- release dry run: the codes release would write — nothing written ------');
  const releases = await dryRunReleases(conn);
  if (!releases.length) say('   no custom order line to try');
  for (const { line, p, trips, ms } of releases) {
    say(`   ${line.order_code} line ${line.line_no}: ${p.nodes.length} pieces, ${p.byRule} coded by a rule, in ${trips} round trips (${ms} ms)`);
    // What would still stop a real release — shown, not judged here: releaseCheck owns that.
    if (p.problems.length) say(`      ${p.problems.length} thing(s) would still stop a real release, e.g. "${p.problems[0]}"`);
  }
  if (releases[0]) printBranch(releases.reduce((a, b) => (b.p.nodes.length > a.p.nodes.length ? b : a)).p);

  failed = await verify(conn, { before, after, rows, parents, releases });

  say(`\nchanged: ${switched.length} coding rule(s), ${changedIds.length} codes`);
  detachNodeCache(conn);
  if (DRY || failed) {
    await conn.rollback();
    say(failed ? 'ROLLED BACK — checks failed' : 'rolled back (dry run — nothing written)');
    if (failed) process.exitCode = 1;
  } else {
    await conn.commit();
    say('committed');
  }
} catch (e) {
  await conn.rollback();
  console.error('FAILED:', e.code ?? '', e.message, JSON.stringify(e.problems ?? ''), e.stack?.split('\n').slice(0, 4).join(' / '));
  process.exitCode = 1;
} finally {
  detachNodeCache(conn);
  conn.release();
  await pool.end();
}
