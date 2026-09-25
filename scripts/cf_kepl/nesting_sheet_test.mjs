/**
 * nesting_sheet_test.mjs — the nesting Excel round trip, against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nesting_sheet_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. Nothing here
 * is committed, and the last thing it does is re-count every table it wrote and
 * prove the counts are exactly what they were before it started.
 *
 * IT BUILDS ITS OWN FIXTURE and depends on no existing order, for the reason
 * nesting_test gives: the KEPL bridge data in this company is somebody else's
 * and a test that reads it fails for reasons that are not about the sheet. Its
 * thickness is a deliberately silly 6.123 mm so the plate it creates is the
 * ONLY candidate in a company that holds 188 real ones.
 *
 * THE PACKER IS NEVER RUN. Every layout below is typed out in this file, which
 * is the whole point of the feature: a person must be able to lay a plate out
 * BY HAND and have the system take it. That also makes every assertion exact —
 * a test that packs first can only assert what the packer happened to decide.
 *
 * IT POSTS A REAL .xlsx BUFFER. The lesson from the BOM sheet, found the day
 * before this was written: its whole suite fed the importer CSV, so the xlsx
 * path — the one people actually use — was never executed once. Sections 3-5
 * push the bytes the export produced straight back into the importer, and
 * section 5 edits them with exceljs first. Section 9 does CSV as well, because
 * both are supported.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import ExcelJS from 'exceljs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const SS = await imp('apps/cf_erp/services/nestingSheetService.js');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const T = 6.123;                 // a thickness nothing else in the catalog has
const LINE_QTY = 2;
const PLATE_L = 2000;
const PLATE_W = 1000;
const KERF = 3;                  // T falls in the 5-16 mm band

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
const section = (s) => console.log(`\n${s}`);
const some = (xs, re) => (xs ?? []).some((p) => re.test(String(p)));

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" is a fact and not a hope
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
 * The layout, as a string, so "unchanged" is one comparison
 * ----------------------------------------------------------------------- */
const pieceKey = (p) => `${p.cutPlateCode}@s${p.seqNo}r${p.rowNo}p${p.posNo}:${p.x},${p.y} ${p.length}x${p.width}${p.rotated ? 'R' : ''}`;
const layoutOf = (saved) => saved.groups
  .flatMap((g) => g.nests.map((n) => `${n.lotNo}/${n.plateCode}[${n.pieces.map(pieceKey).sort().join(' ')}]`))
  .sort().join(' || ');

/* --------------------------------------------------------------------------
 * The fixture
 * ----------------------------------------------------------------------- */
async function nodeByCode(db, code) {
  const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (!n) throw new Error(`This company has no ${code} classification node — the cf_erp taxonomy is not set up here.`);
  return n.id;
}
async function specByCode(db, code, dataType) {
  const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (s) return s.id;
  const [r] = await db.query('INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, \'active\')', [COMPANY, code, code, dataType]);
  return r.insertId;
}
async function anOption(db, specId) {
  const [[o]] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, specId]);
  if (o) return o.id;
  const [r] = await db.query('INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, \'active\')', [COMPANY, specId, `NSHEET-${Date.now()}`]);
  return r.insertId;
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
    await db.query(
      'INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, source) VALUES (?, ?, \'master\', ?, ?, ?, \'entered\')',
      [COMPANY, specId, subjectId, v.kind === 'number' ? v.value : null, v.kind === 'option' ? v.value : null],
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
  const tag = `NS${Date.now().toString(36).toUpperCase()}`;
  const plateNode = await nodeByCode(db, 'PLATE');
  const cutNode = await nodeByCode(db, 'CUT_PLATE');
  const spec = {
    THICKNESS: await specByCode(db, 'THICKNESS', 'number'),
    LENGTH: await specByCode(db, 'LENGTH', 'number'),
    WIDTH: await specByCode(db, 'WIDTH', 'number'),
    GRADE: await specByCode(db, 'GRADE', 'option'),
    MATERIAL: await specByCode(db, 'MATERIAL', 'option'),
    DENSITY: await specByCode(db, 'DENSITY', 'number'),
  };
  const grade = await anOption(db, spec.GRADE);
  const material = await anOption(db, spec.MATERIAL);
  const num = (v) => ({ kind: 'number', value: v });
  const size = (t, l, w) => [
    [spec.THICKNESS, num(t)], [spec.LENGTH, num(l)], [spec.WIDTH, num(w)],
    [spec.GRADE, { kind: 'option', value: grade }], [spec.MATERIAL, { kind: 'option', value: material }],
    [spec.DENSITY, num(7850)],
  ];

  const P1 = await makeMaster(db, { code: `${tag}-P1`, name: 'Sheet fixture plate', classificationId: plateNode, itemType: 'catalog' });
  await setVals(db, P1, size(T, PLATE_L, PLATE_W));

  const [o] = await db.query(
    'INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, \'customer\', \'Nesting sheet fixture\', \'confirmed\')',
    [COMPANY, `${tag}-SO`],
  );
  const root = await makeMaster(db, { code: `${tag}-ROOT`, name: 'Sheet fixture assembly', classificationId: cutNode, itemType: 'temporary' });
  const [l] = await db.query(
    'INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity) VALUES (?, ?, 1, \'custom\', ?, ?, 1, ?)',
    [COMPANY, o.insertId, root, root, LINE_QTY],
  );
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);

  // Two rectangles, both Big (over 200 mm on a dimension), so every sequence
  // holds three rows and the hand layout below is legal by the shop's rule.
  const cut = async (suffix, len, wid, perUnit, lineNo) => {
    const id = await makeMaster(db, { code: `${tag}-${suffix}`, name: `Sheet fixture ${suffix}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(db, id, size(T, len, wid));
    await makeBomLine(db, root, id, perUnit, lineNo);
    return id;
  };
  const A = await cut('CP1', 300, 200, 2, 1);      // 2 per unit x 2 = 4 pieces
  const B = await cut('CP2', 400, 250, 1, 2);      // 1 per unit x 2 = 2 pieces

  // Each rectangle's own BOM line to the raw plate, at the AREA FRACTION, just
  // as cutPlateService leaves it. This is what accepting a sheet replaces.
  const areaLine = {
    [A]: await makeBomLine(db, A, P1, (300 * 200) / (PLATE_L * PLATE_W), 1),
    [B]: await makeBomLine(db, B, P1, (400 * 250) / (PLATE_L * PLATE_W), 1),
  };

  // Own the cut settings outright: a test that shares its inputs with a seed
  // passes or fails on whichever ran last. Hard DELETE is safe — the whole run
  // is one transaction and it is rolled back.
  await db.query('DELETE FROM cf_cut_settings WHERE company_id = ?', [COMPANY]);
  for (const [min, max, kerf] of [[5, 16, 3], [18, 20, 4], [25, 50, 5]]) {
    await db.query(
      'INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, ?, ?, ?, 5, 8, 100, 50, 50, 0)',
      [COMPANY, min, max, kerf],
    );
  }
  return { tag, lineId, orderId: o.insertId, root, A, B, P1, areaLine };
}

/* --------------------------------------------------------------------------
 * A layout, typed out. No packer was involved in the making of this plate.
 *
 *   sequence 1, three rows, on a 2000 x 1000 plate at 3 mm kerf
 *     row 1   CP1 (3, 3)     CP1 (306, 3)      300 x 200
 *     row 2   CP1 (3, 206)   CP1 (306, 206)
 *     row 3   CP2 (3, 409)   CP2 (406, 409)    400 x 250
 *
 * Every neighbour is exactly one kerf apart (a SHARED boundary, cut once), the
 * rim keeps its kerf on all four sides, and three rows is what a Big sequence
 * is allowed. The layout needs 806 + 3 = 809 mm of length and 659 + 3 = 662 mm
 * of width; the plate to ORDER is those plus 100 / 50, rounded up to the 50 mm
 * step, which is 950 x 750.
 * ----------------------------------------------------------------------- */
const HAND = (f) => [
  { lot: 'A', cut: `${f.tag}-CP1`, seq: 1, row: 1, x: 3, y: 3, length: 300, width: 200 },
  { lot: 'A', cut: `${f.tag}-CP1`, seq: 1, row: 1, x: 306, y: 3, length: 300, width: 200 },
  { lot: 'A', cut: `${f.tag}-CP1`, seq: 1, row: 2, x: 3, y: 206, length: 300, width: 200 },
  { lot: 'A', cut: `${f.tag}-CP1`, seq: 1, row: 2, x: 306, y: 206, length: 300, width: 200 },
  { lot: 'A', cut: `${f.tag}-CP2`, seq: 1, row: 3, x: 3, y: 409, length: 400, width: 250 },
  { lot: 'A', cut: `${f.tag}-CP2`, seq: 1, row: 3, x: 406, y: 409, length: 400, width: 250 },
];

/* --- a CSV, written by hand, exactly as a person would ------------------- */
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

function handCsv(f, pieces) {
  const headers = SS.COLUMNS.map((c) => c.header);
  const body = pieces.map((p) => {
    const m = {
      lot: p.lot, plateCode: `${f.tag}-P1`, cutPlateCode: p.cut,
      seqNo: p.seq, rowNo: p.row, x: p.x, y: p.y, length: p.length, width: p.width, rotated: 'no',
    };
    return SS.COLUMNS.map((c) => m[c.key] ?? '');
  });
  return Buffer.from(toCsv([[SS.BANNER], headers, ...body]), 'utf8');
}

/* --- reading and editing a real workbook --------------------------------- */
const flat = (v) => (v && typeof v === 'object' ? (v.text ?? v.result ?? (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : null)) : v);

async function openBook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(SS.SHEET_NAME);
  let head = -1;
  for (let i = 1; i <= Math.min(ws.rowCount, 12) && head < 0; i++) {
    const names = new Set();
    ws.getRow(i).eachCell({ includeEmpty: true }, (cl) => names.add(SS.normaliseHeader(flat(cl.value))));
    if (names.has('LOT') && names.has('CUT PLATE CODE')) head = i;
  }
  const col = {};
  ws.getRow(head).eachCell({ includeEmpty: true }, (cl, i) => { const n = SS.normaliseHeader(flat(cl.value)); if (n) col[n] = i; });
  return { wb, ws, head, col, first: head + 1, last: ws.rowCount };
}
const cellOf = (b, r, name) => flat(b.ws.getRow(r).getCell(b.col[name]).value);
const setCell = (b, r, name, v) => { b.ws.getRow(r).getCell(b.col[name]).value = v; };
const findRow = (b, test) => {
  for (let r = b.first; r <= b.last; r++) if (test((name) => cellOf(b, r, name), r)) return r;
  return -1;
};
const save = (b) => b.wb.xlsx.writeBuffer().then((x) => Buffer.from(x));

/** An edited copy of the exported workbook: mutate in place, write the bytes back. */
async function editBook(buffer, fn) {
  const b = await openBook(buffer);
  await fn(b);
  return save(b);
}

/** Turns the data rows upside down in place. Identity must not be positional, so prove it. */
function shuffleRows(b) {
  const names = Object.keys(b.col);
  const grab = (r) => Object.fromEntries(names.map((n) => [n, cellOf(b, r, n)]));
  const rows = [];
  for (let r = b.first; r <= b.last; r++) rows.push(grab(r));
  rows.reverse();
  rows.forEach((vals, i) => { for (const n of names) setCell(b, b.first + i, n, vals[n] == null ? '' : vals[n]); });
}

/* ==========================================================================
 * The run
 * ======================================================================= */
const before = await counts(pool);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };

  section('Fixture');
  const f = await buildFixture(conn);
  console.log(`  ${f.tag}: order line ${f.lineId}, quantity ${LINE_QTY}, plate ${PLATE_L} × ${PLATE_W}, kerf ${KERF}`);

  /* ---- 0. the service refuses to work outside a transaction ------------- */
  section('0. A sheet is read inside a transaction, never on the pool');
  let onPool = null;
  try { await SS.importSheet(pool, c, f.lineId, { file: handCsv(f, HAND(f)) }); } catch (e) { onPool = e; }
  eq('handed the pool it says so rather than half-committing', onPool?.code, 'NEEDS_TRANSACTION');

  /* ---- 1. a layout nobody packed ---------------------------------------- */
  section('1. A layout written entirely by hand is accepted if it verifies');
  const hand = await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, HAND(f)) });
  eq('it applied', hand.applied, true);
  eq('it read the file as a CSV', hand.format, 'csv');
  eq('one plate', hand.plateLots.length, 1);
  eq('six pieces on it', hand.plateLots[0].pieces, 6);
  eq('and the lot is marked as laid out by hand', hand.plateLots[0].byHand, true);
  eq('six placements were written', hand.pieces, 6);
  eq('a lot IS a plate', hand.plates, 1);
  ok('it says out loud that uploading was accepting', /accepting it/i.test(hand.accepting ?? ''), hand.accepting);
  ok('it reports what it did', /6 pieces placed/.test(hand.says), hand.says);

  const saved1 = await N.getNesting(conn, COMPANY, f.lineId);
  const layout1 = layoutOf(saved1);
  eq('the saved plan is one lot', saved1.groups[0].nests.length, 1);
  eq('with six pieces', saved1.groups[0].nests[0].pieces.length, 6);
  eq('nothing has drifted', saved1.drift.length, 0, JSON.stringify(saved1.drift));
  const posOf = (x) => saved1.groups[0].nests[0].pieces.find((p) => Math.abs(p.x - x) < 1e-6);
  eq('position along a row is worked out from X, first', posOf(3).posNo, 1);
  eq('…and second', posOf(306).posNo, 2);
  const [[q1]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [f.areaLine[f.A]]);
  // One plate carries everything, so the whole sheet is charged across the six
  // pieces by area: CP1's four pieces take 4x60000 of 490000 placed mm2.
  const share = (4 * 300 * 200) / (4 * 300 * 200 + 2 * 400 * 250);
  ok('the area fraction was replaced by the real plate count',
    Math.abs(Number(q1.quantity) - (share / 4)) < 1e-5, `got ${q1.quantity}, wanted ${share / 4}`);

  /* ---- 2. the sheet says what it is on its own face --------------------- */
  section('2. The workbook: a banner, locked columns and the two plate sizes');
  const xlsx = await SS.exportSheet(conn, COMPANY, f.lineId);
  ok('it is a real workbook', xlsx.buffer[0] === 0x50 && xlsx.buffer[1] === 0x4b);
  eq('one row per piece', xlsx.rows, 6);
  eq('one lot', xlsx.lots, 1);
  eq('it is the saved plan, not a fresh proposal', xlsx.saved, true);
  const book = await openBook(xlsx.buffer);
  ok('row 1 says UPLOADING THIS SHEET IS ACCEPTING IT', /UPLOADING THIS SHEET IS ACCEPTING IT/.test(String(flat(book.ws.getRow(1).getCell(1).value))));
  eq('so the header is row 2', book.head, 2);
  const headerTexts = [];
  book.ws.getRow(book.head).eachCell({ includeEmpty: true }, (cl) => headerTexts.push(String(flat(cl.value) ?? '')));
  ok('every locked column says "do not edit" in words, for the CSV that carries no shading',
    SS.COLUMNS.filter((x) => x.locked).every((x) => headerTexts.some((h) => h.startsWith(x.header) && /do not edit/.test(h))),
    headerTexts.join(' | '));
  ok('and the unlocked ones do not', SS.COLUMNS.filter((x) => !x.locked).every((x) => headerTexts.includes(x.header)), headerTexts.join(' | '));
  const notes = book.wb.getWorksheet(SS.NOTES_SHEET);
  ok('there is a "How to use this" tab', !!notes);
  let notesText = '';
  notes.eachRow((r) => r.eachCell({ includeEmpty: true }, (cl) => { notesText += `${flat(cl.value) ?? ''}\n`; }));
  ok('it repeats that uploading IS accepting', /UPLOADING THIS SHEET IS ACCEPTING IT/.test(notesText));
  ok('and that the sheet is the whole plan', /THE SHEET IS THE WHOLE PLAN/.test(notesText));
  const r1 = book.first;
  eq('the piece carries its lot', cellOf(book, r1, 'LOT'), 'N-001');
  eq('and the plate it is on', cellOf(book, r1, 'PLATE CODE'), `${f.tag}-P1`);
  eq('and the plate size', String(cellOf(book, r1, 'PLATE SIZE')), '2000 × 1000');
  eq('what the LAYOUT needs', String(cellOf(book, r1, 'LAYOUT NEEDS')), '809 × 662');
  eq('…and the different number procurement ORDERS', String(cellOf(book, r1, 'ORDER PLATE')), '950 × 750');
  eq('the piece\'s own size', String(cellOf(book, r1, 'PIECE SIZE')), '300 × 200');
  ok('and a Row ID that is not its position', Number(cellOf(book, r1, 'ROW ID')) > 0, String(cellOf(book, r1, 'ROW ID')));

  /* ---- 3. out and straight back in -------------------------------------- */
  section('3. Export then import the same .xlsx bytes is a no-op');
  const noop = await SS.importSheet(conn, c, f.lineId, { file: xlsx.buffer });
  eq('it read it as a workbook', noop.format, 'xlsx');
  eq('it applied', noop.applied, true);
  eq('and it changed nothing at all', noop.says, 'nothing to change');
  eq('all six pieces matched on Row ID', noop.summary.unchanged, 6);
  eq('nothing added', noop.summary.added, 0);
  eq('nothing removed', noop.summary.removed, 0);
  const saved3 = await N.getNesting(conn, COMPANY, f.lineId);
  eq('and the layout is identical', layoutOf(saved3), layout1);
  const [[q3]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [f.areaLine[f.A]]);
  ok('so is the plate count', Math.abs(Number(q3.quantity) - Number(q1.quantity)) < 1e-9, `${q3.quantity} vs ${q1.quantity}`);

  /* ---- 4. identity is not positional ------------------------------------ */
  section('4. A real .xlsx with the rows SHUFFLED still changes the right piece');
  const fresh = await SS.exportSheet(conn, COMPANY, f.lineId);
  const beforeShuffle = await openBook(fresh.buffer);
  const targetRow = findRow(beforeShuffle, (at) => String(at('CUT PLATE CODE')) === `${f.tag}-CP2` && Number(at('X')) === 406);
  const targetId = Number(cellOf(beforeShuffle, targetRow, 'ROW ID'));
  ok('the piece to move was found', targetRow > 0 && targetId > 0, `row ${targetRow}, id ${targetId}`);

  const edited = await editBook(fresh.buffer, (b) => {
    const row = findRow(b, (at) => Number(at('ROW ID')) === targetId);
    setCell(b, row, 'X', 420);                    // 403 + 17: still clear of its neighbour and of the rim
    shuffleRows(b);
  });
  ok('the edited file is still a real workbook', edited[0] === 0x50 && edited[1] === 0x4b);
  const afterShuffle = await openBook(edited);
  ok('and its rows really are in a different order',
    cellOf(afterShuffle, afterShuffle.first, 'ROW ID') !== cellOf(beforeShuffle, beforeShuffle.first, 'ROW ID'));

  const moved = await SS.importSheet(conn, c, f.lineId, { file: edited });
  eq('it applied', moved.applied, true);
  eq('exactly one piece moved', moved.summary.changed, 1);
  eq('and the other five did not', moved.summary.unchanged, 5);
  eq('nothing was added', moved.summary.added, 0);
  eq('nothing was removed', moved.summary.removed, 0);
  eq('the change is matched by Row ID, not by where the row ended up', moved.changes[0].rowId, targetId);
  eq('and it is the X that changed', JSON.stringify(moved.changes.find((x) => x.kind === 'changed').changed), '["X"]');
  const saved4 = await N.getNesting(conn, COMPANY, f.lineId);
  const pieces4 = saved4.groups[0].nests[0].pieces;
  eq('the saved layout has the piece at its new X', pieces4.filter((p) => Math.abs(p.x - 420) < 1e-6).length, 1);
  eq('…and nothing at the old one', pieces4.filter((p) => Math.abs(p.x - 406) < 1e-6).length, 0);
  eq('the other five are where they were',
    pieces4.filter((p) => [3, 306].includes(Number(p.x))).length, 5);

  // Put it back, so the sections below all start from the same layout.
  await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, HAND(f)) });
  const base = await N.getNesting(conn, COMPANY, f.lineId);
  eq('the hand layout is back', layoutOf(base), layout1);

  /* ---- 5. a layout that cannot exist ------------------------------------ */
  section('5. An impossible layout is REFUSED, and by nestingService\'s own verifier');
  const beforeBad = await counts(conn);
  const overlapping = HAND(f).map((p, i) => (i === 1 ? { ...p, x: 100 } : p));   // 100 lands inside 3..303
  let bad = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, overlapping) }); } catch (e) { bad = e; }
  ok('overlapping pieces are refused', some(bad?.problems, /overlap/i), JSON.stringify(bad?.problems ?? bad?.message));
  ok('…in one clear sentence naming both rectangles', some(bad?.problems, new RegExp(`${f.tag}-CP1.*${f.tag}-CP1`)), JSON.stringify(bad?.problems));
  ok('and nothing was written', diff(beforeBad, await counts(conn)).length === 0, diff(beforeBad, await counts(conn)).join(', '));

  const offPlate = HAND(f).map((p, i) => (i === 5 ? { ...p, x: 1900 } : p));     // 1900 + 400 runs past 1997
  let off = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, offPlate) }); } catch (e) { off = e; }
  ok('a piece off the plate is refused', some(off?.problems, /runs past/i), JSON.stringify(off?.problems));
  ok('…and the sentence says what the usable box is', some(off?.problems, /one kerf of 3 mm is cut off each edge/), JSON.stringify(off?.problems));
  ok('nothing was written', diff(beforeBad, await counts(conn)).length === 0);

  const tooManyRows = HAND(f).map((p) => (p.cut.endsWith('CP2') ? { ...p, row: 4 } : p));
  let rowsBad = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, tooManyRows) }); } catch (e) { rowsBad = e; }
  ok('a sequence using a row the small/big rule does not allow is refused',
    some(rowsBad?.problems, /sequence 1: it uses row 4/i), JSON.stringify(rowsBad?.problems));
  ok('…and the sentence quotes the rule', some(rowsBad?.problems, /under 200 mm each way is Small and holds 2/), JSON.stringify(rowsBad?.problems));

  /* ---- 6. every problem at once ----------------------------------------- */
  section('6. Two problems are both reported and neither is applied');
  const twoWrong = HAND(f).map((p, i) => {
    if (i === 1) return { ...p, x: 100 };        // overlaps the piece at x = 3
    if (i === 5) return { ...p, x: 1900 };       // runs off the end of the plate
    return p;
  });
  let both = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, twoWrong) }); } catch (e) { both = e; }
  ok('the overlap is reported', some(both?.problems, /overlap/i), JSON.stringify(both?.problems));
  ok('the piece off the plate is reported too', some(both?.problems, /runs past/i), JSON.stringify(both?.problems));
  ok('both in the same refusal', (both?.problems ?? []).length >= 2, JSON.stringify(both?.problems));
  ok('and the refusal names the spreadsheet row, not "piece 2"', some(both?.problems, /sheet row \d+/), JSON.stringify(both?.problems));
  ok('neither was applied', layoutOf(await N.getNesting(conn, COMPANY, f.lineId)) === layout1);

  section('6b. Problems in the CELLS are collected together too');
  const unreadable = HAND(f).map((p, i) => {
    if (i === 4) return { ...p, cut: 'NO-SUCH-RECTANGLE' };   // a code nobody has
    if (i === 5) return { ...p, x: 'four-o-six' };            // an X that is not a number
    return p;
  });
  let cells = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, unreadable) }); } catch (e) { cells = e; }
  ok('an unknown code is reported', some(cells?.problems, /no item with the code NO-SUCH-RECTANGLE/), JSON.stringify(cells?.problems));
  ok('a cell that is not a number is reported', some(cells?.problems, /X is "four-o-six", which is not a number/), JSON.stringify(cells?.problems));
  ok('both at once', (cells?.problems ?? []).length >= 2, JSON.stringify(cells?.problems));

  section('6c. A pasted Row ID and a duplicated one are both caught');
  const current = await SS.exportSheet(conn, COMPANY, f.lineId);
  const pasted = await editBook(current.buffer, (b) => {
    setCell(b, b.first, 'ROW ID', 999999999);
    setCell(b, b.first + 2, 'ROW ID', cellOf(b, b.first + 1, 'ROW ID'));
  });
  let idsBad = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: pasted }); } catch (e) { idsBad = e; }
  ok('a Row ID from another sheet is refused', some(idsBad?.problems, /pasted in from another sheet/), JSON.stringify(idsBad?.problems));
  ok('the same Row ID twice is refused', some(idsBad?.problems, /is already on row/), JSON.stringify(idsBad?.problems));

  section('6d. …but an OUT-OF-DATE copy of this line\'s own sheet is not an error');
  // Uploading replaces every placement, so the file somebody just uploaded
  // already names ids that no longer exist. Re-uploading it, to be sure it
  // took, must not read as the whole plate being torn up and relaid.
  await SS.importSheet(conn, c, f.lineId, { file: current.buffer });
  const again = await SS.importSheet(conn, c, f.lineId, { file: current.buffer });
  eq('the same file a second time still applies', again.applied, true);
  eq('all six rows are out of date', again.staleRows, 6);
  ok('and it says so instead of failing', /has since been replaced/.test(again.staleNote ?? ''), again.staleNote);
  eq('the pieces were recognised by where they sit', again.summary.unchanged, 6);
  eq('so it changed nothing', again.says, 'nothing to change');
  eq('and the layout is still the hand one', layoutOf(await N.getNesting(conn, COMPANY, f.lineId)), layout1);

  /* ---- 7. the dry run --------------------------------------------------- */
  section('7. A dry run reports and writes NOTHING');
  const beforeDry = await counts(conn);
  const dryFile = await editBook((await SS.exportSheet(conn, COMPANY, f.lineId)).buffer, (b) => {
    const row = findRow(b, (at) => String(at('CUT PLATE CODE')) === `${f.tag}-CP2` && Number(at('X')) === 406);
    setCell(b, row, 'X', 420);
  });
  const dry = await SS.importSheet(conn, c, f.lineId, { file: dryFile, dryRun: true });
  eq('it says it is a dry run', dry.dryRun, true);
  eq('it did not apply', dry.applied, false);
  eq('it is happy with the layout', dry.ok, true);
  eq('it says what would change', dry.says, '1 piece moved');
  eq('and one piece is the whole of it', dry.summary.changed, 1);
  ok('it reports the plate count the accept WOULD write', (dry.would?.quantities ?? []).length === 2, JSON.stringify(dry.would?.quantities));
  const afterDry = await counts(conn);
  ok('not one row changed anywhere', diff(beforeDry, afterDry).length === 0, diff(beforeDry, afterDry).join(', '));
  eq('and the saved layout is untouched', layoutOf(await N.getNesting(conn, COMPANY, f.lineId)), layout1);

  section('7b. A dry run on an impossible layout REPORTS instead of throwing');
  let threw = false;
  let dryBad = null;
  try { dryBad = await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, overlapping), dryRun: true }); }
  catch { threw = true; }
  eq('it came back rather than throwing', threw, false);
  eq('and said no', dryBad?.ok, false);
  ok('with the overlap in its problems', some(dryBad?.problems, /overlap/i), JSON.stringify(dryBad?.problems));
  eq('it stopped at the layout, not at the cells', dryBad?.stoppedAt, 'checking the layout');
  ok('and it still wrote nothing', diff(beforeDry, await counts(conn)).length === 0, diff(beforeDry, await counts(conn)).join(', '));

  /* ---- 8. the whole plan, and only the whole plan ----------------------- */
  section('8. A short sheet is refused — the sheet IS the whole plan');
  let short = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: handCsv(f, HAND(f).slice(0, 5)) }); } catch (e) { short = e; }
  ok('a missing piece is refused, not quietly dropped', some(short?.problems, /the line needs 2 pieces and the layout places 1/), JSON.stringify(short?.problems));
  let wrongFile = null;
  try { await SS.importSheet(conn, c, f.lineId, { file: Buffer.from('a,b,c\n1,2,3\n', 'utf8') }); } catch (e) { wrongFile = e; }
  eq('a file that is not a nesting sheet is turned away', wrongFile?.code, 'WRONG_SHEET');

  /* ---- 9. the other format ---------------------------------------------- */
  section('9. CSV goes out and comes back as well');
  const csv = await SS.exportSheet(conn, COMPANY, f.lineId, { format: 'csv' });
  eq('it is a CSV', csv.format, 'csv');
  const lines = csv.buffer.toString('utf8').split('\r\n');
  ok('its very first line is the banner, because a CSV has no second tab', /UPLOADING THIS SHEET IS ACCEPTING IT/.test(lines[0]));
  ok('and the header comes after it', /Row ID/.test(lines[1]) && /Cut Plate Code/.test(lines[1]));
  ok('locked columns still say so in words', /\[do not edit\]/.test(lines[1]));
  const csvBack = await SS.importSheet(conn, c, f.lineId, { file: csv.buffer });
  eq('it applied', csvBack.applied, true);
  eq('and changed nothing', csvBack.says, 'nothing to change');
  eq('the layout survived the CSV round trip', layoutOf(await N.getNesting(conn, COMPANY, f.lineId)), layout1);

  /* ---- 10. base64, the way the route actually receives it --------------- */
  section('10. The route\'s own shape: base64 in the JSON body');
  const b64file = (await SS.exportSheet(conn, COMPANY, f.lineId, { format: 'csv' })).buffer;
  const b64 = await SS.importSheet(conn, c, f.lineId, { fileBase64: b64file.toString('base64'), dryRun: true });
  eq('base64 is read', b64.ok, true);
  eq('and it is the same nothing', b64.says, 'nothing to change');

  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  if (err.problems) console.error('problems:', err.problems);
  console.error(err.stack?.split('\n').slice(1, 8).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('11. Nothing survived the rollback');
const after = await counts(pool);
const left = diff(before, after);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
