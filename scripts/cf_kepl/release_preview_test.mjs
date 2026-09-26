/**
 * release_preview_test.mjs — the Piece codes card's read: GET
 * /order-lines/:id/release-preview (releaseService.releasePreview). What it
 * shows before release must be exactly what release then writes, piece for
 * piece. Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/release_preview_test.mjs
 *   CF_TEST_COMPANY=2 node scripts/cf_kepl/release_preview_test.mjs     (default company 1)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. The last thing
 * it does is re-count every cf_ table and prove each is back to the count it
 * started at.
 *
 * IT OWNS ITS FIXTURE — classification, templates, flow, customer, orders,
 * coding rules — every name and code carrying this run's tag (uq_ccn_sibling is
 * unique on NAME, so a borrowed or untagged node breaks the second run). Every
 * other item and production-piece coding rule of the company is switched off
 * for the transaction, so only the fixture's rules can code the fixture.
 *
 *   GIRDER (order A sells 2, order B sells 1)
 *     SEG x1 (line 10), SEG x1 (line 20)       pieces, {parent.code}-{piece.seq}
 *       TF  x1  (line 10)  material only       a group of 1
 *       IS  x23 (line 20)  + IS x3 (line 30)   pieces 1-23, then the copy's 24-26
 *         BLK x1           material only       a group of 1 — coded by a RUNNING
 *                                              NUMBER ({order.code}-BLK{#000})
 *       ST  x4  (line 40)  material only       a group of 4: …-ST1-4
 *       CL  x6  (line 50)  material only       no piece rule: the built-in code
 *
 * The girders are {item.shortName}-{piece.seq}: the same on both orders, so
 * once A is released, B's preview must say its codes are taken.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');           // registers the code-generator entities
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const { temporaryTree } = await imp('apps/cf_erp/services/instantiationService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');
const trackerRouter = (await imp('apps/cf_erp/routes/tracker.js')).default;

const COMPANY = Number(process.env.CF_TEST_COMPANY ?? 1);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/**
 * ok(label, cond, detail?) — the LABEL comes first. It demands a string and then
 * a boolean, so a swapped ok(cond, 'label'), or a truthy object passed as the
 * condition, throws instead of passing unconditionally.
 */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, Object.is(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 400)}, wanted ${JSON.stringify(want)?.slice(0, 400)}`);
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
const tag = `TRP${Date.now().toString(36).toUpperCase()}`;
const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });
const seq = (format) => ({ segmentType: 'sequence', format });

async function buildFixture(db, c) {
  const fam = await createNode(db, c, { code: `${tag}-F`, name: `Preview fixture ${tag}` });
  const sub = await createNode(db, c, { parentId: fam.id, code: `${tag}-S`, name: `Preview fixture kinds ${tag}` });
  const sub2 = await createNode(db, c, { parentId: fam.id, code: `${tag}-S2`, name: `Preview fixture uncoded ${tag}` });
  const v = {};
  for (const [key, code, name, parent] of [
    ['assy', 'VA', 'Assemblies', sub], ['seg', 'VS', 'Segments', sub], ['part', 'VP', 'Parts', sub], ['is', 'VI', 'Stiffeners', sub],
    ['blank', 'VB', 'Blanks', sub], ['mat', 'VM', 'Material', sub], ['cleat', 'VC', 'Cleats', sub2],
  ]) v[key] = await createNode(db, c, { parentId: parent.id, code: `${tag}-${code}`, name: `${name} ${tag}` });

  const op = await OPS.createOperation(db, c, { code: `${tag}-OP`, name: `Make ${tag}` });
  const flow = await FLOWS.createFlow(db, c, { code: `${tag}-FL`, name: `Make ${tag}` });
  await FLOWS.addStep(db, c, flow.id, { operationId: op.id });
  await FLOWS.setFlowStatus(db, c, flow.id, 'active');

  const mat = await MR.createItem(db, c, {
    itemType: 'catalog', classificationId: v.mat.id, code: `${tag}-MAT`, name: `Plate stock ${tag}`, shortName: 'MAT', uom: 'kg', status: 'active',
  });
  const tpl = async (code, name, shortName, classificationId) => {
    const d = await MR.createDefinition(db, c, {
      definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, shortName, status: 'active',
    });
    await MR.updateRecord(db, c, d.id, { defaultFlowId: flow.id });
    return d;
  };
  const BLK = await tpl('BLK', 'Blank', 'BLK', v.blank.id);
  const IS = await tpl('IS', 'Stiffener', 'IS', v.is.id);
  const TF = await tpl('TF', 'Top flange', 'TF', v.part.id);
  const ST = await tpl('ST', 'Stud plate', 'ST', v.part.id);
  const CL = await tpl('CL', 'Cleat', 'CL', v.cleat.id);
  const SG = await tpl('SG', 'Segment', 'SG', v.seg.id);
  // The girder's short name carries the tag: its piece code is {item.shortName}-{piece.seq},
  // and piece codes are unique company-wide.
  const GR = await tpl('GR', 'Girder', `GR${tag}`, v.assy.id);

  await B.addLine(db, c, BLK.id, { childId: mat.id, quantity: 0.25 });
  await B.setBomStatus(db, c, BLK.id, 'active');
  await B.addLine(db, c, IS.id, { childId: BLK.id, quantity: 1 });
  await B.setBomStatus(db, c, IS.id, 'active');
  for (const t of [TF, ST, CL]) {
    await B.addLine(db, c, t.id, { childId: mat.id, quantity: 1.5 });
    await B.setBomStatus(db, c, t.id, 'active');
  }
  await B.addLine(db, c, SG.id, { childId: TF.id, quantity: 1, role: 'Top flange' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 23, role: 'Stiffener — plain' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 3, role: 'Stiffener — drilled' });
  await B.addLine(db, c, SG.id, { childId: ST.id, quantity: 4, role: 'Stud plates' });
  await B.addLine(db, c, SG.id, { childId: CL.id, quantity: 6, role: 'Cleats' });
  await B.setBomStatus(db, c, SG.id, 'active');
  await B.addLine(db, c, GR.id, { childId: SG.id, quantity: 1, role: 'Segment 1' });
  await B.addLine(db, c, GR.id, { childId: SG.id, quantity: 1, role: 'Segment 2' });
  await B.setBomStatus(db, c, GR.id, 'active');

  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const underFam = { tokenKey: 'classification', operator: 'under', value: String(fam.id) };
  const underSub = { tokenKey: 'classification', operator: 'under', value: String(sub.id) };
  const inside = { tokenKey: 'placement', operator: 'eq', value: 'component' };
  const onLine = { tokenKey: 'placement', operator: 'eq', value: 'line' };
  const exactly = (node) => ({ tokenKey: 'classification', operator: 'eq', value: String(node.id) });
  const rule = (code, body) => codegen.createScheme(db, COMPANY, c.userId, {
    code: `${tag}-${code}`, name: `Preview test ${code} ${tag}`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', ...body,
  });
  const pieceRule = (code, body) => rule(code, { entityType: 'production_piece', ...body });
  const rules = {
    // The temporary items' own codes (what the order's structure shows).
    itemLine: await rule('LINE', { conditions: [temporary, onLine, underFam], segments: [tok('order.code'), lit('-'), tok('record.shortName'), tok('position', { format: '00' })] }),
    itemPart: await rule('PART', { conditions: [temporary, inside, underFam], segments: [tok('parent.code'), lit('-'), tok('record.shortName'), tok('range')] }),
    // Released pieces. Cleats sit under sub2, which no piece rule reaches.
    pieceTop: await pieceRule('PTOP', { conditions: [temporary, onLine, underFam], segments: [tok('item.shortName'), lit('-'), tok('piece.seq')] }),
    piecePart: await pieceRule('PPART', { conditions: [inside, underSub], segments: [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')] }),
    pieceSeg: await pieceRule('PSEG', { conditions: [inside, exactly(v.seg)], segments: [tok('parent.code'), lit('-'), tok('piece.seq')] }),
    // One running number for the whole rule: release draws 001, 002, … piece after piece.
    pieceBlank: await pieceRule('PBLK', { seqScope: 'scheme', conditions: [inside, exactly(v.blank)], segments: [tok('order.code'), lit('-BLK'), seq('000')] }),
  };
  return { fam, sub, sub2, v, op, flow, mat, BLK, IS, TF, ST, CL, SG, GR, rules, exactly, inside, pieceRule };
}

/** An order of `quantity` girders, confirmed, its structure active. */
async function girderOrder(db, c, f, party, letter, quantity) {
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: party.id, code: `${tag}-SO${letter}`, title: `Preview fixture ${letter} ${tag}`, committedDate: '2026-12-31' });
  const withLine = await SO.addOrderLine(db, c, order.id, { recordId: f.GR.id, quantity });
  const line = withLine.lines[0];
  const [[{ item_id: rootId }]] = await db.query('SELECT item_id FROM cf_sales_order_lines WHERE id = ?', [line.id]);
  for (const id of await temporaryTree(db, COMPANY, rootId)) await MR.setStatus(db, c, id, 'active');
  await SO.setOrderStatus(db, c, order.id, 'confirmed');
  return { order, line, rootId };
}

const pieceCount = async (db) => Number((await db.query('SELECT COUNT(*) AS n FROM cf_production_items WHERE company_id = ?', [COMPANY]))[0][0].n);
const sequenceRows = async (db, schemeId) => (await db.query('SELECT seq_key, next_value FROM cf_code_sequences WHERE company_id = ? AND scheme_id = ?', [COMPANY, schemeId]))[0]
  .map((r) => ({ key: r.seq_key, next: Number(r.next_value) }));

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`release_preview_test — company ${COMPANY}, fixture tag ${tag}`);

section('0. The harness refuses a swapped ok(), and the route is mounted');
ok('ok(cond, label) throws instead of passing', (await refusal(() => ok(true, 'swapped'))) instanceof Error);
ok('ok(label, truthy object) throws too', (await refusal(() => ok('object', {}))) instanceof Error);
const layer = trackerRouter.stack.find((l) => l.route?.path === '/order-lines/:id/release-preview');
ok('GET /order-lines/:id/release-preview is a route of the tracker router', !!layer?.route?.methods?.get);
eq('behind protect, a permission check and the handler — the guard every tracker read has', layer?.route?.stack?.length, 3);
eq('the first of them is protect (a token is required)', layer?.route?.stack?.[0]?.name, 'protect');

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
  const party = await PARTIES.createParty(conn, c, { code: `${tag}-CUST`, name: `Preview test customer ${tag}`, roles: ['customer'] });
  const A = await girderOrder(conn, c, f, party, 'A', 2);
  const Bo = await girderOrder(conn, c, f, party, 'B', 1);
  const area = await AREAS.createArea(conn, c, { code: `${tag}-DSP`, name: `Dispatch ${tag}`, purpose: 'dispatch' });
  const check = await REL.releaseCheck(conn, COMPANY, A.line.id);
  ok('the fixture is releasable: the release check finds nothing wrong', check.problems.length === 0, check.problems.join(' | '));

  /* ---- the preview ------------------------------------------------------ */
  section('1. The preview of an unreleased line: every piece, its code, and what it is');
  const piecesBefore = await pieceCount(conn);
  const tripA = counting(conn);
  const pa = await REL.releasePreview(tripA.db, COMPANY, A.line.id);
  eq('nothing is written — no production piece', await pieceCount(conn), piecesBefore);
  same('and no running number is drawn (the blanks\' rule has no counter yet)', await sequenceRows(conn, f.rules.pieceBlank.id), []);
  eq('it is not released', pa.released, null);
  same('it names the line and its item', [pa.line.id, pa.line.lineNo, pa.line.orderCode, pa.line.quantity, pa.line.item?.id], [A.line.id, A.line.lineNo, `${tag}-SOA`, 2, A.rootId]);
  same('226 nodes: per girder 1 + 2 segments x (1 + TF + 26 IS + 26 BLK + ST + CL)', pa.summary.nodes, 226);
  same('110 numbered pieces (2 girders, 4 segments, 104 stiffeners) and 116 groups', [pa.summary.pieces, pa.summary.groups], [110, 116]);
  eq('226 distinct codes', pa.summary.codes, 226);
  same('222 coded by a rule, 4 by the built-in shape (the cleats), none with a hole', [pa.summary.byRule, pa.summary.builtIn, pa.summary.missing], [222, 4, 0]);
  same('no duplicates, nothing taken', [pa.summary.duplicates, pa.summary.duplicatePieces, pa.summary.taken, pa.duplicates.length, pa.taken.length], [0, 0, 0, 0, 0]);
  same('no problem stops the release', pa.problems, []);
  eq('not truncated', pa.truncated, false);
  const byK = new Map(pa.nodes.map((n) => [n.k, n]));
  ok('nodes come in release order: k is the place in the list, and every parent comes before its children',
    pa.nodes.every((n, i) => n.k === i && (n.parentK == null || n.parentK < n.k)));
  ok('depth is one more than the parent\'s', pa.nodes.every((n) => (n.parentK == null ? n.depth === 0 : n.depth === byK.get(n.parentK).depth + 1)));
  const tops = pa.nodes.filter((n) => n.parentK == null);
  same('the two girders are {item.shortName}-{piece.seq}', tops.map((n) => n.code), [`GR${tag}-1`, `GR${tag}-2`]);
  const kids = (k) => pa.nodes.filter((n) => n.parentK === k);
  const segs = kids(tops[0].k);
  same('under the first girder, its segments print no short name: -1 and -2', segs.map((n) => n.code), [`GR${tag}-1-1`, `GR${tag}-1-2`]);
  const under = kids(segs[1].k);
  const isPieces = under.filter((n) => n.code.includes('-IS'));
  same('the stiffeners of a segment: IS1 … IS23, then the copy carries on IS24 … IS26',
    [isPieces.length, isPieces[0]?.code, isPieces[22]?.code, isPieces[23]?.code, isPieces[25]?.code],
    [26, `GR${tag}-1-2-IS1`, `GR${tag}-1-2-IS23`, `GR${tag}-1-2-IS24`, `GR${tag}-1-2-IS26`]);
  const tf = under.find((n) => n.code.endsWith('-TF1'));
  same('the top flange is a group of 1: no piece number, one code', [tf?.pieceNo, tf?.quantity, tf?.code], [null, 1, `GR${tag}-1-2-TF1`]);
  const st = under.find((n) => n.code.includes('-ST'));
  same('the stud plates are ONE group of 4 sharing one code, their range in it', [st?.pieceNo, st?.quantity, st?.pieceSeq, st?.code], [null, 4, '1-4', `GR${tag}-1-2-ST1-4`]);
  ok('a group has a label saying what it is and how many', typeof st?.label === 'string' && st.label.endsWith(' ×4') && st.label.startsWith(pa.items[st.itemId]?.code ?? '\u0000'), st?.label);
  ok('a numbered piece has none', isPieces.every((n) => n.label === undefined));
  const cl = under.find((n) => n.code.includes('/'));
  same('the cleats have no piece rule: the built-in code, {parent code}/{item}', [cl?.rule, cl?.code, cl?.quantity], [null, `${segs[1].code}/${pa.items[cl?.itemId]?.code}`, 6]);
  same('every other node names the rule that coded it', [...new Set(pa.nodes.filter((n) => n.rule).map((n) => n.rule))].sort(),
    [f.rules.pieceBlank.code, f.rules.piecePart.code, f.rules.pieceSeg.code, f.rules.pieceTop.code].sort());
  const blanks = pa.nodes.filter((n) => n.rule === f.rules.pieceBlank.code);
  same('the 104 blanks take the running number in turn — 001 to 104, as release would draw them, not 104 times the next one',
    [blanks.length, blanks[0]?.code, blanks[1]?.code, blanks[103]?.code, new Set(blanks.map((b) => b.code)).size],
    [104, `${tag}-SOA-BLK001`, `${tag}-SOA-BLK002`, `${tag}-SOA-BLK104`, 104]);
  eq('each blank sits under a stiffener piece', blanks.every((b) => byK.get(b.parentK)?.code.includes('-IS')), true);
  const [[topItem]] = await conn.query('SELECT code, name FROM cf_master_records WHERE id = ?', [A.rootId]);
  same('items carry each item\'s code and name once — here the girder the line sells', [pa.items[A.rootId]?.code, pa.items[A.rootId]?.name], [topItem.code, topItem.name]);
  eq('one entry per item, not per node', Object.keys(pa.items).length, new Set(pa.nodes.map((n) => n.itemId)).size);
  const tripB = counting(conn);
  const pb = await REL.releasePreview(tripB.db, COMPANY, Bo.line.id);
  console.log(`        round trips: ${tripA.tally.n} for order A (${pa.summary.nodes} nodes), ${tripB.tally.n} for order B (${pb.summary.nodes} nodes)`);
  eq('order B, one girder, is half the nodes', pb.summary.nodes, 113);
  ok('the round trips do not grow with the pieces: twice the nodes, the same count', tripA.tally.n === tripB.tally.n, `${tripA.tally.n} vs ${tripB.tally.n}`);
  ok('and stay a handful — 30 or fewer', tripA.tally.n <= 30, `${tripA.tally.n}`);
  const plain = await REL.previewReleaseCodes(conn, COMPANY, A.line.id);
  same('releasePreview lays out exactly what previewReleaseCodes does, code for code', pa.nodes.map((n) => [n.k, n.parentK, n.code, n.pieceNo, n.itemId]), plain.nodes.map((n) => [n.k, n.parentK, n.code, n.pieceNo, n.itemId]));

  /* ---- a rule that gives two pieces one code ---------------------------- */
  section('2. Duplicates: the preview names them, and release refuses them');
  await conn.query('SAVEPOINT dup');
  // Weighs 1 + 4 against PPART's 1 + 2: the stiffeners lose their number.
  await f.pieceRule('PDUP', { conditions: [f.inside, f.exactly(f.v.is)], segments: [tok('parent.code'), lit('-'), tok('item.shortName')] });
  const pd = await REL.releasePreview(conn, COMPANY, A.line.id);
  same('4 codes are each given to 26 stiffeners — one per segment piece', [pd.summary.duplicates, pd.summary.duplicatePieces, pd.duplicates.length], [4, 104, 4]);
  ok('and they are the segment\'s code with -IS', pd.duplicates.includes(`GR${tag}-1-2-IS`), pd.duplicates.join(', '));
  eq('the blanks under them follow their own rule and stay apart', new Set(pd.nodes.filter((n) => n.rule === f.rules.pieceBlank.code).map((n) => n.code)).size, 104);
  const dupErr = await refusal(() => REL.releaseLine(conn, c, A.line.id, { finishedAreaId: area.id }));
  eq('release refuses: CODE_CLASH', dupErr?.code, 'CODE_CLASH');
  ok('naming one of the codes the preview named', pd.duplicates.some((d) => (dupErr?.message ?? '').includes(d)), dupErr?.message);
  says(dupErr?.message);
  await conn.query('ROLLBACK TO SAVEPOINT dup');

  /* ---- a rule with a hole ------------------------------------------------ */
  section('3. A rule with a hole: the preview says which pieces and what is missing; release refuses');
  await conn.query('SAVEPOINT hole');
  // piece.no is blank on a group, so a group's code has a hole.
  await f.pieceRule('PHOLE', { conditions: [f.inside, f.exactly(f.v.part)], segments: [tok('parent.code'), lit('-'), tok('piece.no')] });
  const ph = await REL.releasePreview(conn, COMPANY, A.line.id);
  eq('8 groups (4 top flanges, 4 stud plates) cannot be numbered', ph.summary.missing, 8);
  same('each says which rule and which value', [...new Set(ph.missing.map((m) => `${m.schemeCode}:${m.missing.join(',')}`))], [`${tag}-PHOLE:piece.no`]);
  const holed = ph.nodes[ph.missing[0].k];
  same('the node keeps the built-in code in the preview, and names the rule that failed', [holed.code, holed.rule], [`${ph.nodes[holed.parentK].code}/${ph.items[holed.itemId].code}`, `${tag}-PHOLE`]);
  eq('byRule + built-in + missing is every node', ph.summary.byRule + ph.summary.builtIn + ph.summary.missing, ph.summary.nodes);
  const holeErr = await refusal(() => REL.releaseLine(conn, c, A.line.id, { finishedAreaId: area.id }));
  eq('release refuses: TOKEN_MISSING', holeErr?.code, 'TOKEN_MISSING');
  says(holeErr?.message);
  await conn.query('ROLLBACK TO SAVEPOINT hole');

  /* ---- release, and compare ------------------------------------------------ */
  section('4. Release writes exactly what the preview showed, piece for piece');
  const again = await REL.releasePreview(conn, COMPANY, A.line.id);
  same('back to the fixture\'s own rules, the preview is what it was', again.nodes.map((n) => n.code), pa.nodes.map((n) => n.code));
  await REL.releaseLine(conn, c, A.line.id, { finishedAreaId: area.id });
  const releaseId = (await REL.liveReleaseOfLine(conn, COMPANY, A.line.id))?.id;
  ok('the line is released', Number.isInteger(releaseId));
  const [written] = await conn.query(
    `SELECT id, parent_id, item_id, piece_no, quantity, code, depth, sort_order FROM cf_production_items
      WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
    [COMPANY, releaseId],
  );
  eq('as many pieces written as the preview laid out', written.length, pa.nodes.length);
  same('the same codes, in the same order', written.map((p) => p.code), pa.nodes.map((n) => n.code));
  const kOfId = new Map(written.map((p) => [p.id, p.sort_order - 1]));
  same('each under the same parent', written.map((p) => (p.parent_id == null ? null : kOfId.get(p.parent_id))), pa.nodes.map((n) => n.parentK));
  same('the same item, piece number, quantity and depth', written.map((p) => [p.item_id, p.piece_no, Number(p.quantity), p.depth]),
    pa.nodes.map((n) => [n.itemId, n.pieceNo, n.quantity, n.depth]));
  let mismatches = 0;
  for (let i = 0; i < written.length; i++) if (written[i].code !== pa.nodes[i].code) mismatches += 1;
  eq('no piece differs from its preview', mismatches, 0);
  same('the running number was drawn for real now: next is 105', await sequenceRows(conn, f.rules.pieceBlank.id), [{ key: '', next: 105 }]);

  /* ---- already released ----------------------------------------------------- */
  section('5. A released line says so, and lays nothing out');
  const tripR = counting(conn);
  const pr = await REL.releasePreview(tripR.db, COMPANY, A.line.id);
  same('released: its id and how many pieces it holds', [pr.released?.id, pr.released?.pieces], [releaseId, 226]);
  ok('with the date it was released', !!pr.released?.releasedAt && !Number.isNaN(new Date(pr.released.releasedAt).getTime()));
  same('no nodes, no counts, no problems', [pr.nodes.length, pr.summary.nodes, pr.summary.codes, pr.problems.length, Object.keys(pr.items).length], [0, 0, 0, 0, 0]);
  ok('and costs three round trips, not a tree', tripR.tally.n <= 3, `${tripR.tally.n}`);

  /* ---- taken by another release --------------------------------------------- */
  section('6. Codes another release already holds: the preview says taken, and release refuses');
  const pt = await REL.releasePreview(conn, COMPANY, Bo.line.id);
  const writtenCodes = new Set(written.map((p) => p.code));
  ok('order B\'s girder code is taken — A\'s first girder carries it', pt.taken.includes(`GR${tag}-1`), pt.taken.slice(0, 5).join(', '));
  ok('every code said to be taken is one release A wrote', pt.taken.length > 0 && pt.taken.every((code) => writtenCodes.has(code)));
  eq('the count says the same', pt.summary.taken, pt.taken.length);
  ok('B\'s blanks carry B\'s own order code, so none of them is taken', pt.nodes.filter((n) => n.rule === f.rules.pieceBlank.code).every((n) => !pt.taken.includes(n.code)));
  await conn.query('SAVEPOINT taken');
  const takenErr = await refusal(() => REL.releaseLine(conn, c, Bo.line.id, { finishedAreaId: area.id }));
  eq('release refuses: CODE_CLASH', takenErr?.code, 'CODE_CLASH');
  ok('naming a code the preview called taken', pt.taken.some((code) => (takenErr?.message ?? '').includes(code)), takenErr?.message);
  says(takenErr?.message);
  await conn.query('ROLLBACK TO SAVEPOINT taken');

  /* ---- no item ----------------------------------------------------------------- */
  section('7. Not found, and a line of another company');
  const missingLine = await refusal(() => REL.releasePreview(conn, COMPANY, 999999999));
  eq('a line that does not exist is a 404', missingLine?.status, 404);
  const otherCompany = await refusal(() => REL.releasePreview(conn, COMPANY + 1000000, A.line.id));
  eq('nor can another company read it', otherCompany?.status, 404);

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

section('8. Nothing survived the rollback');
const after = await census(pool, TABLES);
const left = TABLES.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
const touched = ['cf_classification_nodes', 'cf_master_records', 'cf_item_details', 'cf_definition_details', 'cf_boms', 'cf_bom_lines',
  'cf_operations', 'cf_operation_flows', 'cf_operation_flow_steps', 'cf_code_schemes', 'cf_code_scheme_conditions', 'cf_code_scheme_segments',
  'cf_code_sequences', 'cf_parties', 'cf_sales_orders', 'cf_sales_order_lines', 'cf_stocking_areas', 'cf_production_releases',
  'cf_production_items', 'cf_production_steps', 'cf_step_dependencies', 'cf_material_requirements'].filter((t) => t in before);
console.log('        census of the tables the fixture writes (before -> after):');
for (const t of touched) console.log(`          ${t.padEnd(28)} ${String(before[t]).padStart(7)} -> ${String(after[t]).padStart(7)}`);
ok(`every cf_ table (${TABLES.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
