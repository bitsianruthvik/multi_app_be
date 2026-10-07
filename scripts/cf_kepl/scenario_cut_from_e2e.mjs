/**
 * scenario_cut_from_e2e.mjs — the user's acceptance scenario for Cut from (2026-10-08):
 *
 *   1. a sales order with plates of several shapes AND bracings (angles of two sizes, an ISMB),
 *      taken through every step: values → cut pieces (plate AND section) → confirm → freeze
 *      (codes) → plate nesting → section nesting → each nest downloaded, rewritten as a VERY
 *      different but correct nest, uploaded (preview, then save) → buying → release.
 *   2. every template definition answers Cut from, and the answer fits where it is filed.
 *   3. the codes: every piece, cut plate and cut section has a code, none twice, the tracker
 *      carries the frozen codes.
 *
 * Local only (company 2). ONE transaction: rolled back unless --keep (then committed, so the order
 * can be opened in the app). Every check prints PASS / FAIL; the last line is the count.
 *
 *   cd multi_app_be && node scripts/cf_kepl/scenario_cut_from_e2e.mjs [--keep]
 */
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import * as MR from '../../apps/cf_erp/services/masterRecordService.js';
import * as B from '../../apps/cf_erp/services/bomService.js';
import * as V from '../../apps/cf_erp/services/valueService.js';
import * as SO from '../../apps/cf_erp/services/salesOrderService.js';
import * as CUT from '../../apps/cf_erp/services/cutPlateService.js';
import * as LOCK from '../../apps/cf_erp/services/lockService.js';
import * as NEST from '../../apps/cf_erp/services/nestingService.js';
import * as NSHEET from '../../apps/cf_erp/services/nestingSheetService.js';
import * as SNEST from '../../apps/cf_erp/services/sectionNestingService.js';
import * as SSHEET from '../../apps/cf_erp/services/sectionSheetService.js';
import * as PF from '../../apps/cf_erp/services/purchaseFlowService.js';
import * as REL from '../../apps/cf_erp/services/releaseService.js';
import { barLayout } from '../../apps/cf_erp/services/sectionPacker.js';
import { cutPlaces } from '../../apps/cf_erp/lib/cutPlaces.js';
import { cutFromDetailOf } from '../../apps/cf_erp/lib/cutFrom.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = 2;
const KEEP = process.argv.includes('--keep');
const tag = `SCN${Date.now().toString(36).toUpperCase().slice(-5)}`;

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const say = (e) => `${e?.code ?? ''} ${e?.message ?? e}${e?.problems ? ` ${JSON.stringify(e.problems).slice(0, 600)}` : ''}`;

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, isAdmin: true };
  const one = async (sql, args) => (await db.query(sql, args))[0][0];
  const all = async (sql, args) => (await db.query(sql, args))[0];
  const defByCode = async (code) => one("SELECT m.id, m.code, m.name, m.short_name FROM cf_master_records m JOIN cf_definition_details d ON d.master_id = m.id WHERE m.company_id = ? AND m.code = ? AND m.deleted_at IS NULL", [COMPANY, code]);
  const itemByCode = async (code) => one('SELECT id, code FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);

  // The local copy's top-piece rule is older than production's (item.code); align it with prod's
  // order.code-item.shortName piece.seq for this run (inside the transaction only).
  const top = await one("SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = 'CFPC-TOP' AND deleted_at IS NULL", [COMPANY]);
  if (top) {
    const segs = await all('SELECT id, sort_order, token_key FROM cf_code_scheme_segments WHERE scheme_id = ? AND deleted_at IS NULL ORDER BY sort_order', [top.id]);
    if (segs.some((g) => g.token_key === 'item.code')) {
      await db.query('UPDATE cf_code_scheme_segments SET deleted_at = NOW() WHERE scheme_id = ? AND deleted_at IS NULL', [top.id]);
      await db.query("INSERT INTO cf_code_scheme_segments (company_id, scheme_id, sort_order, segment_type, literal_text, token_key) VALUES (?, ?, 1, 'token', NULL, 'order.code'), (?, ?, 2, 'literal', '-', NULL), (?, ?, 3, 'token', NULL, 'item.shortName'), (?, ?, 7, 'token', NULL, 'piece.seq')", [COMPANY, top.id, COMPANY, top.id, COMPANY, top.id, COMPANY, top.id]);
    }
  }

  /* ---------------------------------------------------------------- 0. the parts */
  section('0. The design: a truss of plates and bracings');
  const PLATE_DEFS = { TFL: 'TF-002', WEB: 'WB-002', STF: 'IS-002', GSP: 'GSP', PAD: 'PP-002' };
  const SECTION_DEFS = { XTA: 'XTA', XDA: 'XDA', XBA: 'XBA', BRC: 'BRC', MBM: 'MBM' };
  const defs = {};
  for (const [k, code] of Object.entries({ ...PLATE_DEFS, ...SECTION_DEFS })) defs[k] = await defByCode(code);
  ok('every part definition exists (plates and bracings)', Object.values(defs).every(Boolean), JSON.stringify(Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v?.code ?? null]))));
  const cf = await cutFromDetailOf(db, COMPANY, Object.values(defs).map((d) => d.id));
  ok('plate definitions answer Plate', Object.keys(PLATE_DEFS).every((k) => cf.get(defs[k].id)?.value === 'PLATE'), JSON.stringify(Object.keys(PLATE_DEFS).map((k) => cf.get(defs[k].id))));
  ok('bracing definitions answer Section', Object.keys(SECTION_DEFS).every((k) => cf.get(defs[k].id)?.value === 'SECTION'), JSON.stringify(Object.keys(SECTION_DEFS).map((k) => cf.get(defs[k].id))));

  const stock = {
    A75_6: await itemByCode('ISA-75X75X8X6000-E350BO'), A75_9: await itemByCode('ISA-75X75X8X9000-E350BO'),
    A65_6: await itemByCode('ISA-65X65X6X6000-E350BO'), MB200: await itemByCode('ISMB-200X100X5.4X12000-E250BO'),
  };
  ok('the stock bars exist in the catalog', Object.values(stock).every(Boolean), JSON.stringify(stock));
  // A definition-level default section: every XDA made from now on is cut from ISA 75x75x8.
  await MR.updateRecord(db, c, defs.XDA.id, { cutStockId: stock.A75_6.id });

  const lineNode = await one("SELECT m.classification_id AS id FROM cf_master_records m WHERE m.company_id = ? AND m.code = 'SPAN-002'", [COMPANY]);
  const truss = await MR.createDefinition(db, c, { definitionType: 'template', classificationId: lineNode.id, code: `${tag}-TRUSS`, name: `Scenario truss ${tag}`, shortName: tag, status: 'active' });
  const ROWS = [
    ['TFL', 2, 'Top chord flange'], ['WEB', 1, 'Main web'], ['STF', 6, 'Stiffener'], ['GSP', 4, 'Gusset'], ['PAD', 2, 'Bearing pad'],
    ['XTA', 2, 'X-frame top'], ['XDA', 4, 'X-frame diagonal'], ['XBA', 2, 'X-frame bottom'], ['BRC', 3, 'Side bracing'], ['MBM', 1, 'Cross beam'],
  ];
  for (const [k, q, role] of ROWS) await B.addLine(db, c, truss.id, { childId: defs[k].id, quantity: q, role });
  const tb = await one('SELECT id, status FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, truss.id]);
  if (tb && tb.status !== 'active') await B.setBomStatus(db, c, truss.id, 'active');
  // How each thing is made (release asks): the local copy has no CG flows, so the plain part flow for the
  // new definitions and the truss, and the cutting flow for cut plates (Placebo has its own).
  const partFlow = await one("SELECT id FROM cf_operation_flows WHERE company_id = ? AND code = 'PARTFAB-PLAIN' AND deleted_at IS NULL", [COMPANY]);
  const cutFlow = await one("SELECT id FROM cf_operation_flows WHERE company_id = ? AND code = 'CUTTING' AND deleted_at IS NULL", [COMPANY]);
  for (const d of [truss, defs.GSP, defs.XTA, defs.XDA, defs.XBA, defs.BRC, defs.MBM]) await MR.updateRecord(db, c, d.id, { defaultFlowId: partFlow.id });
  await db.query('INSERT INTO cf_company_settings (company_id, cut_plate_flow_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE cut_plate_flow_id = IFNULL(cut_plate_flow_id, VALUES(cut_plate_flow_id))', [COMPANY, cutFlow.id]);
  ok('the truss template has its ten rows', (await all('SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id WHERE b.parent_id = ? AND l.deleted_at IS NULL', [truss.id])).length === 10);

  /* ---------------------------------------------------------------- 1. the order */
  section('1. The sales order');
  const customer = await one("SELECT p.id FROM parties p WHERE p.company_id = ? AND p.deleted_at IS NULL ORDER BY p.id LIMIT 1", [COMPANY]).catch(() => null)
    ?? await one('SELECT id FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const committed = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  let order = await SO.createOrder(db, c, { customerId: customer.id, committedDate: committed, notes: `Cut from scenario ${tag}` });
  order = await SO.addOrderLine(db, c, order.id, { recordId: truss.id, quantity: 2, committedDate: committed });
  const line = order.lines.find((l) => l.designId === truss.id || l.design?.id === truss.id) ?? order.lines[order.lines.length - 1];
  ok(`order ${order.code} with line ${line.lineNo}: the truss ×2`, !!line?.id);
  const LINE = line.id;
  const rootItem = await one('SELECT m.id, m.code, m.short_name, m.name FROM cf_sales_order_lines l JOIN cf_master_records m ON m.id = l.item_id WHERE l.id = ?', [LINE]);
  console.log('    the line item:', JSON.stringify(rootItem));
  const parts = await all(
    `SELECT m.id, l.role, d2.code AS defCode FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.owner_order_line_id = ?
       JOIN cf_bom_lines l ON l.child_id = m.id AND l.deleted_at IS NULL
       LEFT JOIN cf_master_records d2 ON d2.id = i.source_definition_id
      WHERE m.deleted_at IS NULL AND l.role IS NOT NULL`,
    [LINE],
  );
  const part = (role) => parts.find((p) => p.role === role)?.id;
  ok('the line minted one part per row', ROWS.every(([, , role]) => part(role)), JSON.stringify(parts.map((p) => p.role)));

  /* ---------------------------------------------------------------- 2. values */
  section('2. Values: plate sizes; bracing sections and lengths');
  const PLATES = {
    'Top chord flange': [16, 5800, 300, 'E350'], 'Main web': [12, 5800, 900, 'E350'], Stiffener: [12, 880, 140, 'E350'],
    Gusset: [12, 450, 400, 'E350'], 'Bearing pad': [20, 400, 300, 'E350'],
  };
  for (const [role, [t, l, w, g]] of Object.entries(PLATES)) {
    await V.setValues(db, c, 'master', part(role), [{ specCode: 'THICKNESS', value: t }, { specCode: 'LENGTH', value: l }, { specCode: 'WIDTH', value: w }, { specCode: 'GRADE', value: g }, { specCode: 'IMPACT_CLASS', value: 'BO' }]);
  }
  // Sections: X-frame top on a 6 m ISA 75; X-frame bottom on a 9 m ISA 75 at the SAME length (they pool);
  // the diagonal takes its definition's default; bracing on ISA 65; the cross beam on ISMB 200.
  await MR.updateRecord(db, c, part('X-frame top'), { cutStockId: stock.A75_6.id });
  await MR.updateRecord(db, c, part('X-frame bottom'), { cutStockId: stock.A75_9.id });
  await MR.updateRecord(db, c, part('Side bracing'), { cutStockId: stock.A65_6.id });
  await MR.updateRecord(db, c, part('Cross beam'), { cutStockId: stock.MB200.id });
  const LENGTHS = { 'X-frame top': 2900, 'X-frame bottom': 2900, 'X-frame diagonal': 3400, 'Side bracing': 1750, 'Cross beam': 5800 };
  for (const [role, l] of Object.entries(LENGTHS)) await V.setValues(db, c, 'master', part(role), [{ specCode: 'LENGTH', value: l }]);
  // Part function is required on parts; the new definitions carry none yet, so each part says its own here.
  const FUNCTION = { 'Top chord flange': 'TOP_FLANGE', 'Main web': 'WEB', Stiffener: 'INTERMEDIATE_STIFFENER', Gusset: 'COVER_PLATE', 'Bearing pad': 'PAD_PLATE',
    'X-frame top': 'SPLICE_PLATE', 'X-frame diagonal': 'SPLICE_PLATE', 'X-frame bottom': 'SPLICE_PLATE', 'Side bracing': 'SPLICE_PLATE', 'Cross beam': 'SPLICE_PLATE' };
  for (const [role, fn] of Object.entries(FUNCTION)) await V.setValues(db, c, 'master', part(role), [{ specCode: 'PART_FUNCTION', value: fn }]).catch(() => {});
  // A value save from the screen refreshes the line's cut pieces (routes do it); so does this.
  const refreshed = await CUT.refreshCutPieces(db, c, LINE);
  console.log('    refresh after the values:', refreshed.reason, refreshed.message);
  const diag = await MR.getRecord?.(db, COMPANY, part('X-frame diagonal')).catch(() => null);
  if (diag?.cutStock) ok('the diagonal follows its definition\'s section', diag.cutStock.from === 'definition' && diag.cutStock.effective?.id === stock.A75_6.id, JSON.stringify(diag.cutStock));
  const weightOf = async (id) => Number((await one("SELECT v.value_number AS w FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'WEIGHT' WHERE v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL", [id]))?.w ?? 0);
  const areaOf = async (id) => Number((await one("SELECT v.value_number AS a FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'SECTION_AREA' WHERE v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL", [id]))?.a ?? 0);
  const a75 = await areaOf(part('X-frame top'));
  ok('a bracing takes its bar\'s section area', a75 > 0, String(a75));
  const w = await weightOf(part('X-frame top'));
  ok(`…and weighs section area × length × density (${w.toFixed(2)} kg)`, Math.abs(w - (a75 * 2900 * 7850) / 1e9) < 0.05, `${w} vs ${(a75 * 2900 * 7850) / 1e9}`);

  // Anything else the freeze still asks for (required values the design leaves open) is filled here.
  let plan = await LOCK.lockPlan(db, COMPANY, LINE);
  const valuesCheck = plan.checks.find((x) => x.key === 'values');
  if (valuesCheck && !valuesCheck.ok) console.log('    values still open:', JSON.stringify(valuesCheck.problems ?? valuesCheck.detail).slice(0, 500));

  /* ---------------------------------------------------------------- 3. cut pieces */
  section('3. Cut pieces — plates and sections');
  await CUT.refreshCutPieces(db, c, LINE);
  const cp = await CUT.getCutPlates(db, COMPANY, LINE);
  const plateBlanks = cp.cutPlates.filter((b) => (b.kind ?? 'plate') === 'plate');
  const sectionBlanks = cp.cutPlates.filter((b) => b.kind === 'section');
  ok(`five cut plates, one per plate shape (${plateBlanks.length})`, plateBlanks.length === 5, JSON.stringify(plateBlanks.map((b) => b.code)));
  ok(`four cut sections (${sectionBlanks.length}): X-frame top and bottom share one (same profile, same length)`, sectionBlanks.length === 4,
    JSON.stringify(sectionBlanks.map((b) => [b.code, b.section?.code, b.lengthMm])));
  const shared = sectionBlanks.find((b) => Number(b.lengthMm) === 2900);
  ok('the shared cut section serves both parts', (shared?.parts ?? []).length === 2 || (shared?.partCount ?? 0) === 2, JSON.stringify(shared?.parts ?? shared));
  ok('no bracing got a cut plate', !plateBlanks.some((b) => (b.parts ?? []).some((p) => /X-frame|Side bracing|Cross beam/.test(p.role ?? p.name ?? ''))));
  ok('every cut piece has a code', cp.cutPlates.every((b) => b.code));
  console.log('    cut piece codes:', cp.cutPlates.map((b) => b.code).join('  '));

  /* ---------------------------------------------------------------- 4. confirm + freeze */
  section('4. Confirm and freeze — the codes');
  await SO.setOrderStatus(db, c, order.id, 'confirmed').catch((e) => ok('confirm', false, say(e)));
  plan = await LOCK.lockPlan(db, COMPANY, LINE);
  const blocking = plan.checks.filter((x) => x.applies && !x.ok && !x.warning);
  ok('nothing stops the freeze', blocking.length === 0, JSON.stringify(blocking.map((x) => [x.key, x.detail, (x.problems ?? []).slice(0, 3)])));
  const frozen = await LOCK.lockLine(db, c, LINE).catch((e) => { ok('lockLine', false, say(e)); return null; });
  ok(`frozen: ${frozen?.locked?.pieces ?? 0} pieces coded`, !!frozen?.locked?.at);
  const pieces = await all('SELECT id, code, item_id, parent_id FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  const codes = pieces.map((p) => p.code);
  ok(`every piece has a code (${pieces.length})`, pieces.length > 0 && codes.every(Boolean));
  ok('no code twice', new Set(codes).size === codes.length, codes.filter((x, i) => codes.indexOf(x) !== i).slice(0, 5).join(', '));
  const places = await cutPlaces(db, COMPANY);
  const blankIds = new Set((await all(`SELECT m.id, m.classification_id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ? AND m.deleted_at IS NULL`, [LINE]))
    .filter((r) => places.section.blanksIds.has(Number(r.classification_id))).map((r) => r.id));
  const sectionPieces = pieces.filter((p) => blankIds.has(p.item_id));
  ok(`cut sections are pieces with codes (${sectionPieces.length})`, sectionPieces.length > 0 && sectionPieces.every((p) => p.code));
  console.log('    sample codes:', [...pieces.slice(0, 4), ...sectionPieces.slice(0, 3)].map((p) => p.code).join('  '));

  /* ---------------------------------------------------------------- 5. plate nesting */
  section('5. Plate nesting');
  await NEST.setNestPlates(db, c, LINE, { plates: 'any' });
  const pplan = await NEST.planNesting(db, COMPANY, LINE, {});
  await NEST.acceptNesting(db, c, LINE, pplan).catch((e) => ok('accept plate nest', false, say(e)));
  let nest = await NEST.getNesting(db, COMPANY, LINE);
  const plateLots = await all("SELECT id, lot_no, plate_item_id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'plate' AND deleted_at IS NULL", [COMPANY, LINE]);
  ok(`plates nested on ${plateLots.length} lots`, plateLots.length > 0);
  const [[cover]] = await db.query(
    `SELECT COUNT(*) AS placed FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE l.order_line_id = ? AND l.kind = 'plate' AND l.deleted_at IS NULL AND p.deleted_at IS NULL`, [LINE]);
  const needPlates = (PLATES ? Object.entries({ 'Top chord flange': 2, 'Main web': 1, Stiffener: 6, Gusset: 4, 'Bearing pad': 2 }).reduce((t, [, q]) => t + q * 2, 0) : 0);
  ok(`every plate piece placed (${cover.placed} of ${needPlates})`, Number(cover.placed) === needPlates);

  /* ---------------------------------------------------------------- 6. section nesting */
  section('6. Section nesting');
  const splan = await SNEST.planSectionNesting(db, COMPANY, LINE);
  ok(`${splan.profiles.length} profiles to nest (ISA 75, ISA 65, ISMB 200)`, splan.profiles.length === 3, JSON.stringify(splan.profiles.map((p) => p.label)));
  const acc = await SNEST.acceptSectionNesting(db, c, LINE).catch((e) => { ok('accept section nest', false, say(e)); return null; });
  let sview = await SNEST.getSectionNesting(db, COMPANY, LINE);
  ok('the section nest is accepted', sview.accepted === true);
  const settings = sview.settings;
  for (const p of sview.profiles) {
    const need = new Map(p.pieces.map((x) => [x.cutPieceId, x.quantity]));
    const got = new Map();
    let fits = true;
    for (const b of p.plan?.bars ?? []) {
      for (const cut of b.cuts) got.set(cut.cutPieceId, (got.get(cut.cutPieceId) ?? 0) + 1);
      const lay = barLayout(b.lengthMm, b.cuts.map((x) => x.lengthMm), settings);
      if (!lay || lay.fits === false || lay.ok === false) fits = false;
    }
    ok(`${p.label}: every piece on a bar, exactly (${[...got.values()].reduce((a, x) => a + x, 0)} cuts on ${p.plan?.bars.length ?? 0} bars, waste ${p.plan?.wastePct?.toFixed?.(1) ?? p.plan?.wastePct}%)`,
      [...need].every(([id, q]) => got.get(id) === q) && got.size === need.size, JSON.stringify({ need: [...need], got: [...got] }));
    ok(`${p.label}: every bar holds its cuts with kerf and trim`, fits);
  }
  const barLots = await all("SELECT id, lot_no, plate_item_id, length_mm FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'bar' AND deleted_at IS NULL", [COMPANY, LINE]);
  ok(`bars written as lots (${barLots.length})`, barLots.length > 0);
  nest = await NEST.getNesting(db, COMPANY, LINE);
  ok('plate nesting is untouched by the section nest', (await all("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'plate' AND deleted_at IS NULL", [COMPANY, LINE])).length === plateLots.length);

  /* ---------------------------------------------------------------- 7. plate sheet round trip */
  section('7. Plate nest: download, rewrite very differently, upload');
  const readBook = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
  const pOut = await NSHEET.exportSheet(db, COMPANY, LINE);
  const pBuf = pOut.buffer ?? pOut.file ?? pOut;
  const pBook = await readBook(Buffer.isBuffer(pBuf) ? pBuf : Buffer.from(pBuf));
  const ws = pBook.getWorksheet(NSHEET.NESTS_SHEET);
  const headerRow = [...Array(12).keys()].map((i) => ws.getRow(i + 1)).find((r) => (r.values ?? []).some((v) => String(v ?? '').trim() === 'Cut plate'));
  const col = Object.fromEntries((headerRow.values ?? []).map((v, i) => [String(v ?? '').trim(), i]).filter(([k]) => k));
  const sheetRows = [];
  for (let r = headerRow.number + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cutPlate = String(row.getCell(col['Cut plate']).value ?? '').trim();
    if (!cutPlate) continue;
    sheetRows.push({ nest: String(row.getCell(col.Nest).value ?? ''), plate: String(row.getCell(col.Plate).value ?? ''), cutPlate, qty: Number(row.getCell(col.Qty).value), grade: String(row.getCell(col.Grade).value ?? '') });
  }
  ok(`the downloaded sheet lists the nest (${sheetRows.length} rows)`, sheetRows.length > 0);
  // Very different: ONE cut plate shape per nest, each on a plate of its own — the smallest catalog
  // plate of the right thickness and grade that holds all its pieces in one row along the length.
  const totals = new Map();
  for (const r of sheetRows) totals.set(r.cutPlate, (totals.get(r.cutPlate) ?? 0) + r.qty);
  const blankSize = new Map(plateBlanks.map((b) => [b.code, b]));
  const catalog = await all(
    `SELECT m.code,
            MAX(CASE WHEN s.code = 'THICKNESS' THEN v.value_number END) AS t,
            MAX(CASE WHEN s.code = 'LENGTH' THEN v.value_number END) AS l,
            MAX(CASE WHEN s.code = 'WIDTH' THEN v.value_number END) AS w,
            MAX(CASE WHEN s.code = 'GRADE' THEN o.value END) AS g
       FROM cf_master_records m
       JOIN cf_spec_values v ON v.subject_type = 'master' AND v.subject_id = m.id AND v.deleted_at IS NULL
       JOIN cf_specifications s ON s.id = v.specification_id
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE m.company_id = ? AND m.classification_id IN (?) AND m.deleted_at IS NULL AND m.status = 'active'
      GROUP BY m.id, m.code`,
    [COMPANY, [...places.plate.stockIds]],
  );
  const newRows = [];
  let n = 0;
  for (const [code, qty] of totals) {
    const b = blankSize.get(code);
    const t = Number(b?.size?.thickness ?? b?.thickness), L = Number(b?.size?.length ?? b?.length), W = Number(b?.size?.width ?? b?.width);
    const g = String(b?.size?.grade ?? b?.grade ?? '');
    const fit = catalog.filter((p) => Number(p.t) === t && (!g || String(p.g) === g) && Number(p.w) >= W + 120 && Number(p.l) >= L + 150)
      .sort((a, x) => a.l * a.w - x.l * x.w);
    // Pieces per plate: as many lengths as fit along the plate (with a generous 40 mm per cut), then rows across.
    const plate = fit[0];
    if (!plate) { newRows.push({ nest: `MAN-${++n}`, plate: `${t} x ${L + 200} x ${W + 200}`, cutPlate: code, qty, grade: g }); continue; }
    const along = Math.max(1, Math.floor((Number(plate.l) - 100) / (L + 40)));
    const across = Math.max(1, Math.floor((Number(plate.w) - 100) / (W + 40)));
    let left = qty;
    while (left > 0) { const k = Math.min(left, along * across); newRows.push({ nest: `MAN-${++n}`, plate: plate.code, cutPlate: code, qty: k, grade: g }); left -= k; }
  }
  ok(`rewritten as ${newRows.length} single-shape nests (was ${new Set(sheetRows.map((r) => r.nest)).size} nests)`, newRows.length > 0);
  for (let r = ws.rowCount; r > headerRow.number; r--) ws.spliceRows(r, 1);
  newRows.forEach((r, i) => {
    const row = ws.getRow(headerRow.number + 1 + i);
    row.getCell(col.Nest).value = r.nest; row.getCell(col.Plate).value = r.plate; row.getCell(col['Cut plate']).value = r.cutPlate;
    row.getCell(col.Qty).value = r.qty; row.getCell(col.Grade).value = r.grade; row.commit();
  });
  const pFile = (await pBook.xlsx.writeBuffer()).toString('base64');
  const pDry = await NSHEET.importSheet(db, c, LINE, { file: pFile, dryRun: true });
  ok('the upload preview reads every row', (pDry.problems ?? []).length === 0, JSON.stringify(pDry.problems).slice(0, 600));
  ok('every rewritten nest fits our cutting rules', (pDry.nests ?? []).every((x) => x.verdict === 'fits' || x.verdict === 'tight'), JSON.stringify((pDry.nests ?? []).map((x) => [x.name ?? x.nest, x.verdict, x.reasons])).slice(0, 600));
  ok('preview: it can be saved', pDry.canSave === true);
  const pSaved = await NSHEET.importSheet(db, c, LINE, { file: pFile, dryRun: false, force: !!pDry.needsForce });
  ok('saved', pSaved.applied === true, JSON.stringify(pSaved).slice(0, 400));
  const lotsAfter = await all("SELECT lot_no FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'plate' AND deleted_at IS NULL", [COMPANY, LINE]);
  ok(`the line now holds the uploaded nests (${lotsAfter.length} lots)`, lotsAfter.length === newRows.length, `${lotsAfter.length} vs ${newRows.length}`);
  ok('…and the bars were not touched by the plate upload', (await all("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'bar' AND deleted_at IS NULL", [COMPANY, LINE])).length === barLots.length);

  /* ---------------------------------------------------------------- 8. section sheet round trip */
  section('8. Section nest: download, rewrite very differently, upload');
  const sOut = await SSHEET.exportSectionSheet(db, COMPANY, LINE);
  const sBuf = sOut.buffer ?? sOut.file ?? sOut;
  const sBook = await readBook(Buffer.isBuffer(sBuf) ? sBuf : Buffer.from(sBuf));
  const bars = sBook.getWorksheet('Bars') ?? sBook.worksheets[0];
  const bHeader = [...Array(12).keys()].map((i) => bars.getRow(i + 1)).find((r) => (r.values ?? []).some((v) => String(v ?? '').trim() === 'Cut piece code'));
  const bcol = Object.fromEntries((bHeader.values ?? []).map((v, i) => [String(v ?? '').trim(), i]).filter(([k]) => k));
  const cuts = [];
  for (let r = bHeader.number + 1; r <= bars.rowCount; r++) {
    const row = bars.getRow(r);
    const code = String(row.getCell(bcol['Cut piece code']).value ?? '').trim();
    if (code) cuts.push({ code, length: Number(row.getCell(bcol.Length).value), stock: String(row.getCell(bcol['Stock code']).value ?? '') });
  }
  ok(`the downloaded bars sheet lists every cut (${cuts.length})`, cuts.length === sview.profiles.reduce((t, p) => t + p.pieces.reduce((a, x) => a + x.quantity, 0), 0));
  // Very different: every profile on its SHORTEST stock bar that holds its longest piece, filled longest-first.
  const newBars = [];
  for (const p of sview.profiles) {
    const maxPiece = Math.max(...p.pieces.map((x) => x.lengthMm));
    const longest = [...p.stockLengths].filter((x) => x.lengthMm - 2 * settings.endTrimMm >= maxPiece).sort((a, x) => a.lengthMm - x.lengthMm)[0];
    const list = p.pieces.flatMap((x) => Array.from({ length: x.quantity }, () => ({ code: x.code, length: x.lengthMm }))).sort((a, x) => x.length - a.length);
    let bar = null;
    for (const piece of list) {
      const usable = longest.lengthMm - 2 * settings.endTrimMm;
      const used = bar ? bar.cuts.reduce((t, x) => t + x.length, 0) + bar.cuts.length * settings.sawKerfMm : 0;
      if (!bar || used + piece.length > usable) { bar = { name: `M${newBars.length + 1}`, stock: longest.code, lengthMm: longest.lengthMm, cuts: [] }; newBars.push(bar); }
      bar.cuts.push(piece);
    }
  }
  ok(`rewritten onto ${newBars.length} bars of ${[...new Set(newBars.map((b) => b.lengthMm))].join(' / ')} mm (was ${sview.profiles.reduce((t, p) => t + (p.plan?.bars.length ?? 0), 0)} bars)`, newBars.length > 0);
  for (let r = bars.rowCount; r > bHeader.number; r--) bars.spliceRows(r, 1);
  let rowNo = bHeader.number + 1;
  for (const b of newBars) b.cuts.forEach((cut, i) => {
    const row = bars.getRow(rowNo++);
    row.getCell(bcol.Bar).value = b.name; if (bcol.Source) row.getCell(bcol.Source).value = 'catalog';
    row.getCell(bcol['Stock code']).value = b.stock; if (bcol['Bar length']) row.getCell(bcol['Bar length']).value = b.lengthMm;
    if (bcol.Seq) row.getCell(bcol.Seq).value = i + 1;
    row.getCell(bcol['Cut piece code']).value = cut.code; row.getCell(bcol.Length).value = cut.length; row.commit();
  });
  const sFile = (await sBook.xlsx.writeBuffer()).toString('base64');
  const sDry = await SSHEET.importSectionSheet(db, c, LINE, { file: sFile, dryRun: true });
  ok('the bars upload preview has no problems', (sDry.problems ?? []).length === 0, JSON.stringify(sDry.problems).slice(0, 600));
  ok('every cut piece covered exactly', (sDry.coverage ?? []).every((x) => x.needed === x.placed), JSON.stringify(sDry.coverage));
  ok('preview: it can be saved', sDry.canSave === true);
  const sSaved = await SSHEET.importSectionSheet(db, c, LINE, { file: sFile, dryRun: false, force: !!sDry.needsForce });
  ok('saved', sSaved.applied === true, JSON.stringify(sSaved).slice(0, 400));
  sview = await SNEST.getSectionNesting(db, COMPANY, LINE);
  const barsNow = sview.profiles.flatMap((p) => p.plan?.bars ?? []);
  ok(`the line now holds the uploaded bars (${barsNow.length})`, barsNow.length === newBars.length && barsNow.every((b) => newBars.some((x) => x.stock === b.itemCode)), `${barsNow.length} vs ${newBars.length}`);
  ok('…and the plate nests were not touched by the bar upload', (await all("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'plate' AND deleted_at IS NULL", [COMPANY, LINE])).length === newRows.length);
  // A broken sheet is refused: one cut missing.
  const bad = await readBook(Buffer.from(sFile, 'base64'));
  const badWs = bad.getWorksheet('Bars') ?? bad.worksheets[0];
  badWs.spliceRows(bHeader.number + 1, 1);
  const badDry = await SSHEET.importSectionSheet(db, c, LINE, { file: (await bad.xlsx.writeBuffer()).toString('base64'), dryRun: true });
  ok('a sheet with a cut missing cannot be saved', badDry.canSave === false, JSON.stringify(badDry).slice(0, 300));

  /* ---------------------------------------------------------------- 9. buying */
  section('9. Buying');
  const short = await PF.orderShortfall(db, COMPANY, order.id);
  const buy = new Map(short.map((r) => [r.item.code ?? r.item.id, r.toBuy]));
  ok(`the buy list asks for the bars (${[...buy.keys()].filter((k) => /^IS[AM]/.test(String(k))).join(', ')})`, [...buy.keys()].some((k) => /^ISA-75X75X8/.test(String(k))) && [...buy.keys()].some((k) => /^ISMB-200/.test(String(k))), JSON.stringify([...buy]));
  ok('…in whole bars', short.filter((r) => /^IS/.test(String(r.item.code))).every((r) => Number.isInteger(Number(r.toBuy))), JSON.stringify(short.map((r) => [r.item.code, r.toBuy])));
  ok('…and the plates', [...buy.keys()].some((k) => /^PL-/.test(String(k))), JSON.stringify([...buy.keys()]));
  const po = await PF.requestFromOrder(db, c, order.id, {}).catch((e) => { ok('raise the purchase order', false, say(e)); return null; });
  ok(`purchase order raised (${po?.code ?? po?.order?.code ?? '?'})`, !!po);

  /* ---------------------------------------------------------------- 10. release */
  section('10. Release to production');
  const check = await REL.releaseCheck(db, COMPANY, LINE);
  ok('release check passes', (check.problems ?? []).length === 0, JSON.stringify(check.problems).slice(0, 600));
  // Finished work needs a dispatch area; the local copy has none, so one is made for this run.
  if (!(await one("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'dispatch' AND status = 'active' AND deleted_at IS NULL", [COMPANY]))) {
    await db.query("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, 'Dispatch yard', 'dispatch', 'active')", [COMPANY, `DISP-${tag}`]);
  }
  const rel = await REL.releaseLine(db, c, LINE, {}).catch((e) => { ok('release', false, say(e)); return null; });
  if (rel) {
    const items = await all('SELECT pi.code, pi.order_piece_id FROM cf_production_items pi JOIN cf_production_releases r ON r.id = pi.release_id WHERE r.order_line_id = ? AND pi.deleted_at IS NULL AND r.deleted_at IS NULL', [LINE]);
    const tcodes = items.map((x) => x.code);
    ok(`the tracker holds ${items.length} items`, items.length > 0);
    ok('no tracker code twice', new Set(tcodes).size === tcodes.length);
    const byPiece = new Map(pieces.map((p) => [p.id, p.code]));
    ok('tracker codes are the frozen piece codes', items.filter((x) => x.order_piece_id).every((x) => byPiece.get(x.order_piece_id) === x.code));
    ok('the cut sections are in the tracker', sectionPieces.every((p) => items.some((x) => x.order_piece_id === p.id)));
    const reqs = await all('SELECT m.code, SUM(q.quantity) AS q FROM cf_material_requirements q JOIN cf_master_records m ON m.id = q.item_id JOIN cf_production_releases r ON r.id = q.release_id WHERE r.order_line_id = ? AND q.deleted_at IS NULL GROUP BY m.code', [LINE]).catch(() => []);
    if (reqs.length) ok(`material needed: ${reqs.map((r) => `${r.code} ×${Number(r.q)}`).join(', ').slice(0, 200)}`, reqs.some((r) => /^IS/.test(r.code)) && reqs.some((r) => /^PL-/.test(r.code)));
  }

  /* ---------------------------------------------------------------- 11. definitions */
  section('11. Every template definition answers Cut from, and it fits where it is filed');
  const allDefs = await all(
    `SELECT m.id, m.code, m.name, n.code AS node, p.code AS parent
       FROM cf_master_records m JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template'
       LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id LEFT JOIN cf_classification_nodes p ON p.id = n.parent_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.code NOT LIKE ?`, [COMPANY, `${tag}%`]);
  const det = await cutFromDetailOf(db, COMPANY, allDefs.map((d) => d.id));
  const expect = (d) => (d.node === 'PLATE_PART' ? 'PLATE' : d.node === 'PROFILE_PART' ? 'SECTION' : 'NONE');
  const wrong = allDefs.filter((d) => det.get(d.id)?.value !== expect(d));
  const notOwn = allDefs.filter((d) => det.get(d.id)?.source !== 'own');
  ok(`${allDefs.length} definitions: each answers as its kind (plate parts Plate, profile parts Section, the rest Not cut)`, wrong.length === 0, wrong.map((d) => `${d.code}=${det.get(d.id)?.value}`).join(', '));
  ok('…and each answers for itself (not through its classification)', notOwn.length === 0, notOwn.map((d) => d.code).join(', '));
} catch (e) {
  failed++;
  console.error('  ERROR', say(e), e.stack?.split('\n').slice(1, 4).join(' | '));
} finally {
  if (KEEP && failed === 0) { await db.commit(); console.log('\nCOMMITTED — the order stays for a look in the app'); } else { await db.rollback(); console.log('\nrolled back'); }
  db.release();
  console.log(`${passed} passed, ${failed} failed`);
  await pool.end();
}
