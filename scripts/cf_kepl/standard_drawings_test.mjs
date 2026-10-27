/**
 * standard_drawings_test.mjs — STANDARD DRAWINGS (init.sql §69, services/standardDrawingService.js,
 * lib/standardImport.js, routes/standards.js, scripts/cf_kepl/standard-import.mjs), against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/standard_drawings_test.mjs
 *   CF_STD_COMPANY=2 node scripts/cf_kepl/standard_drawings_test.mjs        (2 is the default: the local bridge catalog)
 *
 * User, 2026-10-16/17: a line can be made FROM a standard drawing (its BOM and values copied, editable); a line's
 * BOM can be SAVED onto a standard; a line made from a standard whose BOM was edited offers "update the standard too
 * (new version)" or "keep the standard as it is"; lines made earlier keep their own copy. And the importer loads the
 * RDSO girders onto the EXISTING catalog definitions, dry run first.
 *
 * It uses the company's real catalog on purpose — mapping onto the existing definitions is what is being proved —
 * and TM/drawing_bom/out/RDSO_11751R3 (+ 11753R3, 11754R3 for the round-trip check).
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last thing it does is re-count every table
 * it wrote and prove each is back where it started.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const STD = await imp('apps/cf_erp/services/standardDrawingService.js');
const PLAN = await imp('apps/cf_erp/lib/standardImport.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const REV = await imp('apps/cf_erp/services/revisionService.js');
const { protect } = await imp('core/middleware/authmiddleware.js');
const stdRoutes = (await imp('apps/cf_erp/routes/standards.js')).default;

const COMPANY = Number(process.env.CF_STD_COMPANY ?? 2);
const OUT = path.resolve(BE, '..', 'drawing_bom', 'out');

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) was called as ok(${typeof label}, ${typeof cond}).`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const alike = (got, want) => Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
const eq = (label, got, want) => ok(label, alike(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (label, got, want, tol = 1e-6) => ok(label, got != null && Math.abs(Number(got) - want) <= tol, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const COUNTED = [
  'cf_master_records', 'cf_item_details', 'cf_definition_details', 'cf_boms', 'cf_bom_lines', 'cf_spec_values', 'cf_spec_value_history',
  'cf_spec_assignments', 'cf_sales_orders', 'cf_sales_order_lines', 'cf_drawings', 'cf_drawing_links', 'cf_part_drawings',
  'cf_standard_drawings', 'cf_standard_drawing_versions', 'cf_standard_drawing_files',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) out[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}
const diff = (a, b) => COUNTED.filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);
async function roundTrips(conn, fn) {
  const real = conn.query.bind(conn);
  let n = 0;
  conn.query = (...a) => { n += 1; return real(...a); };
  try { return { out: await fn(), n }; } finally { conn.query = real; }
}
const routeOf = (router, method, routePath) => router.stack.find((l) => l.route?.path === routePath && l.route.methods[method])?.route ?? null;
const guardsOf = (route) => route.stack.slice(0, -1).map((l) => l.handle).filter((fn) => fn !== protect);
async function throughGuards(route, user) {
  const req = { user, params: { id: '1' }, body: {}, headers: {}, cookies: {} };
  for (const fn of guardsOf(route)) {
    let on = false; let status = null;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await fn(req, res, () => { on = true; });
    if (!on) return { reached: false, status };
  }
  return { reached: true, status: null };
}
const user = (tags) => ({ id: null, role: 'user', companyId: COMPANY, uiPermissions: tags });

// The written standards carry this run's tag in their number, so the suite runs beside a real import of the same set.
const TAG = Date.now().toString(36).toUpperCase();
function readSet(name, tagged = false) {
  const dir = path.join(OUT, name);
  const bom = JSON.parse(fs.readFileSync(path.join(dir, 'bom.json'), 'utf8'));
  if (tagged) bom.drawing.number = `${bom.drawing.number}-T${TAG}`;
  const files = fs.readdirSync(path.join(dir, 'dxf')).filter((f) => /\.dxf$/i.test(f)).map((n) => ({ name: n, text: fs.readFileSync(path.join(dir, 'dxf', n)).toString('latin1') }));
  return { bom, files };
}

/** Rows of a tree (a version's or a line's) by mark: [{ id, values: Map(CODE -> value row) }]. */
async function rowsByMark(db, rootIds) {
  const ids = []; let frontier = rootIds.map(Number);
  while (frontier.length) {
    ids.push(...frontier);
    const [kids] = await db.query(
      `SELECT l.child_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
         JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`, [COMPANY, frontier]);
    frontier = kids.map((k) => Number(k.child_id)).filter((id) => !ids.includes(id));
  }
  const [vals] = await db.query(
    `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number, v.value_text, v.option_id, v.source FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)`, [COMPANY, ids]);
  const by = new Map(ids.map((id) => [id, new Map()]));
  for (const v of vals) by.get(Number(v.subject_id)).set(v.code, v);
  const out = new Map();
  for (const [id, m] of by) { const mark = m.get('DRAWING_MARK')?.value_text ?? null; if (!out.has(mark)) out.set(mark, []); out.get(mark).push({ id, values: m }); }
  return { ids, byMark: out };
}
const numOf = (row, code) => (row?.values.get(code)?.value_number == null ? null : Number(row.values.get(code).value_number));

/* ========================================================================== */
const conn = await pool.getConnection();
attachNodeCache(conn);
const before = await counts(conn);
await conn.beginTransaction();
try {
  const [[u]] = await conn.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: u?.id ?? null };
  const s11751 = readSet('RDSO_11751R3');
  const t11751 = readSet('RDSO_11751R3', true);
  const T_REG = t11751.bom.drawing.number;
  const T_NUM = `${T_REG}R3`;

  /* ------------------------------------------------------------------------ */
  section('1. The plan (pure): the RDSO 24.4 m girder mapped onto the catalog');
  const catalog = await STD.importCatalog(conn, COMPANY);
  const plan = PLAN.planImport(s11751.bom, catalog);
  eq('the standard number is the sheet number and its revision', plan.standard.number, 'RDSO/B-11751R3');
  ok('it keeps the RDSO source link', /^https:\/\/rdso\.indianrailways\.gov\.in\//.test(plan.standard.sourceUrl ?? ''), plan.standard.sourceUrl);
  ok('it is marked internal (RDSO property)', plan.standard.internal === true);
  eq('56 rows, 47 of them parts', [plan.totals.rows, plan.totals.parts], [56, 47]);
  near('its steel is bom.json\'s steel to the kilogram', plan.totals.steelKg, s11751.bom.totals.steelKg, 1);
  near('with the studs it is bom.json\'s total too', plan.totals.steelKg + plan.totals.studKg, s11751.bom.totals.steelKgInclStuds, 1);
  const byWhat = (mark) => plan.rows.filter((r) => r.mark === mark);
  const defName = (mark) => byWhat(mark).map((r) => r.def?.name ?? r.def?.new);
  eq('the span is a Bridge span', plan.rows[0].def.name, 'Bridge span');
  eq('TF1 is a Top flange (twice: segments GA and GC)', defName('TF1'), ['Top flange', 'Top flange']);
  ok('WP1 is the catalog\'s web plate', PLAN.normName(defName('WP1')[0]) === 'web plate', defName('WP1')[0]);
  ok('IS1 (no holes) is the plain intermediate stiffener, IS2 (holed) the holed one',
    PLAN.normName(defName('IS1')[0]) === 'intermediate stiffener plain' && PLAN.normName(defName('IS2')[0]) === 'intermediate stiffener holed', `${defName('IS1')[0]} / ${defName('IS2')[0]}`);
  ok('BS1 plain, BS2 holed bearing stiffener', PLAN.normName(defName('BS1')[0]) === 'bearing stiffener plain' && PLAN.normName(defName('BS2')[0]) === 'bearing stiffener holed');
  ok('GUS3 (one per frame, no holes) is the centre gusset', PLAN.normName(defName('GUS3')[0]) === 'centre gusset', defName('GUS3')[0]);
  ok('ANG4 (top/bottom) is split into the top and the bottom angle of the frame',
    alike(defName('ANG4').map(PLAN.normName), ['x frame top angle', 'x frame bottom angle']) && alike(byWhat('ANG4').map((r) => r.quantity), [1, 1]), JSON.stringify(defName('ANG4')));
  ok('FCP3 is the bottom flange outer cover plate', PLAN.normName(defName('FCP3')[0]) === 'bottom flange outer cover plate');
  ok('PP2 is the packing plate', PLAN.normName(defName('PP2')[0]) === 'packing plate');
  const news = plan.newDefinitions.map((d) => d.name).sort();
  ok('only parts nothing fits get a new definition (the restrainer plates)', news.every((n) => /^Restrainer/.test(n)), JSON.stringify(news));
  says(`new: ${news.join(', ') || 'none'}`);
  ok('studs are the Shear stud selection, left to choose when no 25 x 200 stud is in the catalog',
    byWhat('TS').every((r) => r.kind === 'selection' && (r.chosen || /Choose the stud/.test(r.notes ?? ''))));
  eq('bearings and HSFG bolts are bought out: listed, not rows', plan.bought.map((b) => b.mark), ['NB', 'NB-AB', 'GBRG', 'GBRG-AB', 'HSFG-M22']);
  ok('a part with a drilling caution carries it as a note (BF1..BF6)', ['BF1', 'BF2', 'BF3', 'BF4', 'BF5', 'BF6'].every((m) => /drill/i.test(byWhat(m)[0]?.notes ?? '')));
  const tf1 = byWhat('TF1')[0];
  const v = (r, code) => r.values.find((x) => x.code === code);
  ok('TF1 holds thickness, width, length, grade E250 and its mark', v(tf1, 'THICKNESS')?.number === 32 && v(tf1, 'WIDTH')?.number === 480 && v(tf1, 'LENGTH')?.number === 7925 && v(tf1, 'GRADE')?.display === 'E250' && v(tf1, 'DRAWING_MARK')?.text === 'TF1');
  const ang1 = byWhat('ANG1')[0];
  eq('an angle holds its section area t (2a - t)', v(ang1, 'SECTION_AREA')?.number, 12 * (2 * 130 - 12));
  // The flag carried for "drill on assembly" / "needs decision", whatever the set says today.
  eq('rowNote: DRILL ON ASSEMBLY', PLAN.rowNote({ status: 'drill on assembly', notes: ['DRILL ON ASSEMBLY: bracing holes'] }), 'DRILL ON ASSEMBLY: bracing holes');
  eq('rowNote: an open decision', PLAN.rowNote({ decisions: ['C9'] }, [{ id: 'C9', what: 'hole positions', status: 'needs decision' }]), 'NEEDS DECISION C9: hole positions');
  eq('rowNote: nothing to say', PLAN.rowNote({ status: 'ok', notes: ['weld only'] }), null);
  // The span maps to an EXISTING span definition before a new one (production: "Composite girder span", SPAN-001).
  const spanDef = (id, code, name) => ({ id, code, name, short_name: null, status: 'active', classification_id: 1, default_flow_id: null, definition_type: 'template', bom_id: null });
  const noBridge = { ...catalog, defs: catalog.defs.filter((d) => PLAN.normName(d.name) !== 'bridge span') };
  const p1 = PLAN.planImport(s11751.bom, { ...noBridge, defs: [...noBridge.defs, spanDef(-1, 'SPAN-001', 'Composite girder span'), spanDef(-2, 'SPAN-009', 'Other span')] });
  eq('the root takes SPAN-001 when the catalog has it', p1.rows[0].def.name, 'Composite girder span');
  const p2 = PLAN.planImport(s11751.bom, { ...noBridge, defs: [...noBridge.defs, spanDef(-2, 'X-9', 'Steel span')] });
  eq('…else any definition named "… span"', p2.rows[0].def.name, 'Steel span');
  ok('…and never a new "Bridge span"', !p1.newDefinitions.some((d) => /span/i.test(d.name)) && !p2.newDefinitions.some((d) => /span/i.test(d.name)));
  // An older set: a sentence where the revision goes, channels, legacy grades, bronze plates.
  const s1623 = readSet('RDSO_1623');
  const p1623 = PLAN.planImport(s1623.bom, catalog);
  eq('a sentence in the revision field is a note, not part of the number', [p1623.standard.number, p1623.standard.revision], ['RDSO/B-1623', null]);
  near('its weight is the steel + non-steel of bom.json to the kilogram', p1623.totals.steelKg, s1623.bom.totals.steelKg + (s1623.bom.totals.nonSteelKg ?? 0), 1);
  const tc = p1623.rows.find((r) => r.mark === 'TC');
  const vv = (r, code) => r.values.find((x) => x.code === code)?.number;
  ok('a channel holds depth 250, width 80 and its section area from the weight in bom.json', vv(tc, 'DEPTH') === 250 && vv(tc, 'WIDTH') === 80 && vv(tc, 'SECTION_AREA') > 0, JSON.stringify(tc.values));
  ok('a new definition is named plainly (no brackets, no section size)', p1623.newDefinitions.every((d) => !/[()]|ISMC|ISLC/i.test(d.name)), JSON.stringify(p1623.newDefinitions.map((d) => d.name)));
  ok('a grade that is not an option is said once per grade, with its count', p1623.problems.filter((x) => /Grade/.test(x)).length <= 3);

  // User decisions, 2026-10-17: the old IS grades, impact classes, phosphor bronze.
  const rowOf = (plan, mark) => plan.rows.find((r) => r.mark === mark && r.kind === 'temp');
  const optOf = (r, code) => r?.values.find((x) => x.code === code);
  const grB = p1623.rows.find((r) => /Gr\s*B/i.test(r.item?.grade ?? ''));
  const grA = p1623.rows.find((r) => /IS\s*226|Gr\s*A/i.test(r.item?.grade ?? '') && !/Gr\s*B/i.test(r.item?.grade ?? ''));
  ok('IS 2062-84 Gr B → GRADE E250 and IMPACT_CLASS BR, with the original grade as a note',
    optOf(grB, 'GRADE')?.display === 'E250' && optOf(grB, 'IMPACT_CLASS')?.optionValue === 'BR' && /Original grade on drawing: IS 2062-84 Gr B/.test(grB.notes ?? ''), JSON.stringify(grB?.values));
  ok('IS 226 / Gr A → GRADE E250 and IMPACT_CLASS A', optOf(grA, 'GRADE')?.display === 'E250' && optOf(grA, 'IMPACT_CLASS')?.optionValue === 'A' && /Original grade on drawing/.test(grA.notes ?? ''));
  const pb = p1623.rows.find((r) => /PHOSPHOR/i.test(r.item?.description ?? ''));
  ok('a phosphor bronze plate: no GRADE, MATERIAL PB, and its definition holds MATERIAL PB too',
    !optOf(pb, 'GRADE') && optOf(pb, 'MATERIAL')?.optionValue === 'PB' && p1623.definitionValues.some((d) => (d.def.name ?? d.def.new) === 'Phosphor bronze plate' && d.value.optionValue === 'PB'));
  eq('the grade counts per set', [p1623.gradeMap.legacyE250, p1623.gradeMap.impactBR, p1623.gradeMap.impactA, p1623.gradeMap.bronze, p1623.gradeMap.missed], [29, 18, 11, 1, 0]);
  // Mapping overrides onto production's names, and the restrainer under a Seismic stopper.
  const prodNames = [spanDef(-11, 'SFP', 'Stiffener plate'), spanDef(-12, 'BKT', 'Bracket plate'), spanDef(-13, 'ACL', 'Angle cleat'),
    spanDef(-14, 'STP', 'Seismic stopper'), spanDef(-15, 'XTA', 'X-frame top angle'), spanDef(-16, 'XBA', 'X-frame bottom angle')];
  const prodLike = { ...catalog, defs: [...catalog.defs.filter((d) => !['stiffener plate', 'bracket plate', 'angle cleat', 'seismic stopper'].includes(PLAN.normName(d.name))), ...prodNames] };
  const pS = PLAN.planImport(s11751.bom, prodLike);
  const rsp = rowOf(pS, 'RSP'); const rp = rowOf(pS, 'RP');
  eq('RSP → Stiffener plate (SFP)', rsp?.def?.code, 'SFP');
  const stopper = pS.rows.find((r) => r.key === rp?.parentKey);
  ok('RP and its RSPs sit under a Seismic stopper (STP), in the segment', stopper?.def?.code === 'STP' && rsp.parentKey === stopper.key && pS.rows.find((r) => r.key === stopper.parentKey)?.node?.kind === 'girder_segment');
  near('…and the weight is the same', pS.totals.steelKg, plan.totals.steelKg, 0.01);
  ok('no "Seismic stopper" in the catalog: they stay direct parts, and the plan says so', rowOf(plan, 'RP').parentKey === plan.rows.find((r) => r.mark === 'GA')?.key || plan.info.some((x) => /Seismic stopper/.test(x)));
  const s1534 = readSet('RDSO_1534R');
  const p1534 = PLAN.planImport(s1534.bom, prodLike);
  eq('Jacking bracket plate → Bracket plate (BKT); its angle → Angle cleat (ACL)', [rowOf(p1534, 'JP')?.def?.code, rowOf(p1534, 'JA')?.def?.code], ['BKT', 'ACL']);
  const p516 = PLAN.planImport(readSet('RDSO_516').bom, prodLike);
  const ha = p516.rows.filter((r) => r.mark === 'HA');
  ok('RDSO_516 HA (not told top from bottom) → X-frame top and bottom angles, split evenly, with a note',
    ha.length === 4 && ha.filter((r) => r.def?.code === 'XTA').reduce((a, r) => a + r.quantity, 0) === 3 && ha.filter((r) => r.def?.code === 'XBA').reduce((a, r) => a + r.quantity, 0) === 3 && ha.every((r) => /split evenly/.test(r.notes ?? '')), JSON.stringify(ha.map((r) => [r.def?.code, r.quantity])));

  /* ------------------------------------------------------------------------ */
  section('2. The importer: dry run reads only; --apply writes it in one go');
  const c0 = await counts(conn);
  const dry = await roundTrips(conn, () => STD.importStandard(conn, c, { ...t11751, apply: false }));
  ok('a dry run writes nothing', diff(c0, await counts(conn)).length === 0);
  ok('a dry run is a handful of reads', dry.n <= 6, `${dry.n}`);
  eq('every part file is read as a shape', dry.out.report.files.filter((f) => f.read).length, s11751.files.length);
  const applied = await roundTrips(conn, () => STD.importStandard(conn, c, { ...t11751, apply: true }));
  const w = applied.out.report.written;
  says(`apply: ${applied.n} round trips (incl. ${w.newDefinitions.length} new definitions)`);
  ok('the standard, its version and its register drawing are written', !!(w.standardId && w.versionId && w.drawingId));
  const [[std]] = await conn.query('SELECT * FROM cf_standard_drawings WHERE id = ?', [w.standardId]);
  const [[ver]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE id = ?', [w.versionId]);
  const [[reg]] = await conn.query('SELECT * FROM cf_drawings WHERE id = ?', [w.drawingId]);
  ok('version 1, current, 56 rows', Number(ver.version_no) === 1 && Number(std.current_version_id) === Number(ver.id) && Number(ver.rows_count) === 56);
  ok('the register drawing is the customer\'s RDSO/B-11751 rev R3 with the link', reg.number === T_REG && reg.revision === 'R3' && reg.source === 'customer' && /rdso/.test(reg.url ?? ''));
  ok('the standard is internal and lists what is bought out', Number(std.internal) === 1 && /HSFG/.test(std.notes ?? '') && /internal/i.test(std.notes ?? ''));
  const vt = await rowsByMark(conn, [ver.root_item_id]);
  eq('56 rows under the version\'s root', vt.ids.length, 56);
  const [owners] = await conn.query('SELECT COUNT(*) AS n FROM cf_item_details WHERE master_id IN (?) AND owner_order_line_id IS NOT NULL', [vt.ids]);
  eq('a standard\'s rows belong to no order line', Number(owners[0].n), 0);
  const vTf1 = vt.byMark.get('TF1')[0];
  ok('TF1 on the standard: 32 × 480 × 7925, typed values', numOf(vTf1, 'THICKNESS') === 32 && numOf(vTf1, 'WIDTH') === 480 && numOf(vTf1, 'LENGTH') === 7925 && vTf1.values.get('THICKNESS').source === 'entered');
  near('the root holds the span\'s weight', numOf(vt.byMark.get(null).find((r) => r.id === Number(ver.root_item_id)), 'WEIGHT'), s11751.bom.totals.steelKg, 1);
  const [files] = await conn.query("SELECT mark, drawing_id, geometry_json IS NOT NULL AS shaped FROM cf_standard_drawing_files WHERE version_id = ? AND kind = 'part' AND deleted_at IS NULL", [ver.id]);
  ok('36 part files, every one with its shape and its own register revision', files.length === 36 && files.every((f) => Number(f.shaped) && f.drawing_id));
  const [notes] = await conn.query(
    `SELECT l.notes FROM cf_bom_lines l JOIN cf_spec_values v ON v.subject_id = l.child_id AND v.deleted_at IS NULL JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
      WHERE l.child_id IN (?) AND v.value_text = 'BF1' AND l.deleted_at IS NULL`, [vt.ids]);
  ok('the BF1 row\'s BOM line carries its drilling note', notes.length === 1 && /drill/i.test(notes[0].notes ?? ''));
  const [links] = await conn.query("SELECT SUM(note IS NULL) AS n, SUM(note = 'Sheet of the standard') AS sheets FROM cf_drawing_links WHERE subject_id IN (?) AND deleted_at IS NULL", [vt.ids]);
  eq('each part row is linked to its drawing, the root to the sheet (47 + 1)', Number(links[0].n), 48);
  ok('and the other sheets of the series are on the assembly rows (2026-10-27: drawings at the structure levels)', Number(links[0].sheets) >= 10, `${links[0].sheets}`);
  const again = await refusal(() => STD.importStandard(conn, c, { ...t11751, apply: true }));
  ok('importing the same number again is refused', again?.code === 'DUPLICATE', again?.message);
  // Round trips do not grow with the tree: 18.3 m and 30.5 m sets differ in rows and files, not in statements.
  const a3 = await roundTrips(conn, () => STD.importStandard(conn, c, { ...readSet('RDSO_11753R3', true), apply: true }));
  const a4 = await roundTrips(conn, () => STD.importStandard(conn, c, { ...readSet('RDSO_11754R3', true), apply: true }));
  says(`11753R3: ${a3.out.report.written.rows} rows, ${a3.n} trips · 11754R3: ${a4.out.report.written.rows} rows, ${a4.n} trips`);
  ok('the same number of round trips for two sets of different sizes', a3.n === a4.n && a3.out.report.written.newDefinitions.length === 0, `${a3.n} vs ${a4.n}`);
  ok('…and few of them (production ~49 ms each)', a3.n <= 40, `${a3.n}`);
  // Where the setup step already ran on this DB the first try simply applies: a savepoint takes it back, so the import
  // below is the one made after the setup step, as on a fresh DB.
  await conn.query('SAVEPOINT before_1623');
  const noSetup = await refusal(() => STD.importStandard(conn, c, { ...readSet('RDSO_1623', true), apply: true }));
  await conn.query('ROLLBACK TO SAVEPOINT before_1623');
  const [[aOpt]] = await conn.query("SELECT COUNT(*) AS n FROM cf_spec_options o JOIN cf_specifications s ON s.id = o.specification_id WHERE o.company_id = ? AND s.code = 'IMPACT_CLASS' AND o.value = 'A' AND o.deleted_at IS NULL", [COMPANY]);
  if (!Number(aOpt.n)) ok('an older set without the setup step is refused, and says to run it', noSetup?.code === 'OPTIONS_MISSING', noSetup?.message);
  const setup1 = await STD.importSetup(conn, c, { apply: true });
  const setup2 = await STD.importSetup(conn, c, { apply: false });
  says(`setup: ${setup1.actions.map((a) => a.what).join(' · ') || 'nothing to do'}`);
  eq('the setup step is idempotent: a second run has nothing to do', setup2.actions.filter((a) => !a.problem).length, 0);
  const [[bo]] = await conn.query("SELECT o.label FROM cf_spec_options o JOIN cf_specifications s ON s.id = o.specification_id WHERE o.company_id = ? AND s.code = 'IMPACT_CLASS' AND o.value = 'BO' AND o.deleted_at IS NULL", [COMPANY]);
  eq('the BO impact class reads just "BO"', bo?.label, 'BO');
  const t1623 = await STD.importStandard(conn, c, { ...readSet('RDSO_1623', true), apply: true });
  const [[v1623]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE id = ?', [t1623.report.written.versionId]);
  const r1623 = await rowsByMark(conn, [v1623.root_item_id]);
  ok('an older set applies too: its rows, its new definitions made once', r1623.ids.length === Number(v1623.rows_count) && t1623.report.written.newDefinitions.length === new Set(t1623.plan.newDefinitions.map((d) => d.name)).size, `${r1623.ids.length} rows, ${t1623.report.written.newDefinitions.length} new`);
  says(`RDSO_1623: ${r1623.ids.length} rows, new: ${t1623.report.written.newDefinitions.map((d) => d.name).join(', ')}`);
  const [impact] = await conn.query(
    `SELECT o.value, COUNT(*) AS n FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'IMPACT_CLASS'
       JOIN cf_spec_options o ON o.id = v.option_id WHERE v.subject_id IN (?) AND v.deleted_at IS NULL GROUP BY o.value ORDER BY o.value`, [r1623.ids]);
  eq('…its rows hold IMPACT_CLASS A ×11 and BR ×18', impact.map((x) => [x.value, Number(x.n)]), [['A', 11], ['BR', 18]]);
  // New on a fresh DB; on one where an earlier import already made it, the import reuses it — take it from the rows.
  const [[usedPb]] = await conn.query(
    `SELECT d.id FROM cf_item_details i JOIN cf_master_records d ON d.id = i.source_definition_id
      WHERE i.master_id IN (?) AND d.name = 'Phosphor bronze plate' AND i.deleted_at IS NULL LIMIT 1`, [r1623.ids]);
  const pbDef = t1623.report.written.newDefinitions.find((d) => d.name === 'Phosphor bronze plate') ?? (usedPb ? { id: usedPb.id } : undefined);
  ok('the 1623 rows use a "Phosphor bronze plate" definition', !!pbDef);
  const [[pbv]] = await conn.query(
    `SELECT o.value FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'MATERIAL' JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL`, [pbDef?.id ?? 0]);
  eq('…and the new "Phosphor bronze plate" definition holds MATERIAL PB', pbv?.value, 'PB');
  // MATERIAL is a FIXED rule on Parts: the row takes the nearest value above it — its definition's PB, not Mild steel.
  const [[pbRow]] = await conn.query("SELECT i.master_id FROM cf_item_details i WHERE i.source_definition_id = ? AND i.master_id IN (?) AND i.deleted_at IS NULL LIMIT 1", [pbDef?.id ?? 0, r1623.ids]);
  const RES = await imp('apps/cf_erp/services/resolutionService.js');
  const { loadMaster } = await imp('apps/cf_erp/services/records.js');
  const resolved = pbRow ? RES.effectiveByCode(await RES.resolve(conn, COMPANY, { master: await loadMaster(conn, COMPANY, pbRow.master_id) })) : new Map();
  const mat = resolved.get?.('MATERIAL') ?? resolved.MATERIAL;
  ok('…so its rows resolve MATERIAL = Phosphor bronze', /PB|Phosphor/i.test(JSON.stringify(mat ?? null)), JSON.stringify(mat ?? null));

  /* ------------------------------------------------------------------------ */
  section('3. The list and the detail');
  const list = await STD.listStandards(conn, COMPANY, { search: T_REG });
  const row = list.rows.find((r) => r.id === Number(w.standardId));
  ok('the list shows it: number, version 1, 56 rows, 36 files', !!row && row.version?.versionNo === 1 && row.version.rows === 56 && row.files === 36, JSON.stringify(row?.version));
  const det = await STD.getStandard(conn, COMPANY, w.standardId);
  ok('the detail tree has every row and each stud line', det.tree.filter((t) => t.kind === 'row').length === 56 && det.tree.filter((t) => t.kind !== 'row').length === 4);
  const dTf1 = det.tree.find((t) => t.mark === 'TF1');
  ok('TF1 in the tree: its size, grade, weight and its file', dTf1.sizeText === '32 × 480 × 7925' && dTf1.grade === 'E250' && dTf1.weightKg > 955 && !!dTf1.fileId);
  ok('the GA segment\'s TF1 totals 2 per span (2 girders)', dTf1.total === 2);
  const file = await STD.standardFile(conn, COMPANY, dTf1.fileId);
  ok('its DXF can be read back', /SECTION/.test(file.buffer.toString('latin1')) && file.contentType === 'application/dxf');

  /* ------------------------------------------------------------------------ */
  section('4. A line FROM the standard: a deep copy, editable');
  const [[cust]] = await conn.query('SELECT id FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const order = await SO.createOrder(conn, c, { orderType: 'customer', customerId: cust.id, title: 'standard drawings test' });
  const made = await roundTrips(conn, () => STD.addLineFromStandard(conn, c, order.id, { number: T_NUM.toLowerCase(), quantity: 2 }));
  says(`a line from the standard: ${made.n} round trips (copy, values, names, drawings, cut pieces)`);
  const lineA = made.out.lines.find((l) => l.id === made.out.fromStandard.lineId);
  ok('found by its number, case does not matter; the line says where it came from', lineA?.standard?.number === T_NUM && lineA.standard.versionNo === 1);
  eq('quantity 2, 56 rows of its own', [lineA.quantity, lineA.structure?.temporaryItems], [2, 56]);
  const lt = await rowsByMark(conn, [lineA.item.id]);
  ok('none of its rows is the standard\'s', lt.ids.every((id) => !vt.ids.includes(id)));
  const lTf1 = lt.byMark.get('TF1')[0];
  ok('the values came with it (TF1 32 × 480 × 7925, E250)', numOf(lTf1, 'THICKNESS') === 32 && numOf(lTf1, 'LENGTH') === 7925 && lTf1.values.get('GRADE')?.option_id === vTf1.values.get('GRADE')?.option_id);
  const [pd] = await conn.query('SELECT COUNT(*) AS n, SUM(drawing_id IS NOT NULL) AS reg, SUM(geometry_json IS NOT NULL) AS shaped FROM cf_part_drawings WHERE order_line_id = ? AND deleted_at IS NULL', [lineA.id]);
  ok('its 36 part drawings are on the line, each on its register revision, with its shape', Number(pd[0].n) === 36 && Number(pd[0].reg) === 36 && Number(pd[0].shaped) === 36);
  const [ll] = await conn.query('SELECT COUNT(*) AS n FROM cf_drawing_links WHERE subject_id IN (?) AND deleted_at IS NULL', [lt.ids]);
  eq('the rows are linked to the same drawings (48 links + the sheets on the assembly rows)', Number(ll[0].n), 48 + Number(links[0].sheets));
  const view = await (await imp('apps/cf_erp/services/partDrawingService.js')).getDrawings(conn, COMPANY, order.id, lineA.id);
  ok('the Drawings screen finds every part row\'s file by its mark', view.summary.rows > 0 && view.drawings.length === 36 && view.drawings.every((d) => d.rows.length >= 1), JSON.stringify(view.summary));
  const stA = await STD.lineStandard(conn, COMPANY, lineA.id);
  ok('unedited: nothing to offer', stA.edited === false && stA.offer === null, JSON.stringify({ e: stA.edited, o: stA.offer }));

  /* ------------------------------------------------------------------------ */
  section('5. Edit a line made from the standard: update the standard (new version), or keep it');
  const madeB = await STD.addLineFromStandard(conn, c, order.id, { standardId: w.standardId, quantity: 1 });
  const lineB = madeB.lines.find((l) => l.id === madeB.fromStandard.lineId);
  const bt = await rowsByMark(conn, [lineB.item.id]);
  const bTf1 = bt.byMark.get('TF1').map((r) => r.id);
  await OV.writeLineValues(conn, c, lineB.id, { writes: bTf1.map((id) => ({ recordId: id, specCode: 'THICKNESS', value: 34 })) });
  let stB = await STD.lineStandard(conn, COMPANY, lineB.id);
  ok('a typed change makes it "edited", and the screen offers the update', stB.edited === true && stB.offer === 'update');
  stB = await STD.keepStandard(conn, c, lineB.id);
  ok('"Keep the standard as it is": no more offer for this BOM', stB.kept === true && stB.offer === null);
  await OV.writeLineValues(conn, c, lineB.id, { writes: bTf1.map((id) => ({ recordId: id, specCode: 'WIDTH', value: 500 })) });
  stB = await STD.lineStandard(conn, COMPANY, lineB.id);
  ok('…a further change asks again', stB.offer === 'update' && stB.kept === false);
  const saved = await STD.saveLineToStandard(conn, c, lineB.id, { note: 'TF1 34 × 500 (test)' });
  ok('"Update the standard too": version 2, current, the line counts as made from it', saved.saved.versionNo === 2 && saved.version?.versionNo === 2 && saved.edited === false && saved.offer === null);
  const [[std2]] = await conn.query('SELECT current_version_id FROM cf_standard_drawings WHERE id = ?', [w.standardId]);
  eq('the standard\'s current version is the new one', Number(std2.current_version_id), saved.saved.versionId);
  const [[v2]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE id = ?', [saved.saved.versionId]);
  const v2t = await rowsByMark(conn, [v2.root_item_id]);
  ok('version 2 holds the change (TF1 34 × 500)', numOf(v2t.byMark.get('TF1')[0], 'THICKNESS') === 34 && numOf(v2t.byMark.get('TF1')[0], 'WIDTH') === 500);
  eq('…and the same 56 rows (cut plates of the line not copied)', v2t.ids.length, 56);
  const [defaulted] = await conn.query("SELECT COUNT(*) AS n FROM cf_spec_values WHERE subject_id IN (?) AND source = 'defaulted' AND deleted_at IS NULL", [v2t.ids]);
  eq('values the order gave the line are not put on the standard', Number(defaulted[0].n), 0);
  const [f2] = await conn.query("SELECT COUNT(*) AS n FROM cf_standard_drawing_files WHERE version_id = ? AND deleted_at IS NULL", [v2.id]);
  eq('the line\'s part files come with version 2', Number(f2[0].n), 36);
  const v1again = await rowsByMark(conn, [ver.root_item_id]);
  ok('version 1 is untouched (TF1 still 32 × 480)', numOf(v1again.byMark.get('TF1')[0], 'THICKNESS') === 32 && numOf(v1again.byMark.get('TF1')[0], 'WIDTH') === 480);
  const ltAgain = await rowsByMark(conn, [lineA.item.id]);
  ok('the EARLIER line keeps its own copy (TF1 32)', numOf(ltAgain.byMark.get('TF1')[0], 'THICKNESS') === 32);
  const stA2 = await STD.lineStandard(conn, COMPANY, lineA.id);
  ok('…still made from version 1, told a newer one exists, nothing to offer', stA2.version?.versionNo === 1 && stA2.newer === true && stA2.offer === null);
  const madeC = await STD.addLineFromStandard(conn, c, order.id, { standardId: w.standardId, quantity: 1 });
  const lineC = madeC.lines.find((l) => l.id === madeC.fromStandard.lineId);
  const ct = await rowsByMark(conn, [lineC.item.id]);
  ok('a NEW line takes the new version (TF1 34)', lineC.standard.versionNo === 2 && numOf(ct.byMark.get('TF1')[0], 'THICKNESS') === 34);
  const madeOld = await STD.addLineFromStandard(conn, c, order.id, { standardId: w.standardId, versionId: w.versionId, quantity: 1 });
  ok('…an earlier version can still be asked for by id', madeOld.fromStandard.versionNo === 1);

  /* ------------------------------------------------------------------------ */
  section('6. Upload a drawing for a line, "this is a standard": then save its BOM onto it');
  const [[span]] = await conn.query("SELECT id FROM cf_master_records WHERE company_id = ? AND record_kind = 'definition' AND name = 'Girder segment' AND status = 'active' AND deleted_at IS NULL LIMIT 1", [COMPANY]);
  const withD = await SO.addOrderLine(conn, c, order.id, { recordId: span.id, quantity: 1 });
  const lineD = withD.lines[withD.lines.length - 1];
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1').toString('base64');
  const createdD = await STD.createStandard(conn, c, { number: `STD-TEST-${Date.now().toString(36)}`, name: 'Test girder segment', revision: 'B', sourceUrl: 'https://example.com/std.pdf', file: { name: 'GS-GA.pdf', content: pdf } }, { lineId: lineD.id });
  ok('the standard is made with its sheet in the register, no BOM yet', createdD.versions.length === 0 && createdD.drawing?.revision === 'B' && createdD.files.some((f) => f.kind === 'source'));
  const [[lD]] = await conn.query('SELECT standard_id, standard_version_id FROM cf_sales_order_lines WHERE id = ?', [lineD.id]);
  eq('the line is tied to it', [Number(lD.standard_id), lD.standard_version_id], [createdD.id, null]);
  const [rootFile] = await conn.query('SELECT drawing_id, file_kind FROM cf_part_drawings WHERE order_line_id = ? AND deleted_at IS NULL', [lineD.id]);
  ok('the file also went on the line\'s top row, on the standard\'s register drawing', rootFile.length === 1 && Number(rootFile[0].drawing_id) === Number(createdD.drawing.id) && rootFile[0].file_kind === 'pdf');
  const stD = await STD.lineStandard(conn, COMPANY, lineD.id);
  eq('it offers "Save this BOM to the standard"', stD.offer, 'save');
  const dup = await refusal(() => STD.createStandard(conn, c, { number: createdD.number.toLowerCase(), name: 'again' }));
  ok('a second standard with the same number is refused', dup?.code === 'DUPLICATE');
  const savedD = await STD.saveLineToStandard(conn, c, lineD.id, {});
  ok('saving makes version 1 from the line', savedD.saved.versionNo === 1 && savedD.offer === null);
  const fromD = await STD.addLineFromStandard(conn, c, order.id, { number: createdD.number, quantity: 1 });
  const lineE = fromD.lines.find((l) => l.id === fromD.fromStandard.lineId);
  ok('…and a line made from it by number gets that BOM', lineE.structure?.temporaryItems === lineD.structure?.temporaryItems && lineE.design.id === span.id);
  const noBom = await refusal(async () => {
    const x = await STD.createStandard(conn, c, { number: `STD-EMPTY-${Date.now().toString(36)}` });
    return STD.addLineFromStandard(conn, c, order.id, { standardId: x.id, quantity: 1 });
  });
  ok('a standard with no BOM yet cannot make a line, and says why', noBom?.code === 'NO_BOM', noBom?.message);
  if (noBom) says(noBom.message);

  /* ------------------------------------------------------------------------ */
  section('7. A revision of the order keeps where each line came from');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [lineA.id]);
  const rev2 = await REV.reviseOrder(conn, c, order.id);
  const a2 = rev2.lines.find((l) => l.lineNo === lineA.lineNo);
  ok('the revised line still names its standard and version', a2?.standard?.id === Number(w.standardId) && a2.standard.versionNo === 1);

  /* ------------------------------------------------------------------------ */
  section('8. Who may do what');
  const list403 = await throughGuards(routeOf(stdRoutes, 'get', '/standard-drawings'), user([]));
  const listOk = await throughGuards(routeOf(stdRoutes, 'get', '/standard-drawings'), user(['cf_erp_orders_view']));
  const listCat = await throughGuards(routeOf(stdRoutes, 'get', '/standard-drawings'), user(['cf_erp_catalog_view']));
  ok('reading needs the orders view or the catalog view grant', !list403.reached && listOk.reached && listCat.reached);
  const fromView = await throughGuards(routeOf(stdRoutes, 'post', '/orders/:id/lines/from-standard'), user(['cf_erp_orders_view']));
  const fromManage = await throughGuards(routeOf(stdRoutes, 'post', '/orders/:id/lines/from-standard'), user(['cf_erp_orders_manage']));
  ok('making a line from a standard needs the orders manage grant', !fromView.reached && fromManage.reached);
  const saveView = await throughGuards(routeOf(stdRoutes, 'post', '/order-lines/:id/standard/save'), user(['cf_erp_orders_view']));
  ok('saving a BOM onto a standard needs it too', !saveView.reached);
} catch (err) {
  failed += 1;
  fails.push(`crashed: ${err.message}`);
  console.log(`\n  CRASH ${err.stack ?? err.message}${err.problems ? `\n  ${err.problems.join('\n  ')}` : ''}`);
} finally {
  await conn.rollback();
  const after = await counts(conn);
  const d = diff(before, after);
  ok('rolled back: every table is where it started', d.length === 0, d.join(', '));
  detachNodeCache(conn);
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) console.log(`Failed:\n  ${fails.join('\n  ')}`);
process.exit(failed ? 1 : 0);
