/**
 * cf_recode_order.mjs — gives the KEPL order's temporary items the codes and
 * names they should have had, in place. Nothing is deleted and nothing is
 * recreated: these items carry specification values, BOM lines and history, so
 * every change goes through masterRecordService.updateRecord on the row that is
 * already there.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * 1. Names ended in a number — "Top flange 01", "Girder segment 01". The number
 *    was there to keep names apart. It was never needed, because
 *    cf_master_records is unique on the CODE (uq_cmr_code) and not on the name,
 *    and it did not even work: "Top flange 01" sat under segment GS-046 AND
 *    under GS-047. A name should say what the thing IS; the code says which one.
 *
 * 2. Codes were inconsistent. The span and the girder lines were order-scoped
 *    (SO-20260924-0003-SPAN-01) but a girder segment was GS-046 — a GLOBAL
 *    running number, so two bridges' segments interleave in one sequence and
 *    nothing in the code says which order it belongs to. The cause is the
 *    engine's precedence rule: CFFB-ASSY was conditioned only on
 *    "classification under FAB_ASSY", which weighs 1 + the node's depth = 2,
 *    and that beats the placement condition (weight 1) the order-scoped rules
 *    use. The same bug had already been fixed once, for CFFB-PLATEPART, by
 *    adding "kind = catalog".
 *
 *    The general rule this settles: A CLASSIFICATION-BASED CODE DESCRIBES A
 *    CATALOG TYPE; AN ORDER'S ITEMS ARE CODED BY WHERE THEY SIT. So every
 *    coding rule that selects on classification alone now also says
 *    "kind = catalog", and temporary items are left to the CFTMP-* rules.
 *
 * 3. The 25 cut plates had no code at all: no rule had ever reached them.
 *
 * ---------------------------------------------------------------------------
 * THE CODE CHAIN THIS WRITES
 *
 *   SO-20260924-0003-SPAN-01                 the span the order line sells
 *   SO-20260924-0003-SPAN-01-G1              girder line 1
 *   SO-20260924-0003-SPAN-01-G1-1            its segment 1  (drawing mark G1-1)
 *   SO-20260924-0003-SPAN-01-G1-1-TF1        that segment's top flange
 *   SO-20260924-0003-SPAN-01-G1-1-IS1-21     its 21 plain intermediate stiffeners, one row
 *   SO-20260924-0003-SPAN-01-G1-1-IS22-24    and the copied row of 3 drilled ones
 *   SO-20260924-0003-SPAN-01-G1-SPLC1-4      the girder's four splice sets, one row
 *   SO-20260924-0003-SPAN-01-EDIA1-6         the span's six end diaphragms, one row
 *   SO-20260924-0003-10-CUTPL-25X500X11650-E350   a blank eight parts are cut from
 *
 * Why this shape:
 *   - Every code starts at the ORDER NUMBER, so it is unique company-wide by
 *     construction and a second order for the same bridge gets its own chain.
 *   - It is read down the tree the way the shop reads the drawing: span,
 *     girder, segment, part. "G1-1" is exactly the mark the BOQ uses.
 *   - A segment is a bare number under its girder because its girder is already
 *     in the code — GLINE-01-GS-01 says "girder" twice. The number comes from
 *     the BOM POSITION, not from the DRAWING_MARK specification, because a code
 *     must not break when a text field is left empty; the script checks that
 *     the two agree for all 20 segments, so the mark is the proof and the
 *     position is the source.
 *   - Everything else keeps its short name, followed by the RANGE of pieces its
 *     row covers under its parent (user, 2026-09-26): a repeat is one row with
 *     a quantity and a slightly different copy is a copied row, so 21 plain
 *     stiffeners and their copy of 3 drilled ones are IS1-21 and IS22-24, and a
 *     single top flange is TF1. Rows of one short name share the count; it
 *     starts again under every parent (codeRangeService). It used to be the
 *     row's position (IS1, IS2), which counted rows, not pieces. Only the top
 *     code is padded (SPAN-01): that is the one that goes on the order
 *     document; below it the shop shorthand is tighter. cf_range_rules.mjs,
 *     run after this, also writes the codes released pieces take (…-G1-1-IS24).
 *   - A CUT PLATE is not coded from its parent. One blank is shared by up to 20
 *     parts (they are the same rectangle cut off the same sheet), so it has no
 *     single parent to be named after. It is coded by the ORDER LINE it belongs
 *     to — blanks are pooled per line, so the line is what makes it unique —
 *     and by the rectangle, written thickness x width x length like the raw
 *     plate it comes off, so the two read alike:
 *     SO-20260924-0003-10-CUTPL-25X500X11650-E350 out of PL-25X1850X12000-E350BO.
 *
 * Longest code written: well inside the 100 characters `code` allows.
 *
 * ---------------------------------------------------------------------------
 * Re-runnable. Every step compares before it writes, and codes are PEEKED
 * (consume: false) rather than drawn, so no running number is ever burnt. A
 * second run reports nothing changed.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/cf_recode_order.mjs
 *   node scripts/cf_kepl/cf_recode_order.mjs --dry-run      # roll back at the end
 *   node scripts/cf_kepl/cf_recode_order.mjs --verify-only  # no writes at all
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');   // registers the code-generator entities
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const { generate } = await imp('apps/cf_erp/modules/codegen/index.js');
const { loadMaster } = await imp('apps/cf_erp/services/records.js');
const { refreshRangeCodes } = await imp('apps/cf_erp/services/codeRangeService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const DRY = process.argv.includes('--dry-run');
const VERIFY_ONLY = process.argv.includes('--verify-only');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const say = (...a) => console.log(...a);

/** The span the BOQ states, to 2 dp. Nothing here touches weights; if it moves, something is wrong. */
const SPAN_WEIGHT_KG = 334644.13;

const tally = { rules: 0, shortNames: 0, codes: 0, names: 0, unchanged: 0 };
const problems = [];

// ---------------------------------------------------------------------------
// Coding rules
// ---------------------------------------------------------------------------

const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'upper', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });

/** One shape for a segment, whichever end it came from, so two rules can be compared. */
const segKey = (s) => JSON.stringify([
  s.segmentType ?? s.segment_type,
  s.literalText ?? s.literal_text ?? null,
  s.tokenKey ?? s.token_key ?? null,
  (s.format ?? '') === '' ? null : s.format,
  s.transform ?? 'none',
  s.maxLength ?? s.max_length ?? null,
  (s.isRequired ?? s.is_required ?? true) ? 1 : 0,
]);
const condKey = (x) => `${x.tokenKey ?? x.token_key} ${x.operator ?? 'eq'} ${String(x.value).trim()}`;
const sorted = (xs) => [...xs].sort();

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

async function schemeByCode(db, code) {
  const [[row]] = await db.query(
    'SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  return row ? codegen.getScheme(db, COMPANY, row.id) : null;
}

/**
 * A rule written for catalog TYPES also has to say so, or it outranks the
 * order-scoped rules on condition weight and swallows the order's items.
 */
async function requireCatalogOnly(db, code) {
  const full = await schemeByCode(db, code);
  if (!full) { problems.push(`coding rule ${code} is missing`); return; }
  if (full.conditions.some((x) => x.tokenKey === 'kind')) { say(`   ${code.padEnd(17)} already says kind = catalog`); return; }
  const body = asBody(full);
  body.conditions.push({ tokenKey: 'kind', operator: 'eq', value: 'catalog' });
  if (!VERIFY_ONLY) await codegen.updateScheme(db, COMPANY, c.userId, full.id, body);
  tally.rules += 1;
  say(`   ${code.padEnd(17)} + kind = catalog`);
}

/** Creates the rule, or replaces it when anything about it differs. */
async function putScheme(db, want) {
  const full = await schemeByCode(db, want.code);
  if (full) {
    const same = full.entityType === want.entityType && full.targetField === want.targetField
      && full.seqScope === want.seqScope && full.priority === want.priority && full.status === (want.status ?? 'active')
      && full.name === want.name && (full.description ?? null) === (want.description ?? null)
      && JSON.stringify(sorted(full.conditions.map(condKey))) === JSON.stringify(sorted(want.conditions.map(condKey)))
      && JSON.stringify(full.segments.map(segKey)) === JSON.stringify(want.segments.map(segKey));
    if (same) { say(`   ${want.code.padEnd(17)} unchanged`); return; }
    if (!VERIFY_ONLY) await codegen.updateScheme(db, COMPANY, c.userId, full.id, want);
    tally.rules += 1;
    say(`   ${want.code.padEnd(17)} rewritten`);
    return;
  }
  if (!VERIFY_ONLY) await codegen.createScheme(db, COMPANY, c.userId, want);
  tally.rules += 1;
  say(`   ${want.code.padEnd(17)} created`);
}

async function nodeId(db, code) {
  const [[n]] = await db.query(
    'SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (!n) throw new Error(`classification node ${code} is missing — run cf_bridge_setup.mjs first`);
  return String(n.id);
}

async function ensureRules(db) {
  say('\n--- coding rules ------------------------------------------------------');
  // Written for catalog types; they must not reach an order's items.
  for (const code of ['CFRM-STEEL', 'CFRM-PLATE', 'CFBO-FASTENER', 'CFFB-ASSY', 'CFFB-PROFILEPART']) {
    await requireCatalogOnly(db, code);
  }

  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const inside = { tokenKey: 'placement', operator: 'eq', value: 'component' };

  // The item the sales line sells. Unchanged: SO-20260924-0003-SPAN-01 is the
  // code on the order document, and it is the root every other code hangs off.
  await putScheme(db, {
    code: 'CFTMP-LINE', name: 'Temporary item on an order line', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: -10, status: 'active',
    description: 'The order number, the template short name and the line position: SO-20260924-0003-SPAN-01.',
    conditions: [temporary, { tokenKey: 'placement', operator: 'eq', value: 'line' }],
    segments: [tok('order.code'), lit('-'), tok('record.shortName'), lit('-'), tok('position', { format: '00' })],
  });

  // Everything inside: the parent's code, the short name and the range of pieces
  // the row covers under that parent, with no separator before the number so it
  // reads as one shop mark — TF1, IS1-21, IS22-24. THIS is the one definition of
  // the rule's shape; cf_range_rules.mjs only switches rules still ending in
  // {position}, and leaves this one alone.
  await putScheme(db, {
    code: 'CFTMP-PART', name: 'Temporary item inside another', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: -10, status: 'active',
    description: 'The parent item code, the short name and the pieces its row covers under that parent: SO-20260924-0003-SPAN-01-G1-1-TF1, …-G1-1-IS1-21 and its copied row …-G1-1-IS22-24.',
    conditions: [temporary, inside],
    segments: [tok('parent.code'), lit('-'), tok('record.shortName'), tok('range', { format: '0' })],
  });

  // A girder is cut into segments along its length, and the girder is already
  // in the parent code, so the segment is the number alone: ...-G1-1 .. ...-G1-5.
  await putScheme(db, {
    code: 'CFTMP-SEGMENT', name: 'Girder segment on an order', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: -10, status: 'active',
    description: 'The girder line code and the segment number along it: SO-20260924-0003-SPAN-01-G1-1. The number is the BOM position, which is the segment\'s DRAWING_MARK by construction.',
    conditions: [temporary, inside, { tokenKey: 'classification', operator: 'eq', value: await nodeId(db, 'GIRDER_SEGMENT') }],
    segments: [tok('parent.code'), lit('-'), tok('position', { format: '0' })],
  });

  // A blank has no one parent — the same rectangle is cut for up to 20 parts —
  // so it is coded by WHERE IT BELONGS and WHAT IT IS, with no placement
  // condition on purpose. Where it belongs is an order LINE, not an order:
  // cutPlateService pools blanks per line (deriveCutPlates takes an
  // orderLineId), so two lines of one order that each need a 25x500x11650 blank
  // get two of them, and an order-only code would collide on uq_cmr_code with a
  // raw MySQL error. What it is, is a rectangle of steel, written thickness x
  // width x length like the raw plate it comes off so the two read alike.
  await putScheme(db, {
    code: 'CFTMP-BLANK', name: 'Cut plate on an order', entityType: 'item', targetField: 'code',
    seqScope: 'prefix', priority: -10, status: 'active',
    description: 'The order number, the order line, and the rectangle — thickness x width x length and grade, the way the raw plate code reads: SO-20260924-0003-10-CUTPL-25X500X11650-E350. A blank is shared by every part of that size on that line, so it is never coded from a parent; the line is in the code because blanks are pooled per line.',
    conditions: [temporary, { tokenKey: 'classification', operator: 'under', value: await nodeId(db, 'CUT_PLATE') }],
    segments: [
      tok('order.code'), lit('-'), tok('line.no'), lit('-'), tok('record.shortName'), lit('-'),
      tok('spec:THICKNESS'), lit('X'), tok('spec:WIDTH'), lit('X'), tok('spec:LENGTH'), lit('-'), tok('spec:GRADE'),
    ],
  });
}

// ---------------------------------------------------------------------------
// Short names
// ---------------------------------------------------------------------------

/**
 * A girder line is called G1 on every drawing of every bridge, so G is the
 * design's own short name, not a patch on this order. Its code (GLINE-002) was
 * minted once and does not move — a short name only feeds codes made from now on.
 */
const SHORT_NAMES = [{ name: 'Girder line', shortName: 'G' }];

async function ensureShortNames(db) {
  say('\n--- short names -------------------------------------------------------');
  for (const want of SHORT_NAMES) {
    const [[d]] = await db.query(
      `SELECT m.id, m.code, m.short_name FROM cf_master_records m
         JOIN cf_definition_details dd ON dd.master_id = m.id AND dd.deleted_at IS NULL
        WHERE m.company_id = ? AND m.name = ? AND m.deleted_at IS NULL`, [COMPANY, want.name]);
    if (!d) { problems.push(`template definition "${want.name}" not found`); continue; }
    if (d.short_name === want.shortName) { say(`   ${d.code.padEnd(17)} short name already ${want.shortName}`); continue; }
    if (!VERIFY_ONLY) await recs.updateRecord(db, c, d.id, { shortName: want.shortName });
    tally.shortNames += 1;
    say(`   ${d.code.padEnd(17)} short name ${d.short_name} -> ${want.shortName}`);
  }
}

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

/** Every temporary child of these parents, in BOM order. */
async function childrenOf(db, ids) {
  const [rows] = await db.query(
    `SELECT b.parent_id, l.child_id, l.position, l.role, l.line_no, l.quantity
       FROM cf_boms b
       JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL
      ORDER BY l.line_no, l.id`, [COMPANY, ids]);
  return rows;
}

/**
 * One item: the name its design gives it, and the code its rule makes. Cut
 * plates come from no design, so they keep the name cutPlateService wrote —
 * which already says what it is ("Cut plate 25 × 500 × 11650 E350").
 */
async function recodeOne(db, id) {
  const m = await loadMaster(db, COMPANY, id);
  const def = m.source_definition_id ? await loadMaster(db, COMPANY, m.source_definition_id) : null;
  const patch = {};

  const wantName = def?.name ?? null;
  if (wantName && wantName !== m.name) patch.name = wantName;

  let g = null;
  try { g = await generate(db, COMPANY, 'item', 'code', { entityId: id }, { consume: false }); }
  catch (e) { problems.push(`${m.code ?? m.name}: ${e.code} ${e.message}`); }
  if (!g) problems.push(`${m.code ?? m.name}: no coding rule applies`);
  else if (!g.text) problems.push(`${m.code ?? m.name}: rule ${g.schemeCode} needs ${g.missing.join(', ')}`);
  else if (g.text !== m.code) patch.code = g.text;

  if (!Object.keys(patch).length) { tally.unchanged += 1; return; }
  if (patch.code) tally.codes += 1;
  if (patch.name) tally.names += 1;
  if (!VERIFY_ONLY) await recs.updateRecord(db, c, id, patch);
  say(`   ${String(m.code ?? 'NULL').padEnd(34)} -> ${String(patch.code ?? m.code).padEnd(42)} ${patch.name ? `"${m.name}" -> "${patch.name}"` : ''}`);
}

/**
 * Range codes first, one parent at a time and all of a parent's rows at once.
 * When rows go from counting positions to counting pieces, a later row's new
 * code can be another row's old one — X x2, X x1, X x1 turns X2 into X3 while
 * the third row still holds X3 — and the one-at-a-time updates in recodeOne
 * would run into it. refreshRangeCodes writes a parent's rows together (and the
 * codes built on them below), so they never meet. What it does not touch —
 * names, codes made by other rules — recodeOrders still does.
 */
async function renumberRanges(db) {
  say('\n--- range codes -------------------------------------------------------');
  const [tops] = await db.query(
    `SELECT ol.item_id FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = ol.item_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.deleted_at IS NULL ORDER BY o.code, ol.line_no`, [COMPANY]);
  const seen = new Set();
  let moved = 0;
  let frontier = tops.map((t) => t.item_id);
  for (let depth = 0; frontier.length && depth < 25; depth += 1) {
    const fresh = frontier.filter((id) => !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    for (const id of fresh) {
      const out = await refreshRangeCodes(db, c, id);
      for (const ch of out.changed) say(`   ${String(ch.from ?? 'NULL').padEnd(34)} -> ${ch.to}`);
      for (const s of out.skipped) problems.push(`${s.code ?? s.id}: ${s.why}`);
      moved += out.changed.length;
    }
    frontier = [...new Set((await childrenOf(db, fresh)).map((r) => r.child_id))];
  }
  tally.codes += moved;
  say(`   ${moved} codes renumbered by the pieces their rows cover`);
}

/**
 * Top down, because a code is built from its parent's. A blank is reached from
 * many parents and is done once — its code does not depend on any of them.
 */
async function recodeOrders(db) {
  say('\n--- items -------------------------------------------------------------');
  const [tops] = await db.query(
    `SELECT ol.item_id, o.code AS order_code FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = ol.item_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.deleted_at IS NULL ORDER BY o.code, ol.line_no`, [COMPANY]);
  if (!tops.length) { say('   no order sells a temporary item'); return []; }

  const done = new Set();
  const roots = [];
  for (const t of tops) {
    say(`   ${t.order_code}:`);
    roots.push(t.item_id);
    let frontier = [t.item_id];
    for (let depth = 0; frontier.length && depth < 25; depth += 1) {
      const fresh = frontier.filter((id) => !done.has(id));
      for (const id of fresh) { done.add(id); await recodeOne(db, id); }
      frontier = [...new Set((await childrenOf(db, frontier)).map((r) => r.child_id))];
    }
  }
  say(`   ${done.size} temporary items visited; ${tally.codes} codes and ${tally.names} names changed, ${tally.unchanged} already right`);
  return roots;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function printTree(db, rootIds) {
  say('\n--- the tree ----------------------------------------------------------');
  const shown = new Set();
  let rows = 0;
  const walk = async (id, depth, role, position, quantity) => {
    const [[m]] = await db.query(
      `SELECT m.id, m.code, m.name, n.code AS cls FROM cf_master_records m
         LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id WHERE m.id = ?`, [id]);
    const again = shown.has(id);
    shown.add(id);
    rows += 1;
    say(`${'  '.repeat(depth)}${m.code ?? '(no code)'}  ${m.name}${role ? `  [${role}]` : ''}`
      + `${quantity && Number(quantity) !== 1 ? ` x${Number(quantity)}` : ''}${again ? '   (same blank again)' : ''}`);
    if (again) return;                                   // a shared blank is drawn out once
    for (const ch of await childrenOf(db, [id])) await walk(ch.child_id, depth + 1, ch.role, ch.position, ch.quantity);
  };
  for (const id of rootIds) await walk(id, 0, null, null, null);
  say(`   (${rows} rows, ${shown.size} distinct temporary items)`);
  return shown;
}

async function verify(db, rootIds) {
  const shown = await printTree(db, rootIds);
  say('\n--- checks ------------------------------------------------------------');
  const check = (ok, label, extra = '') => say(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`);
  let bad = 0;
  const fail = (label, extra) => { bad += 1; check(false, label, extra); };

  const [items] = await db.query(
    `SELECT m.id, m.code, m.name, n.code AS cls FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
       LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.id`, [COMPANY]);

  if (items.length === shown.size) check(true, `${items.length} temporary items, all reachable from an order line`);
  else fail('some temporary items hang off no order line', `${items.length} rows, ${shown.size} in the tree`);

  const nulls = items.filter((r) => !r.code);
  nulls.length ? fail('every temporary item has a code', `${nulls.length} without one`) : check(true, 'every temporary item has a code');

  // A NUMBER on the end, not a digit: "Top flange 01" is the fault, "… E350" is a steel grade.
  const numbered = items.filter((r) => /\s\d+$/.test(r.name ?? ''));
  numbered.length
    ? fail('no name ends in a number', numbered.slice(0, 5).map((r) => r.name).join(' | '))
    : check(true, 'no name ends in a number');

  const [dupes] = await db.query(
    `SELECT LOWER(code) AS code, COUNT(*) n FROM cf_master_records
      WHERE company_id = ? AND deleted_at IS NULL AND code IS NOT NULL
      GROUP BY LOWER(code) HAVING n > 1`, [COMPANY]);
  dupes.length
    ? fail('every code is unique company-wide', dupes.map((d) => `${d.code} x${d.n}`).join(', '))
    : check(true, 'every code is unique company-wide (checked against all records, not just this order)');

  const long = items.filter((r) => (r.code ?? '').length > 100);
  long.length ? fail('every code fits VARCHAR(100)', `longest ${Math.max(...items.map((r) => (r.code ?? '').length))}`)
    : check(true, `every code fits VARCHAR(100)`, `longest is ${Math.max(...items.map((r) => (r.code ?? '').length))}`);

  // The segment codes should spell the drawing marks. The mark is the proof, the position is the source.
  const [segs] = await db.query(
    `SELECT m.code, v.value_text AS mark FROM cf_master_records m
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'GIRDER_SEGMENT'
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
       LEFT JOIN cf_spec_values v ON v.subject_id = m.id AND v.subject_type = 'master' AND v.deleted_at IS NULL
         AND v.specification_id = (SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'DRAWING_MARK')
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.code`, [COMPANY, COMPANY]);
  const offMark = segs.filter((s) => !s.mark || !String(s.code).endsWith(`-${s.mark}`));
  offMark.length
    ? fail('every segment code ends in its drawing mark', offMark.map((s) => `${s.code} vs ${s.mark}`).join(', '))
    : check(true, `all ${segs.length} segment codes end in their drawing mark (G1-1 … G4-5)`);

  const [[w]] = await db.query(
    `SELECT m.code, v.value_number FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'WEIGHT'
       JOIN cf_master_records m ON m.id = v.subject_id AND m.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.code = 'BRIDGE_SPAN'
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL`, [COMPANY]);
  const kg = w ? Number(Number(w.value_number).toFixed(2)) : null;
  kg === SPAN_WEIGHT_KG
    ? check(true, `the span still rolls up to ${SPAN_WEIGHT_KG} kg`, w.code)
    : fail(`the span rolls up to ${SPAN_WEIGHT_KG} kg`, `got ${kg}`);

  // Idempotence, proved rather than promised: regenerate every code and compare.
  let drift = 0;
  for (const r of items) {
    const g = await generate(db, COMPANY, 'item', 'code', { entityId: r.id }, { consume: false }).catch(() => null);
    if (g?.text !== r.code) { drift += 1; if (drift <= 5) say(`      drift: ${r.code} would become ${g?.text ?? 'nothing'}`); }
  }
  drift ? fail('a second run would change nothing', `${drift} codes would move`)
    : check(true, 'a second run would change nothing — every code regenerates to itself');

  for (const p of problems) fail('problem', p);
  say(`\n${bad ? `${bad} CHECK(S) FAILED` : 'all checks passed'}`);
  return bad;
}

// ---------------------------------------------------------------------------

const conn = await pool.getConnection();
let failed = 0;
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  say(`cf_recode_order — company ${COMPANY}${VERIFY_ONLY ? '  (verify only)' : DRY ? '  (dry run)' : ''}`);

  await ensureRules(conn);
  await ensureShortNames(conn);
  if (!VERIFY_ONLY) await renumberRanges(conn);
  const roots = await recodeOrders(conn);
  failed = await verify(conn, roots);

  say(`\nchanged: ${tally.rules} coding rules, ${tally.shortNames} short names, ${tally.codes} codes, ${tally.names} names`);
  detachNodeCache(conn);
  if (VERIFY_ONLY || DRY || failed) {
    await conn.rollback();
    say(failed ? 'ROLLED BACK — checks failed' : 'rolled back (nothing written)');
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
