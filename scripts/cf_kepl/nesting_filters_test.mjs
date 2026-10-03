/**
 * nesting_filters_test.mjs — the NESTING CHOICES (init.sql §40) and the plate
 * RULE CHECK, end to end against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nesting_filters_test.mjs
 *
 * Step A (cut pieces left out of a line's nesting) and Step B (raw plates
 * excluded) are saved per line and applied by every run: a left-out piece is
 * never placed and stays "plate chosen at nesting"; an excluded plate is never
 * a sheet; a steel with no plate left is refused; accept checks both again.
 *
 * Same discipline as nesting_test.mjs, whose fixture this copies: ONE
 * transaction, rolled back, and every table it touched re-counted at the end.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const S = await imp('apps/cf_erp/services/nestingService.js');

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
  'cf_plate_lots', 'cf_nest_placements', 'cf_offcuts', 'cf_cut_settings', 'cf_master_records', 'cf_item_details',
  'cf_boms', 'cf_bom_lines', 'cf_spec_values', 'cf_spec_options', 'cf_specifications',
  'cf_sales_orders', 'cf_sales_order_lines', 'cf_nest_exclusions',
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
  // FROZEN from the start (locked_at): nesting lays out a frozen design only
  // (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30). Section 2 proves the refusal first.
  const [l] = await db.query(
    'INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, \'custom\', ?, ?, 1, ?, NOW(), 1)',
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
const sheetsSeen = [];
const spyPacker = (input) => { sheetsSeen.push(input.sheets.map((s) => s.key)); return shelfPacker(input); };
const pieceIds = (plan) => new Set(plan.groups.flatMap((g) => g.nests.flatMap((n) => n.pieces.map((p) => p.cutPlateId))));
const plateIds = (plan) => new Set(plan.groups.flatMap((g) => g.nests.map((n) => n.plateItemId)));
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const before = await counts(pool);
const conn = await pool.getConnection();
let fixture = null;
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };

  section('Fixture');
  fixture = await buildFixture(conn);
  const { lineId, A, B, M, X, P1, P2, P3, P4 } = fixture;
  console.log(`  ${fixture.tag}: order line ${lineId}`);

  section('1. Step A + B: what a run would consider, before anything is chosen');
  const v0 = await S.nestingChoices(conn, COMPANY, lineId);
  eq('one steel group (the fixture thickness, grade A)', v0.groups.length, 1);
  const g0 = v0.groups[0];
  ok('the group lists the cut pieces A, B and the NEST_MANUAL one', [A, B, M].every((id) => g0.pieces.some((p) => p.cutPlateId === id)));
  ok('the NEST_MANUAL piece is marked manual and explained', g0.pieces.find((p) => p.cutPlateId === M)?.manual === true && /NEST_MANUAL/.test(g0.pieces.find((p) => p.cutPlateId === M)?.note ?? ''));
  ok('the piece with no grade is listed as unusable, with the reason', v0.unusable.some((u) => u.cutPlateId === X && /grade/.test(u.reason)));
  eq('pieces A: 2 per unit x line qty 3 = 6', g0.pieces.find((p) => p.cutPlateId === A)?.toNest, 6);
  near('A weighs 900 x 400 x 7.777 mm at 7850 kg/m3 each', g0.pieces.find((p) => p.cutPlateId === A)?.kgEach, (0.9 * 0.4 * 0.007777 * 7850), 1e-3);
  eq('the summary counts the nestable pieces (6 A + 3 B; manual not counted)', g0.summary.pieces, 9);
  const offered = g0.plates.map((p) => p.plateItemId).sort((a, b) => a - b);
  eq("the plates offered are the PACKER's candidates: P1 (matches) and P4 (blank steel, tolerated)", JSON.stringify(offered), JSON.stringify([P1, P4].sort((a, b) => a - b)));
  ok('...never the wrong grade or the wrong thickness', !offered.includes(P2) && !offered.includes(P3));
  ok('every plate starts ticked and carries stock and prices fields', g0.plates.every((p) => p.excluded === false && p.stock && 'lastPaid' in p && 'listPrice' in p));
  eq('nothing is left out yet', v0.summary.piecesLeftOut + v0.summary.platesExcluded, 0);
  eq('nothing is blocked', v0.blocked.length, 0);

  section('2. Saving the choices - validated, whole-line, persisted');
  const bad = await refusal(() => S.saveNestingChoices(conn, c, lineId, { excludedCutPlateIds: [P1], excludedPlateIds: [B] }));
  ok('a plate named as a cut piece (and vice versa) is refused, both reasons together', bad?.code === 'INVALID' && bad.problems?.length === 2, JSON.stringify(bad?.problems));
  const v1 = await S.saveNestingChoices(conn, c, lineId, { excludedCutPlateIds: [B, X], excludedPlateIds: [P4] });
  eq('B (3) and the grade-less X (3) are left out: 6 pieces', v1.summary.piecesLeftOut, 6);
  eq('P4 is excluded: 1 plate', v1.summary.platesExcluded, 1);
  ok('the view marks them unticked', v1.groups[0].pieces.find((p) => p.cutPlateId === B)?.excluded && v1.groups[0].plates.find((p) => p.plateItemId === P4)?.excluded);
  const [[cnt]] = await conn.query('SELECT COUNT(*) AS n FROM cf_nest_exclusions WHERE company_id = ? AND order_line_id = ?', [COMPANY, lineId]);
  eq('three rows in cf_nest_exclusions', Number(cnt.n), 3);

  section('3. Every run applies them');
  // §44: a line's nesting must be told which plates it may use before it runs.
  await conn.query("UPDATE cf_sales_order_lines SET nest_plates = 'any' WHERE company_id = ? AND id IN (?)", [COMPANY, [lineId]]);
  const plan = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7 });
  ok('the left-out piece B is never placed', !pieceIds(plan).has(B));
  ok('A is placed', pieceIds(plan).has(A));
  ok('the excluded plate P4 is never offered to the packer', sheetsSeen.at(-1).every((k) => !k.startsWith(`pl${P4}`)) && sheetsSeen.at(-1).some((k) => k.startsWith(`pl${P1}`)), JSON.stringify(sheetsSeen.at(-1)));
  ok('...nor used', !plateIds(plan).has(P4));
  eq('the plan says what it left out', plan.choices.piecesLeftOut, 6);
  eq('...and the grade-less X, left out, is no longer a problem', plan.problems.length, 0);
  eq('...and how many plates it excluded', plan.choices.platesExcluded, 1);
  ok('every proposed plate carries a rule check and its utilisation', plan.groups[0].nests.every((n) => n.rules && ['ok', 'warn'].includes(n.rules.status) && n.rules.utilisationPct > 0));
  ok('the stub packer obeys the rules, so its plates read ok', plan.groups[0].nests.every((n) => n.rules.status === 'ok'), JSON.stringify(plan.groups[0].nests.map((n) => n.rules.checks.filter((x) => x.ok === false))));
  const plan2 = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'standard', seed: 3 });
  ok('a re-nest at another effort applies them too', !pieceIds(plan2).has(B) && !plateIds(plan2).has(P4));
  const ignored = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7, ignoreChoices: true });
  ok('ignoreChoices plans as if none were made (B placed, X a problem again)', pieceIds(ignored).has(B) && ignored.problems.some((p) => /grade/.test(p)));

  section('4. Accept: the layout is not held to a left-out piece');
  const acc = await S.acceptNesting(conn, c, lineId, plan);
  eq('accepted: 6 pieces of A, none of B', acc.pieces, 6);
  const saved = await S.getNesting(conn, COMPANY, lineId);
  eq('no drift - B is left out, not missing', saved.drift.length, 0);
  const covB = saved.coverage.find((x) => x.cutPlateId === B);
  ok('coverage marks B left out, 0 nested', covB?.leftOut === true && covB.nested === 0);
  eq('the saved plan says "6 pieces left out"', saved.choices.piecesLeftOut, 6);
  eq('...and "1 plate excluded"', saved.choices.platesExcluded, 1);
  ok('saved plates carry the rule check too', saved.groups[0].nests.every((n) => n.rules?.status === 'ok'));
  const [[lineB]] = await conn.query('SELECT child_id, quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[B]]);
  ok("B's plate line is untouched (never nested)", Number(lineB.child_id) === P1 && Math.abs(Number(lineB.quantity) - (600 * 300) / (PLATE_L * PLATE_W)) < 1e-6, JSON.stringify(lineB));
  const leftOutBy = new Map();
  const { explode } = await imp('apps/cf_erp/services/bomService.js');
  const [[ln]] = await conn.query('SELECT item_id, quantity FROM cf_sales_order_lines WHERE id = ?', [lineId]);
  const t = await explode(conn, COMPANY, ln.item_id, { rootQuantity: Number(ln.quantity) });
  const driftBy = await S.layoutDriftOfLines(conn, COMPANY, [lineId], new Map([[lineId, t]]), { leftOut: leftOutBy });
  eq('the process stage sees no drift either', (driftBy.get(lineId) ?? []).length, 0);
  eq('...and counts 6 pieces left out', leftOutBy.get(lineId)?.pieces, 6);

  section('5. Back in, nested, then left out again: plate chosen at nesting');
  await S.saveNestingChoices(conn, c, lineId, { excludedCutPlateIds: [X], excludedPlateIds: [P4] });
  const planAll = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7 });
  ok('ticked back in, B is placed', pieceIds(planAll).has(B));
  await S.acceptNesting(conn, c, lineId, planAll);
  const [[nestedB]] = await conn.query('SELECT child_id, quantity FROM cf_bom_lines WHERE id = ?', [fixture.areaLine[B]]);
  ok("B now carries the nest's plate", Number(nestedB.child_id) === P1);
  await S.saveNestingChoices(conn, c, lineId, { excludedCutPlateIds: [B, X], excludedPlateIds: [P4] });
  const stale = await refusal(() => S.acceptNesting(conn, c, lineId, planAll));
  ok('accept refuses a layout that places a left-out piece, in words', stale?.code === 'INVALID' && stale.problems.some((p) => /left out of this line's nesting/.test(p)), JSON.stringify(stale?.problems?.slice(0, 2)));
  const planNoB = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7 });
  const acc2 = await S.acceptNesting(conn, c, lineId, planNoB);
  ok('accepting without B names it as gone back to nesting', acc2.leftOutBackToNesting?.includes(B), JSON.stringify(acc2.leftOutBackToNesting));
  const [[resetB]] = await conn.query('SELECT l.child_id, l.quantity, d.definition_type FROM cf_bom_lines l LEFT JOIN cf_definition_details d ON d.master_id = l.child_id AND d.deleted_at IS NULL WHERE l.id = ?', [fixture.areaLine[B]]);
  ok("B's plate line holds the plate SELECTION again at the placeholder 1 - chosen at nesting", resetB.definition_type === 'selection' && Number(resetB.quantity) === 1, JSON.stringify(resetB));
  const onP4 = JSON.parse(JSON.stringify(planNoB));
  onP4.groups[0].nests[0].plateItemId = P4;
  const p4 = await refusal(() => S.acceptNesting(conn, c, lineId, onP4));
  ok('accept refuses a lot on an excluded plate', p4?.problems?.some((p) => /excluded from this line's nesting/.test(p)), JSON.stringify(p4?.problems?.slice(0, 2)));

  section('6. A steel with no plate left is blocked');
  const vb = await S.saveNestingChoices(conn, c, lineId, { excludedCutPlateIds: [X], excludedPlateIds: [P1, P4] });
  eq('the view names the blocked steel', vb.blocked.length, 1);
  ok('...in words', /every plate it could be cut from is unticked/.test(vb.blocked[0] ?? ''), vb.blocked[0]);
  const blocked = await refusal(() => S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick' }));
  eq('planNesting refuses with NO_PLATES_LEFT', blocked?.code, 'NO_PLATES_LEFT');
  const vb2 = await S.saveNestingChoices(conn, c, lineId, { excludedCutPlateIds: [A, B, X], excludedPlateIds: [P1, P4] });
  eq('untick the pieces too and nothing is blocked', vb2.blocked.length, 0);

  section('7. Reset, and the rules that close the line');
  const vr = await S.saveNestingChoices(conn, c, lineId, {});
  eq('an empty selection resets everything', vr.summary.piecesLeftOut + vr.summary.platesExcluded, 0);
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [lineId]);
  const unfrozen = await refusal(() => S.saveNestingChoices(conn, c, lineId, { excludedCutPlateIds: [B] }));
  eq('an unfrozen line cannot save choices (NOT_FROZEN)', unfrozen?.code, 'NOT_FROZEN');
  const look = await S.nestingChoices(conn, COMPANY, lineId);
  ok('...but can still look, and is told why it cannot save', look.canSave === false && /Freeze the design first/.test(look.readOnlyReason ?? ''));
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [lineId]);

  section('7b. Standard or custom plates (§44): asked before the first run, then obeyed');
  await conn.query('UPDATE cf_sales_order_lines SET nest_plates = NULL WHERE id = ?', [lineId]);
  const notChosen = await refusal(() => S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7 }));
  eq('a line nobody has chosen for is not nested (PLATES_NOT_CHOSEN)', notChosen?.code, 'PLATES_NOT_CHOSEN');
  eq('...and the choices say it is not chosen', (await S.nestingChoices(conn, COMPANY, lineId)).plateChoice, null);
  const badChoice = await refusal(() => S.setNestPlates(conn, c, lineId, { plates: 'cheap' }));
  eq('only standard or any can be chosen', badChoice?.code, 'INVALID');
  await S.setNestPlates(conn, c, lineId, { plates: 'standard' });
  const noStd = await S.nestingChoices(conn, COMPANY, lineId);
  eq('standard chosen and remembered', noStd.plateChoice, 'standard');
  ok('no fixture plate says Standard, so the steel is blocked — in words', noStd.groups.some((g) => /no standard plate/.test(g.blocked ?? '')), JSON.stringify(noStd.groups.map((g) => g.blocked)));
  ok('each plate says its kind and that it is not allowed', noStd.groups.flatMap((g) => g.plates).every((p) => p.kind !== 'STANDARD' && p.allowed === false));
  const planNone = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7 });
  ok('a run with no standard plate places nothing and says why', planNone.problems.some((p) => /no standard plate/.test(p)), JSON.stringify(planNone.problems));
  const [[kindSpec]] = await conn.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'PLATE_KIND' AND deleted_at IS NULL", [COMPANY]);
  const [[stdOpt]] = await conn.query("SELECT id FROM cf_spec_options WHERE specification_id = ? AND value = 'STANDARD' AND deleted_at IS NULL", [kindSpec.id]);
  await conn.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [P1, kindSpec.id]);
  await conn.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, option_id, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, kindSpec.id, P1, stdOpt.id]);
  const planStd = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7 });
  ok('with P1 marked Standard, only P1 is offered', sheetsSeen.at(-1).length > 0 && sheetsSeen.at(-1).every((k) => k.startsWith(`pl${P1}`)), JSON.stringify(sheetsSeen.at(-1)));
  ok('...and the pieces are placed', pieceIds(planStd).size > 0);
  const stdView = await S.nestingChoices(conn, COMPANY, lineId);
  ok('the view counts one standard plate and P1 is allowed', stdView.plateKinds.standard >= 1 && stdView.groups.flatMap((g) => g.plates).some((p) => p.plateItemId === P1 && p.kind === 'STANDARD' && p.allowed));
  await S.setNestPlates(conn, c, lineId, { plates: 'any' });
  await conn.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [P1, kindSpec.id]);
  const planAny = await S.planNesting(conn, COMPANY, lineId, { pack: spyPacker, effort: 'quick', seed: 7 });
  ok('standard and custom: P1, no longer marked Standard, is offered and used', sheetsSeen.at(-1).some((k) => k.startsWith(`pl${P1}`)) && pieceIds(planAny).size > 0 && !planAny.problems.some((p) => /no standard plate/.test(p)), JSON.stringify(sheetsSeen.at(-1)));

  section('8. The rule check (pure)');
  const good = S.nestRules({
    length: 1000, width: 500, thickness: 10,
    pieces: [
      { x: 3, y: 3, length: 100, width: 100, seqNo: 1, rowNo: 1 },
      { x: 106, y: 3, length: 100, width: 100, seqNo: 1, rowNo: 1 },
      { x: 3, y: 120, length: 300, width: 250, seqNo: 2, rowNo: 1, rotated: true },
    ],
  }, { kerfMm: 3, seqGapMinMm: 5, seqGapMaxMm: 8 });
  eq('a legal plate reads ok', good.status, 'ok');
  eq('...with one shared cut, 100 mm long', `${good.sharedCuts}/${good.sharedLengthMm}`, '1/100');
  near('...utilisation = parts over plate', good.utilisationPct, ((2 * 100 * 100 + 300 * 250) / (1000 * 500)) * 100, 1e-3);
  ok('...and the turned part is allowed', good.checks.find((x) => x.key === 'rotation')?.ok === true && /1 turned/.test(good.checks.find((x) => x.key === 'rotation').label));
  const thin = S.nestRules({ length: 1000, width: 500, pieces: [{ x: 2, y: 2, length: 100, width: 100, seqNo: 1, rowNo: 1 }] }, { kerfMm: 2, seqGapMinMm: 5, seqGapMaxMm: 8 });
  ok('a kerf under the 2.5-5 band warns', thin.status === 'warn' && thin.checks.find((x) => x.key === 'kerf').ok === false);
  const rim = S.nestRules({ length: 1000, width: 500, pieces: [{ x: 1, y: 3, length: 100, width: 100, seqNo: 1, rowNo: 1 }] }, { kerfMm: 3, seqGapMinMm: 5, seqGapMaxMm: 8 });
  ok('a part over the rim warns', rim.checks.find((x) => x.key === 'rim').ok === false);
  const lap = S.nestRules({ length: 1000, width: 500, pieces: [
    { x: 3, y: 3, length: 100, width: 100, seqNo: 1, rowNo: 1 }, { x: 50, y: 50, length: 100, width: 100, seqNo: 1, rowNo: 1 },
  ] }, { kerfMm: 3, seqGapMinMm: 5, seqGapMaxMm: 8 });
  ok('an overlap warns', lap.checks.find((x) => x.key === 'spacing').ok === false && /overlap/.test(lap.checks.find((x) => x.key === 'spacing').label));
  const order = S.nestRules({ length: 1000, width: 900, pieces: [
    { x: 3, y: 400, length: 300, width: 300, seqNo: 1, rowNo: 1 }, { x: 400, y: 3, length: 300, width: 300, seqNo: 2, rowNo: 1 },
    { x: 3, y: 3, length: 300, width: 300, seqNo: 3, rowNo: 1 },
  ] }, { kerfMm: 3, seqGapMinMm: 5, seqGapMaxMm: 8 });
  ok('sequences numbered out of order across the plate warn', order.checks.find((x) => x.key === 'order').ok === false);
  const rows = S.nestRules({ length: 2000, width: 900, pieces: [1, 2, 3].map((r) => ({ x: 3, y: 3 + (r - 1) * 103, length: 100, width: 100, seqNo: 1, rowNo: r })) }, { kerfMm: 3, seqGapMinMm: 5, seqGapMaxMm: 8 });
  ok('three rows of small parts in one sequence warn (Small holds 2)', rows.checks.find((x) => x.key === 'rows').ok === false);
  eq('a plate with no layout has nothing to check', S.nestRules({ length: 1000, width: 500, pieces: [{ x: null, y: null, length: 10, width: 10 }] }, { kerfMm: 3 }).status, 'none');

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

section('9. Nothing survived the rollback');
const after = await counts(pool);
const left = diff(before, after);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
