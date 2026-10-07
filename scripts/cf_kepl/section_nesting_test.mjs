/**
 * section_nesting_test.mjs — section cut pieces laid out on stock bars, end to
 * end on the local database (services/sectionNestingService.js,
 * sectionSheetService.js, the ledger's bar cut, the planner's bar share;
 * CF_ERP_CUT_FROM_PLAN.md §4, §11.3).
 *
 *   cd multi_app_be && node scripts/cf_kepl/section_nesting_test.mjs
 *
 * FIXTURE (one transaction, rolled back; every cf_ table re-counted at the end):
 * three section blanks hung under girder G1 of the frozen KEPL line 923 (line
 * quantity 2, G1 once per line → G1 × 2), each with ONE stock line to a real
 * local stock bar, as Backend A's derive files them:
 *   SB1  2900 mm  ×3 under G1 → 6 pieces   ISA 75 x 75 x 10 E350 BO (6 m bar named)
 *   SB2  1450 mm  ×2 under G1 → 4 pieces   the same section
 *   SB3  5000 mm  ×1 under G1 → 2 pieces   Channel 100 x 50 x 5 E250 BO (6 m bar named)
 * Line 923 is never released here; its 120 plate lots must come through
 * untouched. A second, hand-built release on its own order line tests the
 * ledger's bar cut, as production_ledger_test does for plates.
 */
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { cutPlaces } from '../../apps/cf_erp/lib/cutPlaces.js';
import {
  getSectionNesting, planSectionNesting, acceptSectionNesting, takeBackSectionNesting, sectionNestingState,
} from '../../apps/cf_erp/services/sectionNestingService.js';
import { exportSectionSheet, importSectionSheet } from '../../apps/cf_erp/services/sectionSheetService.js';
import { barLayout } from '../../apps/cf_erp/services/sectionPacker.js';
import { getNesting } from '../../apps/cf_erp/services/nestingService.js';
import { getPlanner } from '../../apps/cf_erp/services/plannerService.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { createItem } from '../../apps/cf_erp/services/masterRecordService.js';
import { postMovement } from '../../apps/cf_erp/services/stockService.js';
import { ledgerOnSteps, WIP_AREA_CODE } from '../../apps/cf_erp/services/productionLedgerService.js';
import { listOffcuts } from '../../apps/cf_erp/services/wipStockService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = 2;
const LINE = 923;
const G1 = 6097;
const tag = `SNT${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, isAdmin: true };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const places = await cutPlaces(db, COMPANY);
  const S = places.settings;
  ok('section places are set locally (blanks, offcuts, stock)', !!places.section.blanksNodeId && !!places.section.offcutNodeId && places.section.stockNodeIds.length > 0);

  // ---- stock -------------------------------------------------------------------
  const stockOf = async (like) => {
    const [rows] = await db.query(
      `SELECT m.id, m.code, v.value_number AS len FROM cf_master_records m
         JOIN cf_spec_values v ON v.subject_type = 'master' AND v.subject_id = m.id AND v.deleted_at IS NULL
         JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'LENGTH'
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' AND m.name LIKE ? ORDER BY v.value_number`, [COMPANY, like]);
    return new Map(rows.map((r) => [Number(r.len), { id: r.id, code: r.code }]));
  };
  const ISA = await stockOf('ISA 75 x 75 x 10 x % E350 BO');
  const CHAN = await stockOf('Channel 100 x 50 x 5 x % E250 BO');
  ok(`ISA 75 x 75 x 10 E350 BO comes in ${ISA.size} stock lengths, the channel in ${CHAN.size}`, ISA.size >= 2 && CHAN.size >= 1 && ISA.has(6000));
  const chanBar = CHAN.get(12000) ?? [...CHAN.values()].pop();
  const chanLen = [...CHAN.entries()].find(([, v]) => v.id === chanBar.id)[0];

  // ---- fixture: three section blanks under G1 -----------------------------------
  const spec = async (code) => (await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]))[0][0]?.id;
  const [sLen, sArea, sDens, sWidth] = [await spec('LENGTH'), await spec('SECTION_AREA'), await spec('DENSITY'), await spec('WIDTH')];
  const [[g1Bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, G1]);
  const [[{ topLine }]] = await db.query('SELECT COALESCE(MAX(line_no), 0) AS topLine FROM cf_bom_lines WHERE company_id = ? AND bom_id = ? AND deleted_at IS NULL', [COMPANY, g1Bom.id]);
  let nextLine = Number(topLine);
  const blankOf = async (key, lengthMm, stock, stockLen, qty, area, width) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status) VALUES (?, 'item', ?, ?, 'CUTSEC', ?, 'draft')",
      [COMPANY, `${tag}-${key}`, `${tag} ${key}`, places.section.blanksNodeId]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id) VALUES (?, ?, 'temporary', 'quantity', 'nos', 'make', ?)", [id, COMPANY, LINE]);
    for (const [s, v] of [[sLen, lengthMm], [sArea, area], [sDens, 7850], [sWidth, width]]) {
      await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, s, id, v]);
    }
    const bom = await ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'draft')", [COMPANY, id]);
    const line = await ins("INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, role, quantity) VALUES (?, ?, 10, ?, ?, 1, 'Stock bar', ?)",
      [COMPANY, bom, stock.id, stock.id, Number((lengthMm / stockLen).toFixed(6))]);
    nextLine += 10;
    await db.query("INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, role, quantity) VALUES (?, ?, ?, ?, ?, 1, 'Cut from', ?)", [COMPANY, g1Bom.id, nextLine, id, id, qty]);
    return { id, code: `${tag}-${key}`, stockLine: line, lengthMm };
  };
  const SB1 = await blankOf('SB1', 2900, ISA.get(6000), 6000, 3, 1400, 75);
  const SB2 = await blankOf('SB2', 1450, ISA.get(6000), 6000, 2, 1400, 75);
  const SB3 = await blankOf('SB3', 5000, CHAN.get(6000) ?? chanBar, CHAN.get(6000) ? 6000 : chanLen, 1, 712, 50);
  const stockLines = async (blankId) => (await db.query(
    'SELECT l.id, l.child_id, l.quantity FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL WHERE b.parent_id = ? AND b.deleted_at IS NULL ORDER BY l.id', [blankId]))[0];

  const platesBefore = await getNesting(db, COMPANY, LINE);
  const [[plateLots0]] = await db.query("SELECT COUNT(*) n, COALESCE(SUM(id), 0) s FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [LINE]);

  section('1. The view before anything is accepted');
  const g0 = await getSectionNesting(db, COMPANY, LINE);
  const isaKeyOf = (v) => v.profiles.find((p) => p.pieces.some((x) => x.cutPieceId === SB1.id));
  const chanKeyOf = (v) => v.profiles.find((p) => p.pieces.some((x) => x.cutPieceId === SB3.id));
  ok('GET shows the line, settings, not accepted', g0.line.id === LINE && g0.accepted === false && g0.acceptedAt === null && g0.settings.sawKerfMm === S.sawKerfMm, JSON.stringify(g0.line));
  const isa0 = isaKeyOf(g0);
  ok('SB1 and SB2 share the ISA 75 x 75 x 10 profile', !!isa0 && isa0.pieces.length === 2 && isa0.pieces.some((x) => x.cutPieceId === SB2.id), JSON.stringify(isa0?.pieces));
  ok('...with the line quantity counted once: SB1 6 pieces, SB2 4', isa0?.pieces.find((x) => x.cutPieceId === SB1.id)?.quantity === 6 && isa0?.pieces.find((x) => x.cutPieceId === SB2.id)?.quantity === 4);
  ok('...the part each is cut from named', isa0?.pieces[0].parts.some((p) => /G1$/.test(p)), JSON.stringify(isa0?.pieces[0].parts));
  ok(`...every catalog stock length of it a candidate (${isa0?.stockLengths.length})`, isa0?.stockLengths.length === ISA.size);
  ok('the channel blank is a profile of its own', !!chanKeyOf(g0) && chanKeyOf(g0).key !== isa0.key);
  ok('nothing saved: plan is null', g0.profiles.every((p) => p.plan === null));
  const st0 = await sectionNestingState(db, COMPANY, LINE);
  ok('state: needed, not accepted', st0.needed === true && st0.accepted === false && st0.pieces === 12, JSON.stringify(st0));

  section('2. Plan: a fresh layout, nothing written');
  const [[lotsPre]] = await db.query("SELECT COUNT(*) n FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar'", [LINE]);
  const p1 = await planSectionNesting(db, COMPANY, LINE);
  const isaP = isaKeyOf(p1).plan;
  const chanP = chanKeyOf(p1).plan;
  const placed = (plan) => plan.bars.reduce((a, b) => a + b.cuts.length, 0);
  ok('the ISA plan places all 10 pieces, the channel plan both', placed(isaP) === 10 && placed(chanP) === 2, `${placed(isaP)} ${placed(chanP)}`);
  const legal = (plan) => plan.bars.every((b) => { const l = barLayout(b.lengthMm, b.cuts.map((x) => x.lengthMm), S); return l.fits && b.cuts.every((x, i) => near(x.xMm, l.xs[i], 1e-6)); });
  ok('every bar obeys kerf and trim, cuts where the rule puts them', legal(isaP) && legal(chanP));
  ok('bars are numbered BAR-001… and carry their stock code', [...isaP.bars, ...chanP.bars].every((b) => /^BAR-\d{3}$/.test(b.lotNo) && b.itemCode && b.lotId === null));
  ok('plan totals add up (length, waste %)', near(isaP.totalLengthMm, isaP.bars.reduce((a, b) => a + b.lengthMm, 0)) && near(isaP.wastePct, (isaP.wasteMm / isaP.totalLengthMm) * 100));
  ok(`ISA: 23,200 mm of pieces on ${isaP.barsBought} bar(s), ${isaP.totalLengthMm} mm bought`, isaP.totalLengthMm >= 23200 + 9 * S.sawKerfMm && isaP.totalLengthMm <= 30000);
  const [[lotsPost]] = await db.query("SELECT COUNT(*) n FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar'", [LINE]);
  ok('a plan writes nothing', Number(lotsPre.n) === 0 && Number(lotsPost.n) === 0);

  section('3. Accept: bar lots, placements, offcuts, the real bar count on the BOM');
  const a1 = await acceptSectionNesting(db, c, LINE);
  ok('accept returns the saved view', a1.accepted === true && !!a1.acceptedAt && a1.written.lots === isaP.bars.length + chanP.bars.length, JSON.stringify(a1.written));
  const [lots] = await db.query("SELECT * FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar' ORDER BY lot_no", [LINE]);
  ok(`${lots.length} bar lots, kind bar, origin auto`, lots.length === a1.written.lots && lots.every((l) => l.kind === 'bar' && l.origin === 'auto'));
  const isaIds = new Set([...ISA.values()].map((x) => x.id));
  const isaLots = lots.filter((l) => isaIds.has(l.plate_item_id));
  ok('each ISA lot: the stock bar, its length, thickness 10 and width 75 from the section', isaLots.length > 0 && isaLots.every((l) => near(l.thickness_mm, 10) && near(l.width_mm, 75) && [...ISA.entries()].some(([len, it]) => it.id === l.plate_item_id && near(l.length_mm, len))));
  const [plc] = await db.query('SELECT * FROM cf_nest_placements WHERE plate_lot_id IN (?) AND deleted_at IS NULL ORDER BY plate_lot_id, pos_no', [lots.map((l) => l.id)]);
  ok('12 placements: x = start along the bar, y 0, length = cut, width = section width', plc.length === 12 && plc.every((p) => Number(p.y_mm) === 0)
    && plc.filter((p) => p.cut_plate_id === SB1.id).every((p) => near(p.length_mm, 2900) && near(p.width_mm, 75)));
  const [offs] = await db.query("SELECT * FROM cf_offcuts WHERE plate_lot_id IN (?) AND deleted_at IS NULL", [lots.map((l) => l.id)]);
  const keptBars = [...isaP.bars, ...chanP.bars].filter((b) => b.keptOffcutMm > 0);
  ok(`${offs.length} bar offcut(s) planned for the leftovers ≥ ${S.minOffcutMm} mm`, offs.length === keptBars.length && offs.every((o) => o.kind === 'bar' && o.status === 'planned' && Number(o.length_mm) >= S.minOffcutMm));
  ok('...each with its length, its stock bar, and area = length × width', offs.every((o) => o.stock_item_id && near(o.area_mm2, Number(o.length_mm) * (isaIds.has(o.stock_item_id) ? 75 : 50), 0.01)));
  // The BOM: bars charged to each blank by its share of each bar's cut length.
  const savedIsa = isaKeyOf(a1).plan;
  const charge = new Map();
  for (const b of [...savedIsa.bars, ...chanKeyOf(a1).plan.bars]) {
    const tot = b.cuts.reduce((x, y) => x + y.lengthMm, 0);
    for (const ct of b.cuts) { const k = `${ct.cutPieceId}:${b.itemId}`; charge.set(k, (charge.get(k) ?? 0) + ct.lengthMm / tot); }
  }
  const lines1 = await stockLines(SB1.id);
  const sumBars = async (blank, pieces) => (await stockLines(blank.id)).reduce((a, l) => a + Number(l.quantity) * pieces, 0);
  ok('SB1\'s stock line(s) = its bar share ÷ 6 pieces, per stock item', lines1.every((l) => near(Number(l.quantity) * 6, charge.get(`${SB1.id}:${l.child_id}`) ?? 0, 1e-4)), JSON.stringify(lines1));
  const catalogBars = lots.filter((l) => l.source === 'catalog').length;
  const totalCharged = (await sumBars(SB1, 6)) + (await sumBars(SB2, 4)) + (await sumBars(SB3, 2));
  ok(`the blanks' stock lines add up to the ${catalogBars} bars bought`, near(totalCharged, catalogBars, 1e-3), String(totalCharged));
  const st1 = await sectionNestingState(db, COMPANY, LINE);
  ok('state: needed and accepted', st1.needed && st1.accepted && st1.bars === lots.length, JSON.stringify(st1));

  section('4. GET returns the saved plan');
  const g1 = await getSectionNesting(db, COMPANY, LINE);
  const sig = (v) => JSON.stringify(v.profiles.map((p) => (p.plan?.bars ?? []).map((b) => [b.lotNo, b.itemId, b.lengthMm, b.cuts.map((x) => [x.cutPieceId, x.xMm])])));
  ok('the saved bars read back exactly as accepted (lot ids now set)', sig(g1) === sig(a1) && g1.profiles.every((p) => (p.plan?.bars ?? []).every((b) => b.lotId > 0)));
  ok('no drift problems', g1.problems.length === 0, JSON.stringify(g1.problems));

  section('5. Plate nesting on the same line is untouched');
  const platesAfter = await getNesting(db, COMPANY, LINE);
  const [[plateLots1]] = await db.query("SELECT COUNT(*) n, COALESCE(SUM(id), 0) s FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [LINE]);
  ok(`the ${plateLots0.n} plate lots are the same rows`, plateLots0.n === plateLots1.n && plateLots0.s === plateLots1.s);
  ok('plate nesting reads the same plan (no bar in it)', JSON.stringify(platesAfter.totals) === JSON.stringify(platesBefore.totals)
    && platesAfter.groups.every((gr) => gr.nests.every((n) => !/^BAR-/.test(n.lotNo))));

  section('6. Sheet: export, a different valid layout, preview, save');
  const out = await exportSectionSheet(db, COMPANY, LINE);
  ok('the workbook carries one row per cut of the saved plan', out.rows === 12 && out.bars === lots.length && out.saved === true);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out.buffer);
  const ws = wb.getWorksheet('Bars');
  ok('headers: Bar, Source, Stock code, Bar length, Seq, Cut piece code, Length, Start', ws.getRow(2).values.slice(1, 9).join('|').startsWith('Bar|Source|Stock code|Bar length|Seq|Cut piece code|Length|Start'), ws.getRow(2).values.join('|'));
  const asSheet = async (rows) => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(out.buffer);
    const sh = book.getWorksheet('Bars');
    for (let r = sh.rowCount; r >= 3; r--) sh.spliceRows(r, 1);
    for (const r of rows) sh.addRow(r);
    return (await book.xlsx.writeBuffer()).toString('base64');
  };
  const isa6 = ISA.get(6000).code;
  // Every SB1 on its own 6 m bar; all four SB2 on one (4 × 1450 + 3 kerfs = 5809 ≤ 5980); both SB3 on one channel bar.
  const layout = [
    ...[1, 2, 3, 4, 5, 6].map((i) => [`X${i}`, 'catalog', isa6, 6000, 1, SB1.code, 2900, '']),
    ['Y1', 'catalog', isa6, '', 1, SB2.code, '', ''], ['', '', '', '', 2, SB2.code, 1450, ''], ['', '', '', '', 3, SB2.code, '', ''], ['', '', '', '', 4, SB2.code, '', ''],
    ['Z1', 'catalog', chanBar.code, '', 1, SB3.code, 5000, ''], ['', '', '', '', 2, SB3.code, 5000, ''],
  ];
  const file = await asSheet(layout);
  const dry = await importSectionSheet(db, c, LINE, { file, filename: 'bars.xlsx', dryRun: true });
  ok('dry run: can save, no force needed, no problems', dry.canSave === true && dry.needsForce === false && dry.problems.length === 0 && dry.applied === false, JSON.stringify(dry.problems));
  ok('...coverage: every cut piece placed exactly as needed', dry.coverage.length === 3 && dry.coverage.every((x) => x.placed === x.needed), JSON.stringify(dry.coverage));
  ok('...8 bars previewed, Start worked out (SB2 #2 at 10 + 1450 + 3)', dry.bars.length === 8 && near(dry.bars.find((b) => b.lotNo === 'Y1').cuts[1].xMm, 1463), JSON.stringify(dry.bars.find((b) => b.lotNo === 'Y1')?.cuts));
  const [[stillAuto]] = await db.query("SELECT COUNT(*) n FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar' AND origin = 'auto'", [LINE]);
  ok('...and nothing was written', Number(stillAuto.n) === lots.length);
  const saved = await importSectionSheet(db, c, LINE, { file, filename: 'bars.xlsx', dryRun: false });
  ok('save: applied', saved.applied === true && saved.written.lots === 8, saved.message);
  const [lots2] = await db.query("SELECT l.*, (SELECT COUNT(*) FROM cf_nest_placements p WHERE p.plate_lot_id = l.id AND p.deleted_at IS NULL) AS n FROM cf_plate_lots l WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar' ORDER BY lot_no", [LINE]);
  ok('the saved lots ARE the edited sheet: X1–X6 one piece, Y1 four, Z1 two, all imported',
    lots2.map((l) => `${l.lot_no}:${l.n}`).join(',') === 'X1:1,X2:1,X3:1,X4:1,X5:1,X6:1,Y1:4,Z1:2' && lots2.every((l) => l.origin === 'imported'), lots2.map((l) => `${l.lot_no}:${l.n}`).join(','));
  ok('Z1 is the channel bar, 12 m', lots2.find((l) => l.lot_no === 'Z1').plate_item_id === chanBar.id);
  const l1 = await stockLines(SB1.id);
  ok('SB1 now charges exactly one 6 m bar per piece', l1.length === 1 && near(l1[0].quantity, 1, 1e-6) && l1[0].child_id === ISA.get(6000).id, JSON.stringify(l1));
  const l3 = await stockLines(SB3.id);
  ok('SB3 is repointed to the 12 m channel bar, ½ bar per piece', l3.length === 1 && l3[0].child_id === chanBar.id && near(l3[0].quantity, 0.5, 1e-6), JSON.stringify(l3));

  section('7. An invalid sheet is refused with problems');
  const bad = await asSheet([
    ...[1, 2, 3, 4, 5].map((i) => [`X${i}`, 'catalog', isa6, '', 1, SB1.code, '', '']),         // one SB1 missing
    ['Y1', 'catalog', isa6, '', 1, SB2.code, '', ''], ['', '', '', '', 2, SB2.code, '', ''], ['', '', '', '', 3, SB2.code, '', ''], ['', '', '', '', 4, SB2.code, '', ''],
    ['T1', 'catalog', chanBar.code, '', 1, SB3.code, '', ''], ['', '', '', '', 2, SB3.code, '', ''], ['', '', '', '', 3, SB3.code, '', ''], // 3 × 5000 on 12 m: too long (and over)
    ['W1', 'catalog', chanBar.code, '', 1, SB1.code, '', ''],                                     // an ISA piece on a channel bar
  ]);
  const badDry = await importSectionSheet(db, c, LINE, { file: bad, dryRun: true });
  const words = badDry.problems.join(' | ');
  ok('cannot save', badDry.canSave === false, JSON.stringify(badDry.problems));
  ok('...says a piece is missing', /needs 6 and the sheet places 5/.test(words), words);
  ok('...says a bar is too long for its cuts', /T1 need 15,006 mm/.test(words) && /too long/.test(words), words);
  ok('...says the stock code is the wrong section', /W1/.test(words) && /is not a stock bar of ISA 75 x 75 x 10/.test(words), words);
  const badSave = await importSectionSheet(db, c, LINE, { file: bad, dryRun: false });
  const [[stillImported]] = await db.query("SELECT COUNT(*) n FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar' AND origin = 'imported'", [LINE]);
  ok('a save of it writes nothing', badSave.applied === false && Number(stillImported.n) === 8);

  section('8. Planner: a bar lot is shared out by placement LENGTH');
  // The planner reads an unlocked line's structure from its BOM (a locked one
  // from its rolled-out pieces, which this fixture does not touch).
  const [[lk]] = await db.query('SELECT locked_at FROM cf_sales_order_lines WHERE id = ?', [LINE]);
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [LINE]);
  const pl = await getPlanner(db, COMPANY, {});
  await db.query('UPDATE cf_sales_order_lines SET locked_at = ? WHERE id = ?', [lk.locked_at, LINE]);
  const mats = pl.units.find((u) => u.key === `l${LINE}`)?.materials ?? [];
  const matQty = (id) => mats.find((m) => m.itemId === id)?.qty ?? 0;
  ok('the line draws 7 ISA 6 m bars (6 for SB1, Y1 shared by length among 4 SB2)', near(matQty(ISA.get(6000).id), 7, 1e-3), String(matQty(ISA.get(6000).id)));
  ok('...and 1 channel bar', near(matQty(chanBar.id), 1, 1e-3), String(matQty(chanBar.id)));

  section('9. Offcuts are offered first, claimed at accept, given back on take-back');
  const customer = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${tag}-CUS`, `${tag} customer`]);
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('sales_order', 'stock_movement', 'stock_lot')", [COMPANY]);
  const node = (parentId, depth, key) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')", [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key}`]);
  const famNode = await node(await node(await node(null, 0, 'F'), 1, 'S'), 2, 'V');   // a Variant: items sit there
  const fg = (await createItem(db, c, { classificationId: famNode, code: `${tag}-FG`, name: `${tag} FG`, status: 'active' })).id;
  const so = await createOrder(db, c, { orderType: 'customer', customerId: customer, code: `${tag}-SO`, committedDate: '2099-12-31' });
  const ol = await addOrderLine(db, c, so.id, { recordId: fg, quantity: 1 });
  await setOrderStatus(db, c, so.id, 'confirmed');
  const line2 = ol.lines[0].id;
  const other = { id: line2 };   // the offcuts come from another line's bar
  const srcLot = await ins("INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, source, kind, thickness_mm, length_mm, width_mm) VALUES (?, ?, ?, ?, 'catalog', 'bar', 10, 12000, 75)", [COMPANY, other.id, ISA.get(6000).id, `${tag}-SRC`]);
  const offId = await ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, kind, thickness_mm, grade, area_mm2, length_mm, stock_item_id, status) VALUES (?, ?, ?, ?, 'bar', 10, 'E350', ?, 3000, ?, 'available')",
    [COMPANY, other.id, srcLot, `${tag}-OC`, 3000 * 75, ISA.get(6000).id]);
  const p2 = await planSectionNesting(db, COMPANY, LINE);
  const isa2 = isaKeyOf(p2);
  ok('the ISA profile offers the free 3 m offcut', isa2.offcuts.some((o) => o.offcutId === offId && o.lengthMm === 3000));
  ok('...and the plan cuts from it (it costs nothing)', isa2.plan.barsFromOffcuts === 1 && isa2.plan.bars[0].source === 'offcut' && isa2.plan.bars[0].offcutId === offId, JSON.stringify(isa2.plan.bars[0]));
  await acceptSectionNesting(db, c, LINE);
  const [[offAfter]] = await db.query('SELECT status FROM cf_offcuts WHERE id = ?', [offId]);
  const [[offLot]] = await db.query("SELECT * FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar' AND source = 'offcut'", [LINE]);
  ok('accept: the offcut is claimed (used), its bar lot is source offcut, born of the lot that left it', offAfter.status === 'used' && offLot?.origin_lot_id === srcLot && (typeof offLot.waste_json === 'string' ? JSON.parse(offLot.waste_json) : offLot.waste_json).offcutId === offId);
  ok('the imported sheet bars were replaced, never a plate lot', Number((await db.query("SELECT COUNT(*) n FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'bar' AND origin = 'imported'", [LINE]))[0][0].n) === 0
    && Number((await db.query("SELECT COUNT(*) n FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [LINE]))[0][0].n) === Number(plateLots0.n));

  section('10. Nothing cut yet: take back. Something cut: refused');
  const [[anyOff]] = await db.query("SELECT o.id FROM cf_offcuts o JOIN cf_plate_lots l ON l.id = o.plate_lot_id WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND l.kind = 'bar' AND o.deleted_at IS NULL LIMIT 1", [LINE]);
  if (anyOff) {
    await db.query("UPDATE cf_offcuts SET status = 'available' WHERE id = ?", [anyOff.id]);
    const cutErr = await refusal(() => acceptSectionNesting(db, c, LINE));
    const backErr = await refusal(() => takeBackSectionNesting(db, c, LINE));
    ok('a bar already cut (its offcut made) refuses accept and take-back, in words', cutErr?.code === 'CUT_ON_FLOOR' && backErr?.code === 'CUT_ON_FLOOR' && /already being cut/.test(cutErr.message), cutErr?.message);
    await db.query("UPDATE cf_offcuts SET status = 'planned' WHERE id = ?", [anyOff.id]);
  } else ok('(no kept offcut to test the cut refusal with)', true);
  const back = await takeBackSectionNesting(db, c, LINE);
  const [[offBack]] = await db.query('SELECT status FROM cf_offcuts WHERE id = ?', [offId]);
  ok('take back: no bar lots, the offcut free again', back.accepted === false && offBack.status === 'available');
  const lb = await stockLines(SB1.id);
  ok('...SB1 back to one line at 2900 ÷ stock length', lb.length === 1 && [...ISA.entries()].some(([len, it]) => it.id === lb[0].child_id && near(lb[0].quantity, 2900 / len, 1e-6)), JSON.stringify(lb));
  const notFrozen = await refusal(async () => { await db.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [LINE]); try { await acceptSectionNesting(db, c, LINE); } finally { await db.query('UPDATE cf_sales_order_lines SET locked_at = ? WHERE id = ?', [lk.locked_at, LINE]); } });
  ok('an unfrozen line is refused (NOT_FROZEN)', notFrozen?.code === 'NOT_FROZEN', notFrozen?.message);

  section('11. Ledger: cutting a bar lot makes its section blanks and a bar offcut stock piece');
  const store = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${tag}-ST`, `${tag} store`]);
  const disp = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'dispatch', 'active')", [COMPANY, `${tag}-DS`, `${tag} dispatch`]);
  const bar6 = ISA.get(6000).id;
  // 1 ISA 6 m bar at ₹6,594 (65.94 kg); a bar offcut of 1,800 mm already in stock at ₹500.
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: bar6, quantity: 1, unitCost: 6594, batch: { code: `${tag}-B6` } }] });
  const [[b6]] = await db.query('SELECT id FROM cf_stock_batches WHERE company_id = ? AND code = ?', [COMPANY, `${tag}-B6`]);
  const blankL = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${tag}-LB`, `${tag} LB`, places.section.blanksNodeId]);
  await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'temporary', 'quantity', 'nos', 'make')", [blankL, COMPANY]);
  for (const [s, v] of [[sLen, 1450], [sArea, 1400], [sDens, 7850]]) await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, s, blankL, v]);
  const part = (await createItem(db, c, { classificationId: famNode, code: `${tag}-PART`, name: `${tag} PART`, status: 'active' })).id;
  const [[flow]] = await db.query('SELECT id FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  const [[op]] = await db.query('SELECT id FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity, finished_area_id) VALUES (?, ?, ?, ?, 1, ?)', [COMPANY, so.id, line2, part, disp]);
  const PN = await ins('INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, NULL, ?, 1, ?, ?, 0, 0)', [COMPANY, rel, part, `${tag}-PN`, flow.id]);
  const BN = await ins('INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, 4, ?, ?, 1, 1)', [COMPANY, rel, PN, blankL, `${tag}-BN`, flow.id]);
  const cutStepId = await ins("INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, step_name, quantity) VALUES (?, ?, ?, 10, 'Saw', 4)", [COMPANY, BN, op.id]);
  // Lot A: a catalog 6 m bar, 3 × 1450 (leftover 6000 − 10 − 4350 − 9 = 1631, kept). Lot B: the 1,800 mm offcut, 1 × 1450.
  const lotA = await ins("INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, source, kind, thickness_mm, length_mm, width_mm, density) VALUES (?, ?, ?, 'BAR-001', 'catalog', 'bar', 10, 6000, 75, 7850)", [COMPANY, line2, bar6]);
  for (const [pos, x] of [[1, 10], [2, 1463], [3, 2916]]) await db.query('INSERT INTO cf_nest_placements (company_id, plate_lot_id, cut_plate_id, pos_no, x_mm, y_mm, length_mm, width_mm) VALUES (?, ?, ?, ?, ?, 0, 1450, 75)', [COMPANY, lotA, blankL, pos, x]);
  const keptKg = Number(((1631 * 1400 * 7850) / 1e9).toFixed(3));
  const plannedOff = await ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, kind, thickness_mm, grade, material, density, area_mm2, length_mm, stock_item_id, weight_kg, status) VALUES (?, ?, ?, 'BAR-001-A', 'bar', 10, 'E350', 'MS', 7850, ?, 1631, ?, ?, 'planned')",
    [COMPANY, line2, lotA, 1631 * 75, bar6, keptKg]);
  // The offcut stock piece the second bar is cut from (an OFC item made like the ledger makes one).
  const ofcItem = (await createItem(db, c, { classificationId: famNode, code: `${tag}-OFCSTOCK`, name: `${tag} offcut stock`, status: 'active' })).id;
  await db.query("UPDATE cf_item_details SET tracked_by = 'batch' WHERE master_id = ?", [ofcItem]);
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: ofcItem, quantity: 1, unitCost: 500, batch: { code: `${tag}-OB` } }] });
  const [[ob]] = await db.query('SELECT id FROM cf_stock_batches WHERE company_id = ? AND code = ?', [COMPANY, `${tag}-OB`]);
  const srcOff = await ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, kind, thickness_mm, grade, area_mm2, length_mm, stock_item_id, status, batch_id) VALUES (?, ?, ?, ?, 'bar', 10, 'E350', ?, 1800, ?, 'used', ?)",
    [COMPANY, other.id, srcLot, `${tag}-OC2`, 1800 * 75, bar6, ob.id]);
  const lotB = await ins("INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, source, kind, thickness_mm, length_mm, width_mm, density, waste_json) VALUES (?, ?, ?, 'BAR-002', 'offcut', 'bar', 10, 1800, 75, 7850, ?)",
    [COMPANY, line2, bar6, JSON.stringify({ kind: 'bar', offcutId: srcOff })]);
  await db.query('INSERT INTO cf_nest_placements (company_id, plate_lot_id, cut_plate_id, pos_no, x_mm, y_mm, length_mm, width_mm) VALUES (?, ?, ?, 1, 10, 0, 1450, 75)', [COMPANY, lotB, blankL]);
  const req = await ins('INSERT INTO cf_material_requirements (company_id, release_id, production_item_id, step_id, item_id, bom_line_id, quantity) VALUES (?, ?, ?, ?, ?, NULL, 1)', [COMPANY, rel, BN, cutStepId, bar6]);
  await db.query("INSERT INTO cf_stock_reservations (company_id, requirement_id, item_id, batch_id, quantity, status) VALUES (?, ?, ?, ?, 1, 'active')", [COMPANY, req, bar6, b6.id]);

  await db.query("UPDATE cf_production_steps SET state = 'done', qty_good = 4 WHERE id = ?", [cutStepId]);
  const moved = await ledgerOnSteps(db, c, [cutStepId]);
  ok('the saw step done posts the cut', moved.movements >= 1, JSON.stringify(moved));
  const [[wip]] = await db.query('SELECT id FROM cf_stocking_areas WHERE company_id = ? AND code = ?', [COMPANY, WIP_AREA_CODE]);
  const bal = async (areaId, itemId, batchId) => Number((await db.query('SELECT COALESCE(SUM(quantity), 0) q FROM cf_stock_balances WHERE stocking_area_id = ? AND item_id = ? AND batch_key = ?', [areaId, itemId, batchId ?? 0]))[0][0].q);
  const [[blot]] = await db.query('SELECT * FROM cf_stock_batches WHERE production_item_id = ? ORDER BY id LIMIT 1', [BN]);
  ok('the stock bar left storage', (await bal(store, bar6, b6.id)) === 0);
  ok('the offcut stock piece the second bar came from left storage too', (await bal(store, ofcItem, ob.id)) === 0);
  ok('4 section blanks are in work in progress', !!blot && (await bal(wip.id, blankL, blot.id)) === 4);
  // Weights: blanks 4 × 1400 × 1450 × 7850 / 1e9 = 63.742 kg; bars 65.94 + 19.782 = 85.722 kg; value in 6594 + 500 = 7094.
  const blanksValue = 7094 * (63.742 / 85.722);
  ok(`the blanks carry their weight share of the bars (₹${blanksValue.toFixed(2)})`, near(Number(blot.unit_cost) * 4, blanksValue, 0.5), String(Number(blot.unit_cost) * 4));
  const [[madeOff]] = await db.query('SELECT o.*, b.item_id, b.code AS batch_code, b.notes, b.unit_cost, m.code AS item_code, m.classification_id FROM cf_offcuts o JOIN cf_stock_batches b ON b.id = o.batch_id JOIN cf_master_records m ON m.id = b.item_id WHERE o.id = ?', [plannedOff]);
  ok('the 1,631 mm leftover is now an available offcut stock piece', madeOff?.status === 'available' && (await bal(wip.id, madeOff.item_id, madeOff.batch_id)) === 1);
  ok('...of item OFC-ISA75X75X10-E350BO under the section offcut place', madeOff?.item_code === 'OFC-ISA75X75X10-E350BO' && madeOff.classification_id === places.section.offcutNodeId, `${madeOff?.item_code} ${madeOff?.classification_id}`);
  ok('...its length on the batch', /1631 mm long/.test(madeOff?.notes ?? ''), madeOff?.notes);
  ok('...worth its weight share', near(Number(madeOff.unit_cost), 7094 * (keptKg / 85.722), 0.5), String(madeOff?.unit_cost));
  const listed = await listOffcuts(db, COMPANY, { kind: 'bar', status: 'all' });
  const row = listed.find((o) => o.id === plannedOff);
  ok('the Offcuts list shows it: kind bar, its length and stock bar', row?.kind === 'bar' && row.lengthMm === 1631 && row.stockItem?.id === bar6, JSON.stringify(row ?? null).slice(0, 200));
  ok('a plate-only filter leaves it out', !(await listOffcuts(db, COMPANY, { kind: 'plate', status: 'all' })).some((o) => o.id === plannedOff));
  // Undo while nothing has moved on: everything back.
  await db.query("UPDATE cf_production_steps SET state = 'in_progress' WHERE id = ?", [cutStepId]);
  await ledgerOnSteps(db, c, [cutStepId]);
  ok('undoing the cut puts the bar and the offcut piece back, the leftover planned again',
    (await bal(store, bar6, b6.id)) === 1 && (await bal(store, ofcItem, ob.id)) === 1 && (await bal(wip.id, blankL, blot.id)) === 0
    && (await db.query('SELECT status FROM cf_offcuts WHERE id = ?', [plannedOff]))[0][0].status === 'planned');
} catch (e) {
  failed++;
  console.error('\nCRASHED:', e?.stack ?? e, e?.problems ?? '');
} finally {
  await db.rollback();
  detachNodeCache(db);
  db.release();
  const after = await counts();
  const moved = after.filter((r, i) => Number(r.n) !== Number(before[i].n));
  console.log('');
  ok('every cf_ table is back to its row count after the rollback', moved.length === 0, moved.map((r) => r.name).join(', '));
  const [[l923]] = await pool.query('SELECT (SELECT COUNT(*) FROM cf_production_releases WHERE order_line_id = 923 AND deleted_at IS NULL) AS rel, locked_at FROM cf_sales_order_lines WHERE id = 923');
  ok('line 923 is not released and still frozen', Number(l923.rel) === 0 && !!l923.locked_at);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
