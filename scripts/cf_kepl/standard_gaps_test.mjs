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
 *   8  production 2026-10-19: a flow the fix gives asks a value the drawing settles — filled in the SAME run (passes
 *      until settled); a second --commit run writes nothing, a third dry run plans nothing
 *   9  a copied version carries every row's section bar, flow, values and own rules (treeCopyService)
 *  10  a copy that would hold nothing new (everything counted was refused / already there) makes no version
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
const ok = (label, cond) => { if (cond) { pass += 1; if (process.env.VERBOSE) console.log('ok', label); } else { failed += 1; console.error('FAIL', label); } };

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

  // 8 ------------------------------------------------------------------------------------------------------------
  // Production 2026-10-19: run 1 gave the x-frame a flow that asks a value the drawing settles; that value was left for
  // run 2, which copied the version again — and the copy dropped the 6 section bars, so run 3 planned them again.
  // Here: a flow made to ask SPAN_LENGTH (the drawing's span) is given to the two bracing assemblies of the local
  // RDSO/B-11751R3; fix --commit, again --commit, then a dry run.
  const STD2 = 'RDSO/B-11751R3';
  const [[fl8]] = await conn.query(
    `SELECT st.flow_id FROM cf_operation_flow_steps st
       JOIN cf_operation_machine_rules r ON r.company_id = st.company_id AND r.operation_id = st.operation_id AND r.deleted_at IS NULL AND r.eligible = 1
       JOIN cf_operation_flows f ON f.id = st.flow_id AND f.status = 'active' AND f.deleted_at IS NULL AND f.owner_order_line_id IS NULL
      WHERE st.company_id = ? AND st.deleted_at IS NULL ORDER BY st.flow_id DESC LIMIT 1`, [COMPANY]);
  await conn.query(
    `UPDATE cf_operation_machine_rules r JOIN cf_operation_flow_steps st ON st.operation_id = r.operation_id AND st.company_id = r.company_id AND st.deleted_at IS NULL
        SET r.work_expression = 'item.SPAN_LENGTH * 0 + 3' WHERE r.company_id = ? AND st.flow_id = ? AND r.eligible = 1 AND r.deleted_at IS NULL`, [COMPANY, fl8.flow_id]);
  const c8 = await G.checkStandards(conn, COMPANY, { only: [STD2], bomDir: BOM_DIR });
  const s8 = c8.standards[0];
  let given8 = 0;
  for (const f of s8.gaps.flows) if (/^[^›]+ › (Bottom lateral bracing|Ixf intermediate x-frame)$/.test(f.path) && !f.derive) { f.derive = { flowId: Number(fl8.flow_id), code: 'TEST', how: 'test' }; given8 += 1; }
  ok('8 the local RDSO/B-11751R3: 2 assemblies with no flow, 6 section parts with no section', given8 === 2 && s8.gaps.sections.length === 6);
  const vCount = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM cf_standard_drawing_versions WHERE standard_id = ? AND deleted_at IS NULL', [s8.standardId]))[0][0].n);
  const v0 = await vCount();
  const r1 = await F.fixStandards({ pool, conn, companyId: COMPANY, standards: c8.standards, commit: true, sectionClass: 'BR', bomDir: BOM_DIR, log: () => {} });
  const w1 = r1.results[0];
  ok(`8 run 1 writes one version, filled until settled (${w1?.filled?.passes} passes: ${w1?.filled?.values} values, ${w1?.filled?.sections} sections, ${w1?.filled?.flows} flows)`,
    r1.fixed === 1 && w1.filled.passes >= 2 && w1.filled.sections === 6 && w1.filled.left === 0 && (await vCount()) === v0 + 1);
  const c8b = await G.checkStandards(conn, COMPANY, { only: [STD2], bomDir: BOM_DIR });
  ok('8 … the new version: nothing the drawing settles is left (the values its new flows ask included)', c8b.standards[0].versionId === w1.versionId && F.fillableCount(c8b.standards[0], { sectionClass: 'BR' }) === 0);
  ok('8 … its section parts hold their bars', c8b.standards[0].gaps.sections.length === 0);
  const r2 = await F.fixStandards({ pool, conn, companyId: COMPANY, standards: c8b.standards, commit: true, sectionClass: 'BR', bomDir: BOM_DIR, log: () => {} });
  ok('8 run 2 (--commit) writes nothing: no new version', r2.fixed === 0 && r2.skipped === 1 && (await vCount()) === v0 + 1);
  const c8c = await G.checkStandards(ro, COMPANY, { only: [STD2], bomDir: BOM_DIR });
  const r3 = await F.fixStandards({ pool, companyId: COMPANY, standards: c8c.standards, commit: false, sectionClass: 'BR', bomDir: BOM_DIR, log: () => {} });
  ok('8 run 3 (dry) plans nothing', r3.fixed === 0 && r3.skipped === 1);

  // 9 ------------------------------------------------------------------------------------------------------------
  // The copy carries every row's section, flow, values and own rules: a copy of the filled version, row by row.
  const rowsOf = async (root) => {
    const t = await (await imp('apps/cf_erp/services/bomService.js')).explode(conn, COMPANY, root, { withCut: true });
    const list = []; const walk = (n, p) => { if (n.kind === 'temporary') list.push({ id: Number(n.id), path: p }); n.children.forEach((k, i) => walk(k, `${p}/${k.lineNo ?? i}:${k.role ?? ''}`)); }; walk(t.root, 'ROOT');
    const ids = list.map((x) => x.id);
    const [m] = await conn.query('SELECT id, cut_stock_id, default_flow_id FROM cf_master_records WHERE id IN (?)', [ids]);
    const [v] = await conn.query("SELECT subject_id, specification_id, value_number, value_text, option_id, value_bool FROM cf_spec_values WHERE subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL ORDER BY subject_id, specification_id", [ids]);
    const [a] = await conn.query("SELECT subject_id, specification_id, capture_at, is_required, value_rule, formula_id, origin FROM cf_spec_assignments WHERE subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL ORDER BY subject_id, specification_id, capture_at", [ids]);
    const by = (rows, id) => JSON.stringify(rows.filter((r) => Number(r.subject_id) === id).map(({ subject_id: _s, ...r }) => r));
    return list.map((x) => { const mm = m.find((r) => Number(r.id) === x.id); return `${x.path}|${mm.cut_stock_id}|${mm.default_flow_id}|${by(v, x.id)}|${by(a, x.id)}`; });
  };
  const [[v8]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE id = ?', [w1.versionId]);
  const cp = await F.copyVersion(conn, { companyId: COMPANY, userId: null }, s8.standardId, w1.versionId, { note: 'test copy' });
  const before9 = await rowsOf(Number(v8.root_item_id));
  const after9 = await rowsOf(cp.rootId);
  ok(`9 a copied version holds every row's section, flow, values and rules (${after9.length} rows, ${after9.filter((r) => r.split('|')[1] !== 'null').length} with a section)`,
    before9.length > 30 && JSON.stringify(before9) === JSON.stringify(after9) && before9.filter((r) => r.split('|')[1] !== 'null').length === 6);

  // 10 -----------------------------------------------------------------------------------------------------------
  // A check that counts something the fill then cannot write (a flow for a row that has one meanwhile) makes no version.
  const c10 = await G.checkStandards(conn, COMPANY, { only: [STD2], bomDir: BOM_DIR });
  const withFlow = after9.length ? (await conn.query('SELECT id, default_flow_id FROM cf_master_records WHERE id = ?', [cp.rootId]))[0][0] : null;
  const fake = { ...c10.standards[0], gaps: { ...c10.standards[0].gaps, values: [], sections: [], quantities: [], flows: [{ itemId: withFlow.id, path: 'root', derive: { flowId: Number(fl8.flow_id), code: 'TEST', how: 'test' } }] } };
  const v10 = await vCount();
  const r10 = await F.fixStandards({ pool, conn, companyId: COMPANY, standards: [fake], commit: true, sectionClass: 'BR', bomDir: BOM_DIR, log: () => {} });
  ok('10 a copy that would hold nothing new is undone: no version', withFlow.default_flow_id != null && r10.fixed === 0 && r10.skipped === 1 && (await vCount()) === v10);

  // 11 -----------------------------------------------------------------------------------------------------------
  // The repair (rdso-standard-repair.mjs) of production's state: v2 filled, v3 a copy of it that LOST the bars (as the
  // old copy did), current. → v4 = v3 + v2's bars, current; v1–v3 untouched; a second run writes nothing.
  const R = await imp('apps/cf_erp/services/standardVersionRepairService.js');
  const STD3 = 'RDSO/B-11754R3';
  const c11 = await G.checkStandards(conn, COMPANY, { only: [STD3], bomDir: BOM_DIR });
  const s11 = c11.standards[0];
  const w11 = (await F.fixStandards({ pool, conn, companyId: COMPANY, standards: c11.standards, commit: true, sectionClass: 'BR', bomDir: BOM_DIR, log: () => {} })).results[0];
  const v3 = await F.copyVersion(conn, { companyId: COMPANY, userId: null }, s11.standardId, w11.versionId, { note: `Gaps filled from the drawing (test) over v${w11.versionNo}; section bars BR: 0 values, 0 sections, 0 flows` });
  const [lostNow] = await conn.query('UPDATE cf_master_records SET cut_stock_id = NULL WHERE company_id = ? AND id IN (?) AND cut_stock_id IS NOT NULL', [COMPANY, [...v3.idMap.values()]]);
  const v11Count = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM cf_standard_drawing_versions WHERE standard_id = ? AND deleted_at IS NULL', [s11.standardId]))[0][0].n);
  const [[v1Row]] = await conn.query('SELECT root_item_id FROM cf_standard_drawing_versions WHERE id = ?', [s11.versionId]);
  const [[v2Row]] = await conn.query('SELECT root_item_id FROM cf_standard_drawing_versions WHERE id = ?', [w11.versionId]);
  const olds = async () => JSON.stringify([await rowsOf(Number(v1Row.root_item_id)), await rowsOf(Number(v2Row.root_item_id)), await rowsOf(v3.rootId)]);
  const oldSig11 = await olds();
  const broken = (await G.checkStandards(conn, COMPANY, { only: [STD3], bomDir: BOM_DIR })).standards[0];
  ok(`11 the broken state: v3 current, its ${lostNow.affectedRows} bars gone, the fix would plan them again`, lostNow.affectedRows === 5 && broken.versionId === v3.versionId && F.fillableCount(broken, { sectionClass: 'BR' }) === 5);
  const dry11 = await R.repairStandards({ read: ro, companyId: COMPANY, only: [STD3], sectionClass: 'BR', commit: false, bomDir: BOM_DIR, log: () => {} });
  ok('11 the repair\'s dry run plans 5 bars restored and nothing else to fill', dry11.repaired === 1 && dry11.results[0].planned?.restore === 5 && dry11.results[0].planned?.fill === 0);
  const n0 = await v11Count();
  const rep = await R.repairStandards({ read: conn, conn, companyId: COMPANY, only: [STD3], sectionClass: 'BR', commit: true, bomDir: BOM_DIR, log: () => {} });
  const r11 = rep.results[0];
  const [[cur11]] = await conn.query('SELECT current_version_id FROM cf_standard_drawings WHERE id = ?', [s11.standardId]);
  ok(`11 the repair writes v4 (${r11.error ?? `${r11.restored} restored`}) and makes it current`, rep.repaired === 1 && r11.restored === 5 && r11.versionNo === v3.versionNo + 1 && Number(cur11.current_version_id) === r11.versionId && (await v11Count()) === n0 + 1);
  const bars2 = (await rowsOf(Number(v2Row.root_item_id))).map((r) => r.split('|')[1]);
  const bars4 = (await rowsOf(r11.rootId)).map((r) => r.split('|')[1]);
  ok('11 … v4 holds v2\'s bars, row for row', JSON.stringify(bars2) === JSON.stringify(bars4) && bars4.filter((b) => b !== 'null').length === 5);
  ok('11 … v1, v2 and v3 are untouched', (await olds()) === oldSig11);
  const again = await R.repairStandards({ read: conn, conn, companyId: COMPANY, only: [STD3], sectionClass: 'BR', commit: true, bomDir: BOM_DIR, log: () => {} });
  ok('11 a second repair run writes nothing', again.repaired === 0 && again.ok === 1 && (await v11Count()) === n0 + 1);
  const fixAfter = (await G.checkStandards(ro, COMPANY, { only: [STD3], bomDir: BOM_DIR })).standards[0];
  ok('11 … and the fix plans nothing on it', F.fillableCount(fixAfter, { sectionClass: 'BR' }) === 0);
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
