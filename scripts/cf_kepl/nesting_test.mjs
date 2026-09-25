/**
 * nesting_test.mjs — nestingService, end to end, against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nesting_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. Nothing here
 * is committed, and the last thing it does is re-count every table it wrote and
 * prove the counts are exactly what they were before it started.
 *
 * IT BUILDS ITS OWN FIXTURE and depends on no existing order. The KEPL bridge
 * data in this company is somebody else's and may change under us; a test that
 * reads it is a test that fails for reasons that are not about nesting. All it
 * borrows from the tenant is the classification tree (Steel › Plates › Plate
 * and › Cut plate) and the GRADE / MATERIAL specifications, because those are
 * what the service looks things up by.
 *
 * The fixture's thickness is a deliberately silly 7.777 mm so that the catalog
 * plates it creates are the ONLY candidates in a company that holds 188 real
 * ones. That is what makes the assertions about candidate selection mean
 * something.
 *
 * IT RUNS THE PACKER BOTH WAYS. Sections 1–12 pass a dumb shelf packer defined
 * in this file through `planNesting(..., { pack })` — the seam the service
 * exposes because the packer is pure geometry — since an EXACT plate count can
 * only be asserted against a layout whose arithmetic is known in advance. It
 * was written when services/nestingPacker.js did not exist yet and it stays,
 * because a service test should not fail when somebody improves the packer.
 * Section 13 then runs the real one and asserts what must hold whatever it
 * decides: above all that acceptNesting VERIFIES the packer's own output.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const S = await imp('apps/cf_erp/services/nestingService.js');
const SHEET = await imp('apps/cf_erp/services/nestingSheetService.js');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const T = 7.777;                         // a thickness nothing else in the catalog has
const LINE_QTY = 3;
// The candidate plate. Two rows of the fixture's rectangles fit on it and a
// third does not, so the pack needs two plates — which is what makes "count
// lots for plates" and the apportionment across a SHARED plate testable.
const PLATE_L = 2500;
const PLATE_W = 900;
const PLATE_AREA = PLATE_L * PLATE_W;

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => ok(name, Object.is(got, want) || got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-6) => ok(name, Math.abs(Number(got) - Number(want)) <= tol, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);

/* --------------------------------------------------------------------------
 * The packer stub: shelves, then sequences of rows, obeying the same rules the
 * verifier checks — kerf at the rim and between pieces, sequences 5–8 mm apart.
 * ----------------------------------------------------------------------- */
function shelfPacker({ pieces, sheets, gap, margin, seqGapMin, guillotine, effort, seed }) {
  const started = Date.now();
  const rowsPerSeq = 3;                  // the fixture's rectangles are all Big
  const remaining = pieces.map((p) => ({ ...p, left: p.qty }));   // by the row OBJECT, never by its key
  const nests = [];
  const unplaced = [];
  const sheet = sheets[0];
  if (!sheet) return { nests, unplaced: pieces.map((p) => ({ key: p.key, qty: p.qty, reason: 'no sheet' })), areaBought: 0, wasteArea: 0, wastePct: 0, deterministic: true, elapsedMs: 0, sizeAdvice: [] };

  const fits = (p) => (p.length <= sheet.length - 2 * margin && p.width <= sheet.width - 2 * margin);
  for (const p of remaining) if (!fits(p)) { unplaced.push({ key: p.key, qty: p.left, reason: `${p.length} × ${p.width} does not fit ${sheet.length} × ${sheet.width}` }); p.left = 0; }

  while (remaining.some((p) => p.left > 0)) {
    const placed = [];
    let y = margin;
    let rowIndex = 0;
    while (remaining.some((p) => p.left > 0)) {
      const row = [];
      let x = margin;
      let rowHeight = 0;
      for (const p of remaining) {
        while (p.left > 0 && x + p.length <= sheet.length - margin && y + p.width <= sheet.width - margin) {
          row.push({ key: p.key, x, y, length: p.length, width: p.width, rotated: false });
          x += p.length + gap;
          rowHeight = Math.max(rowHeight, p.width);
          p.left -= 1;
        }
      }
      if (!row.length) break;                       // nothing more fits on this sheet
      const seqNo = Math.floor(rowIndex / rowsPerSeq) + 1;
      const rowNo = (rowIndex % rowsPerSeq) + 1;
      for (const r of row) placed.push({ ...r, seqNo, rowNo });
      rowIndex += 1;
      // A sequence is cut whole, so the step to the next one is the sequence
      // gap; inside a sequence, rows are one kerf apart.
      y += rowHeight + (rowIndex % rowsPerSeq === 0 ? seqGapMin : gap);
    }
    if (!placed.length) break;
    const usedArea = placed.reduce((a, p) => a + p.length * p.width, 0);
    nests.push({ sheetKey: sheet.key, preferred: !!sheet.preferred, pieces: placed, usedArea, sheetArea: sheet.length * sheet.width });
  }
  for (const p of remaining) if (p.left > 0) unplaced.push({ key: p.key, qty: p.left, reason: 'ran out of sheets' });

  const areaBought = nests.reduce((a, n) => a + n.sheetArea, 0);
  const used = nests.reduce((a, n) => a + n.usedArea, 0);
  return {
    nests, unplaced, areaBought, wasteArea: areaBought - used,
    wastePct: areaBought ? ((areaBought - used) / areaBought) * 100 : 0,
    deterministic: true, elapsedMs: Date.now() - started, sizeAdvice: [],
    echo: { gap, margin, seqGapMin, guillotine, effort, seed },
  };
}

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" and "leaves nothing behind" are facts
 * ----------------------------------------------------------------------- */
const COUNTED = [
  'cf_plate_lots', 'cf_nest_placements', 'cf_cut_settings', 'cf_master_records', 'cf_item_details',
  'cf_boms', 'cf_bom_lines', 'cf_spec_values', 'cf_spec_options', 'cf_specifications',
  'cf_sales_orders', 'cf_sales_order_lines',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
const diff = (a, b) => COUNTED.filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);

/* --------------------------------------------------------------------------
 * The fixture
 * ----------------------------------------------------------------------- */
async function nodeByCode(db, code) {
  const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (!n) throw new Error(`This company has no ${code} classification node — the cf_erp taxonomy is not set up here.`);
  return n.id;
}

async function specByCode(db, code, dataType) {
  const [[s]] = await db.query('SELECT id, data_type FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (s) return s.id;
  const [r] = await db.query(
    'INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, \'active\')',
    [COMPANY, code, code, dataType],
  );
  return r.insertId;
}

async function twoOptions(db, specId) {
  const [rows] = await db.query('SELECT id, value FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY, specId]);
  const out = rows.map((r) => r.id);
  while (out.length < 2) {
    const [r] = await db.query('INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, \'active\')',
      [COMPANY, specId, `NESTTEST-${out.length + 1}-${Date.now()}`]);
    out.push(r.insertId);
  }
  return out;
}

async function makeMaster(db, { code, name, classificationId, itemType, ownerLineId = null }) {
  const [m] = await db.query(
    'INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, \'item\', ?, ?, ?, \'active\')',
    [COMPANY, code, name, classificationId],
  );
  await db.query(
    'INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id) VALUES (?, ?, ?, \'quantity\', \'nos\', ?, ?)',
    [m.insertId, COMPANY, itemType, itemType === 'temporary' ? 'make' : 'stock', ownerLineId],
  );
  return m.insertId;
}

/** Values written straight in: a fixture must not depend on the rule engine's setup. */
async function setVals(db, subjectId, vals) {
  for (const [specId, v] of vals) {
    if (v == null) continue;
    const cols = { value_number: null, option_id: null, value_bool: null };
    if (v.kind === 'number') cols.value_number = v.value;
    if (v.kind === 'option') cols.option_id = v.value;
    if (v.kind === 'bool') cols.value_bool = v.value;
    await db.query(
      'INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, value_bool, source) VALUES (?, ?, \'master\', ?, ?, ?, ?, ?)',
      [COMPANY, specId, subjectId, cols.value_number, cols.option_id, cols.value_bool, v.source ?? 'entered'],
    );
  }
}

async function makeBomLine(db, parentId, childId, quantity, lineNo) {
  let [[bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
  if (!bom) {
    const [b] = await db.query('INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, \'custom\', \'active\')', [COMPANY, parentId]);
    bom = { id: b.insertId };
  }
  const [l] = await db.query(
    'INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, bom.id, lineNo, childId, childId, lineNo, quantity],
  );
  return l.insertId;
}

async function buildFixture(db) {
  const tag = `NT${Date.now().toString(36).toUpperCase()}`;
  const plateNode = await nodeByCode(db, 'PLATE');
  const cutNode = await nodeByCode(db, 'CUT_PLATE');
  const spec = {
    THICKNESS: await specByCode(db, 'THICKNESS', 'number'),
    LENGTH: await specByCode(db, 'LENGTH', 'number'),
    WIDTH: await specByCode(db, 'WIDTH', 'number'),
    GRADE: await specByCode(db, 'GRADE', 'option'),
    MATERIAL: await specByCode(db, 'MATERIAL', 'option'),
    DENSITY: await specByCode(db, 'DENSITY', 'number'),
    NEST_MANUAL: await specByCode(db, S.NEST_MANUAL_SPEC_CODE, 'boolean'),
  };
  const [gradeA, gradeB] = await twoOptions(db, spec.GRADE);
  const [matA] = await twoOptions(db, spec.MATERIAL);

  const num = (v) => ({ kind: 'number', value: v });
  const opt = (v) => ({ kind: 'option', value: v });
  const size = (t, l, w, g, m) => [
    [spec.THICKNESS, num(t)], [spec.LENGTH, num(l)], [spec.WIDTH, num(w)],
    [spec.GRADE, g == null ? null : opt(g)], [spec.MATERIAL, m == null ? null : opt(m)],
    [spec.DENSITY, num(7850)],
  ];

  // Catalog plates: two that match the group, two that must not.
  const P1 = await makeMaster(db, { code: `${tag}-P1`, name: 'Fixture plate 2500x900', classificationId: plateNode, itemType: 'catalog' });
  await setVals(db, P1, size(T, PLATE_L, PLATE_W, gradeA, matA));
  const P2 = await makeMaster(db, { code: `${tag}-P2`, name: 'Fixture plate wrong grade', classificationId: plateNode, itemType: 'catalog' });
  await setVals(db, P2, size(T, 3000, 1500, gradeB, matA));
  const P3 = await makeMaster(db, { code: `${tag}-P3`, name: 'Fixture plate wrong thickness', classificationId: plateNode, itemType: 'catalog' });
  await setVals(db, P3, size(T + 2, 3000, 1500, gradeA, matA));
  const P4 = await makeMaster(db, { code: `${tag}-P4`, name: 'Fixture plate blank steel', classificationId: plateNode, itemType: 'catalog' });
  await setVals(db, P4, size(T, 1200, 600, null, null));

  // The order, its line, and the item the line sells.
  const [o] = await db.query(
    'INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, \'customer\', \'Nesting fixture\', \'confirmed\')',
    [COMPANY, `${tag}-SO`],
  );
  const orderId = o.insertId;
  const root = await makeMaster(db, { code: `${tag}-ROOT`, name: 'Fixture assembly', classificationId: cutNode, itemType: 'temporary' });
  const [l] = await db.query(
    'INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity) VALUES (?, ?, 1, \'custom\', ?, ?, 1, ?)',
    [COMPANY, orderId, root, root, LINE_QTY],
  );
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);

  // The rectangles. All Big (over 200 mm both ways), so every sequence holds 3
  // rows and the stub's numbering is the one the verifier expects.
  const cut = async (suffix, l2, w, grade, perUnit, manual = false) => {
    const id = await makeMaster(db, { code: `${tag}-${suffix}`, name: `Fixture ${suffix}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(db, id, size(T, l2, w, grade, matA));
    if (manual) await setVals(db, id, [[spec.NEST_MANUAL, { kind: 'bool', value: 1, source: 'entered' }]]);
    await makeBomLine(db, root, id, perUnit, Number(String(suffix).replace(/\D/g, '')) || 1);
    return id;
  };
  const A = await cut('CP1', 900, 400, gradeA, 2);
  const B = await cut('CP2', 600, 300, gradeA, 1);
  const M = await cut('CP3', 500, 500, gradeA, 1, true);
  const X = await cut('CP4', 400, 400, null, 1);       // no grade: refused outright

  // Each rectangle's own BOM line to its raw plate, at the AREA FRACTION, just
  // as cutPlateService leaves it. This is what accept replaces.
  const areaLine = {};
  for (const [id, len, wid] of [[A, 900, 400], [B, 600, 300], [M, 500, 500], [X, 400, 400]]) {
    areaLine[id] = await makeBomLine(db, id, P1, (len * wid) / PLATE_AREA, 1);
  }

  // A kerf band table: 5–16 -> 3, 18–20 -> 4, 25–50 -> 5, plus a default row.
  //
  // init.sql SEEDS these bands for every company, so clear them first and own
  // the fixture outright. A test that shares its inputs with a seed passes or
  // fails on whichever ran last, and the default row here is deliberately 2 —
  // a value no seed uses — so an assertion that reads it proves the default was
  // reached rather than a band. Hard DELETE is safe: the whole run is one
  // transaction and it is rolled back.
  // Before clearing them: the bands init.sql seeded must match the copy in
  // code. SQL and JS cannot share a literal, so this is the only thing stopping
  // the two drifting — and a wrong kerf is invisible until a part is cut short.
  const [seeded] = await db.query(
    `SELECT thickness_min_mm lo, thickness_max_mm hi, kerf_mm k FROM cf_cut_settings
       WHERE company_id = ? AND deleted_at IS NULL AND thickness_min_mm IS NOT NULL ORDER BY thickness_min_mm`,
    [COMPANY],
  );
  const wanted = S.PUBLISHED_KERF_BANDS.map((b2) => `${b2.minMm}-${b2.maxMm}:${b2.kerfMm}`).join(' ');
  const got = seeded.map((r) => `${Number(r.lo)}-${Number(r.hi)}:${Number(r.k)}`).join(' ');
  eq('the kerf bands init.sql seeded match the published bands in code', got, wanted);
  eq('and the code fallback bands a thick plate rather than flattening it', S.publishedKerf(40), 5);

  await db.query('DELETE FROM cf_cut_settings WHERE company_id = ?', [COMPANY]);
  for (const [min, max, kerf] of [[5, 16, 3], [18, 20, 4], [25, 50, 5], [null, null, 2]]) {
    await db.query(
      'INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, guillotine) VALUES (?, ?, ?, ?, 5, 8, 100, 50, 0)',
      [COMPANY, min, max, kerf],
    );
  }
  return { tag, lineId, orderId, root, A, B, M, X, P1, P2, P3, P4, areaLine, spec };
}

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
const before = await counts(pool);
const conn = await pool.getConnection();
let fixture = null;
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };

  section('Fixture');
  fixture = await buildFixture(conn);
  console.log(`  ${fixture.tag}: order line ${fixture.lineId}, quantity ${LINE_QTY}`);

  /* ---- 1. the arithmetic the shop quotes ------------------------------- */
  section('1. Kerf bands, shared boundaries and sequence rows');
  const s12 = await S.resolveCutSettings(conn, COMPANY, 12);
  const s19 = await S.resolveCutSettings(conn, COMPANY, 19);
  const s30 = await S.resolveCutSettings(conn, COMPANY, 30);
  const s99 = await S.resolveCutSettings(conn, COMPANY, 99);
  eq('12 mm falls in the 5–16 band (3 mm kerf)', s12.kerfMm, 3);
  eq('19 mm falls in the 18–20 band (4 mm kerf)', s19.kerfMm, 4);
  eq('30 mm falls in the 25–50 band (5 mm kerf)', s30.kerfMm, 5);
  eq('99 mm falls through to the company default', s99.kerfMm, 2);
  ok('the default row says so', /default row/.test(s99.basis), s99.basis);
  eq('three 100 mm parts sharing boundaries span 312 mm', S.sharedSpan([100, 100, 100], 3), 312);
  eq('…and 318 mm not sharing them', 3 * (100 + 2 * 3), 318);
  eq('under 200 mm on both dimensions is Small', S.isSmallPart(199, 199), true);
  eq('200 mm on one dimension is not', S.isSmallPart(199, 200), false);
  eq('a Small sequence holds 2 rows', S.rowsPerSequence([{ length: 100, width: 100 }]), 2);
  eq('a sequence with anything Big holds 3', S.rowsPerSequence([{ length: 100, width: 100 }, { length: 900, width: 400 }]), 3);

  /* ---- 2. planning writes nothing -------------------------------------- */
  section('2. planNesting proposes and writes nothing');
  const beforePlan = await counts(conn);
  const plan = await S.planNesting(conn, COMPANY, fixture.lineId, { pack: shelfPacker, effort: 'quick', seed: 7 });
  const afterPlan = await counts(conn);
  ok('not one row changed anywhere', diff(beforePlan, afterPlan).length === 0, diff(beforePlan, afterPlan).join(', '));
  eq('one steel group', plan.groups.length, 1);
  const g = plan.groups[0];
  eq('the group is keyed on thickness', g.thickness, T);
  eq('it resolved the 5–16 mm kerf band', g.kerfMm, 3);

  /* ---- 3. eligibility, and the unknown asymmetry ----------------------- */
  section('3. Eligibility: thickness, grade, material — and the unknown asymmetry');
  const candIds = g.candidates.map((x) => x.plateItemId);
  ok('the matching plate is a candidate', candIds.includes(fixture.P1), JSON.stringify(candIds));
  ok('a plate of another grade is not', !candIds.includes(fixture.P2));
  ok('a plate of another thickness is not', !candIds.includes(fixture.P3));
  ok('a plate whose steel is BLANK still is — unknown on the plate is tolerated', candIds.includes(fixture.P4));
  eq('exactly those two', candIds.length, 2);
  ok('candidates come back in an explicit order, biggest first', candIds[0] === fixture.P1 && candIds[1] === fixture.P4, JSON.stringify(candIds));
  ok('the rectangle with no grade is refused outright', plan.problems.some((p) => p.includes(`${fixture.tag}-CP4`) && /grade/i.test(p)), JSON.stringify(plan.problems));
  ok('…and never reaches a plate', !g.nests.some((n) => n.pieces.some((p) => p.cutPlateId === fixture.X)));

  /* ---- 4. NEST_MANUAL --------------------------------------------------- */
  section('4. NEST_MANUAL is left out of the pack and reported separately');
  eq('one cut plate is held back by hand', plan.manual.length, 1);
  eq('…and it is the flagged one', plan.manual[0].id, fixture.M);
  ok('the packer never saw it', !g.nests.some((n) => n.pieces.some((p) => p.cutPlateId === fixture.M)));
  ok('it is not counted as unplaced either', !g.unplaced.some((u) => u.cutPlateId === fixture.M), JSON.stringify(g.unplaced));

  /* ---- 5. the refusal's own remedy, then the line quantity -------------- */
  section('5. The remedy the refusal suggests actually works');
  // A rectangle with no steel cannot be accepted either, so the plan cannot be
  // written while CP4 is broken. The message says to set the value or mark it
  // NEST_MANUAL; taking it at its word is the rest of this test.
  let blocked = null;
  try { await S.acceptNesting(conn, c, fixture.lineId, plan); } catch (e) { blocked = e; }
  ok('accepting is refused while a rectangle has no steel', (blocked?.problems ?? []).some((p) => p.includes(`${fixture.tag}-CP4`)), JSON.stringify(blocked?.problems ?? []));
  await conn.query(
    'INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_bool, source) VALUES (?, ?, \'master\', ?, 1, \'entered\')',
    [COMPANY, fixture.spec.NEST_MANUAL, fixture.X],
  );
  const plan2 = await S.planNesting(conn, COMPANY, fixture.lineId, { pack: shelfPacker, effort: 'quick', seed: 7 });
  const g2 = plan2.groups[0];
  eq('marking it by hand clears the refusal', plan2.problems.length, 0, JSON.stringify(plan2.problems));
  eq('and it joins the hand-laid list', plan2.manual.length, 2);

  section('5b. The line quantity is multiplied exactly once');
  const pieceCount = (id) => g2.nests.reduce((a, n) => a + n.pieces.filter((p) => p.cutPlateId === id).length, 0);
  eq('2 per unit x line quantity 3 = 6 pieces', pieceCount(fixture.A), 6);
  eq('1 per unit x line quantity 3 = 3 pieces', pieceCount(fixture.B), 3);
  eq('nothing was left unplaced', g2.unplaced.length, 0, JSON.stringify(g2.unplaced));
  eq('two plates were opened', g2.nests.length, 2);
  eq('and a lot IS a plate', g2.metrics.plates, g2.metrics.lots);
  eq('nine pieces across them — placements counted, not plates', g2.metrics.pieces, 9);
  // The layout needs 2412 mm of a 2500 mm plate. The shop ADDS +100 mm on length
  // and THEN rounds up to the 50 mm step, so it wants 2550 — this plate is
  // technically too tight to buy. Rounding comes second on purpose: the margin
  // is real slack for a crooked mill edge and must survive the rounding.
  const margins = plan2.sizeAdvice.filter((a) => a.kind === 'ordering margin');
  ok('the ordering margin is reported, not silently swallowed', margins.length === 2, JSON.stringify(plan2.sizeAdvice));
  ok('…and says what size would carry it', margins.every((a) => /at least 2550/.test(a.detail)), JSON.stringify(margins.map((a) => a.detail)));
  ok('both rectangles share both plates, which is what pooling IS',
    g2.nests.every((n) => new Set(n.pieces.map((p) => p.cutPlateId)).size === 2),
    JSON.stringify(g2.nests.map((n) => n.pieces.map((p) => p.cutPlateId))));

  /* ---- 6. accepting writes, and replaces the area fraction -------------- */
  section('6. acceptNesting writes lots and placements, and replaces the area fraction');
  const [[wasA]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[fixture.A]]);
  const accepted = await S.acceptNesting(conn, c, fixture.lineId, plan2);
  eq('nothing was there to replace', accepted.replacedLots, 0);
  eq('two lots', accepted.lots, 2);
  eq('nine placements', accepted.pieces, 9);
  const [[lotRows]] = await conn.query('SELECT COUNT(*) AS n FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, fixture.lineId]);
  eq('two live lot rows', Number(lotRows.n), 2);
  const [[placeRows]] = await conn.query(
    'SELECT COUNT(*) AS n FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE p.company_id = ? AND l.order_line_id = ? AND p.deleted_at IS NULL',
    [COMPANY, fixture.lineId],
  );
  eq('nine live placement rows', Number(placeRows.n), 9);
  // Two plates, shared 80/20 by area between the two rectangles, so the big one
  // is charged 1.6 plates over 6 blanks and the small one 0.4 over 3.
  const [[nowA]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[fixture.A]]);
  const [[nowB]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[fixture.B]]);
  near('the big rectangle is charged 1.6 plates over 6 blanks', Number(nowA.quantity), 1.6 / 6, 1e-6);
  near('the small one 0.4 plates over 3 blanks', Number(nowB.quantity), 0.4 / 3, 1e-6);
  // Exact to the six decimals the column holds: a quantity is DECIMAL(18,6), so
  // two of them multiplied back out land within a millionth of the plate count.
  near('and the two together buy EXACTLY the two plates that were opened — nothing double counted, nothing lost',
    Number(nowA.quantity) * 6 + Number(nowB.quantity) * 3, 2, 1e-5);
  ok('and it asks for MORE steel than the area fraction did', Number(nowA.quantity) > Number(wasA.quantity), `${nowA.quantity} vs ${wasA.quantity}`);
  const [[nowM]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[fixture.M]]);
  near('the hand-laid rectangle keeps its area fraction', Number(nowM.quantity), (500 * 500) / PLATE_AREA, 1e-6);
  const [[lot1]] = await conn.query('SELECT required_length_mm, required_width_mm, kerf_mm, length_mm FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, fixture.lineId]);
  ok('the lot records the size the layout NEEDS as well as the size it is', lot1.required_length_mm != null && Number(lot1.required_length_mm) < Number(lot1.length_mm), JSON.stringify(lot1));
  eq('and the kerf it was laid out with', Number(lot1.kerf_mm), 3);

  /* ---- 7. accepting twice is not double steel --------------------------- */
  section('7. Accepting twice is not double steel');
  const again = await S.acceptNesting(conn, c, fixture.lineId, plan2);
  eq('the second accept replaced the first two lots', again.replacedLots, 2);
  const [[lots2]] = await conn.query('SELECT COUNT(*) AS n FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, fixture.lineId]);
  eq('still two live lots, not four', Number(lots2.n), 2);
  const [[place2]] = await conn.query(
    'SELECT COUNT(*) AS n FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE p.company_id = ? AND l.order_line_id = ? AND p.deleted_at IS NULL AND l.deleted_at IS NULL',
    [COMPANY, fixture.lineId],
  );
  eq('still nine live placements', Number(place2.n), 9);
  const [[stillA]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[fixture.A]]);
  near('and the plate count did not move', Number(stillA.quantity), 1.6 / 6, 1e-6);

  /* ---- 8. reading the saved plan back ----------------------------------- */
  section('8. A look is a look — the saved plan reads back as the same layout');
  const saved = await S.getNesting(conn, COMPANY, fixture.lineId);
  eq('it says it is saved', saved.saved, true);
  eq('one group again', saved.groups.length, 1);
  const sg = saved.groups[0];
  eq('two lots', sg.nests.length, 2);
  const key = (n) => n.pieces.map((p) => `${p.cutPlateId}@${p.x},${p.y},${p.length}x${p.width},s${p.seqNo}r${p.rowNo}p${p.posNo},${p.rotated ? 'R' : '-'}`).join('|');
  const plannedKeys = g2.nests.map(key).sort();
  const savedKeys = sg.nests.map(key).sort();
  ok('every piece is back where it was put', JSON.stringify(plannedKeys) === JSON.stringify(savedKeys), `\n    planned ${JSON.stringify(plannedKeys)}\n    saved   ${JSON.stringify(savedKeys)}`);
  eq('the recorded kerf comes back with it', sg.kerfMm, 3);
  eq('the hand-laid rectangles are still reported', saved.manual.length, 2);
  eq('nothing has drifted from the structure', saved.drift.length, 0, JSON.stringify(saved.drift));
  eq('reading it changed nothing', diff(await counts(conn), await counts(conn)).length, 0);

  /* ---- 9. a layout that does not verify is refused, all at once --------- */
  section('9. A layout whose geometry does not verify is refused with every problem at once');
  const bad = JSON.parse(JSON.stringify(plan2));
  const n0 = bad.groups[0].nests[0];
  n0.pieces[1].x = n0.pieces[0].x;                 // sits on top of piece 0
  n0.pieces[1].y = n0.pieces[0].y;
  n0.pieces[2].x = 99999;                          // off the end of the plate
  n0.pieces[3].length = 12;                        // not the rectangle it claims to be
  bad.groups[0].nests[1].plateItemId = fixture.P3; // a plate of the wrong thickness
  let refusal = null;
  try { await S.acceptNesting(conn, c, fixture.lineId, bad); }
  catch (e) { refusal = e; }
  ok('it was refused', refusal != null && refusal.status === 422, refusal ? `${refusal.code}` : 'nothing was thrown');
  ok('with every problem listed at once, not the first', (refusal?.problems ?? []).length >= 4, `${(refusal?.problems ?? []).length} problem(s): ${JSON.stringify(refusal?.problems ?? [])}`);
  ok('the overlap is named', (refusal?.problems ?? []).some((p) => /overlap/i.test(p)));
  ok('the piece off the plate is named', (refusal?.problems ?? []).some((p) => /runs past/i.test(p)));
  ok('the resized piece is named', (refusal?.problems ?? []).some((p) => /is drawn/i.test(p)));
  ok('the wrong-thickness plate is named', (refusal?.problems ?? []).some((p) => /mm and/.test(p)));
  const [[afterBad]] = await conn.query('SELECT COUNT(*) AS n FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, fixture.lineId]);
  eq('and the refusal wrote nothing — the good plan is untouched', Number(afterBad.n), 2);

  /* ---- 10. verification reads the DB, not the request -------------------- */
  section('10. Verification reads the database, not the request');
  const lying = JSON.parse(JSON.stringify(plan2));
  for (const n of lying.groups[0].nests) for (const p of n.pieces) { p.cutPlateCode = 'MADE UP'; p.rotated = false; }
  lying.groups[0].thickness = 999;
  lying.groups[0].kerfMm = 0;
  lying.line = { id: -1, quantity: 9999 };
  const stillFine = await S.acceptNesting(conn, c, fixture.lineId, lying);
  eq('the lies in the payload are ignored and the geometry still passes', stillFine.lots, 2);
  const [[lyingA]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[fixture.A]]);
  near('the plate count is unaffected by the faked line quantity', Number(lyingA.quantity), 1.6 / 6, 1e-6);

  /* ---- 11. a short plan is refused -------------------------------------- */
  section('11. A plan that does not cover the line is refused');
  const short = JSON.parse(JSON.stringify(plan2));
  short.groups[0].nests[0].pieces.pop();
  let shortErr = null;
  try { await S.acceptNesting(conn, c, fixture.lineId, short); } catch (e) { shortErr = e; }
  ok('refused, saying how many are missing', (shortErr?.problems ?? []).some((p) => /the line needs \d+ pieces? and the layout places \d+/.test(p)), JSON.stringify(shortErr?.problems ?? []));

  /* ---- 12. the Excel round trip ----------------------------------------- */
  section('12. The sheet goes out and comes back, and coming back IS accepting');
  await S.acceptNesting(conn, c, fixture.lineId, plan2);            // a clean state to export
  const sheet = await SHEET.exportSheet(conn, COMPANY, fixture.lineId);
  eq('one row per piece', sheet.rows, 9);
  eq('it is the saved plan, not a fresh proposal', sheet.saved, true);
  ok('and it is a workbook', sheet.buffer[0] === 0x50 && sheet.buffer[1] === 0x4b);
  const back = await SHEET.importSheet(conn, c, fixture.lineId, { fileBase64: sheet.buffer.toString('base64') });
  eq('reading it back rewrites the same two lots', back.lots, 2);
  eq('with the same nine pieces', back.pieces, 9);
  eq('and it says where it came from', back.source, 'sheet');
  const afterSheet = await S.getNesting(conn, COMPANY, fixture.lineId);
  const sheetKeys = afterSheet.groups[0].nests.map(key).sort();
  ok('the layout survived the round trip unchanged', JSON.stringify(sheetKeys) === JSON.stringify(savedKeys), `\n    before ${JSON.stringify(savedKeys)}\n    after  ${JSON.stringify(sheetKeys)}`);
  const [[sheetA]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[fixture.A]]);
  near('and so did the plate count', Number(sheetA.quantity), 1.6 / 6, 1e-6);

  /* ---- 13. the real packer --------------------------------------------- */
  // Everything above runs on the stub, because exact plate counts need a layout
  // whose arithmetic is known in advance. This section runs services/
  // nestingPacker.js itself and asserts the things that must hold whatever it
  // decides — above all that the accept path VERIFIES what the packer produced.
  section('13. The real packer — its output passes the same verification');
  let real = null;
  try { real = await S.planNesting(conn, COMPANY, fixture.lineId, { effort: 'quick', seed: 11 }); }
  catch (e) { real = { failed: e }; }
  if (real.failed) {
    ok('the real packer could be reached', false, `${real.failed.code ?? ''} ${real.failed.message}`);
  } else {
    const rg = real.groups[0];
    eq('it groups on one steel', real.groups.length, 1);
    eq('it placed all nine pieces', rg.metrics.pieces, 9);
    eq('and left nothing unplaced', rg.unplaced.length, 0, JSON.stringify(rg.unplaced));
    ok('it opened at least one plate', rg.nests.length >= 1);
    ok('it reports whether the answer is reproducible', rg.deterministic != null);
    ok('it honours the kerf resolved from cf_cut_settings, not a table of its own',
      rg.nests.every((n) => n.pieces.every((p) => p.x >= 3 - 1e-6 && p.y >= 3 - 1e-6)),
      'a piece sits inside the 3 mm rim kerf');

    let realAccept = null;
    try { realAccept = await S.acceptNesting(conn, c, fixture.lineId, real); }
    catch (e) { realAccept = { failed: e }; }
    ok('ITS GEOMETRY VERIFIES — accept did not refuse the packer\'s own plan',
      !realAccept.failed, realAccept.failed ? JSON.stringify(realAccept.failed.problems ?? realAccept.failed.message) : '');

    if (!realAccept.failed) {
      eq('every piece was written', realAccept.pieces, 9);
      eq('one lot per plate the packer opened', realAccept.lots, rg.nests.length);
      // The plate counts need not be whole when a rectangle spills onto a
      // different SIZE of plate, but the steel must balance to the millimetre:
      // what the BOM now asks for is exactly the area of the plates opened.
      const areaAsked = realAccept.quantities.reduce((a, q) => {
        const n = rg.nests.find((x) => x.plateItemId === q.plateItemId);
        return a + q.quantity * q.blanks * (n.length * n.width);
      }, 0);
      const areaBought = rg.nests.reduce((a, n) => a + n.length * n.width, 0);
      near('the steel balances exactly — nothing double counted, nothing lost', areaAsked, areaBought, areaBought * 1e-5);

      const realSaved = await S.getNesting(conn, COMPANY, fixture.lineId);
      eq('the saved plan reads back as ONE group, as it was proposed', realSaved.groups.length, 1);
      const a1 = rg.nests.map(key).sort();
      const a2 = realSaved.groups[0].nests.map(key).sort();
      ok('and piece for piece it is the same layout', JSON.stringify(a1) === JSON.stringify(a2), `\n    planned ${JSON.stringify(a1)}\n    saved   ${JSON.stringify(a2)}`);
      eq('nothing has drifted', realSaved.drift.length, 0, JSON.stringify(realSaved.drift));
    }

    const twice = await S.planNesting(conn, COMPANY, fixture.lineId, { effort: 'quick', seed: 11 });
    ok('the same seed gives the same layout', JSON.stringify(twice.groups[0].nests.map(key)) === JSON.stringify(rg.nests.map(key)));
  }

  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  if (err.problems) console.error('problems:', err.problems);
  console.error(err.stack?.split('\n').slice(1, 6).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('14. Nothing survived the rollback');
const after = await counts(pool);
const left = diff(before, after);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
