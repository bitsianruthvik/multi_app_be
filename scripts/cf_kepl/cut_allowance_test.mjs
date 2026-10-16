/**
 * cut_allowance_test.mjs — CUTTING ALLOWANCE by BOM part name (init.sql §64, TM/s64.sql, 2026-10-16):
 * services/cutAllowanceService.js, applied to cut pieces in cutPlateService.survey, carried by a revision
 * (revisionService), and read by the nesting upload (nestDxfImportService → lib/nestDxfReader.matchNest).
 *
 *   cd multi_app_be && node scripts/cf_kepl/cut_allowance_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is counted before and after.
 *
 *   1. no rule: cut pieces at the drawn length
 *   2. a CUSTOMER default for "top flange" (7.5 mm at each end): 11940 → 11955 — cut piece length, code and
 *      weight follow; the row's LENGTH and the order weight stay as drawn; the Cut pieces list says "+15 mm"
 *   3. an ORDER override (5 mm an end + 1 mm a metre) beats the customer's; the order view lists only the part
 *      names in this order's BOM
 *   4. a ROW override beats both; taken away, the row rejoins; the order override taken away → the customer's
 *   5. refusals in words
 *   6. a LOCKED line keeps its cut pieces when the allowance changes; the open line follows
 *   7. a REVISION takes the order's and its rows' rules, and the allowance in force
 *   8. the nesting upload: a nested part as long as drawn + the allowance matches EXACTLY (no "allowance")
 *   9. the reader: a name stating the DRAWN length of a cut piece cut longer matches exactly
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache, invalidateNodeCache } = await imp('apps/cf_erp/lib/db.js');
const CUT = await imp('apps/cf_erp/services/cutPlateService.js');
const CA = await imp('apps/cf_erp/services/cutAllowanceService.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const CLS = await imp('apps/cf_erp/services/classificationService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const SEL = await imp('apps/cf_erp/services/selectionService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const RES = await imp('apps/cf_erp/services/resolutionService.js');
const { loadMaster } = await imp('apps/cf_erp/services/records.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const REV = await imp('apps/cf_erp/services/revisionService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');
const PRICE = await imp('apps/cf_erp/services/priceService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const RD = await imp('apps/cf_erp/lib/nestDxfReader.js');
const NS = await imp('apps/cf_erp/services/nestShapes.js');
const { cutPlaces } = await imp('apps/cf_erp/lib/cutPlaces.js');

const COMPANY = Number(process.env.CF_CUT_COMPANY ?? 2);
const NIF_DIR = path.resolve(BE, '../NECL_48M_NESTING_NIF');

let passed = 0; let failed = 0; const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean (${String(label).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const says = (t) => console.log(`        says: ${t}`);
const J = (v) => JSON.stringify(v);
const near = (a, b, tol = 1e-6) => a != null && Math.abs(Number(a) - Number(b)) <= tol;
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

const tag = `CAL${Date.now().toString(36).toUpperCase()}`;
const tok = (key) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true });
const lit = (text) => ({ segmentType: 'literal', literalText: text });

/* ─────────────── the fixture: templates, a customer, an order of two girder lines ─────────────── */
// The same scaffolding as cut_pieces_auto_test.mjs (its comments say why each piece is there).
async function buildFixture(db, c) {
  const row = async (id) => (await db.query('SELECT id, parent_id, depth, code, name FROM cf_classification_nodes WHERE company_id = ? AND id = ?', [COMPANY, id]))[0][0];
  const node = async (input) => {
    const [[found]] = await db.query('SELECT id, parent_id, depth, code, name FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, input.code]);
    return found ?? row((await CLS.createNode(db, c, input)).id);
  };
  const steel = await node({ code: `${tag}-STEEL`, name: `${tag} steel` });
  const platesSub = await node({ parentId: steel.id, code: `${tag}-PLATES`, name: `${tag} plates` });
  const fab = await node({ code: `${tag}-FAB`, name: `${tag} fabricated` });
  const PLATE = await node({ parentId: platesSub.id, code: 'PLATE', name: 'Plate' });
  const CUTPL = await node({ parentId: platesSub.id, code: 'CUT_PLATE', name: 'Cut plate' });
  const FABPARTS = await node({ parentId: fab.id, code: 'FAB_PARTS', name: 'Parts' });
  const partsV = await node({ parentId: FABPARTS.id, code: `${tag}-PV`, name: `${tag} plate parts` });
  const fam = await node({ code: `${tag}-F`, name: `${tag} girders`, scope: 'definition' });
  const sub = await node({ parentId: fam.id, code: `${tag}-S`, name: `${tag} girder kinds`, scope: 'definition' });
  const girderV = await node({ parentId: sub.id, code: `${tag}-GV`, name: `${tag} plate girder`, scope: 'definition' });

  const spec = async (code, name, dataType, uom = null) => {
    const [[found]] = await db.query('SELECT id, code, data_type FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (found) return found;
    const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?)", [COMPANY, code, name, dataType, uom, c.userId]);
    return { id: r.insertId, code, data_type: dataType };
  };
  const TH = await spec('THICKNESS', 'Thickness', 'number', 'mm');
  const LN = await spec('LENGTH', 'Length', 'number', 'mm');
  const WD = await spec('WIDTH', 'Width', 'number', 'mm');
  const GR = await spec('GRADE', 'Grade', 'option');
  for (const v of ['E250', 'E350']) {
    const [[o]] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND value = ? AND deleted_at IS NULL', [COMPANY, GR.id, v]);
    if (!o) await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, label, status, sort_order) VALUES (?, ?, ?, ?, 'active', 0)", [COMPANY, GR.id, v, v]);
  }
  const MARK = await spec(`${tag}_MARK`, `${tag} mark`, 'text');
  const blankView = await RES.resolve(db, COMPANY, { nodeId: CUTPL.id });
  const FOUR = ['THICKNESS', 'LENGTH', 'WIDTH', 'GRADE'];
  const steelExtras = blankView.specs
    .filter((s) => s.applicable && s.rule.isRequired && s.rule.valueRule === 'entered' && !FOUR.includes(s.spec.code))
    .map((s) => ({ id: s.spec.id, code: s.spec.code, value: s.spec.dataType === 'option' ? s.options?.[0]?.value : s.spec.dataType === 'number' ? 1 : s.spec.dataType === 'boolean' ? false : s.spec.dataType === 'date' ? '2026-01-01' : 'CAL' }))
    .filter((s) => s.value !== undefined);
  const chainIds = [];
  for (let cur = partsV.id; cur;) { const n = await row(cur); if (!n) break; chainIds.push(n.id); cur = n.parent_id; }
  const [reaching] = await db.query(
    `SELECT DISTINCT a.specification_id, a.capture_at FROM cf_spec_assignments a
      WHERE a.company_id = ? AND a.subject_type = 'classification' AND a.subject_id IN (?) AND a.is_applicable = 1 AND a.deleted_at IS NULL`, [COMPANY, chainIds]);
  const mine = [...[TH, LN, WD, GR, MARK].map((s) => ({ id: s.id, required: true })), ...steelExtras.map((s) => ({ id: s.id, required: false }))];
  for (const s of mine) await createRule(db, c, { subjectType: 'classification', subjectId: partsV.id, specificationId: s.id, captureAt: 'item', valueRule: 'entered', isApplicable: true, isRequired: s.required });
  const mineKeys = new Set(mine.map((s) => `${s.id}:item`));
  let [[cfSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'CUT_FROM' AND deleted_at IS NULL", [COMPANY]);
  if (!cfSpec) {
    const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, 'CUT_FROM', 'Cut from', 'option', 'active')", [COMPANY]);
    cfSpec = { id: r.insertId };
    for (const [i, v] of ['PLATE', 'SECTION', 'NONE'].entries()) await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, label, sort_order, status) VALUES (?, ?, ?, ?, ?, 'active')", [COMPANY, cfSpec.id, v, v, i + 1]);
  }
  mineKeys.add(`${cfSpec.id}:item`);
  for (const r of reaching) {
    if (mineKeys.has(`${r.specification_id}:${r.capture_at}`)) continue;
    await createRule(db, c, { subjectType: 'classification', subjectId: partsV.id, specificationId: r.specification_id, captureAt: r.capture_at, isApplicable: false });
  }
  await db.query(`INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, sort_order)
                  VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'defaulted', 0)`, [COMPANY, cfSpec.id, partsV.id]);
  await V.setValues(db, c, 'classification', partsV.id, [{ specCode: 'CUT_FROM', value: 'PLATE' }]);

  const fillRequired = async (masterId) => {
    const r = await RES.resolve(db, COMPANY, { master: await loadMaster(db, COMPANY, masterId) });
    const writes = [];
    for (const s of r.specs) {
      if (s.status !== 'missing') continue;
      const dt = s.spec.dataType;
      const value = dt === 'option' ? s.options?.[0]?.value : dt === 'number' ? 1 : dt === 'boolean' ? false : dt === 'date' ? '2026-01-01' : 'CAL';
      if (value !== undefined) writes.push({ specCode: s.spec.code, value });
    }
    if (writes.length) await V.setValues(db, c, 'master', masterId, writes);
  };
  const PL1 = await MR.createItem(db, c, { classificationId: PLATE.id, code: `${tag}-PL1`, name: `${tag} plate 25 x 2500 x 12500`, trackedBy: 'quantity', uom: 'nos' });
  await V.setValues(db, c, 'master', PL1.id, [{ specCode: 'THICKNESS', value: 25 }, { specCode: 'LENGTH', value: 12500 }, { specCode: 'WIDTH', value: 2500 }, { specCode: 'GRADE', value: 'E350' }]);
  await fillRequired(PL1.id);
  await MR.setStatus(db, c, PL1.id, 'active');
  const [rivals] = await db.query(
    `SELECT m.id FROM cf_definition_details d JOIN cf_master_records m ON m.id = d.master_id AND m.deleted_at IS NULL
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.definition_type = 'selection' AND d.candidate_classification_id = ? AND m.status = 'active'`, [COMPANY, PLATE.id]);
  if (rivals.length) await db.query("UPDATE cf_master_records SET status = 'obsolete' WHERE company_id = ? AND id IN (?)", [COMPANY, rivals.map((r) => r.id)]);
  let sel = await MR.createDefinition(db, c, { definitionType: 'selection', classificationId: PLATE.id, code: `${tag}-SEL`, name: `${tag} SEL plate`, selectionMode: 'allowed_list', candidateClassificationId: PLATE.id });
  await SEL.addAllowedItem(db, c, sel.id, { itemId: PL1.id });
  sel = await MR.setStatus(db, c, sel.id, 'active');
  await codegen.createScheme(db, COMPANY, c.userId, {
    code: `${tag}-BLANK`, name: `${tag} blank`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 100, status: 'active',
    conditions: [{ tokenKey: 'kind', operator: 'eq', value: 'temporary' }, { tokenKey: 'classification', operator: 'eq', value: String(CUTPL.id) }],
    segments: [lit(`${tag}-`), tok('line.no'), lit('-'), tok('spec:THICKNESS'), lit('X'), tok('spec:WIDTH'), lit('X'), tok('spec:LENGTH'), lit('-'), tok('spec:GRADE')],
  });
  const tpl = async (code, name, classificationId) => MR.setStatus(db, c, (await MR.createDefinition(db, c, { definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${tag} ${name}`, shortName: `${tag}${code}` })).id, 'active');
  const WEB = await tpl('WEB', 'Web plate', partsV.id);
  const TOP = await tpl('TOP', 'Top flange', partsV.id);
  const END = await tpl('END', 'End plate', partsV.id);
  const girder = async (code, lines) => {
    const g = await tpl(code, `girder ${code}`, girderV.id);
    for (const l of lines) await B.addLine(db, c, g.id, l);
    await B.setBomStatus(db, c, g.id, 'active');
    return g;
  };
  const GA = await girder('GA', [{ childId: WEB.id, quantity: 1 }, { childId: TOP.id, quantity: 1 }, { childId: END.id, quantity: 2 }]);
  const GB = await girder('GB', [WEB, TOP, TOP, TOP, END].map((t) => ({ childId: t.id, quantity: 1 })));
  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CU`, name: `${tag} NECL-like`, roles: ['customer'] });
  const other = await PARTIES.createParty(db, c, { code: `${tag}-CU2`, name: `${tag} another customer`, roles: ['customer'] });
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: cust.id, code: `${tag}-SO`, committedDate: '2026-12-31' });
  const add = async (recordId) => { const o = await SO.addOrderLine(db, c, order.id, { recordId, quantity: 1 }); return o.lines[o.lines.length - 1]; };
  const lineA = await add(GA.id);
  const lineB = await add(GB.id);
  const partsOf = async (lineId) => (await db.query(
    `SELECT m.id, i.source_definition_id AS def FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND i.deleted_at IS NULL AND m.classification_id = ? ORDER BY m.id`, [COMPANY, lineId, partsV.id]))[0];
  return { PLATE, CUTPL, partsV, MARK, steelExtras, PL1, sel, WEB, TOP, END, GA, GB, cust, other, order, lineA, lineB, partsOf };
}

/* ─────────────── helpers ─────────────── */
async function blankOf(db, f, partId) {
  const [rows] = await db.query(
    `SELECT m.id, m.code FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
      JOIN cf_master_records m ON m.id = l.child_id AND m.classification_id = ? AND m.deleted_at IS NULL
     WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL`, [f.CUTPL.id, COMPANY, partId]);
  return rows;
}
async function valuesOf(db, id, codes) {
  const [rows] = await db.query(
    `SELECT s.code, v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL AND s.code IN (?)`, [COMPANY, id, codes]);
  return Object.fromEntries(rows.map((r) => [r.code, r.value_number != null ? Number(r.value_number) : null]));
}
/** The cut piece one part is cut from: { id, code, length, weight }. */
async function cutOf(db, f, partId) {
  const [b] = await blankOf(db, f, partId);
  if (!b) return null;
  const v = await valuesOf(db, b.id, ['LENGTH', 'WEIGHT', 'THICKNESS', 'WIDTH']);
  return { id: b.id, code: b.code, length: v.LENGTH ?? null, weight: v.WEIGHT ?? null, thickness: v.THICKNESS, width: v.WIDTH };
}
const size = (id, t, l, w) => [{ recordId: id, specCode: 'THICKNESS', value: t }, { recordId: id, specCode: 'LENGTH', value: l }, { recordId: id, specCode: 'WIDTH', value: w }, { recordId: id, specCode: 'GRADE', value: 'E350' }];

/* ─────────────── the run ─────────────── */
console.log(`cut_allowance_test — company ${COMPANY}, tag ${tag}`);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const f = await buildFixture(conn, c);
  const pa = await f.partsOf(f.lineA.id);
  const pb = await f.partsOf(f.lineB.id);
  const of = (rows, def) => rows.filter((r) => Number(r.def) === Number(def.id)).map((r) => r.id);
  const [aWeb] = of(pa, f.WEB); const [aTop] = of(pa, f.TOP); const [aEnd] = of(pa, f.END);
  const [bWeb] = of(pb, f.WEB); const bTops = of(pb, f.TOP); const [bEnd] = of(pb, f.END);
  const dims = (id, def) => (def === f.WEB ? size(id, 16, 11940, 1500) : def === f.TOP ? size(id, 25, 11940, 500) : size(id, 12, 400, 300));
  const fill = (rows) => rows.flatMap((r) => [
    ...dims(r.id, [f.WEB, f.TOP, f.END].find((d) => Number(d.id) === Number(r.def))),
    { recordId: r.id, specCode: f.MARK.code, value: 'M' },
    ...f.steelExtras.map((s) => ({ recordId: r.id, specCode: s.code, value: s.value })),
  ]);
  await OV.writeLineValues(conn, c, f.lineA.id, { writes: fill(pa) });
  await OV.writeLineValues(conn, c, f.lineB.id, { writes: fill(pb) });
  invalidateNodeCache(conn);
  const [[{ line_no: noA }]] = await conn.query('SELECT line_no FROM cf_sales_order_lines WHERE id = ?', [f.lineA.id]);
  const [[{ line_no: noB }]] = await conn.query('SELECT line_no FROM cf_sales_order_lines WHERE id = ?', [f.lineB.id]);

  /* ─── 1 ─── */
  section('1. No rule: every cut piece at the drawn length');
  const r1a = await CUT.refreshCutPieces(conn, c, f.lineA.id);
  const r1b = await CUT.refreshCutPieces(conn, c, f.lineB.id);
  ok('both lines made their cut pieces', r1a.made === true && r1b.made === true, J([r1a, r1b]));
  const top0 = await cutOf(conn, f, aTop);
  ok(`the top flange is cut 11940 long, coded ${top0?.code}`, near(top0?.length, 11940) && top0.code === `${tag}-${noA}-25X500X11940-E350`, J(top0));
  const rootId = (await conn.query('SELECT item_id FROM cf_sales_order_lines WHERE id = ?', [f.lineA.id]))[0][0].item_id;
  const partBefore = { a: await valuesOf(conn, aTop, ['LENGTH', 'WEIGHT']), root: await valuesOf(conn, rootId, ['WEIGHT']) };
  /** Every stored value of the line's own rows (the girder and its parts — not the cut pieces): what "as drawn" means. */
  const rowValues = async (lineId) => (await conn.query(
    `SELECT v.subject_id, v.specification_id, v.value_number, v.value_text, v.option_id, v.value_bool FROM cf_spec_values v
       JOIN cf_item_details i ON i.master_id = v.subject_id AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
       JOIN cf_master_records m ON m.id = v.subject_id AND m.classification_id <> ?
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL ORDER BY v.subject_id, v.specification_id`, [lineId, f.CUTPL.id, COMPANY]))[0];
  const drawnBefore = J(await rowValues(f.lineA.id));
  const measure = async () => J([...(await PRICE.measuresOf(conn, COMPANY, [rootId]))]);
  const measureBefore = await measure();
  says(`top flange part: ${J(partBefore.a)}; cut piece: ${J(top0)}; girder: ${J(partBefore.root)}`);
  const view0 = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  ok('the Cut pieces list says no allowance on any of them', view0.cutPlates.every((x) => x.allowance === null), J(view0.cutPlates.map((x) => x.allowance)));
  const names = await CA.partNames(conn, COMPANY, { search: tag });
  ok('the part-name picker lists the plate-part definitions (web, top flange, end plate), never the girders', J(names.partNames.map((x) => x.id).sort()) === J([f.WEB.id, f.TOP.id, f.END.id].sort()), J(names.partNames));

  /* ─── 2 ─── */
  section('2. The customer\'s default for "Top flange": 7.5 mm at each end');
  const setCust = await CA.setCustomerAllowance(conn, c, f.cust.id, f.TOP.id, { perEndMm: 7.5 });
  ok('saved, and the cut pieces of both open lines worked out again', setCust.rules.length === 1 && setCust.rules[0].perEndMm === 7.5 && setCust.refreshed.length === 2 && setCust.refreshed.every((r) => r.made) && setCust.frozen.length === 0, J({ refreshed: setCust.refreshed, frozen: setCust.frozen }));
  says(setCust.message);
  ok('the rule says itself: "7.5 mm at each end", worked on 12000: 12000 → 12015', setCust.rules[0].words === '7.5 mm at each end' && setCust.rules[0].example.words === '12000 → 12015 mm (+15 mm)', J(setCust.rules[0]));
  const top1 = await cutOf(conn, f, aTop);
  ok(`THE NECL EXAMPLE: the top flange's cut piece is 11940 + 2 × 7.5 = 11955 long, coded ${top1?.code}`, near(top1?.length, 11955) && top1.code === `${tag}-${noA}-25X500X11955-E350`, J(top1));
  if (top0.weight != null && top1.weight != null) {
    ok(`the cut piece's weight follows its length: ${top0.weight} → ${top1.weight} kg (× 11955 / 11940)`, near(top1.weight, top0.weight * 11955 / 11940, 0.01), J([top0.weight, top1.weight]));
  } else says('no WEIGHT rule reaches a cut piece in this company — the weight check is the plate quantity and nesting\'s own L × W × T');
  const partAfter = { a: await valuesOf(conn, aTop, ['LENGTH', 'WEIGHT']), root: await valuesOf(conn, rootId, ['WEIGHT']) };
  ok('THE ROW KEEPS ITS DRAWN LENGTH (11940) and its weight; the order weight stays as drawn', J(partAfter) === J(partBefore) && near(partAfter.a.LENGTH, 11940), J([partBefore, partAfter]));
  ok("every stored value of the line's own rows (girder and parts) is what it was — only cut pieces moved", J(await rowValues(f.lineA.id)) === drawnBefore);
  ok(`the line's weight for pricing (priceService.measuresOf the line's item) is unchanged: ${measureBefore}`, (await measure()) === measureBefore);
  ok('the web and the end plate are untouched (no rule for them)', near((await cutOf(conn, f, aWeb)).length, 11940) && near((await cutOf(conn, f, aEnd)).length, 400));
  const bTop1 = await Promise.all(bTops.map((id) => cutOf(conn, f, id)));
  ok('line B: its three top flange rows share ONE cut piece, 11955 long', new Set(bTop1.map((x) => x.id)).size === 1 && near(bTop1[0].length, 11955), J(bTop1));
  const view1 = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  const vTop = view1.cutPlates.find((x) => x.id === top1.id);
  ok('the Cut pieces list: "+15 mm allowance" beside the size, the drawn length, the rule and where it comes from (the customer)', vTop?.allowance?.extraMm === 15 && vTop.allowance.words === '+15 mm allowance' && vTop.allowance.drawnLength === 11940 && vTop.allowance.cutLength === 11955 && vTop.allowance.rule?.scope === 'customer' && vTop.size.length === 11955, J(vTop?.allowance));
  ok('…and the line is up to date', view1.upToDate === true);
  // A derive that changes nothing still writes nothing, and costs one read more for the rules.
  {
    const tally = { trips: 0, writes: 0 };
    const counted = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { tally.trips += 1; if (/^\s*(INSERT|UPDATE|DELETE)/i.test(String(a[0]))) tally.writes += 1; return t.query(...a); } : Reflect.get(t, p)) });
    const again = await CUT.refreshCutPieces(counted, c, f.lineA.id);
    ok(`called again: up to date, nothing written, ${tally.trips} round trips (the allowance read is one)`, again.reason === 'up_to_date' && tally.writes === 0 && tally.trips <= 11, J([again.reason, tally]));
  }
  const otherOrder = await CA.customerAllowances(conn, COMPANY, f.other.id);
  ok('another customer has no rule', otherOrder.rules.length === 0);

  /* ─── 3 ─── */
  section('3. An ORDER override for "Top flange": 5 mm at each end + 1 mm a metre');
  const setOrd = await CA.setOrderAllowance(conn, c, f.order.id, f.TOP.id, { perEndMm: 5, perMetreMm: 1 });
  const ordTop = setOrd.partNames.find((p) => p.definitionId === f.TOP.id);
  ok('the order view lists ONLY the part names in this order\'s BOM — web, top flange, end plate — with their rows', J(setOrd.partNames.map((p) => p.definitionId).sort()) === J([f.WEB.id, f.TOP.id, f.END.id].sort()) && ordTop.rows === 4 && setOrd.partNames.find((p) => p.definitionId === f.WEB.id).rows === 2, J(setOrd.partNames.map((p) => [p.definition.name, p.rows])));
  ok('top flange: the customer says 7.5 at each end, the order 5 + 1 a metre — the order wins: 11940 → 11961.9 (+21.9)', ordTop.customer?.perEndMm === 7.5 && ordTop.order?.perEndMm === 5 && ordTop.order.perMetreMm === 1 && ordTop.effective?.scope === 'order' && ordTop.example?.cutLength === 11961.9 && ordTop.example.extraMm === 21.9, J(ordTop));
  says(`${ordTop.definition.name}: ${ordTop.effective.words} — ${ordTop.example.words}`);
  const top2 = await cutOf(conn, f, aTop);
  ok('the cut pieces followed on both lines: 11961.9', near(top2.length, 11961.9) && near((await cutOf(conn, f, bTops[0])).length, 11961.9), J(top2));
  ok('the view says no line is locked', setOrd.lines.every((l) => !l.frozen) && setOrd.order.editable === true);

  /* ─── 4 ─── */
  section('4. A ROW override beats both; taken away, back to the part name\'s');
  const rowSet = await CA.setRowAllowance(conn, c, f.order.id, f.lineB.id, bTops[0], { perEndMm: 0, perMetreMm: 0 });
  ok('the row\'s levels: customer 7.5, order 5 + 1, its own 0 — its own wins, and it is cut as drawn', rowSet.customer?.perEndMm === 7.5 && rowSet.order?.perEndMm === 5 && rowSet.own?.perEndMm === 0 && rowSet.effective.scope === 'row' && rowSet.example.cutLength === 11940 && rowSet.row.drawnLength === 11940, J(rowSet));
  const b0 = await cutOf(conn, f, bTops[0]); const b1 = await cutOf(conn, f, bTops[1]);
  ok('that row has its own cut piece at 11940; the other flange rows stay on 11961.9', near(b0.length, 11940) && near(b1.length, 11961.9) && b0.id !== b1.id, J([b0, b1]));
  const ordView = await CA.orderAllowances(conn, COMPANY, f.order.id);
  ok('the order view lists the row override, and counts it on its part name', ordView.rows.length === 1 && ordView.rows[0].partId === bTops[0] && ordView.rows[0].lineNo === noB && ordView.partNames.find((p) => p.definitionId === f.TOP.id).rowOverrides === 1, J(ordView.rows));
  await CA.clearRowAllowance(conn, c, f.order.id, f.lineB.id, bTops[0]);
  const b0b = await cutOf(conn, f, bTops[0]);
  ok('row override taken away: the row rejoins the others\' cut piece', b0b.id === b1.id && near(b0b.length, 11961.9), J(b0b));
  const cleared = await CA.clearOrderAllowance(conn, c, f.order.id, f.TOP.id);
  ok('order override taken away: back to the customer\'s 11955', near((await cutOf(conn, f, aTop)).length, 11955) && cleared.partNames.find((p) => p.definitionId === f.TOP.id).effective.scope === 'customer');

  /* ─── 5 ─── */
  section('5. Refusals, in words');
  const neg = await refusal(() => CA.setCustomerAllowance(conn, c, f.cust.id, f.TOP.id, { perEndMm: -2 }));
  ok('a negative allowance is refused', neg?.code === 'INVALID' && /less than 0/.test(neg.message), neg?.message);
  const big = await refusal(() => CA.setOrderAllowance(conn, c, f.order.id, f.TOP.id, { perEndMm: 500 }));
  ok('more than 200 mm at an end is refused', big?.code === 'INVALID' && /at most 200/.test(big.message), big?.message);
  const notPlate = await refusal(() => CA.setCustomerAllowance(conn, c, f.cust.id, f.GA.id, { perEndMm: 5 }));
  ok('a part name that is not cut from plate (a girder) is refused', notPlate?.code === 'NOT_A_PLATE_PART', notPlate?.message);
  const notRow = await refusal(() => CA.setRowAllowance(conn, c, f.order.id, f.lineB.id, aTop, { perEndMm: 5 }));
  ok('a row of another line is refused', notRow?.code === 'NOT_A_PLATE_PART', notRow?.message);

  /* ─── 6 ─── */
  section('6. A LOCKED line keeps its cut pieces; the open line follows');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [f.lineA.id]);
  const lockedTop = await cutOf(conn, f, aTop);
  const ten = await CA.setCustomerAllowance(conn, c, f.cust.id, f.TOP.id, { perEndMm: 10 });
  ok('the change says line A is locked and keeps its cut pieces (a revision takes it); line B was worked out again', ten.frozen.length === 1 && ten.frozen[0].lineId === f.lineA.id && /is frozen — its cut pieces stay as they are/.test(ten.frozen[0].message) && ten.refreshed.length === 1 && ten.refreshed[0].lineId === f.lineB.id && ten.refreshed[0].made, J([ten.frozen, ten.refreshed]));
  says(ten.message);
  const lockedAfter = await cutOf(conn, f, aTop);
  ok('the locked line\'s flange is untouched: same cut piece, still 11955', lockedAfter.id === lockedTop.id && near(lockedAfter.length, 11955), J(lockedAfter));
  ok('the open line\'s flange is now 11940 + 20 = 11960', near((await cutOf(conn, f, bTops[0])).length, 11960));
  const lockedView = await CUT.getCutPlates(conn, COMPANY, f.lineA.id);
  const lv = lockedView.cutPlates.find((x) => x.id === lockedTop.id);
  ok('the locked line\'s Cut pieces list still says +15 mm (what its cut piece carries) and why it is frozen', lv?.allowance?.extraMm === 15 && lockedView.lock?.reason === 'locked' && lockedView.upToDate === null, J([lv?.allowance, lockedView.lock]));
  const rowOnLocked = await CA.rowAllowance(conn, COMPANY, f.order.id, f.lineA.id, aTop);
  ok('the row on the locked line says its rule (10 at each end) and that the line is frozen', rowOnLocked.effective.perEndMm === 10 && rowOnLocked.lineFrozen?.reason === 'locked', J(rowOnLocked));

  /* ─── 7 ─── */
  section('7. A REVISION takes the order\'s and its rows\' rules, and the allowance in force');
  await CA.setOrderAllowance(conn, c, f.order.id, f.WEB.id, { perEndMm: 2 });
  await CA.setRowAllowance(conn, c, f.order.id, f.lineA.id, aEnd, { perEndMm: 1 });
  ok('the end-plate row rule on the LOCKED line is kept (for its revision), its cut piece unchanged at 400', near((await cutOf(conn, f, aEnd)).length, 400));
  const rev = await REV.reviseOrder(conn, c, f.order.id);
  ok(`revision ${rev.revision} made`, Number(rev.revision) === 2 && rev.cutPieces.every((x) => ['made', 'up_to_date'].includes(x.reason)), J(rev.cutPieces));
  const [carried] = await conn.query("SELECT scope, definition_id, part_id, per_end_mm FROM cf_cut_allowances WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY scope", [COMPANY, rev.id]);
  ok('the new revision holds the order\'s web rule and the end plate\'s row rule (on its copy of the row)', carried.length === 2 && carried.some((r) => r.scope === 'order' && Number(r.definition_id) === f.WEB.id) && carried.some((r) => r.scope === 'row' && Number(r.part_id) !== aEnd), J(carried));
  const newLineA = rev.lines.find((l) => l.lineNo === noA);
  const npa = await f.partsOf(newLineA.id);
  const [nTop] = of(npa, f.TOP); const [nWeb] = of(npa, f.WEB); const nEnds = of(npa, f.END);
  const nTopCut = await cutOf(conn, f, nTop); const nWebCut = await cutOf(conn, f, nWeb); const nEndCut = await cutOf(conn, f, nEnds[0]);
  ok('rev 2 line A: the flange at the customer\'s 10 at each end (11960), the web at the order\'s 2 at each end (11944), the end plate at its row\'s 1 at each end (402)', near(nTopCut?.length, 11960) && near(nWebCut?.length, 11944) && near(nEndCut?.length, 402), J([nTopCut, nWebCut, nEndCut]));
  ok('rev 1 line A keeps its cut pieces as they were (11955, 11940, 400)', near((await cutOf(conn, f, aTop)).length, 11955) && near((await cutOf(conn, f, aWeb)).length, 11940) && near((await cutOf(conn, f, aEnd)).length, 400));
  const oldRev = await refusal(() => CA.setOrderAllowance(conn, c, f.order.id, f.TOP.id, { perEndMm: 3 }));
  ok('the revised order takes no allowance change: change the latest revision instead', oldRev?.code === 'ORDER_LOCKED' && /was revised/.test(oldRev.message), oldRev?.message);

  /* ─── 8 ─── */
  section('8. The nesting upload: drawn + the allowance is an EXACT match');
  await uploadSection(conn, c, f);

  /* ─── 9 ─── */
  section('9. The reader: a name that states the DRAWN length of a cut piece cut longer matches exactly');
  readerSection();

  /* ─── 10 ─── */
  section('10. A drawn cut piece cut longer than its drawing is nested as its rectangle');
  {
    const ring = [[0, 0], [1000, 0], [1000, 200], [500, 260], [0, 200]];
    const facts = new Map([[1, { rings: [ring], partLength: 1000 }], [2, { rings: [ring], partLength: 1000 }]]);
    const longer = NS.shapeOfCutPlate({ id: 1, steel: { length: 1015, width: 260 } }, facts);
    const same = NS.shapeOfCutPlate({ id: 2, steel: { length: 1000, width: 260 } }, facts);
    ok('cut 15 mm longer than its drawing: its rectangle, with the reason in words', longer.drawn === false && longer.length === 1015 && /15 mm longer than its drawing/.test(longer.shapeNote), J(longer && { ...longer, rings: 0 }));
    ok('cut as drawn: its drawing, as before', same.drawn === true && same.shapeFrom === 'drawing');
  }
} finally {
  try { detachNodeCache(conn); } catch { /* */ }
  await conn.rollback();
  conn.release();
}

const after = await counts();
const moved = after.filter((r) => before.find((b) => b.name === r.name)?.n !== r.n);
ok('rolled back: every cf_ table has the rows it started with', moved.length === 0, J(moved));
console.log(`\n${passed} passed, ${failed} failed${failed ? `\n  ${fails.join('\n  ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);

/* ─────────────── 8. the upload, on the shop's real 25 mm ProNest job ─────────────── */
async function uploadSection(db, c, f) {
  const NIF = await imp('apps/cf_erp/lib/nifReader.js');
  const name = '25MM-NECL-PATNA -SPAN1.nif';
  if (!fs.existsSync(path.join(NIF_DIR, name))) { says(`${name} is not here — section skipped`); return; }
  const buffer = fs.readFileSync(path.join(NIF_DIR, name));
  void NIF;
  const places = (await cutPlaces(db, COMPANY)).plate;
  const cutNode = places.blanksNodeId; const plateNode = Math.min(...places.stockNodeIds);
  const specId = async (code) => (await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]))[0][0]?.id;
  const spec = {};
  for (const code of ['THICKNESS', 'LENGTH', 'WIDTH', 'GRADE', 'MATERIAL', 'DENSITY', 'DRAWING_MARK']) spec[code] = await specId(code);
  const grade = (await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, spec.GRADE, `${tag}-UPG`]))[0].insertId;
  const mat = spec.MATERIAL ? (await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, spec.MATERIAL, `${tag}-UPM`]))[0].insertId : null;
  const master = async (code, classificationId, itemType, ownerLineId = null) => {
    const [m] = await db.query("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, code, code, classificationId]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id, list_price, price_basis) VALUES (?, ?, ?, 'quantity', 'nos', ?, ?, 62000, 'tonne')", [m.insertId, COMPANY, itemType, itemType === 'temporary' ? 'make' : 'stock', ownerLineId]);
    return m.insertId;
  };
  const setVals = async (id, vals) => {
    const rows = vals.filter(([s, v]) => s && v != null).map(([s, v]) => [COMPANY, s, 'master', id, v.n ?? null, v.o ?? null, v.t ?? null, 'entered']);
    if (rows.length) await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, value_text, source) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`, rows.flat());
  };
  const steel = (t, l, w) => [[spec.THICKNESS, { n: t }], [spec.LENGTH, { n: l }], [spec.WIDTH, { n: w }], [spec.GRADE, { o: grade }], [spec.MATERIAL, mat ? { o: mat } : null], [spec.DENSITY, { n: 7850 }]];
  const bomLine = async (parentId, childId, quantity, lineNo) => {
    let [[bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
    if (!bom) bom = { id: (await db.query("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'active')", [COMPANY, parentId]))[0].insertId };
    await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', [COMPANY, bom.id, lineNo, childId, childId, lineNo, quantity]);
  };
  const [[band]] = await db.query('SELECT id FROM cf_cut_settings WHERE company_id = ? AND thickness_min_mm = 25 AND thickness_max_mm = 25 AND deleted_at IS NULL', [COMPANY]);
  if (!band) await db.query('INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, 25, 25, 3, 5, 8, 100, 50, 50, 0)', [COMPANY]);
  const plate = await master(`${tag}-P25`, plateNode, 'catalog');
  await setVals(plate, steel(25, 12000, 2500));
  const [node] = await db.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, NULL, 0, 'item', ?, ?)", [COMPANY, `${tag}-UPARTS`, `${tag} upload parts`]);

  /**
   * A line holding the 25 mm job's parts as an ERP line would: the bottom flange DRAWN 6120 (the shop nests it 6135).
   * `bfCut` = the length its cut piece is cut: 6120 as drawn, or 6135 = 6120 + 7.5 at each end.
   */
  const lineWith = async (bfCut, k) => {
    const [o] = await db.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', 'Cut allowance upload', 'confirmed')", [COMPANY, `${tag}-UP${k}`]);
    const root = await master(`${tag}-UP${k}-ROOT`, node.insertId, 'temporary');
    const [l] = await db.query("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 1, NOW(), 1)", [COMPANY, o.insertId, root, root]);
    await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [l.insertId, COMPANY, root]);
    const parts = {
      TF: [6135, 500, 8, 6135], BF: [6120, 750, 8, bfCut], SPTO: [2290, 700, 8, 2290], SPTI: [2290, 275, 20, 2290],
      SPBO: [1770, 950, 8, 1770], EDS: [2150, 240, 49, 2150], SPBX: [1770, 400, 16, 1770],
    };
    const cut = {};
    let n = 0;
    for (const [sfx, [len, wid, qty, cutLen]] of Object.entries(parts)) {
      n += 1;
      const row = await master(`${tag}-UP${k}-PT-${sfx}`, node.insertId, 'temporary', l.insertId);
      await setVals(row, [[spec.THICKNESS, { n: 25 }], [spec.LENGTH, { n: len }], [spec.WIDTH, { n: wid }], [spec.DENSITY, { n: 7850 }], [spec.DRAWING_MARK, { t: `${tag}-UP${k}-${sfx}` }]]);
      const cp = await master(`${tag}-UP${k}-C${sfx}`, cutNode, 'temporary', l.insertId);
      await setVals(cp, steel(25, cutLen, wid));
      await bomLine(root, row, qty, n);
      await bomLine(row, cp, 1, 1);
      await bomLine(cp, plate, (cutLen * wid) / (12000 * 2500), 1);
      cut[sfx] = cp;
    }
    return { lineId: l.insertId, cut };
  };
  const BTM = '25MM-EG1-IG1 BTM FL1-750X6135- 8';
  const req = [{ filename: name, file: buffer.toString('base64') }];
  const asDrawn = await lineWith(6120, 'D');
  const before = await U.uploadNestFiles(db, c, asDrawn.lineId, { files: req });
  const b = before.jobs[0].partRows.find((r) => r.partName === BTM);
  ok('cut as drawn (6120): the bottom flange nested 6135 is matched only through the ≤25 mm rung — status "allowance", 15 mm', b?.status === 'allowance' && b.matched?.allowanceMm === 15 && b.matched.cutPlateId === asDrawn.cut.BF, J(b && { ...b, candidates: 0 }));
  const withAllowance = await lineWith(6135, 'A');
  const after = await U.uploadNestFiles(db, c, withAllowance.lineId, { files: req });
  const a = after.jobs[0].partRows.find((r) => r.partName === BTM);
  ok('cut with the allowance (6120 + 2 × 7.5 = 6135): the same part is an EXACT match — status "matched", no allowanceMm, no outline difference', a?.status === 'matched' && a.matched?.cutPlateId === withAllowance.cut.BF && a.matched.allowanceMm === undefined && !a.matched.outlineDiffers, J(a && { ...a, candidates: 0 }));
  ok('…and nothing of the job counts as matched by the allowance any more', !after.jobs[0].matchedBy.allowance, J(after.jobs[0].matchedBy));
  says(`matchedBy as drawn ${J(before.jobs[0].matchedBy)} → with the allowance ${J(after.jobs[0].matchedBy)}`);
}

/* ─────────────── 9. matchNest on its own ─────────────── */
function readerSection() {
  // A cambered web: its outline is not its rectangle, so only its NAME can say what it is.
  const bow = [[0, 0], [11955, 0], [11955, 500], [5977, 590], [0, 500]];
  const part = (nameSize) => ({ id: 'P1', rings: [bow], bbox: { x: 0, y: 0, length: 11955, width: 590 }, labels: [], outlineOnly: true, labelFrom: 'name', nameSize });
  const cand = (drawnLengths) => [{ key: 'cp1', codes: ['CP-WEB'], length: 11955, width: 500, ...(drawnLengths ? { drawnLengths } : {}) }];
  const drawnName = RD.matchNest({ parts: [part([11940, 500])] }, cand([11940]));
  const pl = drawnName.placements[0];
  ok('the name states the DRAWN 11940 of a cut piece cut 11955 (it carries drawnLengths [11940]): matched by the size in its name, exactly — no allowanceMm', !!pl && pl.candidateKey === 'cp1' && pl.by === 'name size' && pl.allowanceMm === undefined, J(drawnName.placements.concat(drawnName.unmatched)));
  const without = RD.matchNest({ parts: [part([11940, 500])] }, cand(null));
  ok('without drawnLengths the same name is SHORTER than the cut piece: no match (the allowance rung is never "under")', without.placements.length === 0, J(without.placements));
  const allowedName = RD.matchNest({ parts: [part([11955, 500])] }, cand([11940]));
  ok('a name stating the cut length 11955 still matches exactly', allowedName.placements[0]?.by === 'name size' && allowedName.placements[0].allowanceMm === undefined, J(allowedName.placements));
  // An OUTLINE as drawn (11940) is not the cut piece (11955): drawnLengths are for names only.
  const rect = [[0, 0], [11940, 0], [11940, 500], [0, 500]];
  const short = RD.matchNest({ parts: [{ id: 'P2', rings: [rect], bbox: { x: 0, y: 0, length: 11940, width: 500 }, labels: [], outlineOnly: true, labelFrom: 'name', nameSize: null }] }, cand([11940]));
  ok('an outline nested at the drawn 11940 does NOT match the 11955 cut piece (drawnLengths are for names only)', short.placements.length === 0, J(short.placements));
  ok('drawnLengthsOf: the rows\' drawn lengths of a cut piece cut longer, and nothing for one cut as drawn',
    J(CA.drawnLengthsOf({ id: 9, steel: { length: 11955 } }, [{ cutPlateId: 9, length: 11940 }, { cutPlateId: 9, length: 11940 }, { cutPlateId: 8, length: 100 }])) === J([11940])
    && J(CA.drawnLengthsOf({ id: 9, steel: { length: 11940 } }, [{ cutPlateId: 9, length: 11940 }])) === J([]));
  ok('extraMmOf: 7.5 at each end on 11940 = 15; 5 + 1 a metre = 21.9', CA.extraMmOf({ perEndMm: 7.5, perMetreMm: 0 }, 11940) === 15 && CA.extraMmOf({ perEndMm: 5, perMetreMm: 1 }, 11940) === 21.9);
}
