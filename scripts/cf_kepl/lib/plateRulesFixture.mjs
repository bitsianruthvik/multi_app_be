/**
 * plateRulesFixture.mjs — the fixture of nest_grade_check_test and nest_custom_plate_test (§90, 2026-10-19).
 *
 * Built inside the caller's transaction (rolled back by the caller). Like nest_missing_plates_test's: its OWN branch of
 * the classification for raw plates (Steel › Plates › Plate) with its own rules — size, grade and impact class
 * entered, material and density fixed, WEIGHT by its own formula, PLATE_KIND defaulted to CUSTOM — and its own coding
 * rule (SHORT-T X W X L-GRADE IMPACT), so a custom plate size can really be added to the catalog. For the length of the
 * transaction the company's raw plate stock place is THIS branch only, so the tenant's own plates are not in play.
 *
 *   plates  12 mm × 6000 × 2000 E350 BR (P12R, 62 000 / t, HSN 7208, GST 18) and E350 BO (P12O, 64 000 / t);
 *           16 mm × 6000 × 2000 E350 with NO impact class (P16N); 20 mm × 6000 × 2000 E350 BR (P20R)
 *   pieces  12 mm E350 BR 1200 × 400 × 4 (A), 12 mm E350 BO 900 × 300 × 4 (B), 16 mm E350 BR 800 × 400 × 2 (C),
 *           20 mm E250 BR 600 × 300 × 2 (D)
 * The grades are the real words E350 / E250 (the 'higher' rule reads the strength), the impact classes BO / BR (found
 * or made); material and the short name carry the run tag.
 */
import { cutPlaces } from '../../../apps/cf_erp/lib/cutPlaces.js';

export const DENSITY = 7850;

export async function buildPlateRulesFixture(db, { company = 2, parts = null } = {}) {
  const COMPANY = company;
  const tag = `PG${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase()}`;
  const places = (await cutPlaces(db, COMPANY)).plate;
  if (!places.placeId || !places.blanksNodeId) throw new Error(`Company ${COMPANY} has no place set for plate cut pieces (Setup › Cutting).`);
  const cutNode = places.blanksNodeId;

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
  const optionNamed = async (specId, value) => { const [[o]] = await db.query("SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND value = ? AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1", [COMPANY, specId, value]); return o?.id ?? option(specId, value); };
  const MS = `${tag}MS`;
  const opt = {
    E350: await optionNamed(spec.GRADE, 'E350'), E250: await optionNamed(spec.GRADE, 'E250'),
    BO: await optionNamed(spec.IMPACT_CLASS, 'BO'), BR: await optionNamed(spec.IMPACT_CLASS, 'BR'), MS: await option(spec.MATERIAL, MS),
    CUSTOM: await optionNamed(spec.PLATE_KIND, 'CUSTOM'), STANDARD: await optionNamed(spec.PLATE_KIND, 'STANDARD'),
  };

  const [formula] = await db.query("INSERT INTO cf_formulas (company_id, code, name, expression, version, status) VALUES (?, ?, ?, 'LENGTH * WIDTH * THICKNESS * DENSITY / 1e9', 1, 'active')", [COMPANY, `${tag}_PW`, `${tag} plate weight`]);
  const rule = (code, valueRule, required, sort, formulaId = null) => db.query(
    "INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order) VALUES (?, ?, 'classification', ?, 'item', ?, 1, ?, ?, ?)",
    [COMPANY, spec[code], plateNode, required ? 1 : 0, valueRule, formulaId, sort]);
  await rule('PLATE_KIND', 'defaulted', true, 0);
  await rule('GRADE', 'entered', true, 10); await rule('IMPACT_CLASS', 'entered', false, 11);
  await rule('THICKNESS', 'entered', true, 20); await rule('WIDTH', 'entered', true, 21); await rule('LENGTH', 'entered', false, 22);
  await rule('WEIGHT', 'calculated', false, 80, formula.insertId);
  await rule('DENSITY', 'fixed', false, 90); await rule('MATERIAL', 'fixed', false, 91);
  const setVals = async (subjectType, subjectId, vals) => {
    const rows = vals.filter(([, v]) => v != null).map(([specId, v, source = 'entered']) => [COMPANY, specId, subjectType, subjectId, v.n ?? null, v.o ?? null, v.t ?? null, source]);
    if (rows.length) await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, value_text, source) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`, rows.flat());
  };
  await setVals('classification', plateNode, [[spec.DENSITY, { n: DENSITY }], [spec.MATERIAL, { o: opt.MS }], [spec.PLATE_KIND, { o: opt.CUSTOM }]]);

  const [scheme] = await db.query("INSERT INTO cf_code_schemes (company_id, code, name, entity_type, target_field, seq_scope, priority, status) VALUES (?, ?, ?, 'item', 'code', 'prefix', 0, 'active')", [COMPANY, `${tag}-PLATE`, `${tag} plate code`]);
  await db.query("INSERT INTO cf_code_scheme_conditions (company_id, scheme_id, token_key, operator, value) VALUES (?, ?, 'classification', 'under', ?), (?, ?, 'kind', 'eq', 'catalog')", [COMPANY, scheme.insertId, String(family), COMPANY, scheme.insertId]);
  const segs = [['token', null, 'record.shortName'], ['literal', '-', null], ['token', null, 'spec:THICKNESS'], ['literal', 'X', null], ['token', null, 'spec:WIDTH'], ['literal', 'X', null], ['token', null, 'spec:LENGTH'], ['literal', '-', null], ['token', null, 'spec:GRADE'], ['token', null, 'spec:IMPACT_CLASS']];
  await db.query(`INSERT INTO cf_code_scheme_segments (company_id, scheme_id, sort_order, segment_type, literal_text, token_key, transform, is_required) VALUES ${segs.map(() => "(?,?,?,?,?,?,'upper',0)").join(',')}`,
    segs.flatMap(([type, text, token], i) => [COMPANY, scheme.insertId, i + 1, type, text, token]));

  const SHORT = `P${tag}`;
  const master = async ({ code, name, classificationId, itemType, shortName = null, ownerLineId = null, details = {} }) => {
    const [m] = await db.query("INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status) VALUES (?, 'item', ?, ?, ?, ?, 'active')", [COMPANY, code, name, shortName, classificationId]);
    await db.query('INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id, list_price, price_basis, hsn_code, gst_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [m.insertId, COMPANY, itemType, details.trackedBy ?? 'quantity', details.uom ?? 'nos', itemType === 'temporary' ? 'make' : 'stock', ownerLineId, details.listPrice ?? null, details.priceBasis ?? 'unit', details.hsn ?? null, details.gst ?? null]);
    return m.insertId;
  };
  const plates = {}; const plateCode = {};
  const addPlate = async (sfx, t, l, w, grade, impact, details = {}) => {
    plateCode[sfx] = `${SHORT}-${t}X${w}X${l}-${grade}${impact ?? ''}`;
    plates[sfx] = await master({ code: plateCode[sfx], name: `${tag} Plate ${t} x ${w} x ${l} ${grade}${impact ? ` ${impact}` : ''}`, classificationId: plateNode, itemType: 'catalog', shortName: SHORT, details: { trackedBy: 'batch', ...details } });
    await setVals('master', plates[sfx], [[spec.THICKNESS, { n: t }], [spec.LENGTH, { n: l }], [spec.WIDTH, { n: w }], [spec.GRADE, { o: opt[grade] }], ...(impact ? [[spec.IMPACT_CLASS, { o: opt[impact] }]] : []),
      [spec.MATERIAL, { o: opt.MS }, 'fixed'], [spec.DENSITY, { n: DENSITY }, 'fixed'], [spec.PLATE_KIND, { o: opt.CUSTOM }, 'defaulted'], [spec.WEIGHT, { n: (l * w * t * DENSITY) / 1e9 }, 'calculated']]);
  };
  await addPlate('P12R', 12, 6000, 2000, 'E350', 'BR', { listPrice: 62000, priceBasis: 'tonne', hsn: '7208', gst: 18 });
  await addPlate('P12O', 12, 6000, 2000, 'E350', 'BO', { listPrice: 64000, priceBasis: 'tonne', hsn: '7208', gst: 18 });
  await addPlate('P16N', 16, 6000, 2000, 'E350', null, { listPrice: 62000, priceBasis: 'tonne' });
  await addPlate('P20R', 20, 6000, 2000, 'E350', 'BR', { listPrice: 62000, priceBasis: 'tonne' });
  for (const t of [12, 16, 20]) await db.query('INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, ?, ?, 3, 5, 8, 100, 50, 50, 0)', [COMPANY, t, t]);

  const [o] = await db.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', 'Plate rules fixture', 'confirmed')", [COMPANY, `${tag}-SO`]);
  const root = await master({ code: `${tag}-ROOT`, name: `${tag} fixture girder`, classificationId: partNode, itemType: 'temporary' });
  const [l] = await db.query("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 1, NOW(), 1)", [COMPANY, o.insertId, root, root]);
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);
  const bomLine = async (parentId, childId, quantity, lineNo) => {
    let [[bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
    if (!bom) bom = { id: (await db.query("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'active')", [COMPANY, parentId]))[0].insertId };
    await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', [COMPANY, bom.id, lineNo, childId, childId, lineNo, quantity]);
  };
  const cut = {}; const want = {}; let n = 0;
  const addPart = async (sfx, t, len, wid, qty, grade, impact) => {
    n += 1;
    const row = await master({ code: `${tag}-PT-${sfx}`, name: `${tag} fixture part ${sfx}`, classificationId: partNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals('master', row, [[spec.THICKNESS, { n: t }], [spec.LENGTH, { n: len }], [spec.WIDTH, { n: wid }], [spec.DRAWING_MARK, { t: `${tag}-Z${sfx}` }]]);
    cut[sfx] = await master({ code: `${tag}-C${sfx}`, name: `${tag} fixture cut plate ${sfx}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals('master', cut[sfx], [[spec.THICKNESS, { n: t }], [spec.LENGTH, { n: len }], [spec.WIDTH, { n: wid }], [spec.GRADE, { o: opt[grade] }], ...(impact ? [[spec.IMPACT_CLASS, { o: opt[impact] }]] : []), [spec.MATERIAL, { o: opt.MS }], [spec.DENSITY, { n: DENSITY }]]);
    await bomLine(root, row, qty, n);
    await bomLine(row, cut[sfx], 1, 1);
    want[sfx] = { t, len, wid, qty, grade, impact };
  };
  for (const [sfx, t, len, wid, qty, grade, impact] of parts ?? [
    ['A', 12, 1200, 400, 4, 'E350', 'BR'],
    ['B', 12, 900, 300, 4, 'E350', 'BO'],
    ['C', 16, 800, 400, 2, 'E350', 'BR'],
    ['D', 20, 600, 300, 2, 'E250', 'BR'],
  ]) await addPart(sfx, t, len, wid, qty, grade, impact);
  return {
    company: COMPANY, tag, SHORT, MS, spec, opt, family, plateNode, placeId: places.placeId, plates, plateCode, lineId, orderId: o.insertId, cut, want,
    code: (sfx) => `${tag}-C${sfx}`, setVals,
    sfxOfCut: (id) => Object.keys(cut).find((k) => Number(cut[k]) === Number(id)) ?? null,
    sfxOfPlate: (id) => Object.keys(plates).find((k) => Number(plates[k]) === Number(id)) ?? null,
  };
}

/** The company's §90 settings, inside the caller's transaction. */
export async function setPlateRules(db, company, { gradeRule, customPlates } = {}) {
  const sets = []; const vals = [];
  if (gradeRule !== undefined) { sets.push('nest_grade_rule'); vals.push(gradeRule); }
  if (customPlates !== undefined) { sets.push('nest_custom_plates'); vals.push(customPlates == null ? null : JSON.stringify(customPlates)); }
  if (!sets.length) return;
  await db.query(`INSERT INTO cf_company_settings (company_id, ${sets.join(', ')}) VALUES (?, ${sets.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${sets.map((s) => `${s} = VALUES(${s})`).join(', ')}`, [company, ...vals]);
}
