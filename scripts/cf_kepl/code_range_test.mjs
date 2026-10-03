/**
 * code_range_test.mjs — how an order's pieces are numbered, and what its rows
 * show before they are. Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/code_range_test.mjs
 *
 * A BOM row is a design with a quantity, not an item (user, 2026-09-26): it has
 * NO code. Its pieces are rolled out and coded when the line is LOCKED
 * (rollOutService), and until then each row shows a placeholder — the code its
 * pieces will get, # where each piece's own number goes (placeholderService).
 * Pieces are numbered per parent (piece.seq, codeRangeService's ranges): a row
 * of 23 plain stiffeners and its copy of 3 drilled ones are IS1 … IS23 and
 * IS24 … IS26 under every segment piece.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. The last thing
 * it does is re-count every cf_ table and prove each is back to the count it
 * started at. Nothing is locked or released: the roll-out is laid out and coded
 * in memory, exactly as lock would code it (codeNodes, peeking at numbers).
 *
 * IT OWNS ITS FIXTURE: its own Family > Subfamily > Variants, specification,
 * template definitions, flow, customer, order and coding rules — nothing of
 * company 2's KEPL data. Every name and code carries this run's tag, and every
 * other item and production-piece coding rule of the company is switched off
 * for the transaction.
 *
 *   GIRDER  (the order line sells 2)
 *     SEG x1          line 10
 *     SEG x1          line 20
 *       TF  x1        line 10          -> TF1        (a grouped card of one)
 *       IS  x23       line 20 (plain)  -> IS1 … IS23
 *       IS  x3        line 30 (drilled)-> IS24 … IS26
 *         BLK x1      (every IS)       -> …-IS24-BLK1
 *
 * With piece rules shaped as the company's (CFPC-TOP / -PART / -SEGMENT after
 * cf_rows_no_codes.mjs), the pieces are <order>-<girder>-01-1 and -2, then
 * …-1-1 (a segment prints no short name), …-1-1-IS24 … and so on.
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
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const RO = await imp('apps/cf_erp/services/rollOutService.js');
const { linePlaceholders } = await imp('apps/cf_erp/services/placeholderService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const { setValues } = await imp('apps/cf_erp/services/valueService.js');
const { temporaryTree } = await imp('apps/cf_erp/services/instantiationService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
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
 * twice in this codebase).
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

  // One specification of its own, fixed on the blanks' Variant.
  const lenCode = `${tag}_LEN`;
  const [sr] = await db.query(
    "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status, created_by) VALUES (?, ?, ?, 'number', 'mm', 'active', ?)",
    [COMPANY, lenCode, `Blank length ${tag}`, c.userId],
  );
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
  // The girder's short name carries the tag: piece codes are unique company-wide.
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

  // Its coding rules. An ITEM rule that would reach every row — to prove a row
  // is coded by nothing — and the three piece rules, shaped as the company's.
  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const under = { tokenKey: 'classification', operator: 'under', value: String(fam.id) };
  const rule = (code, body) => codegen.createScheme(db, COMPANY, c.userId, {
    code: `${tag}-${code}`, name: `Range test ${code} ${tag}`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', ...body,
  });
  const rules = {
    rowItems: await rule('ROWS', {
      conditions: [temporary, under],
      segments: [tok('order.code'), lit('-ROW-'), tok('record.shortName'), tok('position', { format: '00' })],
    }),
    pieceTop: await rule('PTOP', {
      entityType: 'production_piece', conditions: [temporary, { tokenKey: 'placement', operator: 'eq', value: 'line' }, under],
      segments: [tok('order.code'), lit('-'), tok('item.shortName'), lit('-'), tok('line.position', { format: '00' }), lit('-'), tok('piece.seq')],
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
/** A segment's three rows as the template laid them out: TF x1 (line 10), IS x23 (20), IS x3 (30). */
async function segmentOf(db, segId) {
  const rows = await rowsOf(db, segId);
  if (rows.length !== 3) throw new Error(`segment ${segId} has ${rows.length} rows, not 3 — the fixture is not what this test expects`);
  return { rows, tf: rows[0], is23: rows[1], is3: rows[2] };
}
/** The order line as the roll-out reads it. */
async function lineRow(db, lineId) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`,
    [COMPANY, lineId],
  );
  return l;
}
/** The line rolled out and coded as lock would code it — nothing written, no number drawn. */
async function rolledOut(db, lineId) {
  const line = await lineRow(db, lineId);
  const plan = await RO.rollOutPlan(db, COMPANY, line);
  const memo = await RO.seedPieceMemo(db, COMPANY, line, plan.nodes);
  const linePosition = await RO.linePositionOf(db, COMPANY, lineId);
  const coded = await RO.codeNodes(db, COMPANY, line, plan.nodes, { consume: false, memo, linePosition });
  return { line, plan, nodes: plan.nodes, coded, linePosition };
}
const placeholderRe = (ph) => new RegExp(`^${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#/g, '\\d+')}$`);

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
    `SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type IN ('item', 'production_piece')
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
  const segRows = await rowsOf(conn, rootId);
  const seg1 = await segmentOf(conn, segRows[0].childId);
  const seg2 = await segmentOf(conn, segRows[1].childId);
  const tree = await temporaryTree(conn, COMPANY, rootId);
  const top = `${tag}-SO-GR${tag}-01`;

  /* ---- no codes on rows ---------------------------------------------------- */
  section('1. A row has no code — even with an item rule that would reach it');
  eq('13 rows: girder, 2 segments, 2 x (TF, IS x23, IS x3, 2 blanks)', tree.length, 13);
  const [coded] = await conn.query('SELECT code FROM cf_master_records WHERE id IN (?) AND code IS NOT NULL', [tree]);
  same('not one of them has a code', coded.map((r) => r.code), []);
  const wouldBe = await generate(conn, COMPANY, 'item', 'code', { entityId: seg1.is3.childId }, { consume: false });
  ok('though the fixture\'s item rule would give one if asked', !!wouldBe?.text && String(wouldBe.schemeCode).startsWith(`${tag}-`), JSON.stringify(wouldBe));
  const activate = await refusal(() => MR.setStatus(conn, c, seg1.is3.childId, 'active'));
  eq('and a row cannot be activated by hand — locking its line activates it', activate?.code, 'ROW_STATUS');

  /* ---- 23 + 3 --------------------------------------------------------------- */
  section('2. IS x23 then its copy IS x3, under one parent: 1–23 and 24–26');
  const r1 = await R.rangesOfParent(conn, COMPANY, segRows[0].childId);
  const rIS23 = r1.lines.find((l) => l.lineId === seg1.is23.lineId);
  const rIS3 = r1.lines.find((l) => l.lineId === seg1.is3.lineId);
  same('the rows come back in display order', r1.lines.map((l) => l.lineNo), [10, 20, 30]);
  same('IS x23 covers 1 … 23', [rIS23?.start, rIS23?.end, rIS23?.text], [1, 23, '1-23']);
  same('IS x3, the copy, carries on: 24 … 26', [rIS3?.start, rIS3?.end, rIS3?.text], [24, 26, '24-26']);
  eq('both counted under the short name IS — the definition\'s, since the rows have none of their own', rIS3?.shortName, 'IS');

  section('3. A different short name keeps its own count');
  const rTF = r1.lines.find((l) => l.lineId === seg1.tf.lineId);
  same('TF x1 is 1 — not 24, not 27', [rTF?.shortName, rTF?.start, rTF?.end], ['TF', 1, 1]);

  section('4. The count starts again under the next parent');
  const r2 = await R.rangesOfParent(conn, COMPANY, segRows[1].childId);
  same('under segment 2, IS x23 is 1 … 23 again and the copy 24 … 26', r2.lines.map((l) => l.text), ['1', '1-23', '24-26']);

  /* ---- the roll-out ------------------------------------------------------------ */
  section('5. Rolled out as lock rolls it out: piece.seq numbers the copy\'s pieces 24, 25, 26 under every segment piece');
  const pieceCount = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM cf_order_pieces WHERE company_id = ?', [COMPANY]))[0][0].n);
  const beforeRoll = await pieceCount();
  const ro = await rolledOut(conn, orderLine.id);
  eq('laying it out writes no piece', await pieceCount(), beforeRoll);
  same('and stops on nothing', ro.plan.problems, []);
  eq('the line is the first of its design on the order: position 1', ro.linePosition, 1);
  eq('every piece is coded by a rule', ro.coded.byRule, ro.nodes.length);
  same('none twice, none taken, no rule with a hole', [ro.coded.duplicates.length, ro.coded.taken.length, ro.coded.missing.length], [0, 0, 0]);
  const tops = ro.nodes.filter((n) => n.parentK == null);
  same('the line\'s two girders: <order>-<girder>-01-1 and -2', tops.map((n) => n.code), [`${top}-1`, `${top}-2`]);
  const segPieces = ro.nodes.filter((n) => n.parentK != null && ro.nodes[n.parentK].parentK == null);
  eq('four segment pieces — two under each girder', segPieces.length, 4);
  same('under each girder, the segments print no short name: -1 then -2', segPieces.map((n) => n.code.slice(ro.nodes[n.parentK].code.length)), ['-1', '-2', '-1', '-2']);
  let copyOk = 0; let plainOk = 0; let tfOk = 0;
  const copyNos = [];
  for (const sp of segPieces) {
    const seg = sp.itemId === segRows[0].childId ? seg1 : seg2;
    const kids = sp.childKs.map((k) => ro.nodes[k]);
    const suffixes = (lineId) => kids.filter((n) => n.bomLineId === lineId).map((n) => n.code.slice(sp.code.length));
    if (JSON.stringify(suffixes(seg.is3.lineId)) === JSON.stringify(['-IS24', '-IS25', '-IS26'])) copyOk += 1;
    const plain = suffixes(seg.is23.lineId);
    if (plain.length === 23 && plain[0] === '-IS1' && plain[22] === '-IS23') plainOk += 1;
    if (JSON.stringify(suffixes(seg.tf.lineId)) === JSON.stringify(['-TF1'])) tfOk += 1;
    if (seg === seg1) copyNos.push(kids.filter((n) => n.bomLineId === seg.is3.lineId).map((n) => n.pieceNo));
  }
  eq('under all four segment pieces the drilled copy\'s three pieces are IS24, IS25, IS26', copyOk, 4);
  eq('and the plain row\'s 23 are IS1 … IS23', plainOk, 4);
  eq('the top flange, a grouped card of one, is TF1', tfOk, 4);
  same('piece.no still counts one design across the whole line: 1-3 under the first girder, 4-6 under the second', copyNos, [[1, 2, 3], [4, 5, 6]]);
  const aCopy = ro.nodes.find((n) => n.code.endsWith('-1-1-IS25'));
  const blank = aCopy ? ro.nodes[aCopy.childKs[0]] : null;
  eq('a blank under a stiffener piece is that piece\'s BLK1', blank?.code, `${aCopy?.code}-BLK1`);

  /* ---- placeholders ------------------------------------------------------------- */
  section('6. Each row shows the code its pieces get, # where each piece\'s number goes');
  const ph = await linePlaceholders(conn, COMPANY, orderLine.id);
  const phOf = (bomLineId, itemId = null) => ph.rows.find((r) => (bomLineId != null ? r.bomLineId === bomLineId : r.bomLineId == null && r.itemId === itemId));
  eq('the line is not locked, and would be position 1', `${ph.locked}/${ph.position}`, 'false/1');
  eq('the girder: two of them, so its number is #', phOf(null, rootId)?.code, `${top}-#`);
  eq('segment 1: the only piece of its row under each girder, so its number shows', phOf(segRows[0].lineId)?.code, `${top}-#-1`);
  eq('the plain stiffeners: # for each piece', phOf(seg1.is23.lineId)?.code, `${top}-#-1-IS#`);
  same('and what # runs over under each segment: 1 … 23', phOf(seg1.is23.lineId)?.seqRange, [1, 23]);
  same('the drilled copy reads the same, and runs 24 … 26', [phOf(seg1.is3.lineId)?.code, phOf(seg1.is3.lineId)?.seqRange], [`${top}-#-1-IS#`, [24, 26]]);
  same('the top flange: one grouped card, no # of its own', [phOf(seg1.tf.lineId)?.code, phOf(seg1.tf.lineId)?.seqRange], [`${top}-#-1-TF1`, null]);
  same('how many pieces each row becomes on the line', [phOf(null, rootId)?.pieces, phOf(seg1.is23.lineId)?.pieces, phOf(seg1.is3.lineId)?.pieces], [2, 46, 6]);
  let fits = 0;
  const misfits = [];
  for (const n of ro.nodes) {
    const row = phOf(n.bomLineId, n.itemId);
    if (row?.code && placeholderRe(row.code).test(n.code)) fits += 1;
    else if (misfits.length < 3) misfits.push(`${n.code} vs ${row?.code}`);
  }
  eq(`every one of the ${ro.nodes.length} pieces' codes fits its row's placeholder`, fits, ro.nodes.length);
  if (misfits.length) console.log(`        e.g. ${misfits.join(' · ')}`);

  /* ---- line.position ---------------------------------------------------------- */
  section('7. line.position: counted over the lines that exist — a deleted trial line leaves no gap');
  const withTwo = await SO.addOrderLine(conn, c, order.id, { recordId: f.GR.id, quantity: 1 });
  const second = withTwo.lines.find((l) => l.id !== orderLine.id);
  eq('a second girder line on the order is position 2', await RO.linePositionOf(conn, COMPANY, second.id), 2);
  eq('its placeholder says so: …-02-3 (one girder; piece numbers run on after the first line\'s two)', phOfLine(await linePlaceholders(conn, COMPANY, second.id)), `${tag}-SO-GR${tag}-02-3`);
  await SO.removeOrderLine(conn, c, orderLine.id);
  eq('the first line deleted before anything was locked: the second is now 1 — no "2"', await RO.linePositionOf(conn, COMPANY, second.id), 1);
  eq('and its placeholder is …-01-1', phOfLine(await linePlaceholders(conn, COMPANY, second.id)), `${tag}-SO-GR${tag}-01-1`);

  /* ---- a short name set to none ------------------------------------------ */
  // User, 2026-09-26: "give an option to give empty in short name which should
  // ideally produce the same effect" as the segment's own rule. Set to NONE, the
  // segment prints nothing where the short name goes, so the one part rule
  // {parent.code}-{item.shortName}{piece.seq} codes its pieces …-1, …-2.
  section('8. A short name set to NONE prints nothing — a segment needs no rule of its own');
  const sgNone = await MR.updateRecord(conn, c, f.SG.id, { noShortName: true });
  same('the definition keeps an empty short name, flagged none', [sgNone.shortName, sgNone.noShortName], ['', true]);
  await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id = ?", [COMPANY, f.rules.pieceSeg.id]);
  const ro2 = await rolledOut(conn, second.id);
  const top2 = ro2.nodes.find((n) => n.parentK == null);
  const segs2 = ro2.nodes.filter((n) => n.parentK === top2?.k).map((n) => n.code);
  same('rolled out, a segment piece is its parent piece and its number — by the one part rule', segs2, [`${top2?.code}-1`, `${top2?.code}-2`]);
  ok('with no missing value and no clash', ro2.coded.missing.length === 0 && ro2.coded.duplicates.length === 0, JSON.stringify({ missing: ro2.coded.missing.length, duplicates: ro2.coded.duplicates }));
  const segRows2 = await rowsOf(conn, second.item_id ?? (await lineRow(conn, second.id)).item_id);
  const ph2 = await linePlaceholders(conn, COMPANY, second.id);
  same('and the segment rows show it before it happens', segRows2.map((r) => ph2.rows.find((x) => x.bomLineId === r.lineId)?.code), [`${top2?.code}-1`, `${top2?.code}-2`]);
  const sgBack = await MR.updateRecord(conn, c, f.SG.id, { noShortName: false, shortName: null });
  const ro3 = await rolledOut(conn, second.id);
  const top3 = ro3.nodes.find((n) => n.parentK == null);
  same('set back to not-set, the fallback returns: the first word of the name', [sgBack.shortName, sgBack.noShortName, ro3.nodes.find((n) => n.parentK === top3?.k)?.code], [null, false, `${top3?.code}-SEGMENT1`]);

  /* ---- the vocabulary -------------------------------------------------------- */
  section('9. The words the Coding Rules screen offers');
  const pieceTokens = listEntities().find((e) => e.entityType === 'production_piece').tokens;
  ok('piece.seq, piece.no and line.position are all there to build a piece rule with', ['piece.seq', 'piece.no', 'line.position'].every((k) => pieceTokens.some((t) => t.key === k && t.available)));

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

/** A line's own placeholder: the row with no BOM line — what the line sells. */
function phOfLine(ph) { return ph.rows.find((r) => r.bomLineId == null)?.code ?? null; }

section('10. Nothing survived the rollback');
const after = await census(pool, TABLES);
const left = TABLES.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
ok(`every cf_ table (${TABLES.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
