/**
 * cut_from_test.mjs — CUT FROM (CF_ERP_CUT_FROM_PLAN.md, init.sql §48): how a
 * part is cut is its own answer (CUT_FROM: plate | section | not cut), not the
 * classification it is filed under; a SECTION part names the stock bar it is
 * cut from and gets a cut section; the places are Setup › Cutting's, by id.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cut_from_test.mjs
 *   CF_CUT_LINE=923 (default; company 2 — the local copy of the real tenant)
 *
 * ONE TRANSACTION, ROLLED BACK. Line 923 is frozen; inside the transaction it
 * is unfrozen, given section parts (a bracing template filed under Profile
 * part) and worked on; at the end every cf_ table is re-counted and must come
 * back to the count it started at, and line 923 must be frozen again and not
 * released.
 *
 * What it proves:
 *   1. resolution — node default, definition override, item override, NONE
 *   2. plate derive results are unchanged on line 923 (from scratch: the same
 *      rectangles pooled from the same parts, the same codes)
 *   3. a profile part with no section: the freeze check lists it
 *   4. section derive grouping — same section + length share a blank, another
 *      length or another section gets its own; the part takes its bar's steel
 *      and a weight; the blank's stock line is length ÷ stock length; profile
 *      parts never get plate blanks
 *   5. a part switched PLATE -> SECTION lets go of its plate blank
 *   6. cutStockId refuses a non-stock item; GET / PUT /cut-places; /section-stock
 *   7. the tree shows cutFrom / cutStock; a record shows cutFrom / cutStock
 *   8. release: unresolved section stock refused in words, passes when chosen;
 *      bars bought whole before nesting, by placement length after; valuation
 *      weighs a cut section by its bar
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import * as CUT from '../../apps/cf_erp/services/cutPlateService.js';
import * as MR from '../../apps/cf_erp/services/masterRecordService.js';
import * as B from '../../apps/cf_erp/services/bomService.js';
import * as V from '../../apps/cf_erp/services/valueService.js';
import * as LOCK from '../../apps/cf_erp/services/lockService.js';
import * as REL from '../../apps/cf_erp/services/releaseService.js';
import * as VAL from '../../apps/cf_erp/services/valuationService.js';
import * as FLOWS from '../../apps/cf_erp/services/flowService.js';
import * as CLS from '../../apps/cf_erp/services/classificationService.js';
import * as SO from '../../apps/cf_erp/services/salesOrderService.js';
import { cutFromDetailOf, cutStockOf } from '../../apps/cf_erp/lib/cutFrom.js';
import { placesView, savePlaces, sectionStock } from '../../apps/cf_erp/routes/cutting.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = 2;
const LINE = Number(process.env.CF_CUT_LINE ?? 923);
const tag = `CF${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed += 1; else failed += 1;
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (label, got, want, tol = 1e-6) => ok(label, got != null && Math.abs(Number(got) - want) < tol, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();

try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  const node = async (code) => (await db.query('SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]))[0][0];
  const PLATE_PART = await node('PLATE_PART');
  const PROFILE_PART = await node('PROFILE_PART');
  const FAB_PARTS = await node('FAB_PARTS');
  const places0 = await placesView(db, COMPANY);
  ok('company 2 has its plate and section places (Setup › Cutting)', !!places0.plate.blanksNode && !!places0.section.blanksNode && places0.section.stockNodes.length >= 1, JSON.stringify(places0.problems));
  const PLATE_BLANKS = places0.plate.blanksNode.id;
  const SECTION_BLANKS = places0.section.blanksNode.id;

  const [[l0]] = await db.query('SELECT l.locked_at, l.item_id, l.order_id FROM cf_sales_order_lines l WHERE l.company_id = ? AND l.id = ?', [COMPANY, LINE]);
  ok(`line ${LINE} is frozen to start with`, l0.locked_at != null);
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NULL, locked_by = NULL WHERE company_id = ? AND id = ?', [COMPANY, LINE]);

  const blanksOfPart = async (partId) => (await db.query(
    `SELECT l.child_id, m.classification_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id AND m.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id = ? AND b.deleted_at IS NULL AND m.classification_id IN (?, ?)`,
    [COMPANY, partId, PLATE_BLANKS, SECTION_BLANKS]))[0];
  const valueOf = async (id, code) => (await db.query(
    `SELECT v.value_number, v.option_id, v.source, o.value AS option_value FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = ?
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL`, [code, COMPANY, id]))[0][0] ?? null;

  /* ---- 2. plate derive unchanged on line 923 ------------------------------------- */
  section('2. The plate method gives line 923 exactly the cut plates it had');
  const sig = (g) => g.cutPlates.filter((b) => b.kind === 'plate')
    .map((b) => `${b.size.thickness}|${b.size.length}|${b.size.width}|${b.size.grade}:${b.parts.map((p) => p.id).sort((x, y) => x - y).join(',')}`).sort();
  const was = await CUT.getCutPlates(db, COMPANY, LINE);
  ok('every cut piece of the line says its kind, and they are all plates', was.cutPlates.length > 0 && was.cutPlates.every((b) => b.kind === 'plate'), `${was.cutPlates.length}`);
  const wasCodes = was.cutPlates.map((b) => b.code).sort();
  const up = await CUT.refreshCutPieces(db, c, LINE);
  eq('a refresh of the unfrozen line changes nothing: up_to_date', up.reason, 'up_to_date');
  await db.query('SAVEPOINT scratch');
  await db.query(
    `UPDATE cf_bom_lines l JOIN cf_master_records m ON m.id = l.child_id SET l.deleted_at = NOW()
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND m.classification_id = ?
        AND l.child_id IN (SELECT master_id FROM cf_item_details WHERE owner_order_line_id = ?)`,
    [COMPANY, PLATE_BLANKS, LINE],
  );
  await db.query(
    'UPDATE cf_master_records m JOIN cf_item_details i ON i.master_id = m.id SET m.deleted_at = NOW() WHERE i.owner_order_line_id = ? AND m.classification_id = ?',
    [LINE, PLATE_BLANKS],
  );
  const scratch = await CUT.deriveCutPlates(db, c, LINE, {});
  const now = await CUT.getCutPlates(db, COMPANY, LINE);
  ok(`made from scratch: ${scratch.created} cut plates, the same rectangles from the same parts`, JSON.stringify(sig(now)) === JSON.stringify(sig(was)) && scratch.created === was.cutPlates.length,
    `${sig(now).length} vs ${sig(was).length}`);
  eq('with the same codes', now.cutPlates.map((b) => b.code).sort(), wasCodes);
  await db.query('ROLLBACK TO SAVEPOINT scratch');

  /* ---- a bracing template, filed under Profile part ------------------------------ */
  const flow = 603;
  const defBRC = await MR.createDefinition(db, c, { definitionType: 'template', classificationId: PROFILE_PART.id, code: `${tag}-BRC`, name: `Bracing ${tag}`, shortName: `${tag}B`, status: 'active' });
  await MR.updateRecord(db, c, defBRC.id, { defaultFlowId: flow });
  const [[edia]] = await db.query("SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ? AND m.code LIKE '%EDIA1%' AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1", [LINE]);
  const addPart = async (role) => {
    const r = await B.addLine(db, c, edia.id, { childId: defBRC.id, quantity: 1, role });
    const [[row]] = await db.query(
      `SELECT l.child_id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id WHERE b.parent_id = ? AND l.role = ? AND l.deleted_at IS NULL ORDER BY l.id DESC LIMIT 1`,
      [edia.id, role],
    );
    return row?.child_id ?? r?.childId;
  };
  const p1 = await addPart(`${tag} a`);
  const p2 = await addPart(`${tag} b`);
  const p3 = await addPart(`${tag} c`);
  const p4 = await addPart(`${tag} d`);
  ok('four bracing parts added to the end diaphragm of the line', [p1, p2, p3, p4].every(Boolean), JSON.stringify([p1, p2, p3, p4]));

  /* ---- 1. resolution --------------------------------------------------------------- */
  section('1. Cut from: node default, definition override, item override, not cut');
  let r = await cutFromDetailOf(db, COMPANY, [p1, defBRC.id, edia.id]);
  eq('a bracing part is cut from a SECTION — from its node, Profile part', r.get(p1), { value: 'SECTION', source: 'classification', from: 'Profile part' });
  eq('its definition shows the same default', r.get(defBRC.id).value, 'SECTION');
  // Not cut — from Assemblies, or from its definition once cut-from-setup has given every definition its own answer.
  ok('the diaphragm is NOT cut — from Assemblies or its definition', r.get(edia.id)?.value === 'NONE' && ['classification', 'definition'].includes(r.get(edia.id)?.source), JSON.stringify(r.get(edia.id)));
  await MR.updateRecord(db, c, defBRC.id, { cutFrom: 'PLATE' });
  r = await cutFromDetailOf(db, COMPANY, [p1]);
  eq('the definition says PLATE: the part follows it (source definition)', [r.get(p1).value, r.get(p1).source], ['PLATE', 'definition']);
  await MR.updateRecord(db, c, p1, { cutFrom: 'NONE' });
  r = await cutFromDetailOf(db, COMPANY, [p1, p2]);
  eq('an own answer also says what inherit would give', r.get(p1).inherited, { value: 'PLATE', source: 'definition', from: defBRC.code });
  eq('the part says NONE itself: its own answer wins (source own)', [r.get(p1).value, r.get(p1).source], ['NONE', 'own']);
  eq('its sibling still follows the definition', r.get(p2).value, 'PLATE');
  await MR.updateRecord(db, c, p1, { cutFrom: null });
  await MR.updateRecord(db, c, defBRC.id, { cutFrom: null });
  r = await cutFromDetailOf(db, COMPANY, [p1]);
  eq('both cleared (null = inherit): back to the node default, SECTION', r.get(p1).value, 'SECTION');
  const badCut = await refusal(() => MR.updateRecord(db, c, p1, { cutFrom: 'LASER' }));
  ok('a Cut from that is not PLATE / SECTION / NONE is refused', badCut?.status === 422, badCut?.message);

  /* ---- 6a. section stock picker --------------------------------------------------- */
  section('6a. /section-stock searches by size');
  const found = await sectionStock(db, COMPANY, { search: '75x75x8', limit: 200 });
  ok('"75x75x8" finds the ISA 75 × 75 × 8 angles in every stock length', found.length >= 6 && found.every((s) => /75 x 75 x 8/.test(s.name)), `${found.length}: ${found.slice(0, 3).map((s) => s.name).join(', ')}`);
  const found2 = await sectionStock(db, COMPANY, { search: '75 × 75 × 8', limit: 200 });
  eq('"75 × 75 × 8" finds the same', found2.map((s) => s.id), found.map((s) => s.id));
  const isa6 = found.find((s) => /6000 E350 BO$/.test(s.name));
  const isa12 = found.find((s) => /12000 E350 BO$/.test(s.name));
  ok('each says its steel: thickness 8, width 75, depth 75, stock length, section area, grade', !!isa6 && isa6.thickness === 8 && isa6.width === 75 && isa6.depth === 75 && isa6.lengthMm === 6000 && isa6.sectionArea > 0 && isa6.grade === 'E350', JSON.stringify(isa6));
  const [other] = await sectionStock(db, COMPANY, { search: '100x100x12x6000-e350bo', limit: 5 });
  ok('a code-shaped search finds ISA 100 × 100 × 12 × 6000', !!other && /100 x 100 x 12 x 6000/.test(other.name), JSON.stringify(other));

  /* ---- 6b. cutStockId validation ------------------------------------------------- */
  section('6b. A part may only name a stock bar');
  const [[aPlate]] = await db.query("SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' WHERE m.company_id = ? AND m.code LIKE 'PL-%' AND m.deleted_at IS NULL LIMIT 1", [COMPANY]);
  const notBar = await refusal(() => MR.updateRecord(db, c, p1, { cutStockId: aPlate.id }));
  ok('a raw plate is refused as a section, in words', notBar?.status === 422 && /not a section in stock/.test(JSON.stringify(notBar.problems ?? notBar.message)), `${notBar?.status} ${JSON.stringify(notBar?.problems ?? notBar?.message)}`);
  const notThere = await refusal(() => MR.updateRecord(db, c, p1, { cutStockId: 999999999 }));
  ok('an id that is no record is refused', notThere?.status === 422);

  /* ---- 3. freeze check: a profile part with no section --------------------------- */
  section('3. Freeze checklist: section parts with no section are listed');
  await V.setValues(db, c, 'master', p1, [{ specCode: 'LENGTH', value: 1500 }]);
  await V.setValues(db, c, 'master', p2, [{ specCode: 'LENGTH', value: 1500 }]);
  await V.setValues(db, c, 'master', p3, [{ specCode: 'LENGTH', value: 2000 }]);
  await V.setValues(db, c, 'master', p4, [{ specCode: 'LENGTH', value: 1500 }]);
  let look = await LOCK.lockPlan(db, COMPANY, LINE);
  const secCheck = look.checks.find((k) => k.key === 'section_parts');
  ok('section_parts fails and names the bracing with no section chosen', !!secCheck && secCheck.ok === false && /no section chosen/.test(secCheck.detail) && secCheck.detail.includes('section part'), JSON.stringify(secCheck));
  ok('the line cannot be frozen while it says so', look.canLock === false && look.problems.some((p) => /no section chosen/.test(p)));
  const refreshNoSec = await CUT.refreshCutPieces(db, c, LINE);
  ok('the automatic refresh makes nothing yet (values missing, or no section chosen) and never throws', refreshNoSec.made === false && ['values_missing', 'cannot_derive'].includes(refreshNoSec.reason), JSON.stringify(refreshNoSec));
  const deriveNoSec = await refusal(() => CUT.deriveCutPlates(db, c, LINE, {}));
  ok('working them out by hand is refused, naming the part with no section', deriveNoSec?.code === 'NO_SECTION' && /no section chosen/.test(deriveNoSec.message), `${deriveNoSec?.code}: ${deriveNoSec?.message}`);

  /* ---- 4. section derive ---------------------------------------------------------- */
  section('4. Cut sections: pooled by profile and length');
  await MR.updateRecord(db, c, p1, { cutStockId: isa6.id });
  await MR.updateRecord(db, c, p2, { cutStockId: isa12.id });    // same profile, another stock length
  await MR.updateRecord(db, c, p3, { cutStockId: isa6.id });
  await MR.updateRecord(db, c, p4, { cutStockId: other.id });
  await FLOWS.setCutSectionFlow(db, c, { flowId: flow });
  const d = await CUT.deriveCutPlates(db, c, LINE, {});
  const sec = d.cutPlates.filter((b) => b.kind === 'section');
  eq('three cut sections: (a, b) share one, c (another length) and d (another section) have their own', sec.map((b) => b.parts.map((p) => p.id).sort((x, y) => x - y)).sort(),
    [[p1, p2].sort((x, y) => x - y), [p3], [p4]].sort());
  const sAB = sec.find((b) => b.parts.some((p) => p.id === p1));
  ok('a cut section says its section and its cut length', sAB?.section?.id === isa6.id && sAB.lengthMm === 1500 && sAB.size.thickness === 8, JSON.stringify({ section: sAB?.section, lengthMm: sAB?.lengthMm, size: sAB?.size }));
  near('its stock line is length ÷ stock length (1500 ÷ 6000 = 0.25)', sAB?.plateQuantity, 0.25);
  const [[sLine]] = await db.query(
    'SELECT l.child_id, l.quantity, l.role FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL WHERE b.parent_id = ? AND b.deleted_at IS NULL',
    [sAB.id],
  );
  ok('written as one BOM line to the bar the first part names', Number(sLine.child_id) === isa6.id && Math.abs(Number(sLine.quantity) - 0.25) < 1e-9 && sLine.role === 'Raw section', JSON.stringify(sLine));
  const [[blankRow]] = await db.query('SELECT classification_id, short_name, default_flow_id FROM cf_master_records WHERE id = ?', [sAB.id]);
  ok('filed at the section blanks place, made by the cut-section flow', Number(blankRow.classification_id) === SECTION_BLANKS && Number(blankRow.default_flow_id) === flow, JSON.stringify(blankRow));
  const bSA = await valueOf(sAB.id, 'SECTION_AREA');
  const bDE = await valueOf(sAB.id, 'DENSITY');
  const bLN = await valueOf(sAB.id, 'LENGTH');
  ok('the cut section carries LENGTH, SECTION_AREA and DENSITY (what it is weighed by)', Number(bLN?.value_number) === 1500 && Number(bSA?.value_number) === isa6.sectionArea && Number(bDE?.value_number) === 7850, JSON.stringify({ bLN, bSA, bDE }));
  eq('no profile part got a plate blank', (await Promise.all([p1, p2, p3, p4].map(blanksOfPart))).flat().filter((x) => Number(x.classification_id) === PLATE_BLANKS).length, 0);

  section('4b. The part takes its steel from its bar, and a weight');
  const th = await valueOf(p1, 'THICKNESS');
  const sa = await valueOf(p1, 'SECTION_AREA');
  const gr = await valueOf(p1, 'GRADE');
  const w = await valueOf(p1, 'WEIGHT');
  ok('THICKNESS 8 and SECTION_AREA from the bar, stored as inherited', Number(th?.value_number) === 8 && th.source === 'inherited' && Number(sa?.value_number) === isa6.sectionArea && sa.source === 'inherited', JSON.stringify({ th, sa }));
  ok('GRADE E350 from the bar', gr?.option_value === 'E350' && gr.source === 'inherited', JSON.stringify(gr));
  near('WEIGHT = SECTION_AREA × LENGTH × DENSITY (kg)', w?.value_number, isa6.sectionArea * 1500 * 7850 / 1e9, 1e-3);
  const again = await CUT.refreshCutPieces(db, c, LINE);
  ok('a second refresh changes nothing (and the steel stays put through the Values engine)', again.made === false && ['up_to_date', 'values_missing'].includes(again.reason) && Number((await valueOf(p1, 'THICKNESS'))?.value_number) === 8, JSON.stringify(again));
  await V.setValues(db, c, 'master', p3, [{ specCode: 'THICKNESS', value: 9 }]);
  await CUT.deriveCutPlates(db, c, LINE, {});
  ok('an entered value on the part is never overwritten by its bar', Number((await valueOf(p3, 'THICKNESS'))?.value_number) === 9 && (await valueOf(p3, 'THICKNESS')).source === 'entered');

  section('4c. Another stock length of the same profile: the blank follows the first part');
  await MR.updateRecord(db, c, p1, { cutStockId: isa12.id });
  const d2 = await CUT.deriveCutPlates(db, c, LINE, {});
  const sAB2 = d2.cutPlates.find((b) => b.kind === 'section' && b.parts.some((p) => p.id === p1));
  ok('same blank kept, its stock line moved to the 12 m bar at 1500 ÷ 12000', sAB2?.id === sAB.id && sAB2.section.id === isa12.id && Math.abs(sAB2.plateQuantity - 0.125) < 1e-9, JSON.stringify({ id: sAB2?.id, section: sAB2?.section, q: sAB2?.plateQuantity }));
  await MR.updateRecord(db, c, p1, { cutStockId: isa6.id });
  await CUT.deriveCutPlates(db, c, LINE, {});

  /* ---- 5. PLATE -> SECTION ------------------------------------------------------- */
  section('5. A part switched from PLATE to SECTION lets go of its plate blank');
  const [[shared]] = await db.query(
    `SELECT l.child_id AS blank, COUNT(*) AS n, MIN(b.parent_id) AS part FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id AND m.classification_id = ? AND m.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.child_id IN (SELECT master_id FROM cf_item_details WHERE owner_order_line_id = ?)
      GROUP BY l.child_id HAVING COUNT(*) >= 2 ORDER BY l.child_id LIMIT 1`,
    [PLATE_BLANKS, COMPANY, LINE],
  );
  const switched = Number(shared.part);
  await MR.updateRecord(db, c, switched, { cutFrom: 'SECTION', cutStockId: isa6.id });
  await V.setValues(db, c, 'master', switched, [{ specCode: 'LENGTH', value: 1500 }]).catch(() => null);
  const d3 = await CUT.deriveCutPlates(db, c, LINE, {});
  const now5 = await blanksOfPart(switched);
  ok('it no longer holds a plate blank, and holds a cut section instead', now5.every((b) => Number(b.classification_id) !== PLATE_BLANKS) && now5.some((b) => Number(b.classification_id) === SECTION_BLANKS), JSON.stringify(now5));
  const keptPlate = d3.cutPlates.find((b) => b.id === Number(shared.blank));
  ok('the plate blank it shared stays for the other parts, one part fewer', !!keptPlate && keptPlate.partCount === Number(shared.n) - 1, JSON.stringify({ was: Number(shared.n), now: keptPlate?.partCount }));
  await MR.updateRecord(db, c, switched, { cutFrom: null, cutStockId: null });
  await CUT.deriveCutPlates(db, c, LINE, {});
  ok('switched back, it rejoins a plate blank and its cut-section line is gone',
    (await blanksOfPart(switched)).every((b) => Number(b.classification_id) === PLATE_BLANKS) && (await blanksOfPart(switched)).length === 1);
  ok('and its steel taken from the bar is taken back (its own entered thickness is all it holds)', (await valueOf(switched, 'THICKNESS'))?.source === 'entered');

  /* ---- 6c. /cut-places ----------------------------------------------------------- */
  section('6c. Setup › Cutting: GET / PUT /cut-places');
  ok('GET says each place with its path', /Cut plate/.test(places0.plate.blanksNode.path) && places0.plate.blanksNode.path.includes('›') && places0.section.stockNodes.every((n) => n.path.startsWith('Steel')),
    JSON.stringify(places0.plate.blanksNode));
  eq('and the section settings', Object.keys(places0.sectionSettings).sort(), ['endTrimMm', 'minOffcutMm', 'sawKerfMm']);
  const steel = await node('STEEL');
  const badBlanks = await refusal(() => savePlaces(db, c, { section: { blanksNodeId: steel.id } }));
  ok('a blanks node with nodes under it is refused', badBlanks?.status === 422 && /nodes under it/.test(JSON.stringify(badBlanks.problems)), JSON.stringify(badBlanks?.problems));
  const [[machineNode]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope = 'machine' AND deleted_at IS NULL LIMIT 1", [COMPANY]);
  if (machineNode) {
    const badStock = await refusal(() => savePlaces(db, c, { section: { stockNodeIds: [machineNode.id] } }));
    ok('a machine node as stock is refused', badStock?.status === 422 && /machines/.test(JSON.stringify(badStock.problems)), JSON.stringify(badStock?.problems));
  }
  const sameNode = await refusal(() => savePlaces(db, c, { section: { offcutNodeId: SECTION_BLANKS } }));
  ok('cut pieces and offcuts at one node is refused', sameNode?.status === 422);
  const saved = await savePlaces(db, c, { sectionSettings: { sawKerfMm: 4 } });
  eq('PUT stores the saw kerf and answers with the view', saved.sectionSettings.sawKerfMm, 4);
  const cleared = await savePlaces(db, c, { section: { offcutNodeId: null } });
  ok('clearing the section offcut place says so in problems', cleared.section.offcutNode === null && cleared.problems.some((p) => /section offcuts/.test(p)), JSON.stringify(cleared.problems));
  await savePlaces(db, c, { section: { offcutNodeId: places0.section.offcutNode.id } });

  /* ---- 7. tree + record ----------------------------------------------------------- */
  section('7. The tree and the record say how a row is cut');
  const tree = await SO.lineStructure(db, COMPANY, LINE, {});
  const findNode = (n, id) => (Number(n.id) === id ? n : (n.children ?? []).reduce((f, k) => f ?? findNode(k, id), null));
  const n1 = findNode(tree.root, p1);
  ok('the bracing node: cutFrom SECTION, cutStock the 6 m angle', n1?.cutFrom === 'SECTION' && n1.cutStock?.id === isa6.id && !!n1.cutStock.code, JSON.stringify({ cutFrom: n1?.cutFrom, cutStock: n1?.cutStock }));
  ok('the diaphragm node: NONE, no stock', findNode(tree.root, edia.id)?.cutFrom === 'NONE' && findNode(tree.root, edia.id)?.cutStock === null);
  const rec = await MR.getRecord(db, COMPANY, p1);
  ok('GET /records/:id: cutFrom { value, source, from } and cutStock { own, effective + steel, from }',
    rec.cutFrom?.value === 'SECTION' && rec.cutFrom.source === 'classification' && rec.cutStock?.own?.id === isa6.id && rec.cutStock.effective?.steel?.thickness === 8 && rec.cutStock.from === 'own',
    JSON.stringify({ cutFrom: rec.cutFrom, cutStock: rec.cutStock }));
  await MR.updateRecord(db, c, defBRC.id, { cutStockId: other.id });
  const st = await cutStockOf(db, COMPANY, [p1, defBRC.id]);
  ok('a definition\'s section is the default; the item\'s own still wins', st.get(defBRC.id)?.stockId === other.id && st.get(p1)?.from === 'own');
  await MR.updateRecord(db, c, defBRC.id, { cutStockId: null });

  /* ---- 8. release, bars, valuation ------------------------------------------------ */
  section('8. Release: section stock and bars');
  const sCut = (await CUT.getCutPlates(db, COMPANY, LINE)).cutPlates.filter((b) => b.kind === 'section');
  const sCD = sCut.find((b) => b.parts.some((p) => p.id === p4));
  const sC3 = sCut.find((b) => b.parts.some((p) => p.id === p3));
  const kg = await VAL.unitKgOf(db, COMPANY, [sAB.id]);
  near('a cut section weighs its bar\'s section area × its length × density', kg.get(sAB.id), Math.round(isa6.sectionArea * 1500 * 7850 / 1e9 * 1000) / 1000, 1e-3);
  // The rest of the line is the real tenant's; freezing it again needs its own codes etc. — the bars are what is asked here.
  const plan = { nodes: [{ k: 0, itemId: sAB.id }, { k: 1, itemId: sC3.id }, { k: 2, itemId: sCD.id }],
    reqs: [{ nodeK: 0, itemId: isa6.id, quantity: 0.25 }, { nodeK: 0, itemId: isa6.id, quantity: 0.25 }, { nodeK: 1, itemId: isa6.id, quantity: 0.333333 }, { nodeK: 2, itemId: other.id, quantity: 0.25 }] };
  REL.roundUpSectionBars(plan, () => true);
  const sumOf = (id) => plan.reqs.filter((q) => q.itemId === id).reduce((t, q) => t + q.quantity, 0);
  ok('before nesting each bar is bought whole: 0.25 + 0.25 + 0.333 of the 6 m angle -> 1, 0.25 of the 100 angle -> 1', Math.abs(sumOf(isa6.id) - 1) < 1e-9 && Math.abs(sumOf(other.id) - 1) < 1e-9, JSON.stringify(plan.reqs));

  const temporaries = (await db.query('SELECT master_id FROM cf_item_details WHERE owner_order_line_id = ? AND deleted_at IS NULL', [LINE]))[0].map((x) => x.master_id);
  eq('with every section chosen, release has nothing to say about sections', await CUT.sectionStockProblems(db, COMPANY, temporaries), []);
  await db.query('UPDATE cf_master_records SET cut_stock_id = NULL WHERE id = ?', [p4]);
  const unresolved = await CUT.sectionStockProblems(db, COMPANY, temporaries);
  ok('a section part with no bar refuses release, in words', unresolved.length === 1 && /no stock bar chosen/.test(unresolved[0]) && unresolved[0].includes('Choose the section'), JSON.stringify(unresolved));
  await db.query('UPDATE cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id SET l.deleted_at = NOW() WHERE b.parent_id = ? AND l.deleted_at IS NULL', [sCD.id]);
  ok('a cut section with no bar under it is said too', (await CUT.sectionStockProblems(db, COMPANY, temporaries)).some((p) => /cut section has no stock bar/.test(p)));
  await db.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE id = ?', [other.id, p4]);
  await CUT.deriveCutPlates(db, c, LINE, {});
  eq('chosen again (and derived), it passes', await CUT.sectionStockProblems(db, COMPANY, temporaries), []);

  // Release itself, on the line frozen again: the section words are not among its problems.
  await db.query("UPDATE cf_sales_orders SET status = 'confirmed' WHERE company_id = ? AND id = ?", [COMPANY, l0.order_id]);
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  const chk = await REL.releaseCheck(db, COMPANY, LINE);
  ok('releaseCheck runs on the line and does not refuse it for a section', !chk.problems.some((p) => /section/.test(p) && /stock bar/.test(p)), chk.problems.filter((p) => /section/.test(p)).join(' | '));
  await db.query('UPDATE cf_master_records SET cut_stock_id = NULL WHERE id = ?', [p4]);
  const chk2 = await REL.releaseCheck(db, COMPANY, LINE);
  ok('with a bar unchosen, releaseCheck refuses in those words', chk2.ok === false && chk2.problems.some((p) => /no stock bar chosen/.test(p)), chk2.problems.slice(0, 4).join(' | '));
  await db.query('UPDATE cf_master_records SET cut_stock_id = ? WHERE id = ?', [other.id, p4]);

  // After section nesting: one 6 m bar holding a-b (2 × 1500) and c (2000) — shared by length.
  const [lotR] = await db.query(
    `INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, source, kind, thickness_mm, length_mm, width_mm)
     VALUES (?, ?, ?, ?, 'catalog', 'bar', 8, 6000, 75)`, [COMPANY, LINE, isa6.id, `${tag}-B1`]);
  await db.query(
    `INSERT INTO cf_nest_placements (company_id, plate_lot_id, cut_plate_id, seq_no, x_mm, y_mm, length_mm, width_mm)
     VALUES (?, ?, ?, 1, 10, 0, 1500, 75), (?, ?, ?, 2, 1513, 0, 1500, 75), (?, ?, ?, 3, 3016, 0, 2000, 75)`,
    [COMPANY, lotR.insertId, sAB.id, COMPANY, lotR.insertId, sAB.id, COMPANY, lotR.insertId, sC3.id]);
  const lots = (await REL.lotsOfLines(db, COMPANY, [LINE])).get(LINE);
  const bar = lots.get(lotR.insertId);
  ok('lotsOfLines says the lot is a bar, with the length each cut section takes on it', bar?.kind === 'bar' && bar.lengthByCutPlate.get(sAB.id) === 3000 && bar.lengthByCutPlate.get(sC3.id) === 2000, JSON.stringify(bar && [...bar.lengthByCutPlate]));
  const chk3 = await REL.releaseCheck(db, COMPANY, LINE);
  const isaNeed = chk3.materials.find((m) => m.item.id === isa6.id);
  ok('release asks for the 6 m angle the bar lot holds: one bar, shared 0.6 / 0.4 by length', !!isaNeed && Math.abs(isaNeed.required - 1) < 1e-6, JSON.stringify(isaNeed));
  const otherNeed = chk3.materials.find((m) => m.item.id === other.id);
  ok('the cut section not on a bar still asks for its bar, rounded up to one whole bar', !!otherNeed && Math.abs(otherNeed.required - Math.ceil(otherNeed.required)) < 1e-9 && otherNeed.required >= 1, JSON.stringify(otherNeed));
} catch (err) {
  failed += 1;
  console.error('\nERROR', err);
} finally {
  await db.rollback();
  db.release();
}

const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
console.log('\nRolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((dd) => dd.name).join(', '));
const [[l]] = await pool.query('SELECT locked_at, (SELECT COUNT(*) FROM cf_production_releases r WHERE r.order_line_id = cf_sales_order_lines.id AND r.deleted_at IS NULL) AS released FROM cf_sales_order_lines WHERE id = ?', [LINE]);
ok(`line ${LINE} is frozen again and not released (as it was)`, l.locked_at != null && Number(l.released) === 0);
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
