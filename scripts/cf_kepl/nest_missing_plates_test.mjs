/**
 * nest_missing_plates_test.mjs — plates an uploaded nesting is cut on that the catalog does not
 * have (2026-10-14): the preview lists them (`missingPlates`), POST …/nesting/plates adds them
 * (services/nestPlateCatalogService.js), and the same preview then finds them. Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_missing_plates_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK, and every cf_ table is re-counted at the end. IT OWNS ITS FIXTURE,
 * every code and name tagged with a run id: its own branch of the classification for plates (Steel
 * › Plates › Plate) with its own rules — size, grade and impact class entered, material and density
 * fixed, WEIGHT by its own formula, PLATE_KIND defaulted to CUSTOM — its own options, its own coding
 * rule (short name - thickness X width X length - grade + impact class, as the tenant's reads), three
 * catalog plates (11, 14 and 36 mm × 6000 × 2000), cut settings, an order, a line and one cut piece:
 * the 9 mm packing the real 10 mm job of TM/NECL_48M_NESTING_NIF nests on 10 mm plate. For the length
 * of the transaction the company's raw plate stock place is THIS branch only, so the tenant's own
 * plates are not in the picture.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const P = await imp('apps/cf_erp/services/nestPlateCatalogService.js');
const M = await imp('apps/cf_erp/services/masterRecordService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const NIF = await imp('apps/cf_erp/lib/nifReader.js');
const { cutPlaces } = await imp('apps/cf_erp/lib/cutPlaces.js');
const D = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const DIR = path.resolve(BE, '../NECL_48M_NESTING_NIF');
const DENSITY = 7850;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 1200)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

/** Counts the round trips made through it. */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (target, prop) => (prop === 'query' || prop === 'execute' ? (...args) => { tally.n += 1; return target[prop](...args); } : Reflect.get(target, prop)) });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'missing plates test' };

/* ───────────────────────────── the shop's file ───────────────────────────── */
const J10 = (() => { const name = '10MM-NECL-PATNA.nif'; const buffer = fs.readFileSync(path.join(DIR, name)); return { filename: name, buffer, file: buffer.toString('base64'), doc: NIF.readNif(buffer, { filename: name }) }; })();

/* ───────────────────────────── the fixture ───────────────────────────── */
async function buildFixture(db) {
  const tag = `MP${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase()}`;
  const places = (await cutPlaces(db, COMPANY)).plate;
  if (!places.placeId || !places.blanksNodeId) throw new Error(`Company ${COMPANY} has no place set for plate cut pieces (Setup › Cutting).`);
  const cutNode = places.blanksNodeId;

  // Its own branch for raw plates: Steel › Plates › Plate — and, for this transaction, the ONLY raw plate stock place.
  const node = async (parentId, depth, sfx, name) => (await db.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, ?, ?, 'item', ?, ?)", [COMPANY, parentId, depth, `${tag}-${sfx}`, `${tag} ${name}`]))[0].insertId;
  const family = await node(null, 0, 'STEEL', 'steel');
  const sub = await node(family, 1, 'PLATES', 'plates');
  const plateNode = await node(sub, 2, 'PLATE', 'plate');
  const partNode = await node(null, 0, 'PARTS', 'parts');
  await db.query('DELETE FROM cf_cut_place_stock WHERE company_id = ? AND place_id = ?', [COMPANY, places.placeId]);
  await db.query('INSERT INTO cf_cut_place_stock (company_id, place_id, node_id) VALUES (?, ?, ?)', [COMPANY, places.placeId, plateNode]);

  const specByCode = async (code, dataType, uom = null) => {
    const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (s) return s.id;
    return (await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status) VALUES (?, ?, ?, ?, ?, 'active')", [COMPANY, code, code, dataType, uom]))[0].insertId;
  };
  const spec = {};
  for (const [code, type, uom] of [['THICKNESS', 'number', 'mm'], ['LENGTH', 'number', 'mm'], ['WIDTH', 'number', 'mm'], ['GRADE', 'option'], ['IMPACT_CLASS', 'option'], ['MATERIAL', 'option'], ['DENSITY', 'number'], ['WEIGHT', 'number', 'kg'], ['PLATE_KIND', 'option'], ['DRAWING_MARK', 'text']]) spec[code] = await specByCode(code, type, uom);
  const option = async (specId, value) => (await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, specId, value]))[0].insertId;
  const optionNamed = async (specId, value) => { const [[o]] = await db.query("SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND value = ? AND deleted_at IS NULL AND status = 'active'", [COMPANY, specId, value]); return o?.id ?? option(specId, value); };
  const GA = `${tag}E350`; const GB = `${tag}E250`; const BO = `${tag}BO`; const BR = `${tag}BR`; const MS = `${tag}MS`;
  const opt = { GA: await option(spec.GRADE, GA), GB: await option(spec.GRADE, GB), BO: await option(spec.IMPACT_CLASS, BO), BR: await option(spec.IMPACT_CLASS, BR), MS: await option(spec.MATERIAL, MS),
    CUSTOM: await optionNamed(spec.PLATE_KIND, 'CUSTOM'), STANDARD: await optionNamed(spec.PLATE_KIND, 'STANDARD') };

  // The rules a plate of this branch is given: what is typed, what is fixed, what is worked out.
  const [formula] = await db.query("INSERT INTO cf_formulas (company_id, code, name, expression, version, status) VALUES (?, ?, ?, 'LENGTH * WIDTH * THICKNESS * DENSITY / 1e9', 1, 'active')", [COMPANY, `${tag}_PW`, `${tag} plate weight`]);
  const rule = (code, valueRule, required, sort, formulaId = null) => db.query(
    "INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order) VALUES (?, ?, 'classification', ?, 'item', ?, 1, ?, ?, ?)",
    [COMPANY, spec[code], plateNode, required ? 1 : 0, valueRule, formulaId, sort]);
  await rule('PLATE_KIND', 'defaulted', true, 0);
  await rule('GRADE', 'entered', true, 10); await rule('IMPACT_CLASS', 'entered', true, 11);
  await rule('THICKNESS', 'entered', true, 20); await rule('WIDTH', 'entered', true, 21); await rule('LENGTH', 'entered', false, 22);
  await rule('WEIGHT', 'calculated', false, 80, formula.insertId);
  await rule('DENSITY', 'fixed', false, 90); await rule('MATERIAL', 'fixed', false, 91);
  const setVals = async (subjectType, subjectId, vals) => {
    const rows = vals.filter(([, v]) => v != null).map(([specId, v, source = 'entered']) => [COMPANY, specId, subjectType, subjectId, v.n ?? null, v.o ?? null, v.t ?? null, source]);
    if (rows.length) await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, value_text, source) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`, rows.flat());
  };
  await setVals('classification', plateNode, [[spec.DENSITY, { n: DENSITY }], [spec.MATERIAL, { o: opt.MS }], [spec.PLATE_KIND, { o: opt.CUSTOM }]]);

  // Its own coding rule for a raw plate: SHORT-TxWxL-GRADE+IMPACT, the way the tenant's plate code reads.
  const [scheme] = await db.query("INSERT INTO cf_code_schemes (company_id, code, name, entity_type, target_field, seq_scope, priority, status) VALUES (?, ?, ?, 'item', 'code', 'prefix', 0, 'active')", [COMPANY, `${tag}-PLATE`, `${tag} plate code`]);
  await db.query("INSERT INTO cf_code_scheme_conditions (company_id, scheme_id, token_key, operator, value) VALUES (?, ?, 'classification', 'under', ?), (?, ?, 'kind', 'eq', 'catalog')", [COMPANY, scheme.insertId, String(family), COMPANY, scheme.insertId]);
  const segs = [['token', null, 'record.shortName'], ['literal', '-', null], ['token', null, 'spec:THICKNESS'], ['literal', 'X', null], ['token', null, 'spec:WIDTH'], ['literal', 'X', null], ['token', null, 'spec:LENGTH'], ['literal', '-', null], ['token', null, 'spec:GRADE'], ['token', null, 'spec:IMPACT_CLASS']];
  await db.query(`INSERT INTO cf_code_scheme_segments (company_id, scheme_id, sort_order, segment_type, literal_text, token_key, transform, is_required) VALUES ${segs.map(() => "(?,?,?,?,?,?,'upper',1)").join(',')}`,
    segs.flatMap(([type, text, token], i) => [COMPANY, scheme.insertId, i + 1, type, text, token]));

  const SHORT = `P${tag}`;
  const master = async ({ code, name, classificationId, itemType, shortName = null, ownerLineId = null, details = {} }) => {
    const [m] = await db.query("INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status) VALUES (?, 'item', ?, ?, ?, ?, 'active')", [COMPANY, code, name, shortName, classificationId]);
    await db.query('INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id, list_price, price_basis, hsn_code, gst_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [m.insertId, COMPANY, itemType, details.trackedBy ?? 'quantity', details.uom ?? 'nos', itemType === 'temporary' ? 'make' : 'stock', ownerLineId, details.listPrice ?? null, details.priceBasis ?? 'unit', details.hsn ?? null, details.gst ?? null]);
    return m.insertId;
  };
  // Three catalog plates of the size the job draws, none of them 10 mm: 11 (GA BO), 14 (GA BR), 36 (GB BO).
  const plates = {}; const plateCode = {};
  const addPlate = async (sfx, t, l, w, g, i, details = {}) => {
    const grade = g === 'A' ? GA : GB; const impact = i === 'O' ? BO : BR;
    plateCode[sfx] = `${SHORT}-${t}X${w}X${l}-${grade}${impact}`;
    plates[sfx] = await master({ code: plateCode[sfx], name: `${tag} Plate ${t} x ${w} x ${l} ${grade} ${impact}`, classificationId: plateNode, itemType: 'catalog', shortName: SHORT, details: { trackedBy: 'batch', uom: 'nos', ...details } });
    await setVals('master', plates[sfx], [[spec.THICKNESS, { n: t }], [spec.LENGTH, { n: l }], [spec.WIDTH, { n: w }], [spec.GRADE, { o: g === 'A' ? opt.GA : opt.GB }], [spec.IMPACT_CLASS, { o: i === 'O' ? opt.BO : opt.BR }],
      [spec.MATERIAL, { o: opt.MS }, 'fixed'], [spec.DENSITY, { n: DENSITY }, 'fixed'], [spec.PLATE_KIND, { o: opt.CUSTOM }, 'defaulted'], [spec.WEIGHT, { n: (l * w * t * DENSITY) / 1e9 }, 'calculated']]);
  };
  await addPlate('P11', 11, 6000, 2000, 'A', 'O', { listPrice: 62000, priceBasis: 'tonne', hsn: '7208', gst: 18 });
  await addPlate('P14', 14, 6000, 2000, 'A', 'R', { listPrice: 480000, priceBasis: 'unit' });
  await addPlate('P36', 36, 6000, 2000, 'B', 'O');
  for (const t of [9, 10, 12]) await db.query('INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, ?, ?, 3, 5, 8, 100, 50, 50, 0)', [COMPANY, t, t]);

  // The line: one part row and its cut piece — the 9 mm packing, 185 × 1400, GA BO.
  const [o] = await db.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', 'Missing plates fixture', 'confirmed')", [COMPANY, `${tag}-SO`]);
  const root = await master({ code: `${tag}-ROOT`, name: `${tag} fixture girder`, classificationId: partNode, itemType: 'temporary' });
  const [l] = await db.query("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 1, NOW(), 1)", [COMPANY, o.insertId, root, root]);
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);
  const bomLine = async (parentId, childId, quantity, lineNo) => {
    let [[bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
    if (!bom) bom = { id: (await db.query("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'active')", [COMPANY, parentId]))[0].insertId };
    await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', [COMPANY, bom.id, lineNo, childId, childId, lineNo, quantity]);
  };
  const cut = {}; let n = 0;
  const addPart = async (sfx, t, len, wid, qty, g = 'A', i = 'O') => {
    n += 1;
    const row = await master({ code: `${tag}-PT-${sfx}`, name: `${tag} fixture part ${sfx}`, classificationId: partNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals('master', row, [[spec.THICKNESS, { n: t }], [spec.LENGTH, { n: len }], [spec.WIDTH, { n: wid }], [spec.DRAWING_MARK, { t: `${tag}-Z${sfx}` }]]);
    cut[sfx] = await master({ code: `${tag}-C${sfx}`, name: `${tag} fixture cut plate ${sfx}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals('master', cut[sfx], [[spec.THICKNESS, { n: t }], [spec.LENGTH, { n: len }], [spec.WIDTH, { n: wid }], [spec.GRADE, { o: g === 'A' ? opt.GA : opt.GB }], [spec.IMPACT_CLASS, { o: i === 'O' ? opt.BO : opt.BR }], [spec.MATERIAL, { o: opt.MS }], [spec.DENSITY, { n: DENSITY }]]);
    await bomLine(root, row, qty, n);
    await bomLine(row, cut[sfx], 1, 1);
  };
  await addPart('COV', 9, 1400, 185, 24);            // the job's "9MM-ED COVER PACK PL-185X1400- 12"
  await addPart('DX', 12, 500, 300, 4, 'A', 'R');    // on the DXF plates below
  await addPart('DY', 12, 400, 250, 4, 'B', 'R');    // another grade, for a nest of two grades
  return { tag, GA, GB, BO, BR, MS, SHORT, spec, opt, family, plateNode, placeId: places.placeId, plates, plateCode, lineId, orderId: o.insertId, cut, code: (sfx) => `${tag}-C${sfx}` };
}

/* ───────────────────────────── helpers on the fixture ───────────────────────────── */
let fx = null;
const upload = (files, opts = {}, db = conn) => U.uploadNestFiles(db, c, fx.lineId, { files, ...opts });
const create = (plates, opts = {}, db = conn) => P.createNestPlates(db, c, fx.lineId, { plates, ...opts });
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const said = (e, ...words) => !!e && e.status === 422 && words.every((w) => [e.message, ...(e.problems ?? [])].join(' | ').includes(w));
const dxf = (filename, plate, parts) => { const text = D.makeNestDxf({ plate, parts }); return { filename, file: Buffer.from(text, 'latin1').toString('base64') }; };
const itemOf = async (id) => {
  const [[m]] = await conn.query('SELECT m.*, i.item_type, i.tracked_by, i.uom, i.sourcing, i.list_price, i.price_basis, i.hsn_code, i.gst_rate FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL', [COMPANY, id]);
  const [vals] = await conn.query("SELECT s.code, v.id, v.value_number, v.option_id, v.value_bool, v.uom, v.source, o.value AS opt FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id LEFT JOIN cf_spec_options o ON o.id = v.option_id WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL", [COMPANY, id]);
  const [[h]] = await conn.query("SELECT COUNT(*) AS n, SUM(change_type = 'create') AS creates, COUNT(DISTINCT value_id) AS vals FROM cf_spec_value_history WHERE company_id = ? AND subject_type = 'master' AND subject_id = ?", [COMPANY, id]);
  return { m, v: Object.fromEntries(vals.map((r) => [r.code, r])), history: h };
};
const shapeOf = (item) => Object.fromEntries(Object.entries(item.v).map(([code, r]) => [code, r.source]).sort());
const plateCount = async () => Number((await conn.query("SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL", [COMPANY, fx.plateNode]))[0][0].n);

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  section('Fixture');
  fx = await buildFixture(conn);
  const KEY10 = `10|6000|2000|${fx.GA}|${fx.BO}`;
  const CODE10 = `${fx.SHORT}-10X2000X6000-${fx.GA}${fx.BO}`;
  console.log(`  ${fx.tag}: line ${fx.lineId}, plates ${Object.values(fx.plateCode).join(', ')}`);
  {
    const ctx = await N.importContext(conn, COMPANY, fx.lineId);
    ok('the fixture is what the upload sees: its three plates and no other, its cut pieces with their grade and impact class', ctx.plates.length === 3 && ctx.plates.every((p) => Object.values(fx.plates).includes(p.id)) && ctx.cutPlates.find((x) => x.id === fx.cut.COV)?.steel.impactClass === fx.BO && ctx.cutPlates.find((x) => x.id === fx.cut.COV)?.pieces === 24, J(ctx.plates.map((p) => p.code)));
  }

  /* ───────────── 1. the preview says which plate is missing ───────────── */
  section('1. The real 10 mm job — the preview');
  const jobPlates = J10.doc.counts.plates;
  let trips = {};
  {
    const t = counting(conn);
    const dry = await upload([{ filename: J10.filename, file: J10.file }], {}, t.db);
    trips.previewMissing = t.tally.n;
    const sentence = dry.problems.find((p) => p.includes('no catalog plate is 10 mm × 6000 × 2000'));
    ok('PLATE_NOT_FOUND stays, in its sentence: "no catalog plate is 10 mm × 6000 × 2000 — … only at 11, 14 and 36 mm"', dry.canSave === false && dry.problemList.some((p) => p.code === 'PLATE_NOT_FOUND') && /that size is in the catalog only at 11, 14 and 36 mm\./.test(sentence ?? ''), J(dry.problems));
    ok('…and now points at the way out: it can be added to the catalog from here', /It can be added to the catalog from here \(Add to the catalog\), or name the plate you mean \(plateCode\)\.$/.test(sentence ?? ''), sentence);
    const mp = dry.missingPlates;
    ok(`missingPlates lists the plate ONCE, though the job cuts ${J10.doc.counts.nests} nest(s) on ${jobPlates} plate(s) of it`, Array.isArray(mp) && mp.length === 1 && mp[0].plates === jobPlates && mp[0].nests.length === J10.doc.counts.nests && mp[0].nests.every((n) => n.filename === J10.filename && Number.isInteger(n.nestNo)), J(mp));
    const m = mp[0] ?? {};
    ok('its size and thickness are the job\'s: 10 mm × 6000 × 2000 (the long side is the length)', m.thickness === 10 && m.length === 6000 && m.width === 2000);
    ok('its grade and impact class are VOTED by the cut pieces matched on the nest (a 9 mm packing: GA, BO) — matching ran before the plate was looked for', m.grade === fx.GA && m.impactClass === fx.BO && m.key === KEY10, J([m.key, m.grade, m.impactClass]));
    ok('its material and density too (the cut pieces\'; the classification fixes the same)', m.material === fx.MS && m.density === DENSITY, J([m.material, m.density]));
    ok(`the code it will get follows the tenant's coding rule: ${CODE10}`, m.suggestedCode === CODE10, m.suggestedCode);
    ok('its name follows the model plate\'s name, with the new size', m.suggestedName === `${fx.tag} Plate 10 x 2000 x 6000 ${fx.GA} ${fx.BO}`, m.suggestedName);
    ok('it is modelled on the nearest thickness of the same grade and impact class (the 11 mm plate), and is a custom size unless told otherwise', m.similarTo?.itemId === fx.plates.P11 && m.similarTo.code === fx.plateCode.P11 && m.kind === 'custom' && m.canCreate === true && m.why === undefined, J([m.similarTo, m.kind, m.canCreate, m.why]));
    ok('what only the save needs stays inside: no entry of files[] carries _missing', dry.files.every((f) => !('_missing' in f)));
    ok('nothing was written by the preview', (await plateCount()) === 3);
  }

  section('2. A DXF whose parts match nothing: the grade is not known');
  {
    // 2750 × 1300 at 10 mm (the file name says so); its one shape is no cut piece of the line.
    const f = dxf(`${fx.tag}-U1_10mm_2750x1300.dxf`, { length: 2750, width: 1300 }, [{ rect: { length: 777, width: 333 }, x: 100, y: 100 }]);
    const dry = await upload([f]);
    const m = dry.missingPlates[0] ?? {};
    ok('the plate is listed with what the file says (10 mm, 2750 × 1300) and no grade', dry.missingPlates.length === 1 && m.thickness === 10 && m.length === 2750 && m.width === 1300 && m.grade === null && m.impactClass === null && m.key === '10|2750|1300||', J(dry.missingPlates));
    ok('canCreate is false, and why: "its grade is not known — match its parts first, or name the plate."', m.canCreate === false && m.why === 'its grade is not known — match its parts first, or name the plate.', m.why);
    ok('it still says what it would be modelled on, and gets no code yet', m.similarTo?.itemId != null && m.suggestedCode === null);
    const e = await refused(() => create([{ key: m.key, kind: 'custom' }]));
    ok('asked for anyway, the route refuses it in the same words and writes nothing', said(e, '10 mm × 2750 × 1300', 'its grade is not known') && (await plateCount()) === 3, e?.message);

    // The same plate with a part of the line on it: the 12 mm cut piece (GA, BR) votes.
    const g = dxf(`${fx.tag}-U2_12mm_2750x1300.dxf`, { length: 2750, width: 1300 }, [{ rect: { length: 500, width: 300 }, x: 100, y: 100, label: fx.code('DX') }, { rect: { length: 500, width: 300 }, x: 700, y: 100, label: fx.code('DX') }]);
    const two = await upload([f, g, { filename: J10.filename, file: J10.file }]);
    const byKey = Object.fromEntries(two.missingPlates.map((x) => [x.key, x]));
    ok('three files, three different plates: one entry each, each with the files that use it', two.missingPlates.length === 3 && byKey[KEY10]?.plates === jobPlates && byKey['10|2750|1300||']?.nests[0].filename === f.filename && byKey[`12|2750|1300|${fx.GA}|${fx.BR}`]?.nests[0].filename === g.filename, J(two.missingPlates.map((x) => [x.key, x.plates, x.nests])));
    const dx = byKey[`12|2750|1300|${fx.GA}|${fx.BR}`] ?? {};
    ok('a DXF plate takes its thickness from the file and its grade and impact class from its matched parts; it is modelled on the NEAREST THICKNESS first (the 11 mm plate, though the 14 mm one shares its impact class)', dx.canCreate === true && dx.grade === fx.GA && dx.impactClass === fx.BR && dx.similarTo?.itemId === fx.plates.P11 && dx.suggestedCode === `${fx.SHORT}-12X1300X2750-${fx.GA}${fx.BR}`, J(dx));

    // Two grades on one nest: the one most pieces have is taken, and it is said.
    const h = dxf(`${fx.tag}-U3_12mm_2750x1300.dxf`, { length: 2750, width: 1300 }, [{ rect: { length: 500, width: 300 }, x: 100, y: 100, label: fx.code('DX') }, { rect: { length: 500, width: 300 }, x: 700, y: 100, label: fx.code('DX') }, { rect: { length: 400, width: 250 }, x: 1300, y: 100, label: fx.code('DY') }]);
    const mixed = await upload([h]);
    const mx = mixed.missingPlates[0] ?? {};
    ok('a nest whose cut pieces are of two grades: the plate takes the grade most pieces have, and a note says so', mixed.missingPlates.length === 1 && mx.grade === fx.GA && /are of 2 grades/.test(mx.note ?? '') && mx.note.includes(`the plate is taken as ${fx.GA.toUpperCase()}`), J(mx));
  }

  /* ───────────── 3. adding it ───────────── */
  section('3. POST …/nesting/plates');
  let id10 = null;
  {
    const dry = await create([{ key: KEY10 }], { dryRun: true });
    ok('dryRun says what it would create and writes nothing', dry.dryRun === true && dry.created.length === 1 && dry.created[0].itemId === null && dry.created[0].code === CODE10 && dry.created[0].kind === 'custom' && dry.skipped.length === 0 && (await plateCount()) === 3 && /^Would add /.test(dry.message), J(dry));

    const t = counting(conn);
    const out = await create([{ key: KEY10 }], {}, t.db);
    trips.create1 = t.tally.n;
    id10 = out.created[0]?.itemId ?? null;
    ok(`created: { key, itemId, code, name, kind } — ${CODE10}, a custom size (the default)`, out.dryRun === false && out.created.length === 1 && out.skipped.length === 0 && out.created[0].key === KEY10 && Number.isInteger(id10) && out.created[0].code === CODE10 && out.created[0].name === `${fx.tag} Plate 10 x 2000 x 6000 ${fx.GA} ${fx.BO}` && out.created[0].kind === 'custom', J(out));
    ok('the message says it in a sentence', out.message === `Added ${CODE10} to the catalog as a custom size.`, out.message);
    const it = await itemOf(id10);
    ok('the item is an ACTIVE catalog item, FILED WITH THE PLATES (the model plate\'s classification), with its short name', it.m.status === 'active' && it.m.record_kind === 'item' && it.m.item_type === 'catalog' && Number(it.m.classification_id) === fx.plateNode && it.m.short_name === fx.SHORT && it.m.code === CODE10);
    ok('unit, tracking, sourcing, HSN and GST are the model plate\'s; its price too, because it is a RATE (per tonne)', it.m.tracked_by === 'batch' && it.m.uom === 'nos' && it.m.sourcing === 'stock' && it.m.hsn_code === '7208' && Number(it.m.gst_rate) === 18 && Number(it.m.list_price) === 62000 && it.m.price_basis === 'tonne', J([it.m.tracked_by, it.m.uom, it.m.sourcing, it.m.hsn_code, it.m.gst_rate, it.m.list_price, it.m.price_basis]));
    const v = it.v;
    ok('THICKNESS 10, LENGTH 6000, WIDTH 2000 — entered', Number(v.THICKNESS?.value_number) === 10 && Number(v.LENGTH?.value_number) === 6000 && Number(v.WIDTH?.value_number) === 2000 && [v.THICKNESS, v.LENGTH, v.WIDTH].every((r) => r.source === 'entered'), J(v));
    ok('GRADE and IMPACT_CLASS — the options the cut pieces carry, entered', v.GRADE?.option_id === fx.opt.GA && v.IMPACT_CLASS?.option_id === fx.opt.BO && v.GRADE.source === 'entered' && v.IMPACT_CLASS.source === 'entered');
    ok('MATERIAL and DENSITY — fixed by the classification, stored as fixed', v.MATERIAL?.option_id === fx.opt.MS && v.MATERIAL.source === 'fixed' && Number(v.DENSITY?.value_number) === DENSITY && v.DENSITY.source === 'fixed');
    ok('PLATE_KIND — CUSTOM, by the rule\'s default (nothing typed), as a plate made in Items has it', v.PLATE_KIND?.option_id === fx.opt.CUSTOM && v.PLATE_KIND.source === 'defaulted');
    ok(`WEIGHT — worked out by the classification's own formula: 6000 × 2000 × 10 × 7850 / 1e9 = ${(6000 * 2000 * 10 * DENSITY) / 1e9} kg, stored as calculated`, Math.abs(Number(v.WEIGHT?.value_number) - 942) < 1e-6 && v.WEIGHT.source === 'calculated', J(v.WEIGHT));
    ok('every value has its history row ("create"), as a value written by hand has', Number(it.history.n) === Object.keys(v).length && Number(it.history.creates) === Object.keys(v).length && Number(it.history.vals) === Object.keys(v).length, J(it.history));
    const ctx = await N.importContext(conn, COMPANY, fx.lineId);
    const seen = ctx.plates.find((p) => p.id === id10);
    ok('nesting reads it as a plate: 10 mm × 6000 × 2000, its grade, impact class, material, density — kind CUSTOM', !!seen && seen.steel.thickness === 10 && seen.steel.length === 6000 && seen.steel.width === 2000 && seen.steel.grade === fx.GA && seen.steel.impactClass === fx.BO && seen.steel.material === fx.MS && seen.steel.density === DENSITY && seen.kind === 'CUSTOM', J(seen));

    // The same plate made the long way — the Items screen's creator — is stored the same.
    const t1 = counting(conn);
    const byHand = await M.createItem(t1.db, c, { classificationId: fx.plateNode, name: `${fx.tag} Plate 13 x 2000 x 6000 ${fx.GA} ${fx.BO}`, shortName: fx.SHORT, trackedBy: 'batch', status: 'active',
      values: [{ specCode: 'THICKNESS', value: 13 }, { specCode: 'LENGTH', value: 6000 }, { specCode: 'WIDTH', value: 2000 }, { specCode: 'GRADE', value: fx.GA }, { specCode: 'IMPACT_CLASS', value: fx.BO }] });
    trips.byHand = t1.tally.n;
    const hand = await itemOf(byHand.id);
    ok(`a plate made by the Items creator (${trips.byHand} round trips for one) holds the same values from the same sources, and a code of the same rule`, J(shapeOf(hand)) === J(shapeOf(it)) && hand.m.code === `${fx.SHORT}-13X2000X6000-${fx.GA}${fx.BO}` && Math.abs(Number(hand.v.WEIGHT.value_number) - (6000 * 2000 * 13 * DENSITY) / 1e9) < 1e-6, J([shapeOf(hand), shapeOf(it), hand.m.code]));
  }

  section('4. Idempotent');
  {
    const n = await plateCount();
    const again = await create([{ key: KEY10 }]);
    ok('a second call skips it, naming the item that is there — nothing is made twice', again.created.length === 0 && again.skipped.length === 1 && again.skipped[0].key === KEY10 && again.skipped[0].itemId === id10 && again.skipped[0].code === CODE10 && again.skipped[0].why === `10 mm × 6000 × 2000 ${fx.GA} ${fx.BO} is already in the catalog: ${CODE10}.` && (await plateCount()) === n, J(again));
    const turned = await create([{ thickness: 10, length: 2000, width: 6000, grade: fx.GA.toLowerCase(), impactClass: fx.BO }]);
    ok('the same plate given by its values, the other way round and in another case, is the same plate: skipped', turned.created.length === 0 && turned.skipped[0]?.itemId === id10 && (await plateCount()) === n, J(turned));
    const part = await create([{ key: KEY10 }, { key: `10|6000|2000|${fx.GA}|${fx.BR}`, kind: 'standard' }, { key: `10|6000|2000|${fx.GA}|${fx.BR}` }]);
    ok('a partial result: one there already (skipped), one new (created), one named twice (added once)', part.created.length === 1 && part.skipped.length === 2 && part.skipped.some((s) => s.itemId === id10) && part.skipped.some((s) => /named twice/.test(s.why)) && (await plateCount()) === n + 1, J(part));
    const std = await itemOf(part.created[0].itemId);
    ok('asked for as STANDARD: PLATE_KIND is STANDARD, entered — and nesting reads it as a standard plate', part.created[0].kind === 'standard' && std.v.PLATE_KIND?.option_id === fx.opt.STANDARD && std.v.PLATE_KIND.source === 'entered' && (await N.importContext(conn, COMPANY, fx.lineId)).plates.find((p) => p.id === part.created[0].itemId)?.kind === 'STANDARD', J(std.v.PLATE_KIND));
    ok('…another impact class is another plate, with its own code; the message says both halves', part.created[0].code === `${fx.SHORT}-10X2000X6000-${fx.GA}${fx.BR}` && part.message.startsWith(`Added ${part.created[0].code} to the catalog as a standard size. 2 plates were not added:`), part.message);
  }

  section('5. Refused, in words — and nothing written');
  {
    const n = await plateCount();
    let e = await refused(() => create([{ thickness: 'abc', length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO }]));
    ok('a thickness that is not a number', said(e, 'its thickness is "abc", and has to be a number above 0'), J([e?.message, e?.problems]));
    e = await refused(() => create([{ thickness: 8, length: -5, width: 0, grade: fx.GA, impactClass: fx.BO }]));
    ok('a length below 0 and a width of 0: both said at once', said(e, 'its length is "-5"', 'its width is "0"') && e.problems.length === 2, J(e?.problems));
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: `${fx.tag}NOPE`, impactClass: fx.BO }]));
    ok('a grade that is not one of the GRADE options — and the options are named', said(e, `its grade is "${fx.tag}NOPE", which is not one of the GRADE options`, fx.GA), J(e?.problems));
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO, kind: 'weird' }]));
    ok('a kind that is neither custom nor standard', said(e, 'a plate is custom or standard'), J(e?.problems));
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO, code: fx.plateCode.P36 }]));
    ok('a code already taken — by whom', said(e, `the code ${fx.plateCode.P36} is already taken, by ${fx.tag} Plate 36 x 2000 x 6000`, 'give it another code'), J(e?.problems));
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO, code: `${fx.tag}-SAME` }, { thickness: 7, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO, code: `${fx.tag}-SAME` }]));
    ok('one code given to two plates of the request', said(e, `the code ${fx.tag}-SAME is given to two plates of this request`), J(e?.problems));
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO }, { thickness: 'x', length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO }]));
    ok('ALL OR NOTHING: one bad plate among good ones — nothing is added', said(e, 'Nothing was added to the catalog') && (await plateCount()) === n, J([e?.message, e?.problems]));
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA }]));
    ok('no impact class where the catalog requires one: "its impact class is not known"', said(e, 'its impact class is not known'), J(e?.problems));
    e = await refused(() => create([]));
    ok('no plate named', !!e && e.status === 422 && e.code === 'NO_PLATES', e?.message);
    e = await refused(() => create([{ key: 'not a key' }]));
    ok('a key this screen never handed out', said(e, '"not a key" is not a plate this screen listed'), J(e?.problems));
    e = await refused(() => P.createNestPlates(conn, c, 2147483000, { plates: [{ key: KEY10 }] }));
    ok('a line that is not there: 404', !!e && e.status === 404, e?.message);

    await conn.query('SAVEPOINT no_models');
    await conn.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL', [COMPANY, fx.plateNode]);
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO }]));
    ok('no existing plate to model on', said(e, 'the catalog has no plate yet to model a new one on'), J(e?.problems));
    await conn.query('ROLLBACK TO SAVEPOINT no_models');

    await conn.query('SAVEPOINT no_place');
    await conn.query('DELETE FROM cf_cut_place_stock WHERE company_id = ? AND place_id = ?', [COMPANY, fx.placeId]);
    e = await refused(() => create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO }]));
    ok('no plate stock place set: Setup › Cutting', said(e, 'no raw plate stock is set', 'Setup › Cutting'), J(e?.problems));
    await conn.query('ROLLBACK TO SAVEPOINT no_place');
    ok('none of the refusals wrote anything', (await plateCount()) === n);

    const typed = await create([{ thickness: 8, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO, code: `${fx.tag}-MINE`, name: `${fx.tag} my own plate` }]);
    const mine = await itemOf(typed.created[0].itemId);
    ok('a code and a name typed by the user are the ones it gets', typed.created[0].code === `${fx.tag}-MINE` && mine.m.code === `${fx.tag}-MINE` && mine.m.name === `${fx.tag} my own plate` && Math.abs(Number(mine.v.WEIGHT.value_number) - (6000 * 2000 * 8 * DENSITY) / 1e9) < 1e-6);
    // Modelled on the 14 mm plate, whose price is for ONE plate of its size: not copied.
    const far = await create([{ thickness: 15, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BR }]);
    const farItem = await itemOf(far.created[0].itemId);
    ok('a model plate priced per plate (not a rate): the price is NOT copied to another size', farItem.m.list_price === null && farItem.m.price_basis === 'unit', J([farItem.m.list_price, farItem.m.price_basis]));
  }

  /* ───────────── 6. the same preview again ───────────── */
  section('6. The same preview, after adding');
  {
    const t = counting(conn);
    const dry = await upload([{ filename: J10.filename, file: J10.file }], {}, t.db);
    trips.previewFound = t.tally.n;
    ok('the nests that were blocked now resolve to the new plate (found by size)', dry.files.length > 0 && dry.files.every((f) => f.plate?.itemId === id10 && f.plate.code === CODE10 && f.plate.resolvedBy === 'size' && f.plate.thickness === 10), J(dry.files.map((f) => f.plate)));
    ok('PLATE_NOT_FOUND is gone, missingPlates is [], and the files can be saved', !dry.problemList.some((p) => p.code === 'PLATE_NOT_FOUND') && J(dry.missingPlates) === '[]' && dry.canSave === true, J(dry.problems));
    ok('the 9 mm packing on 10 mm plate is what it always was: a warning to confirm, every piece matched', dry.needsForce === true && dry.warningList.some((w) => w.code === 'PART_THINNER_THAN_PLATE') && dry.files.every((f) => f.placed === f.parts && f.counts.every((x) => x.cutPlateId === fx.cut.COV)), J(dry.warnings));
    ok(`a preview with a missing plate costs ${trips.previewMissing} round trips, one with none ${trips.previewFound}: a fixed handful more, only when something is missing`, trips.previewMissing > trips.previewFound && trips.previewMissing - trips.previewFound <= 12);
    const saved = await upload([{ filename: J10.filename, file: J10.file }], { dryRun: false, force: true });
    const [lots] = await conn.query("SELECT plate_item_id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [COMPANY, fx.lineId]);
    ok(`…and they save: ${jobPlates} plate(s) on the new catalog plate`, saved.applied === true && saved.saved.lots === jobPlates && lots.length === jobPlates && lots.every((l) => Number(l.plate_item_id) === id10), saved.message);
  }

  /* ───────────── 7. round trips ───────────── */
  section('7. Round trips: the same for 1 plate and for 10');
  {
    const plate = (t) => ({ thickness: t, length: 6000, width: 2000, grade: fx.GA, impactClass: fx.BO });
    const t1 = counting(conn);
    const one = await create([plate(20)], {}, t1.db);
    const t10 = counting(conn);
    const ten = await create([21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(plate), {}, t10.db);
    trips.one = t1.tally.n; trips.ten = t10.tally.n;
    ok(`1 plate: ${trips.one} round trips; 10 plates: ${trips.ten} — equal`, one.created.length === 1 && ten.created.length === 10 && trips.one === trips.ten, J(trips));
    ok(`…against ${trips.byHand} for ONE plate through the single-item creator`, trips.one < trips.byHand);
    const tenItems = await Promise.all(ten.created.map((x) => itemOf(x.itemId)));
    ok('each of the ten has its own code, every value, and its own weight', new Set(ten.created.map((x) => x.code)).size === 10 && tenItems.every((it, i) => it.m.code === `${fx.SHORT}-${21 + i}X2000X6000-${fx.GA}${fx.BO}` && Math.abs(Number(it.v.WEIGHT.value_number) - (6000 * 2000 * (21 + i) * DENSITY) / 1e9) < 1e-6 && Object.keys(it.v).length === 9 && Number(it.history.n) === 9), J(tenItems.map((it) => [it.m.code, it.v.WEIGHT?.value_number, Object.keys(it.v).length])));
    const tm = counting(conn);
    const mix = await create([plate(31), { thickness: 32, length: 6000, width: 2000, grade: fx.GB, impactClass: fx.BR, kind: 'standard' }, plate(20)], {}, tm.db);
    ok(`a request that creates, makes one standard and skips one costs the same again (${tm.tally.n})`, mix.created.length === 2 && mix.skipped.length === 1 && tm.tally.n === trips.one && mix.message.includes('as a custom size, and') && mix.message.includes('as a standard size.'), mix.message);
  }
} catch (err) {
  failed += 1;
  fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  await R.settleRuns?.().catch(() => {});
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}

section('Nothing survived the rollback');
const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));

console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
