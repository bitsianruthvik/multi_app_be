/**
 * code_range_test.mjs — running piece numbers per parent: codeRangeService,
 * the `range` token for items and `piece.seq` for released pieces, and the
 * codes kept true when a row moves. Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/code_range_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. The last thing
 * it does is re-count every cf_ table and prove each is back to the count it
 * started at.
 *
 * IT OWNS ITS FIXTURE: its own Family > Subfamily > Variants, its own
 * specification, template definitions, flow, customer, order and coding rules —
 * nothing of company 2's KEPL data. Four suites went red this week by borrowing
 * shared tenant data (uq_ccn_sibling is unique on NAME), so every name and code
 * here carries this run's tag. Every other item and production-piece coding
 * rule of the company is switched off for the transaction, and the fixture
 * asserts its codes come from its own rules.
 *
 * The fixture — the user's own example, twice over:
 *
 *   GIRDER  (the order line sells 2)
 *     SEG x1          line 10          -> SG1
 *     SEG x1          line 20          -> SG2
 *       TF  x1        line 10          -> TF1
 *       IS  x23       line 20 (plain)  -> IS1-23
 *       IS  x3        line 30 (drilled)-> IS24-26
 *         BLK x1      (every IS)       -> …-IS1-23-BLK1L250   (a spec in the rule)
 *
 * Released, with production-piece rules shaped as cf_range_rules.mjs writes
 * them for the company, the pieces are GIRDER-1 and -2, then …-1-1 (a segment
 * prints no short name), …-1-1-IS24 … IS26 (the drilled copy), …-IS24-BLK1 —
 * and the release dry run (previewReleaseCodes) shows exactly those codes
 * before anything is written.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');           // registers the code-generator entities
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const { generate, listEntities } = await imp('apps/cf_erp/modules/codegen/index.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const R = await imp('apps/cf_erp/services/codeRangeService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const { setValues } = await imp('apps/cf_erp/services/valueService.js');
const { temporaryTree } = await imp('apps/cf_erp/services/instantiationService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');

const COMPANY = Number(process.env.CF_RANGE_COMPANY ?? 2);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/**
 * ok(name, cond, detail?) — the NAME comes first. It demands a string and then
 * a boolean, so a swapped ok(cond, 'name'), or a truthy object passed as the
 * condition, throws instead of passing unconditionally (that has happened
 * twice in this codebase this week).
 */
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(name, cond) takes a string and then a boolean — got ok(${typeof name}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" is a fact and not a hope
 * ----------------------------------------------------------------------- */
async function cfTables(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  return rows.map((r) => Object.values(r)[0]).sort();
}
async function census(db, tables) {
  const out = {};
  for (const t of tables) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}

/** Counts the round trips made through it. A Proxy, so the transaction's node cache still rides on the connection. */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' ? (...args) => { tally.n += 1; return target.query(...args); } : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

/* --------------------------------------------------------------------------
 * The fixture — all of it this run's own
 * ----------------------------------------------------------------------- */
const tag = `TCR${Date.now().toString(36).toUpperCase()}`;
const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });

async function buildFixture(db, c) {
  const fam = await createNode(db, c, { code: `${tag}-F`, name: `Range fixture ${tag}` });
  const sub = await createNode(db, c, { parentId: fam.id, code: `${tag}-S`, name: `Range fixture kinds ${tag}` });
  const vAssy = await createNode(db, c, { parentId: sub.id, code: `${tag}-VA`, name: `Assemblies ${tag}` });
  const vSeg = await createNode(db, c, { parentId: sub.id, code: `${tag}-VS`, name: `Segments ${tag}` });
  const vPart = await createNode(db, c, { parentId: sub.id, code: `${tag}-VP`, name: `Parts ${tag}` });
  const vBlank = await createNode(db, c, { parentId: sub.id, code: `${tag}-VB`, name: `Blanks ${tag}` });
  const vMat = await createNode(db, c, { parentId: sub.id, code: `${tag}-VM`, name: `Material ${tag}` });

  // One specification of its own. specificationService is being changed by
  // another agent this week, and a number specification is one row — written
  // exactly as createSpec writes it.
  const lenCode = `${tag}_LEN`;
  const [sr] = await db.query(
    "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status, created_by) VALUES (?, ?, ?, 'number', 'mm', 'active', ?)",
    [COMPANY, lenCode, `Blank length ${tag}`, c.userId],
  );
  // Fixed on the blanks' Variant: every blank reads 250, so a rule can print it.
  await createRule(db, c, {
    specificationId: sr.insertId, subjectType: 'classification', subjectId: vBlank.id,
    captureAt: 'item', valueRule: 'fixed', isRequired: false, isApplicable: true,
  });
  await setValues(db, c, 'classification', vBlank.id, [{ specCode: lenCode, value: 250 }]);

  const op = await OPS.createOperation(db, c, { code: `${tag}-OP`, name: `Make ${tag}` });
  const flow = await FLOWS.createFlow(db, c, { code: `${tag}-FL`, name: `Make ${tag}` });
  await FLOWS.addStep(db, c, flow.id, { operationId: op.id });
  await FLOWS.setFlowStatus(db, c, flow.id, 'active');

  const mat = await MR.createItem(db, c, {
    itemType: 'catalog', classificationId: vMat.id, code: `${tag}-MAT`, name: `Plate stock ${tag}`, shortName: 'MAT', uom: 'kg', status: 'active',
  });
  const tpl = async (code, name, shortName, classificationId) => {
    const d = await MR.createDefinition(db, c, {
      definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, shortName, status: 'active',
    });
    await MR.updateRecord(db, c, d.id, { defaultFlowId: flow.id });
    return d;
  };
  const BLK = await tpl('BLK', 'Blank', 'BLK', vBlank.id);
  const IS = await tpl('IS', 'Stiffener', 'IS', vPart.id);
  const TF = await tpl('TF', 'Top flange', 'TF', vPart.id);
  const SG = await tpl('SG', 'Segment', 'SG', vSeg.id);
  // The girder's short name carries the tag: a released line's top pieces have
  // no parent code, and piece codes are unique company-wide.
  const GR = await tpl('GR', 'Girder', `GR${tag}`, vAssy.id);

  await B.addLine(db, c, BLK.id, { childId: mat.id, quantity: 0.25 });
  await B.setBomStatus(db, c, BLK.id, 'active');
  await B.addLine(db, c, IS.id, { childId: BLK.id, quantity: 1 });
  await B.setBomStatus(db, c, IS.id, 'active');
  await B.addLine(db, c, TF.id, { childId: mat.id, quantity: 1.5 });
  await B.setBomStatus(db, c, TF.id, 'active');
  await B.addLine(db, c, SG.id, { childId: TF.id, quantity: 1, role: 'Top flange' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 23, role: 'Stiffener — plain' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 3, role: 'Stiffener — drilled' });
  await B.setBomStatus(db, c, SG.id, 'active');
  await B.addLine(db, c, GR.id, { childId: SG.id, quantity: 1, role: 'Segment 1' });
  await B.addLine(db, c, GR.id, { childId: SG.id, quantity: 1, role: 'Segment 2' });
  await B.setBomStatus(db, c, GR.id, 'active');

  // Its coding rules. The classification condition makes them outweigh any
  // company rule that could reach these items, and the rest are switched off
  // below anyway.
  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const under = { tokenKey: 'classification', operator: 'under', value: String(fam.id) };
  const inside = { tokenKey: 'placement', operator: 'eq', value: 'component' };
  const rule = (code, body) => codegen.createScheme(db, COMPANY, c.userId, {
    code: `${tag}-${code}`, name: `Range test ${code} ${tag}`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', ...body,
  });
  const rules = {
    line: await rule('LINE', {
      conditions: [temporary, { tokenKey: 'placement', operator: 'eq', value: 'line' }, under],
      segments: [tok('order.code'), lit('-'), tok('record.shortName'), tok('position', { format: '00' })],
    }),
    part: await rule('PART', {
      conditions: [temporary, inside, under],
      segments: [tok('parent.code'), lit('-'), tok('record.shortName'), tok('range')],
    }),
    blank: await rule('BLANK', {
      conditions: [temporary, inside, { tokenKey: 'classification', operator: 'eq', value: String(vBlank.id) }],
      segments: [tok('parent.code'), lit('-'), tok('record.shortName'), tok('range'), lit('L'), tok(`spec:${lenCode}`)],
    }),
    // Released pieces, shaped as cf_range_rules.mjs writes them for the company
    // (CFPC-TOP / -PART / -SEGMENT): the top keeps {item code}-{piece no}, a
    // piece inside another is its parent's code, its short name and its own
    // number, and the segments — whose item codes this fixture pretends print
    // no short name — are the parent's code and the number alone.
    pieceTop: await rule('PTOP', {
      entityType: 'production_piece', conditions: [temporary, { tokenKey: 'placement', operator: 'eq', value: 'line' }, under],
      segments: [tok('item.code'), lit('-'), tok('piece.seq')],
    }),
    piecePart: await rule('PPART', {
      entityType: 'production_piece', conditions: [{ tokenKey: 'placement', operator: 'eq', value: 'component' }, under],
      segments: [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')],
    }),
    pieceSeg: await rule('PSEG', {
      entityType: 'production_piece', conditions: [{ tokenKey: 'placement', operator: 'eq', value: 'component' }, { tokenKey: 'classification', operator: 'eq', value: String(vSeg.id) }],
      segments: [tok('parent.code'), lit('-'), tok('piece.seq')],
    }),
  };
  return { fam, vAssy, vSeg, vPart, vBlank, vMat, lenCode, op, flow, mat, BLK, IS, TF, SG, GR, rules };
}

/** A parent's rows in display order, with each child's code. */
async function rowsOf(db, parentId) {
  const [rows] = await db.query(
    `SELECT l.id AS lineId, l.line_no AS lineNo, l.quantity, l.child_id AS childId, m.code
       FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id
      WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL ORDER BY l.line_no, l.id`,
    [COMPANY, parentId],
  );
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
}
async function codeOf(db, id) {
  const [[r]] = await db.query('SELECT code FROM cf_master_records WHERE id = ?', [id]);
  return r?.code ?? null;
}
/** A segment's three rows as the template laid them out: TF x1 (line 10), IS x23 (20), IS x3 (30). */
async function segmentOf(db, segId) {
  const rows = await rowsOf(db, segId);
  if (rows.length !== 3) throw new Error(`segment ${segId} has ${rows.length} rows, not 3 — the fixture is not what this test expects`);
  return { rows, tf: rows[0], is23: rows[1], is3: rows[2] };
}

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`code_range_test — company ${COMPANY}, fixture tag ${tag}`);

section('0. The harness refuses a swapped ok()');
const swapped = await refusal(() => ok(true, 'swapped'));
ok('ok(cond, name) throws instead of passing', swapped instanceof Error);

const TABLES = await cfTables(pool);
const before = await census(pool, TABLES);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };

  // Every other item and production-piece coding rule of the company goes quiet
  // for the transaction; the fixture's rules are the only ones that can apply.
  const [rivals] = await conn.query(
    `SELECT id, code FROM cf_code_schemes WHERE company_id = ? AND entity_type IN ('item', 'production_piece')
        AND status = 'active' AND deleted_at IS NULL`,
    [COMPANY],
  );
  if (rivals.length) await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id IN (?)", [COMPANY, rivals.map((r) => r.id)]);

  const f = await buildFixture(conn, c);
  const party = await PARTIES.createParty(conn, c, { code: `${tag}-CUST`, name: `Range test customer ${tag}`, roles: ['customer'] });
  const order = await SO.createOrder(conn, c, { orderType: 'customer', customerId: party.id, code: `${tag}-SO`, title: `Range fixture ${tag}`, committedDate: '2026-12-31' });
  const withLine = await SO.addOrderLine(conn, c, order.id, { recordId: f.GR.id, quantity: 2 });
  const orderLine = withLine.lines[0];
  const [[{ item_id: rootId }]] = await conn.query('SELECT item_id FROM cf_sales_order_lines WHERE id = ?', [orderLine.id]);
  const rootCode = await codeOf(conn, rootId);
  const segRows = await rowsOf(conn, rootId);
  const seg1 = await segmentOf(conn, segRows[0].childId);
  const seg2 = await segmentOf(conn, segRows[1].childId);
  const seg1Code = segRows[0].code;
  const seg2Code = segRows[1].code;
  const blkUnder = async (isId) => (await rowsOf(conn, isId))[0];
  const tree = await temporaryTree(conn, COMPANY, rootId);

  /* ---- isolation -------------------------------------------------------- */
  section('1. The fixture is coded by its own rules and nobody else\'s');
  eq('the order line sells the girder, coded by the fixture\'s line rule (order, short name, position 01)', rootCode, `${tag}-SO-GR${tag}01`);
  let foreign = 0;
  for (const id of tree) {
    const g = await generate(conn, COMPANY, 'item', 'code', { entityId: id }, { consume: false });
    if (!g || !String(g.schemeCode).startsWith(`${tag}-`)) foreign += 1;
  }
  eq(`all ${tree.length} temporary items of the order choose a rule of this run`, foreign, 0);
  eq('13 temporary items: girder, 2 segments, 2 x (TF, IS x23, IS x3, 2 blanks)', tree.length, 13);

  /* ---- 23 + 3 --------------------------------------------------------------- */
  section('2. IS x23 then its copy IS x3, under one parent: 1–23 and 24–26');
  const r1 = await R.rangesOfParent(conn, COMPANY, segRows[0].childId);
  const rIS23 = r1.lines.find((l) => l.lineId === seg1.is23.lineId);
  const rIS3 = r1.lines.find((l) => l.lineId === seg1.is3.lineId);
  same('the rows come back in display order', r1.lines.map((l) => l.lineNo), [10, 20, 30]);
  same('IS x23 covers 1 … 23', [rIS23?.start, rIS23?.end, rIS23?.text], [1, 23, '1-23']);
  same('IS x3, the copy, carries on: 24 … 26', [rIS3?.start, rIS3?.end, rIS3?.text], [24, 26, '24-26']);
  eq('both counted under the short name IS — the definition\'s, since the items have none of their own', rIS3?.shortName, 'IS');
  eq('the row\'s code prints its range', seg1.is23.code, `${seg1Code}-IS1-23`);
  eq('and the copy\'s prints 24-26', seg1.is3.code, `${seg1Code}-IS24-26`);
  eq('a blank under IS x23 builds on that code, with its own range and a spec value', (await blkUnder(seg1.is23.childId)).code, `${seg1Code}-IS1-23-BLK1L250`);

  /* ---- short names ---------------------------------------------------------- */
  section('3. A different short name keeps its own count');
  const rTF = r1.lines.find((l) => l.lineId === seg1.tf.lineId);
  same('TF x1 is 1 — not 24, not 27', [rTF?.shortName, rTF?.start, rTF?.end], ['TF', 1, 1]);
  eq('and its code is TF1', seg1.tf.code, `${seg1Code}-TF1`);

  /* ---- restart ---------------------------------------------------------------- */
  section('4. The count starts again under the next parent');
  const r2 = await R.rangesOfParent(conn, COMPANY, segRows[1].childId);
  same('under segment 2, IS x23 is 1 … 23 again and the copy 24 … 26',
    r2.lines.map((l) => l.text), ['1', '1-23', '24-26']);
  eq('segment 2\'s copy is coded IS24-26 under its own parent', seg2.is3.code, `${seg2Code}-IS24-26`);
  same('the two segments are SG1 and SG2 under the girder', [segRows[0].code, segRows[1].code], [`${rootCode}-SG1`, `${rootCode}-SG2`]);

  /* ---- batch = single -------------------------------------------------------- */
  section('5. The batched renumbering agrees with the code generator, item for item');
  let drift = 0;
  for (const id of tree) {
    const g = await generate(conn, COMPANY, 'item', 'code', { entityId: id }, { consume: false });
    if (g?.text !== await codeOf(conn, id)) drift += 1;
  }
  eq('every code the order was born with regenerates to itself', drift, 0);
  let moved = 0;
  for (const id of [rootId, segRows[0].childId, segRows[1].childId, seg1.is23.childId, seg1.is3.childId]) {
    moved += (await R.refreshRangeCodes(conn, c, id)).changed.length;
  }
  eq('refreshRangeCodes finds nothing to change on an untouched structure (so its batched contexts pick the same rules and print the same codes)', moved, 0);

  /* ---- position unchanged ---------------------------------------------------- */
  section('6. Rules that use `position` are unchanged');
  const itemTokens = listEntities().find((e) => e.entityType === 'item').tokens;
  const posToken = itemTokens.find((t) => t.key === 'position');
  same('the position token is as it was', [posToken?.label, posToken?.available], ['Position among its siblings of the same design (Web 01, Web 02)', true]);
  ok('and `range` sits beside it in the token list the Coding Rules screen shows', itemTokens.some((t) => t.key === 'range' && t.available === true && typeof t.label === 'string'));
  const byPosition = async (id) => (await generate(conn, COMPANY, 'item', 'code', { entityId: id }, {
    consume: false,
    inline: { code: 'BY-POSITION', segments: codegen.normalizeSegments([tok('parent.code'), lit('-'), tok('record.shortName'), tok('position')]) },
  }))?.text;
  eq('a position rule still numbers the copy by row: IS2', await byPosition(seg1.is3.childId), `${seg1Code}-IS2`);
  eq('and the plain row IS1', await byPosition(seg1.is23.childId), `${seg1Code}-IS1`);
  const pieceTokens = listEntities().find((e) => e.entityType === 'production_piece').tokens;
  same('piece.no is as it was, and piece.seq sits beside it', [pieceTokens.find((t) => t.key === 'piece.no')?.label, pieceTokens.some((t) => t.key === 'piece.seq')],
    ['Piece number among its own kind (blank for a grouped node)', true]);

  /* ---- quantity 1 ------------------------------------------------------------ */
  section('7. A row of quantity 1 keeps the code it had');
  for (const [label, id] of [['segment 1', segRows[0].childId], ['segment 2', segRows[1].childId], ['TF under segment 1', seg1.tf.childId], ['TF under segment 2', seg2.tf.childId]]) {
    eq(`${label}: the range rule gives what the position rule gave`, await codeOf(conn, id), await byPosition(id));
  }
  // …unless an earlier row of its short name holds more than one piece: that is
  // the user's own rule (a count of pieces, not of rows), shown here so the
  // difference is on record rather than a surprise.
  await B.addLine(conn, c, segRows[1].childId, { childId: f.IS.id, quantity: 1, role: 'Stiffener — one more' });
  const late = (await rowsOf(conn, segRows[1].childId)).at(-1);
  eq('a single IS after IS x23 and IS x3 is piece 27', late.code, `${seg2Code}-IS27`);
  eq('where a position rule would call it IS3', await byPosition(late.childId), `${seg2Code}-IS3`);
  await B.removeLine(conn, c, late.lineId);

  /* ---- release ------------------------------------------------------------------ */
  section('8. Release: piece.seq numbers the copy\'s pieces 24, 25, 26 under every parent piece');
  for (const id of tree) await MR.setStatus(conn, c, id, 'active');
  await SO.setOrderStatus(conn, c, order.id, 'confirmed');
  const area = await AREAS.createArea(conn, c, { code: `${tag}-DSP`, name: `Dispatch ${tag}`, purpose: 'dispatch' });
  const check = await REL.releaseCheck(conn, COMPANY, orderLine.id);
  ok('the release check passes', check.problems.length === 0, check.problems.join(' | '));
  const pieceCount = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM cf_production_items WHERE company_id = ?', [COMPANY]))[0][0].n);
  const beforeDry = await pieceCount();
  const dry = await REL.previewReleaseCodes(conn, COMPANY, orderLine.id);
  eq('the dry run writes no piece', await pieceCount(), beforeDry);
  eq('the dry run codes every piece by a rule', dry.byRule, dry.nodes.length);
  same('and finds no code twice, none taken, no rule with a hole', [dry.duplicates.length, dry.taken.length, dry.missing.length], [0, 0, 0]);
  await REL.releaseLine(conn, c, orderLine.id, { finishedAreaId: area.id });
  const releaseId = (await REL.liveReleaseOfLine(conn, COMPANY, orderLine.id))?.id;
  ok('the line is released', Number.isInteger(releaseId));
  const [pieces] = await conn.query(
    'SELECT id, parent_id, item_id, bom_line_id, piece_no, quantity, code, sort_order FROM cf_production_items WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL ORDER BY sort_order',
    [COMPANY, releaseId],
  );
  same('the dry run showed exactly the codes the release wrote, piece for piece', dry.nodes.map((n) => n.code), pieces.map((p) => p.code));
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const tops = pieces.filter((p) => p.parent_id == null);
  same('the line\'s two girders keep {item code}-{piece no}: pieces 1 and 2', tops.map((p) => p.code), [`${rootCode}-1`, `${rootCode}-2`]);
  const segPieces = pieces.filter((p) => p.parent_id != null && byId.get(p.parent_id)?.parent_id == null);
  eq('four segment pieces — two under each girder', segPieces.length, 4);
  same('under each girder, the segments print no short name: -1 then -2', segPieces.map((p) => p.code.slice(byId.get(p.parent_id).code.length)), ['-1', '-2', '-1', '-2']);
  let copyOk = 0;
  let plainOk = 0;
  let tfOk = 0;
  const copyNos = [];
  for (const sp of segPieces) {
    const seg = sp.item_id === segRows[0].childId ? seg1 : seg2;
    const kids = pieces.filter((p) => p.parent_id === sp.id);
    const suffixes = (lineId) => kids.filter((p) => p.bom_line_id === lineId).map((p) => p.code.slice(sp.code.length));
    const copy = suffixes(seg.is3.lineId);
    if (JSON.stringify(copy) === JSON.stringify(['-IS24', '-IS25', '-IS26'])) copyOk += 1;
    const plain = suffixes(seg.is23.lineId);
    if (plain.length === 23 && plain[0] === '-IS1' && plain[22] === '-IS23') plainOk += 1;
    if (JSON.stringify(suffixes(seg.tf.lineId)) === JSON.stringify(['-TF1'])) tfOk += 1;
    if (seg === seg1) copyNos.push(kids.filter((p) => p.bom_line_id === seg.is3.lineId).map((p) => p.piece_no));
  }
  eq('under all four segment pieces the drilled copy\'s three pieces are IS24, IS25, IS26', copyOk, 4);
  eq('and the plain row\'s 23 are IS1 … IS23', plainOk, 4);
  eq('the top flange, a grouped card of one, is TF1', tfOk, 4);
  same('piece.no still counts one design across the whole line: 1-3 under the first girder, 4-6 under the second', copyNos, [[1, 2, 3], [4, 5, 6]]);
  const aCopy = pieces.find((p) => p.code.endsWith('-IS25'));
  const blank = pieces.find((p) => p.parent_id === aCopy?.id);
  eq('a blank under a stiffener piece is that piece\'s BLK1', blank?.code, `${aCopy?.code}-BLK1`);
  const again = await generate(conn, COMPANY, 'production_piece', 'code', { entityId: aCopy.id }, { consume: false });
  eq('a saved piece regenerates to its own code (piece.seq worked out again from the rows)', again?.text, aCopy.code);

  /* ---- frozen: released -------------------------------------------------------- */
  section('9. A frozen line is not recoded — released');
  await conn.query('UPDATE cf_bom_lines SET quantity = 20 WHERE id = ?', [seg1.is23.lineId]);   // what a careless writer might do
  const frozenOut = await R.refreshRangeCodes(conn, c, segRows[0].childId);
  eq('refreshRangeCodes says the line is released', frozenOut.frozen, 'released');
  eq('and changes nothing', frozenOut.changed.length, 0);
  eq('the copy keeps IS24-26 although its range would now be 21-23', await codeOf(conn, seg1.is3.childId), `${seg1Code}-IS24-26`);
  await conn.query('UPDATE cf_bom_lines SET quantity = 23 WHERE id = ?', [seg1.is23.lineId]);
  const refused = await refusal(() => B.updateLine(conn, c, seg1.is23.lineId, { quantity: 22 }));
  eq('and the BOM service itself refuses the edit', refused?.code, 'RELEASED');
  await REL.unrelease(conn, c, releaseId);

  /* ---- moving rows ------------------------------------------------------------- */
  section('10. Changing the first row\'s quantity moves the second row\'s code');
  await B.updateLine(conn, c, seg1.is23.lineId, { quantity: 22 });
  eq('IS x22 is now IS1-22', await codeOf(conn, seg1.is23.childId), `${seg1Code}-IS1-22`);
  eq('the copy moved to IS23-25', await codeOf(conn, seg1.is3.childId), `${seg1Code}-IS23-25`);
  eq('the blank under the copy followed its parent', (await blkUnder(seg1.is3.childId)).code, `${seg1Code}-IS23-25-BLK1L250`);
  eq('segment 2 did not move', await codeOf(conn, seg2.is3.childId), `${seg2Code}-IS24-26`);
  eq('the top flange did not move', await codeOf(conn, seg1.tf.childId), `${seg1Code}-TF1`);

  // Round trips: the same move made by hand, then the refresh on its own.
  await conn.query('UPDATE cf_bom_lines SET quantity = 23 WHERE id = ?', [seg1.is23.lineId]);
  const trip = counting(conn);
  const movedOut = await R.refreshRangeCodes(trip.db, c, segRows[0].childId);
  eq('by hand back to 23: two rows and the two blanks under them change', movedOut.changed.length, 4);
  const tripsMoved = trip.tally.n;
  const still = counting(conn);
  const stillOut = await R.refreshRangeCodes(still.db, c, segRows[0].childId);
  eq('run again, nothing changes', stillOut.changed.length, 0);
  console.log(`        round trips: ${tripsMoved} with 4 codes moving over two levels, ${still.tally.n} when nothing moves`);
  ok('a refresh that moves nothing stays within 8 round trips', still.tally.n <= 8, `${still.tally.n}`);

  section('11. A row put in among existing rows moves the rows after it — without meeting their old codes');
  // A same-sized copy put BEFORE the original is born IS1-23: exactly the code
  // the original still carries until it is moved up.
  await B.addLine(conn, c, segRows[0].childId, { childId: f.IS.id, quantity: 23, lineNo: 15, role: 'Stiffener — inserted' });
  const afterInsert = await rowsOf(conn, segRows[0].childId);
  same('the rows now read TF1, IS1-23 (new), IS24-46, IS47-49', afterInsert.map((r) => r.code.slice(seg1Code.length)), ['-TF1', '-IS1-23', '-IS24-46', '-IS47-49']);
  eq('the old IS x23\'s blank followed it', (await blkUnder(seg1.is23.childId)).code, `${seg1Code}-IS24-46-BLK1L250`);
  eq('the new row\'s blank is under IS1-23', (await blkUnder(afterInsert[1].childId)).code, `${seg1Code}-IS1-23-BLK1L250`);

  section('12. Removing a row moves the codes after it');
  await B.removeLine(conn, c, afterInsert[1].lineId);
  same('without the inserted row: TF1, IS1-23, IS24-26', (await rowsOf(conn, segRows[0].childId)).map((r) => r.code.slice(seg1Code.length)), ['-TF1', '-IS1-23', '-IS24-26']);
  await B.removeLine(conn, c, seg1.is23.lineId);
  eq('without IS x23 the copy is IS1-3', await codeOf(conn, seg1.is3.childId), `${seg1Code}-IS1-3`);
  eq('and its blank followed', (await blkUnder(seg1.is3.childId)).code, `${seg1Code}-IS1-3-BLK1L250`);

  /* ---- not a count ----------------------------------------------------------- */
  section('13. A quantity that is not a whole number has no range — and says why');
  await B.addLine(conn, c, segRows[1].childId, { childId: f.mat.id, quantity: 2.5, role: 'Plate by area' });
  await B.addLine(conn, c, segRows[1].childId, { childId: f.mat.id, quantity: 1, role: 'Plate, one more' });
  const r3 = await R.rangesOfParent(conn, COMPANY, segRows[1].childId);
  const [area25, after25] = r3.lines.filter((l) => l.shortName === 'MAT');
  same('MAT x2.5 has no range', [area25?.start, area25?.text], [null, null]);
  ok('and says 2.5 is not a whole number of pieces', /2\.5 is not a whole number/.test(area25?.reason ?? ''), area25?.reason);
  says(area25?.reason);
  same('the MAT row after it has none either — its numbers would be counted on from 2.5', [after25?.start, /comes after line/.test(after25?.reason ?? '')], [null, true]);
  says(after25?.reason);
  await B.updateLine(conn, c, seg2.is3.lineId, { quantity: 2.5 });
  const preview = await generate(conn, COMPANY, 'item', 'code', { entityId: seg2.is3.childId }, { consume: false });
  same('a temporary row of 2.5 cannot render its range', [preview?.text, preview?.missing], [null, ['range']]);
  eq('so it keeps the code it had', await codeOf(conn, seg2.is3.childId), `${seg2Code}-IS24-26`);
  const kept = await R.refreshRangeCodes(conn, c, segRows[1].childId);
  const why = kept.skipped.find((s) => s.id === seg2.is3.childId)?.why ?? '';
  ok('and refreshRangeCodes names it, with the reason', /not a whole number/.test(why), why);
  says(why);
  await B.updateLine(conn, c, seg2.is3.lineId, { quantity: 3 });
  eq('back to 3, it is IS24-26 again', await codeOf(conn, seg2.is3.childId), `${seg2Code}-IS24-26`);

  /* ---- clash ------------------------------------------------------------------- */
  section('14. A renumbering that would reuse somebody else\'s code is refused in words');
  await conn.query('SAVEPOINT before_clash');
  await MR.createItem(conn, c, { itemType: 'catalog', classificationId: f.vMat.id, code: `${seg2Code}-IS23-25`, name: `Squatter ${tag}`, status: 'draft' });
  const clash = await refusal(() => B.updateLine(conn, c, seg2.is23.lineId, { quantity: 22 }));
  eq('it is CODE_CLASH, not a raw duplicate key', clash?.code, 'CODE_CLASH');
  ok('and names the code', (clash?.message ?? '').includes(`${seg2Code}-IS23-25`), clash?.message);
  says(clash?.message);
  await conn.query('ROLLBACK TO SAVEPOINT before_clash');

  /* ---- frozen: closed -------------------------------------------------------- */
  section('15. A frozen line is not recoded — a closed order');
  await SO.setOrderStatus(conn, c, order.id, 'closed');
  await conn.query('UPDATE cf_bom_lines SET quantity = 20 WHERE id = ?', [seg2.is23.lineId]);
  const closedOut = await R.refreshRangeCodes(conn, c, segRows[1].childId);
  same('refreshRangeCodes says the order is closed and changes nothing', [closedOut.frozen, closedOut.changed.length], ['closed', 0]);
  eq('the copy keeps IS24-26', await codeOf(conn, seg2.is3.childId), `${seg2Code}-IS24-26`);

  /* ---- no temporary children --------------------------------------------------- */
  section('16. A parent with no temporary children costs one round trip');
  const tmpl = counting(conn);
  const tmplOut = await R.refreshRangeCodes(tmpl.db, c, f.SG.id);
  same('a template\'s BOM: nothing checked, nothing changed', [tmplOut.checked, tmplOut.changed.length], [0, 0]);
  eq('in one query', tmpl.tally.n, 1);

  /* ---- a short name set to none ------------------------------------------ */
  // User, 2026-09-26: the girder-segment rule "is a bit too much — rather give
  // an option to give empty in short name which should ideally produce the same
  // effect". Set to NONE, the segment template prints nothing where the short
  // name goes, so the ONE part rule {parent.code}-{record.shortName}{range}
  // codes a segment …-1, …-2 — and with the segment's own piece rule switched
  // off, the one piece rule codes its pieces …-1-1, …-1-2.
  section('16b. A short name set to NONE prints nothing — a segment needs no rule of its own');
  const sgNone = await MR.updateRecord(conn, c, f.SG.id, { noShortName: true });
  same('the definition keeps an empty short name, flagged none', [sgNone.shortName, sgNone.noShortName], ['', true]);
  await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id = ?", [COMPANY, f.rules.pieceSeg.id]);
  const order2 = await SO.createOrder(conn, c, { orderType: 'customer', customerId: party.id, code: `${tag}-SO2`, title: `Range fixture 2 ${tag}`, committedDate: '2026-12-31' });
  await SO.addOrderLine(conn, c, order2.id, { recordId: f.GR.id, quantity: 1 });
  const [[line2]] = await conn.query('SELECT id, item_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, order2.id]);
  const root2Code = await codeOf(conn, line2.item_id);
  const segs2 = await rowsOf(conn, line2.item_id);
  same('a new girder\'s segments are its code and their number alone', segs2.map((r) => r.code), [`${root2Code}-1`, `${root2Code}-2`]);
  const inSeg2 = await segmentOf(conn, segs2[0].childId);
  same('and what sits inside a segment is built on that code', [inSeg2.tf.code, inSeg2.is23.code, inSeg2.is3.code], [`${root2Code}-1-TF1`, `${root2Code}-1-IS1-23`, `${root2Code}-1-IS24-26`]);
  const byGenerator = await generate(conn, COMPANY, 'item', 'code', { entityId: segs2[1].childId }, { consume: false });
  same('the code generator agrees, and nothing is "missing" — none is not empty', [byGenerator?.text, byGenerator?.missing ?? []], [`${root2Code}-2`, []]);
  const pieces2 = await REL.previewReleaseCodes(conn, COMPANY, line2.id);
  const noneSegPieces = pieces2.nodes.filter((n) => segs2.some((s) => s.childId === n.itemId)).map((n) => n.code);
  same('released, a segment piece is its parent piece and its number — by the one piece rule', noneSegPieces, [`${root2Code}-1-1`, `${root2Code}-1-2`]);
  ok('with no missing value and no clash', pieces2.missing.length === 0 && pieces2.duplicates.length === 0, JSON.stringify({ missing: pieces2.missing, duplicates: pieces2.duplicates }));
  const sgBack = await MR.updateRecord(conn, c, f.SG.id, { noShortName: false, shortName: null });
  const fallback = await generate(conn, COMPANY, 'item', 'code', { entityId: segs2[0].childId }, { consume: false });
  same('set back to not-set, the fallback returns: the first word of the name', [sgBack.shortName, sgBack.noShortName, fallback?.text], [null, false, `${root2Code}-SEGMENT1`]);

  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  if (err.problems) console.error('problems:', err.problems);
  console.error(err.stack?.split('\n').slice(1, 8).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('17. Nothing survived the rollback');
const after = await census(pool, TABLES);
const left = TABLES.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
ok(`every cf_ table (${TABLES.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
