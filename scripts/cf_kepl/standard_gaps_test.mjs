/**
 * standard_gaps_test.mjs — the standard drawings' gaps (lib/standardGaps.js) and their fix as a NEW VERSION
 * (services/standardGapFixService.js, scripts/cf_kepl/rdso-standard-fix.mjs, importStandard's gap fill). 2026-10-18.
 *
 *   cd multi_app_be && node scripts/cf_kepl/standard_gaps_test.mjs        CF_GAPS_COMPANY (2)
 *
 * Production: RDSO/B-11753R3 v1 made line SO260014/1 with 20 required values blank, 4 section parts with no
 * section and 3 rows with no flow. ONE TRANSACTION, ROLLED BACK; the cf_ tables touched are re-counted at the end.
 * Uses the local copy of RDSO/B-11753R3 (company 2) read-only, and writes only new versions / a TEST- standard.
 *   1  derivations from the drawing data (pure): segment LENGTH from the layout, GIRDER_TYPE from the title, a
 *      segment's HOLES / HOLE_DRILL_THICKNESS from its web, an assembly's SURFACE_AREA as the catalog's formulas
 *      add it, weld sizes NOT derived; which formula asks come out empty; the set folder of a standard's number
 *   2  the check on the local standard: sections found with bar candidates per class, every gap has a path
 *   3  the fix (--commit) with --section-class BR: a NEW version, current moves, the OLD version's rows, values and
 *      bars untouched; the new rows carry the BR bars; the files copied
 *   4  idempotent: a second run finds nothing the drawing settles and writes nothing
 *   5  values and flows on a version's rows: only what is empty is filled, a typed value stays; twice = once
 *   6  dry run cannot write (the read-only wrapper refuses a write)
 *   7  the importer fills what the drawing settles on a fresh import (a TEST- number), and says it
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool, isReadOnlySql } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST || 'localhost')) { console.error('Local database only.'); process.exit(1); }
await imp('apps/cf_erp/services/codegenProvider.js');
const G = await imp('apps/cf_erp/lib/standardGaps.js');
const F = await imp('apps/cf_erp/services/standardGapFixService.js');
const STD = await imp('apps/cf_erp/services/standardDrawingService.js');
const COMPANY = Number(process.env.CF_GAPS_COMPANY || 2);
const RUN = Date.now().toString(36).toUpperCase();
const BOM_DIR = path.join(BE, '..', 'drawing_bom', 'out');

let pass = 0, failed = 0;
const ok = (label, cond) => { if (cond) pass += 1; else { failed += 1; console.error('FAIL', label); } };

// 1 --------------------------------------------------------------------------------------------------------------
{
  const bom = JSON.parse(fs.readFileSync(path.join(BOM_DIR, 'RDSO_11753R3', 'bom.json'), 'utf8'));
  const seg = { segment: 'GA', fromMm: 0, toMm: 7650 };
  ok('1 segment LENGTH from the girder layout', G.deriveValue('LENGTH', { segment: seg, values: {} })?.value === 7650);
  const girderType = { code: 'GIRDER_TYPE', options: new Map([['COMPOSITE', 90005], ['BOWSTRING', 90006], ['OPEN_WEB', 90007], ['OPEN WEB', 90007], ['TUB', 90008]]) };
  ok('1 GIRDER_TYPE from the drawing title (composite)', G.deriveValue('GIRDER_TYPE', { bom, spec: girderType })?.optionId === 90005);
  ok('1 GIRDER_TYPE: a title that names none of the options is not guessed', G.deriveValue('GIRDER_TYPE', { bom: { drawing: { type: 'riveted plate girder' } }, spec: girderType }) === null);
  const byMark = G.itemsByRowMark(bom);
  const kid = (mark, q, extra = {}) => ({ kind: 'temporary', name: `${byMark.get(mark).description}`, quantity: q, values: {}, item: byMark.get(mark), mark, children: [], ...extra });
  const kids = [kid('TF1', 1), kid('BF1', 1), kid('WP1', 1, { name: 'Web plate Web plate' }), kid('IS1', 9), kid('IS2', 1), { kind: 'catalog', name: 'Shear stud', quantity: 276, values: {}, children: [] }];
  ok('1 segment HOLES = the web\'s holes on the drawing (WP1: 88)', G.deriveValue('HOLES', { children: kids })?.value === 88);
  ok('1 segment HOLE_DRILL_THICKNESS = the web\'s thickness (18)', G.deriveValue('HOLE_DRILL_THICKNESS', { children: kids })?.value === 18);
  const area = G.deriveValue('SURFACE_AREA', { children: kids });
  const want = (7650 * 360 + 7650 * 750 + 7650 * 1350 + 9 * 160 * 1254 + 160 * 1350) / 1e6;
  ok(`1 assembly SURFACE_AREA = Σ quantity × L × W / 1e6 (the catalog's formulas; studs left out) ${area?.value} ≈ ${want.toFixed(3)}`, Math.abs((area?.value ?? 0) - want) < 0.01);
  const brace = [{ kind: 'temporary', name: 'Bottom lateral bracing', quantity: 2, cutFrom: 'SECTION', values: { LENGTH: 2685, WIDTH: 110, DEPTH: 110 }, children: [] }];
  ok('1 an angle\'s area is one face of each leg (a + b) × L', Math.abs(G.deriveValue('SURFACE_AREA', { children: brace }).value - (2 * 220 * 2685) / 1e6) < 0.001);
  ok('1 weld sizes are NOT derived (the drawing data has none)', G.deriveValue('MIG_WELD_SIZE', { children: kids, bom }) === null && G.deriveValue('SAW_WELD_SIZE', { children: kids, bom }) === null);
  ok('1 SURFACE_AREA by SUM(children) comes out empty with a stud under it (as on SO260014)', G.formulaComesOutEmpty('SURFACE_AREA', kids) === true);
  ok('1 … and fills when every part has a size', G.formulaComesOutEmpty('SURFACE_AREA', kids.slice(0, 5)) === false);
  ok('1 segment HOLES (NONZERO of the web\'s DRAWN_HOLES) empty when the web has none drawn', G.formulaComesOutEmpty('HOLES', kids) === true);
  ok('1 … filled when the web has drawn holes', G.formulaComesOutEmpty('HOLES', [{ ...kids[2], values: { DRAWN_HOLES: 88 } }]) === false);
  ok('1 another formula ask is taken to fill', G.formulaComesOutEmpty('SAW_WELD_LENGTH', kids) === false);
  ok('1 the set folder of a standard\'s number', G.setFolderOf('RDSO/B-11753R3', BOM_DIR) === 'RDSO_11753R3' && G.setFolderOf('RDSO/B-1534/R', BOM_DIR) === 'RDSO_1534R' && G.setFolderOf('CBS-0055', BOM_DIR) === 'RDSO_CBS-0055');
  ok('1 pieces a span from the drawing tree (IS1: 2 girders × (9 + 15))', G.piecesPerSpan(bom).get('IS1') === 48);
}

const conn = await pool.getConnection();
const count = async () => {
  const out = {};
  for (const t of ['cf_standard_drawings', 'cf_standard_drawing_versions', 'cf_standard_drawing_files', 'cf_master_records', 'cf_item_details', 'cf_boms', 'cf_bom_lines', 'cf_spec_values', 'cf_spec_assignments', 'cf_drawing_links', 'cf_drawings']) {
    const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t}`);
    out[t] = Number(r.n);
  }
  return out;
};
const before = await count();
await conn.beginTransaction();
try {
  // 2 ------------------------------------------------------------------------------------------------------------
  const res = await G.checkStandards(conn, COMPANY, { only: ['RDSO/B-11753R3'], bomDir: BOM_DIR });
  const s = res.standards[0];
  ok('2 the local RDSO/B-11753R3 is read', !!s && s.set === 'RDSO_11753R3' && s.rows > 30);
  ok('2 its section parts with no section are found (4: 3 x-frame angles, 1 bracing)', s.gaps.sections.length === 4);
  const xf = s.gaps.sections.filter((x) => /150x150x15/.test(x.profile ?? ''));
  ok('2 the x-frame angles get one bar per impact class (the class is the order\'s)', xf.length === 3 && xf.every((x) => x.derive?.byClass?.BR && x.derive?.byClass?.BO));
  ok('2 ISA 110x110x12 has no catalog bar: left for a person', s.gaps.sections.some((x) => /110x110x12/.test(x.profile ?? '') && !x.derive));
  ok('2 every gap names its row by path', [...s.gaps.values, ...s.gaps.sections, ...s.gaps.flows].every((x) => typeof x.path === 'string' && x.path.includes(' › ')));

  // 3 ------------------------------------------------------------------------------------------------------------
  const [[stdRow]] = await conn.query('SELECT * FROM cf_standard_drawings WHERE company_id = ? AND id = ?', [COMPANY, s.standardId]);
  const oldVersionId = s.versionId;
  const sig = async (root) => {
    const t = await (await imp('apps/cf_erp/services/bomService.js')).explode(conn, COMPANY, root, { withCut: true });
    const ids = []; const walk = (n) => { ids.push(Number(n.id)); n.children.forEach(walk); }; walk(t.root);
    const [vals] = await conn.query("SELECT subject_id, specification_id, value_number, value_text, option_id FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL ORDER BY subject_id, specification_id", [COMPANY, ids]);
    const [bars] = await conn.query('SELECT id, cut_stock_id, default_flow_id FROM cf_master_records WHERE company_id = ? AND id IN (?) ORDER BY id', [COMPANY, ids]);
    return JSON.stringify({ vals, bars });
  };
  const [[oldV]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE id = ?', [oldVersionId]);
  const oldSig = await sig(Number(oldV.root_item_id));
  const logs = [];
  const fx = await F.fixStandards({ pool, conn, companyId: COMPANY, userId: null, standards: res.standards, commit: true, sectionClass: 'BR', log: (l) => logs.push(l) });
  ok('3 the fix wrote one new version', fx.fixed === 1 && fx.failed === 0);
  const r0 = fx.results[0];
  const [[newV]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE id = ?', [r0.versionId]);
  const [[stdAfter]] = await conn.query('SELECT current_version_id FROM cf_standard_drawings WHERE id = ?', [s.standardId]);
  ok('3 … numbered after the old one, and now current', Number(newV.version_no) === Number(oldV.version_no) + 1 && Number(stdAfter.current_version_id) === Number(r0.versionId) && Number(stdRow.current_version_id) === oldVersionId);
  ok('3 … with a note that says what was filled', /Gaps filled from the drawing/.test(newV.note ?? '') && /3 sections/.test(newV.note ?? ''));
  ok('3 … its own rows (a different root)', Number(newV.root_item_id) !== Number(oldV.root_item_id) && newV.made_from === 'fix');
  ok('3 the OLD version\'s rows, values, bars and flows are untouched', (await sig(Number(oldV.root_item_id))) === oldSig);
  const [[files]] = await conn.query('SELECT (SELECT COUNT(*) FROM cf_standard_drawing_files WHERE version_id = ?) AS a, (SELECT COUNT(*) FROM cf_standard_drawing_files WHERE version_id = ?) AS b', [oldVersionId, r0.versionId]);
  ok(`3 the part files copied with it (${files.b} of ${files.a})`, Number(files.a) > 0 && Number(files.a) === Number(files.b));
  const after = await G.checkStandards(conn, COMPANY, { only: ['RDSO/B-11753R3'], bomDir: BOM_DIR });
  const n = after.standards[0];
  ok('3 the new version: the 3 x-frame angles have their BR bar; the 110 angle still needs a person', n.versionId === r0.versionId && n.gaps.sections.length === 1 && /110x110x12/.test(n.gaps.sections[0].profile));
  const [bars] = await conn.query(
    `SELECT b.code FROM cf_master_records m JOIN cf_master_records b ON b.id = m.cut_stock_id WHERE m.company_id = ? AND m.cut_stock_id IS NOT NULL AND m.id IN (
       SELECT i.master_id FROM cf_item_details i WHERE i.company_id = ? AND i.owner_order_line_id IS NULL AND i.master_id >= ?)`, [COMPANY, COMPANY, Number(newV.root_item_id)]);
  ok('3 … the bars are E250BR', bars.length === 3 && bars.every((b) => /E250BR$/.test(b.code)));
  ok('3 the gap count went down by what was filled', n.total === s.total - 3);

  // 4 ------------------------------------------------------------------------------------------------------------
  const logs2 = [];
  const fx2 = await F.fixStandards({ pool, conn, companyId: COMPANY, standards: after.standards, commit: true, sectionClass: 'BR', log: (l) => logs2.push(l) });
  const [[vc]] = await conn.query('SELECT COUNT(*) AS n FROM cf_standard_drawing_versions WHERE standard_id = ? AND deleted_at IS NULL', [s.standardId]);
  ok('4 a second run finds nothing the drawing settles and writes nothing', fx2.fixed === 0 && fx2.skipped === 1 && Number(vc.n) === 2);

  // 5 ------------------------------------------------------------------------------------------------------------
  // On the new version's rows: a value the rows have a rule for (IMPACT_CLASS on a plate part here), and a flow.
  const tree = await (await imp('apps/cf_erp/services/bomService.js')).explode(conn, COMPANY, Number(newV.root_item_id));
  const rows = []; const walk = (x) => { if (x.kind === 'temporary') rows.push(x); x.children.forEach(walk); }; walk(tree.root);
  const gapRow = n.gaps.values.find((v) => v.specCode === 'IMPACT_CLASS');
  const [[flow]] = await conn.query("SELECT id, code FROM cf_operation_flows WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const noFlow = n.gaps.flows[0];
  if (gapRow && flow && noFlow) {
    const entry = { gaps: { values: [{ ...gapRow, derive: { value: 'BR', how: 'test' } }], sections: [], flows: [{ ...noFlow, derive: { flowId: Number(flow.id), code: flow.code, how: 'test' } }], quantities: [] } };
    const f1 = await F.fillVersionGaps(conn, { companyId: COMPANY, userId: null }, entry, null);
    ok(`5 the value is written (${f1.problems.join('; ') || 'ok'})`, f1.values === 1 && f1.problems.length === 0);
    ok('5 the flow is given to the row that had none', f1.flows === 1);
    const [[fl]] = await conn.query('SELECT default_flow_id FROM cf_master_records WHERE id = ?', [noFlow.itemId]);
    ok('5 … that flow', Number(fl.default_flow_id) === Number(flow.id));
    const f2 = await F.fillVersionGaps(conn, { companyId: COMPANY, userId: null }, entry, null);
    ok('5 twice = once: nothing more written', f2.values === 0 && f2.flows === 0);
    const typed = { gaps: { values: [{ ...gapRow, derive: { value: 'BO', how: 'test' } }], sections: [], flows: [], quantities: [] } };
    await F.fillVersionGaps(conn, { companyId: COMPANY, userId: null }, typed, null);
    const [[iv]] = await conn.query(
      "SELECT o.value FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'IMPACT_CLASS' JOIN cf_spec_options o ON o.id = v.option_id WHERE v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL", [gapRow.itemId]);
    ok('5 a value already held is never changed', iv?.value === 'BR');
  } else ok('5 a local value gap, flow and row without flow to test with', false);

  // 6 ------------------------------------------------------------------------------------------------------------
  const ro = { query: (sql, ...rest) => { if (!isReadOnlySql(sql)) throw new Error('read-only'); return conn.query(sql, ...rest); } };
  let refused = null;
  try { await ro.query('UPDATE cf_standard_drawings SET name = name WHERE id = -1'); } catch (e) { refused = e; }
  ok('6 the dry run\'s wrapper refuses a write', /read-only/.test(refused?.message ?? ''));
  const dry = await G.checkStandards(ro, COMPANY, { only: ['RDSO/B-11753R3'], bomDir: BOM_DIR });
  const fx3 = await F.fixStandards({ pool, companyId: COMPANY, standards: dry.standards.map((x) => ({ ...x, gaps: { ...x.gaps, sections: s.gaps.sections } })), commit: false, sectionClass: 'BR', log: () => {} });
  ok('6 a dry run plans and writes nothing', fx3.fixed === 1 && fx3.results[0].planned >= 1 && !fx3.results[0].versionId);

  // 7 ------------------------------------------------------------------------------------------------------------
  const bom = JSON.parse(fs.readFileSync(path.join(BOM_DIR, 'RDSO_11753R3', 'bom.json'), 'utf8'));
  bom.drawing = { ...bom.drawing, number: `TEST-GAPS-${RUN}`, revision: null };
  const dxfDir = path.join(BOM_DIR, 'RDSO_11753R3', 'dxf');
  const filesIn = fs.readdirSync(dxfDir).filter((f) => /\.dxf$/i.test(f)).map((name) => ({ name, text: fs.readFileSync(path.join(dxfDir, name)).toString('latin1') }));
  const out = await STD.importStandard(conn, { companyId: COMPANY, userId: null }, { bom, files: filesIn, apply: true });
  const gf = await F.fillImportedGaps(conn, { companyId: COMPANY, userId: null }, { standardId: out.standardId, bom, sectionClass: 'BR' });
  ok(`7 the import says what it filled (${gf?.error ?? `${gf?.sections} sections`})`, gf && !gf.error && gf.sections === 3);
  const fresh = await G.checkStandards(conn, COMPANY, { only: [`TEST-GAPS-${RUN}`], bomDir: BOM_DIR });
  ok('7 … and the imported version has only what needs a person left', fresh.standards[0] && F.fillableCount(fresh.standards[0], { sectionClass: 'BR' }) === 0 && fresh.standards[0].gaps.sections.length === 1);
} catch (e) {
  failed += 1;
  console.error('ERROR', e);
} finally {
  await conn.rollback();
}
const afterCounts = await count();
ok('the transaction left every table as it was', JSON.stringify(afterCounts) === JSON.stringify(before));
conn.release();
await pool.end();
console.log(`standard_gaps_test: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
