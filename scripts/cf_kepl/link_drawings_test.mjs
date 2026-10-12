/**
 * link_drawings_test.mjs — drawings and linked copies (partDrawingService with linkService and
 * lib/drawingName.js; CF_ERP_LINKED_COPIES_PLAN.md §2 "Drawing upload", §5 and the two scripts).
 *
 *   cd multi_app_be && node scripts/cf_kepl/link_drawings_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table re-counted. Its own fixture (link_fixture.mjs).
 *
 * Proved here: a file named by its rows' code is matched by it (before the freeze against the code
 * preview, after it against real piece codes); the mark is the fallback, whole and without its
 * hints; every linked copy takes the drawing; a drawing uploaded BEFORE any size is typed fills
 * LENGTH / WIDTH from its rectangle and THICKNESS / GRADE from its name into the empty cells of
 * every copy, in one bulk write — and the copies STAY LINKED, drawing facts included; a filled
 * cell is kept and said; two files for one row, a row with another drawing (conflict → replace on
 * all), a name over unequal rows and over part of a row are each handled as said; the design-uses
 * read; the seeding script and the rename helper; and the round trips at two sizes.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as OV from '../../apps/cf_erp/services/orderValuesService.js';
import * as BC from '../../apps/cf_erp/services/bomChangeService.js';
import { uploadDrawings, getDrawings, startDrawing, designUses, codeRowsOfLine, drawingFile } from '../../apps/cf_erp/services/partDrawingService.js';
import { parseDrawingName, matchCodePattern } from '../../apps/cf_erp/lib/drawingName.js';
import { seedLinks } from './link-groups-seed.mjs';
import { codeNames } from './drawings-code-names.mjs';
import { buildLinkFixture, harness, tableCounts, counted, newTag, COMPANY } from './link_fixture.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const { state, ok, section, refusal } = harness();
const before = await tableCounts(pool);
const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
let sp = 0;
const rehearse = async (fn) => { const name = `ldt_${sp += 1}`; await db.query(`SAVEPOINT ${name}`); try { return await fn(); } finally { await db.query(`ROLLBACK TO SAVEPOINT ${name}`); } };

const dxf = (entities) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n');
const lw = (pts) => ['0', 'LWPOLYLINE', '8', 'PART', '90', pts.length, '70', 1, ...pts.flatMap(([x, y]) => ['10', x, '20', y])].map(String);
const circle = (cx, cy, r) => ['0', 'CIRCLE', '8', 'PART', '10', cx, '20', cy, '40', r].map(String);
const words = (t) => ['0', 'TEXT', '8', 'TITLE', '10', '0', '20', '-200', '40', '20', '1', t];
const rect = (l, w, ...more) => dxf([lw([[0, 0], [l, 0], [l, w], [0, w]]), ...more]);
const file = (name, text, extra = {}) => ({ name, content: Buffer.from(text, 'latin1').toString('base64'), ...extra });
const pdf = (name, extra = {}) => ({ name, content: Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(32, 5), Buffer.from('\n%%EOF\n')]).toString('base64'), ...extra });

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const fx = await buildLinkFixture(db, c, { tag: newTag('LDT'), parts: 0 });
  const { lineId, order } = fx;
  const change = (changes, extra = {}) => BC.applyBomChanges(db, c, { scope: { orderLineId: lineId }, changes, ...extra });
  const upload = (files, extra = {}) => uploadDrawings(db, c, order.id, lineId, { files, dryRun: false, ...extra });
  const preview = (files, extra = {}) => uploadDrawings(db, c, order.id, lineId, { files, dryRun: true, ...extra });
  const keyOf = async (id) => (await db.query('SELECT link_group FROM cf_item_details WHERE master_id = ?', [id]))[0][0]?.link_group ?? null;
  const valueOf = async (id, code) => {
    const [[r]] = await db.query("SELECT v.value_number, v.value_text, o.value AS opt FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id LEFT JOIN cf_spec_options o ON o.id = v.option_id WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND s.code = ? AND v.deleted_at IS NULL", [COMPANY, id, code]);
    return r ? (r.value_number != null ? Number(r.value_number) : r.opt ?? r.value_text) : null;
  };
  const lineRow = async () => (await db.query('SELECT * FROM cf_sales_order_lines WHERE id = ?', [lineId]))[0][0];
  const printed = async () => new Map((await codeRowsOfLine(db, COMPANY, await lineRow())).rows.map((r) => [r.id, r.texts[0]]));
  // What the drawing says is written on the part where the tenant has the facts set up: make sure it has.
  for (const code of ['TRUE_AREA', 'DRAWN_HOLES', 'DRAWN_HOLE_DIA']) {
    const [[have]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (!have) await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, 'number', NULL, 3, 'active')", [COMPANY, code, `${code} (test)`]);
  }

  // Three copies of the segment — and NOTHING typed on the parts yet: drawings come before dimensions.
  let r = await fx.rows();
  await change([{ op: 'paste', sourceLineId: r.segments[0].node.lineId, parentId: r.girder.id }]);
  await change([{ op: 'paste', sourceLineId: r.segments[0].node.lineId, parentId: r.girder.id }]);
  r = await fx.rows();
  const [S, S2, S3] = r.segments;
  const flanges = [S.flange.id, S2.flange.id, S3.flange.id];
  const webs = [S.web.id, S2.web.id, S3.web.id];
  const flangeKey = await keyOf(S.flange.id);
  const webKey = await keyOf(S.web.id);
  let codes = await printed();

  /* ------------------------------------------------------------------ */
  section('1. A file named by its row\'s code — before any size is typed');
  ok('the fixture: three linked flanges with no size, each with its own printed code', flangeKey && (await keyOf(S3.flange.id)) === flangeKey && new Set(flanges.map((id) => codes.get(id))).size === 3 && (await valueOf(S.flange.id, 'LENGTH')) === null, JSON.stringify(flanges.map((id) => codes.get(id))));
  const flangeName = `${codes.get(S.flange.id)}_25mm_E350.dxf`;
  const shape = rect(12000, 500, circle(100, 250, 11), circle(11900, 250, 11));
  const dry = await counted(db, () => preview([file(flangeName, shape)]));
  const d0 = dry.out.files[0];
  ok(`${flangeName}: matched by its code, said so`, d0.status === 'new' && d0.matchedBy === 'code' && d0.pattern === codes.get(S.flange.id) && d0.problems.length === 0, JSON.stringify({ s: d0.status, by: d0.matchedBy, p: d0.pattern, pr: d0.problems }));
  ok('the hints of the name are read', d0.hints.thicknessMm === 25 && d0.hints.grade === 'E350');
  ok('every linked copy takes it: one row named, two added', JSON.stringify(d0.fanOut.fromRowIds) === JSON.stringify([S.flange.id]) && JSON.stringify([...d0.fanOut.added].sort()) === JSON.stringify([S2.flange.id, S3.flange.id].sort()) && d0.rows.length === 3 && d0.fanOut.skipped.length === 0, JSON.stringify(d0.fanOut));
  const dv = Object.fromEntries(d0.values.map((v) => [v.specCode, v]));
  ok('the values it will write, into the EMPTY cells of all three: L, W from the rectangle, thickness and grade from the name', dv.LENGTH?.value === 12000 && dv.LENGTH.from === 'drawing' && dv.LENGTH.rows.length === 3 && dv.WIDTH?.value === 500 && dv.THICKNESS?.value === 25 && dv.THICKNESS.from === 'name' && dv.THICKNESS.rows.length === 3 && dv.GRADE?.value === 'E350' && dv.GRADE.rows.length === 3 && d0.values.every((v) => v.kept.length === 0), JSON.stringify(d0.values));
  ok('a preview writes nothing', !dry.out.saved && (await valueOf(S.flange.id, 'LENGTH')) === null && (await db.query('SELECT COUNT(*) n FROM cf_part_drawings WHERE order_line_id = ? AND deleted_at IS NULL', [lineId]))[0][0].n === 0);

  const saved = await counted(db, () => upload([file(flangeName, shape)]));
  const got = [];
  for (const id of flanges) got.push([await valueOf(id, 'LENGTH'), await valueOf(id, 'WIDTH'), await valueOf(id, 'THICKNESS'), await valueOf(id, 'GRADE')]);
  ok('saved: every copy holds the size, the thickness and the grade', saved.out.saved && got.every((g) => JSON.stringify(g) === JSON.stringify([12000, 500, 25, 'E350'])), JSON.stringify(got));
  ok('…in ONE bulk value write for all of them', saved.sql.filter((q) => /^SAVEPOINT cf_order_values/.test(q)).length === 1 && saved.out.valuesWritten?.written === 12, JSON.stringify(saved.out.valuesWritten));
  const facts = [];
  for (const id of flanges) facts.push([await valueOf(id, 'TRUE_AREA'), await valueOf(id, 'DRAWN_HOLES'), await valueOf(id, 'DRAWN_HOLE_DIA')]);
  ok('…and what the drawing says (true area, holes, their diameter) is on every copy', facts.every((f) => f[0] > 5.99e6 && f[0] < 6e6 && f[1] === 2 && f[2] === 22), JSON.stringify(facts));
  ok('…with the weight worked out from the typed size on each', Math.abs(await valueOf(S3.flange.id, fx.spec.WT) - 6000) < 1e-6);
  const view = await OV.readLineValues(db, COMPANY, lineId);
  ok('THE COPIES ARE STILL LINKED — a drawing for all members breaks nothing, drawing facts included', flanges.every((id) => view.links.rows[id]?.n === 3) && (await keyOf(S.flange.id)) === flangeKey && (await keyOf(S2.flange.id)) === flangeKey && (await keyOf(S3.flange.id)) === flangeKey, JSON.stringify(flanges.map((id) => view.links.rows[id])));
  ok('…and so are the segments above them', [S.node.id, S2.node.id, S3.node.id].every((id) => view.links.rows[id]?.n === 3));
  const dv1 = await getDrawings(db, COMPANY, order.id, lineId);
  ok('one register drawing, one file, on all three rows', dv1.drawings.length === 1 && dv1.drawings[0].rows.length === 3 && dv1.drawings[0].geometry?.holes === 2 && dv1.summary.partsWithShape === 3);
  const again = await preview([file(flangeName, shape)]);
  ok('the same name again replaces its own file (the next revision), not a second drawing', again.files[0].status === 'replaces' && again.files[0].register.action === 'revise' && again.files[0].values.every((v) => v.rows.length === 0 && v.kept.length === 3));

  /* ------------------------------------------------------------------ */
  section('2. A filled cell is kept, and a disagreement is said');
  const other = await preview([file(`${codes.get(S.flange.id)}_30mm_E250.dxf`, rect(12000, 510))]);
  const o0 = other.files[0];
  ok('the name says 30 mm / E250, the rows hold 25 / E350: nothing is offered for writing', o0.values.filter((v) => ['THICKNESS', 'GRADE'].includes(v.specCode)).every((v) => v.rows.length === 0 && v.kept.length === 3), JSON.stringify(o0.values));
  ok('…and both disagreements are warnings in words', /THICKNESS is already filled .*says 30/.test(o0.warnings.join(' | ')) && /GRADE is already filled .*says E250/.test(o0.warnings.join(' | ')), o0.warnings.join(' | '));
  ok('…the drawing\'s own size against the row\'s is said as before', /on the order, and the drawing's rectangle is/.test(o0.warnings.join(' | ')));
  const badGrade = await rehearse(async () => {
    await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id = ? AND deleted_at IS NULL", [COMPANY, flanges, fx.specId.GRADE]);
    return preview([file(`${codes.get(S.flange.id)}_S355.dxf`, shape)]);
  });
  ok('a grade that is not one of the row\'s choices is not written, and said', !badGrade.files[0].values.some((v) => v.specCode === 'GRADE' && v.rows.length) && /S355 .* is not one of the choices of GRADE/.test(badGrade.files[0].warnings.join(' | ')), badGrade.files[0].warnings.join(' | '));

  /* ------------------------------------------------------------------ */
  section('3. The mark is the fallback — whole, then without its hints; and the title\'s words');
  await OV.writeLineValues(db, c, lineId, { writes: [{ recordId: S.web.id, specCode: 'DRAWING_MARK', value: 'Wpl 1' }] });
  ok('a drawing mark typed on ONE copy breaks nothing (it is not design)', (await keyOf(S.web.id)) === webKey && (await keyOf(S2.web.id)) === webKey);
  const webShape = rect(12000, 1500, words('WEB PLATE'), words('THK 12  MATERIAL E250'));
  const m1 = await preview([file('WPL-1.dxf', webShape)]);
  ok('WPL-1.dxf: no code ends so — matched by the mark, and the copies of the marked row come along', m1.files[0].matchedBy === 'mark' && m1.files[0].pattern === null && m1.files[0].rows.length === 3 && m1.files[0].fanOut.added.length === 2, JSON.stringify({ by: m1.files[0].matchedBy, rows: m1.files[0].rows.length }));
  ok('…thickness and grade come from the drawing\'s own words', m1.files[0].hints.thicknessMm === 12 && m1.files[0].hints.grade === 'E250' && m1.files[0].values.find((v) => v.specCode === 'THICKNESS')?.from === 'title' && m1.files[0].values.find((v) => v.specCode === 'GRADE')?.rows.length === 3, JSON.stringify(m1.files[0].values));
  const m2 = await preview([file('wpl_1_16mm.dxf', webShape)]);
  ok('wpl_1_16mm.dxf: the mark without its hint tokens; the name\'s thickness wins over the title\'s', m2.files[0].matchedBy === 'mark' && m2.files[0].mark === 'wpl_1' && m2.files[0].hints.thicknessMm === 16 && m2.files[0].values.find((v) => v.specCode === 'THICKNESS')?.from === 'name', JSON.stringify({ mark: m2.files[0].mark, hints: m2.files[0].hints }));
  const m3 = await preview([file('NOPE-9.dxf', webShape), file('ZZ(1,2)-X.dxf', webShape), file('L(1,.dxf', webShape)]);
  ok('no row: unmatched — a mark in the old words, a code in the new; brackets that do not read are an error', m3.files[0].status === 'unmatched' && /No row on this line has drawing mark NOPE-9/.test(m3.files[0].warnings.join(' ')) && m3.files[1].status === 'unmatched' && /code ending in ZZ\(1,2\)-X/.test(m3.files[1].warnings.join(' ')) && m3.files[2].status === 'error' && /brackets .* do not read/.test(m3.files[2].problems.join(' ')), JSON.stringify(m3.files.map((f) => [f.status, f.warnings, f.problems])));
  const webSaved = await upload([file('WPL-1.dxf', webShape)]);
  ok('saved by mark: the three webs hold 12000 × 1500 × 12, E250 — and are still linked', webSaved.saved && (await valueOf(S3.web.id, 'WIDTH')) === 1500 && (await valueOf(S2.web.id, 'THICKNESS')) === 12 && (await valueOf(S3.web.id, 'GRADE')) === 'E250' && (await keyOf(S3.web.id)) === webKey && (await keyOf(S.web.id)) === webKey);

  /* ------------------------------------------------------------------ */
  section('4. Aimed at one row: every copy by default, only that row when said');
  const gPdf = await preview([pdf('GA sheet 1.pdf', { rowId: S2.node.id })]);
  ok('aimed at a segment: its two copies come along', gPdf.files[0].matchedBy === 'row' && gPdf.files[0].fanOut.added.length === 2 && gPdf.files[0].rows.length === 3 && /Goes to 3 linked rows/.test(gPdf.files[0].notes.join(' ')), JSON.stringify(gPdf.files[0].fanOut));
  const onlyOne = await rehearse(async () => {
    const out = await upload([pdf('GA sheet 1.pdf', { rowId: S2.node.id, links: 'one' })]);
    return { out, key: await keyOf(S2.node.id), others: [await keyOf(S.node.id), await keyOf(S3.node.id)], view: await OV.readLineValues(db, COMPANY, lineId) };
  });
  ok('links: one — only that row, the copies listed as skipped, and a note that it stops being a copy', onlyOne.out.files[0].rows.length === 1 && onlyOne.out.files[0].fanOut.added.length === 0 && onlyOne.out.files[0].fanOut.skipped.length === 2 && /stops being a copy/.test(onlyOne.out.files[0].notes.join(' ')));
  ok('…and it does: the drawing is part of the design', onlyOne.key === null && onlyOne.others[0] && onlyOne.others[0] === onlyOne.others[1] && onlyOne.view.links.rows[S.node.id].n === 2);
  const ignored = await preview([file('WPL-1.dxf', webShape, { links: 'one' })]);
  ok('links: one on a file that is NOT aimed at a row is not honoured (a name reaches whom it reaches)', ignored.files[0].rows.length === 3);
  const started = await rehearse(() => startDrawing(db, c, order.id, lineId, { rowIds: [S.node.id], number: `${fx.tag}/GA-1`, revision: '0', source: 'customer', status: 'draft' }));
  ok('a drawing STARTED from one row covers its copies too', started.fanOut.added.length === 2 && started.view.waiting[0].rows.length === 3, JSON.stringify(started.fanOut));
  const startedOne = await rehearse(async () => { const out = await startDrawing(db, c, order.id, lineId, { rowIds: [S.node.id], number: `${fx.tag}/GA-2`, links: 'one' }); return { out, key: await keyOf(S.node.id) }; });
  ok('…unless links: one — then the row stops being a copy', startedOne.out.fanOut.skipped.length === 2 && startedOne.out.view.waiting[0].rows.length === 1 && startedOne.key === null);

  /* ------------------------------------------------------------------ */
  section('5. Two files for one row; a row that has another drawing; unequal rows; part of a row');
  const two = await preview([pdf('GA one.pdf', { rowId: S.node.id }), pdf('GA two.pdf', { rowId: S2.node.id })]);
  ok('two files of one upload that reach the same rows (through their copies): the later one is refused, in words', two.files[0].status === 'new' && two.files[1].status === 'error' && /already take.* GA one\.pdf from this upload/.test(two.files[1].problems.join(' ')), JSON.stringify(two.files.map((f) => [f.status, f.problems])));
  const twoSame = await preview([file(`${codes.get(S2.flange.id)}.dxf`, shape), file(`${codes.get(S3.flange.id)}.dxf`, shape)]);
  ok('…and two files for one drawing are refused as before', twoSame.files[0].status === 'replaces' && twoSame.files[1].status === 'error' && /goes on the same drawing/.test(twoSame.files[1].problems.join(' ')));
  // One flange gets a drawing of its own (and so stops being a copy)…
  await upload([pdf('Flange special.pdf', { rowId: S3.flange.id, links: 'one' })]);
  ok('a flange with a drawing of its own is not a copy of the others any more', (await keyOf(S3.flange.id)) === null && (await keyOf(S.flange.id)) === flangeKey && (await keyOf(S3.node.id)) === null);
  codes = await printed();
  const both = `${(await import('./drawings-code-names.mjs')).mergedCode([codes.get(S.flange.id), codes.get(S3.flange.id)], await import('../../apps/cf_erp/lib/drawingName.js')).join('-')}.dxf`;
  const conflict = await preview([file(both, shape)]);
  const c0 = conflict.files[0];
  ok(`${both} reaches a row that has ANOTHER drawing: status conflict, nothing to save, the row and its file named`, c0.status === 'conflict' && c0.conflicts?.length >= 1 && c0.conflicts.some((x) => x.rowId === S3.flange.id && x.fileName === 'Flange special.pdf') && /Replace on all/.test(c0.warnings.join(' ')), JSON.stringify({ s: c0.status, c: c0.conflicts }));
  ok('…and the rows it reaches are not all the same design: said', /not all the same design/.test(c0.notes.join(' ')), c0.notes.join(' | '));
  const kept = await upload([file(both, shape)]);
  ok('saving without the choice keeps everything as it was', !kept.saved && kept.files[0].status === 'conflict' && (await getDrawings(db, COMPANY, order.id, lineId)).drawings.some((d) => d.fileName === 'Flange special.pdf'));
  const replaced = await rehearse(async () => {
    const out = await upload([file(both, shape)], { replaceOnMembers: true });
    return { out, view: await getDrawings(db, COMPANY, order.id, lineId), links: (await OV.readLineValues(db, COMPANY, lineId)).links };
  });
  ok('replaceOnMembers: saved, the other drawing comes off the row — and its file goes, no row being left to read it', replaced.out.saved && !replaced.view.drawings.some((d) => d.fileName === 'Flange special.pdf') && replaced.view.drawings.find((d) => d.fileName === both)?.rows.length === 3, JSON.stringify(replaced.view.drawings.map((d) => [d.fileName, d.rows.length])));
  ok('…the flange is the same design again, and is offered for re-linking', Array.isArray(replaced.links.rows[S3.flange.id]?.same) && replaced.links.rows[S3.flange.id].same.includes(S.flange.id), JSON.stringify(replaced.links.rows[S3.flange.id]));
  // A line of TWO girders: every row below stands for the pieces of both, and its code prints (1,2).
  const twin = await buildLinkFixture(db, c, { tag: newTag('LDQ'), parts: 0, quantity: 2 });
  const tr = await twin.rows();
  const twinLine = (await db.query('SELECT * FROM cf_sales_order_lines WHERE id = ?', [twin.lineId]))[0][0];
  const twinCode = (await codeRowsOfLine(db, COMPANY, twinLine)).rows.find((x) => x.id === tr.segments[0].web.id).texts[0];
  const pieceOne = twinCode.replace(/\(1,2\)/, '(1)');
  const partOf = await uploadDrawings(db, c, twin.order.id, twin.lineId, { files: [file(`${pieceOne}.dxf`, webShape)], dryRun: true });
  ok(`${pieceOne}.dxf names the pieces of one girder of two: the drawing goes on the whole row, and says so`, /\(1,2\)/.test(twinCode) && partOf.files[0].matchedBy === 'code' && partOf.files[0].rows.some((x) => x.id === tr.segments[0].web.id) && /names only some of the pieces/.test(partOf.files[0].notes.join(' ')), `${twinCode} · ${partOf.files[0].notes.join(' | ')}`);
  const wholeOf = await uploadDrawings(db, c, twin.order.id, twin.lineId, { files: [file(`${twinCode}.dxf`, webShape)], dryRun: true });
  ok('…the code as printed, brackets and all, names the whole row and says no such thing', wholeOf.files[0].matchedBy === 'code' && !/names only some/.test(wholeOf.files[0].notes.join(' ')));

  /* ------------------------------------------------------------------ */
  section('6. The rows a design is used by (GET /order-lines/:id/design-uses)');
  const byGroup = await counted(db, () => designUses(db, COMPANY, lineId, { group: webKey }));
  ok('by group: the three webs, each with its own code preview and its pieces', byGroup.out.rows.length === 3 && byGroup.out.rows.every((x) => webs.includes(x.recordId) && x.code && x.label && x.pieces === 1) && new Set(byGroup.out.rows.map((x) => x.code)).size === 3 && byGroup.out.total === 3 && byGroup.out.frozen === false && byGroup.out.pieces.length === 0, JSON.stringify(byGroup.out).slice(0, 300));
  const byRecord = await designUses(db, COMPANY, lineId, { recordId: S2.flange.id });
  ok('by row: its group (two flanges of two pieces), with the segments a code is cut into', byRecord.rows.length === 2 && byRecord.total === 4 && byRecord.rows.every((x) => Array.isArray(x.segments) || x.segments === null));
  const alone = await designUses(db, COMPANY, lineId, { recordId: S3.flange.id });
  ok('a row that is no copy is used by itself', alone.rows.length === 1 && alone.rows[0].recordId === S3.flange.id && alone.total === 2);
  const webFile = (await getDrawings(db, COMPANY, order.id, lineId)).drawings.find((d) => d.fileName === 'WPL-1.dxf');
  const byDrawing = await designUses(db, COMPANY, lineId, { drawingId: webFile.id });
  ok('by drawing file: the rows it is on', byDrawing.rows.length === 3 && byDrawing.rows.every((x) => webs.includes(x.recordId)));
  const byRegister = await designUses(db, COMPANY, lineId, { drawingId: webFile.drawing.id });
  ok('…a register drawing\'s id is taken too', byRegister.rows.length === 3 || byRegister.rows.length === byDrawing.rows.length);
  const noneSaid = await refusal(() => designUses(db, COMPANY, lineId, {}));
  const noRow = await refusal(() => designUses(db, COMPANY, lineId, { recordId: 999999999 }));
  const noCompany = await refusal(() => designUses(db, 999999, lineId, { group: webKey }));
  ok('nothing asked is refused in words; an unknown row and another company see nothing', noneSaid?.status === 422 && noRow?.status === 404 && noCompany?.status === 404, `${noneSaid?.status} ${noRow?.status} ${noCompany?.status}`);

  /* ------------------------------------------------------------------ */
  section('7. After the freeze: real piece codes, and no value written');
  await rehearse(async () => {
    // A frozen line as lock leaves it: locked, with a piece per copy of each row and its real code.
    await db.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [lineId]);
    const pieces = [];
    let n = 0;
    for (const [i, seg] of [S, S2, S3].entries()) {
      pieces.push([seg.node.id, seg.node.lineId, `${order.code}-CG1-L${i + 1}`]);
      for (const k of [1, 2]) pieces.push([seg.flange.id, seg.flange.lineId, `${order.code}-CG1-L${i + 1}-TFL${k}`]);
      pieces.push([seg.web.id, seg.web.lineId, `${order.code}-CG1-L${i + 1}-WPL1`]);
    }
    for (const [itemId, bomLineId, code] of pieces) {
      n += 1;
      await db.query('INSERT INTO cf_order_pieces (company_id, order_id, order_line_id, item_id, bom_line_id, quantity, code, path_key, depth, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 2, ?)', [COMPANY, order.id, lineId, itemId, bomLineId, code, `${fx.tag}/${n}`, n]);
    }
    await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id = ? AND deleted_at IS NULL", [COMPANY, webs, fx.specId.THICKNESS]);
    const frozen = await preview([file('L(1,2)-WPL1_14mm.dxf', webShape), file('L(1–3)-TFL(1,2).pdf', '%PDF-1.4 x')]);
    const f0 = frozen.files[0];
    ok('L(1,2)-WPL1 is matched against the REAL piece codes: the webs of segments 1 and 2', f0.matchedBy === 'code' && [S.web.id, S2.web.id].every((id) => f0.rows.some((x) => x.id === id)), JSON.stringify(f0.rows.map((x) => x.id)));
    ok('…and segment 3\'s web comes along: it is on the drawing this file replaces (the same sheet under a new name)', f0.rows.length === 3 && f0.rows.some((x) => x.id === S3.web.id) && f0.status === 'replaces', JSON.stringify([f0.fanOut, f0.rows.map((x) => x.id), webs]));
    ok('…and no value is written on a frozen design: said, with nothing to write', f0.values.every((v) => v.rows.length === 0) && /design is frozen/.test(f0.notes.join(' ')), JSON.stringify(f0.values));
    ok('a range with an en dash and a bracket of pieces reads against piece codes too', frozen.files[1].matchedBy === 'code' && frozen.files[1].rows.length >= 2);
    const uses = await designUses(db, COMPANY, lineId, { group: webKey });
    ok('design-uses on a frozen line lists the real pieces, one code each, never merged', uses.frozen === true && uses.pieces.length === 3 && new Set(uses.pieces.map((p) => p.code)).size === 3 && uses.rows.every((x) => x.code === null && x.pieces === 1) && uses.total === 3, JSON.stringify(uses.pieces));
    const savedFrozen = await upload([file('L(1,2)-WPL1_14mm.dxf', webShape)]);
    ok('saved on the frozen line: the drawing is attached, the thickness stays empty', savedFrozen.saved && (await valueOf(S.web.id, 'THICKNESS')) === null && !savedFrozen.valuesWritten);
  });

  /* ------------------------------------------------------------------ */
  section('8. Existing orders: the seeding script');
  await rehearse(async () => {
    // An order built before copies were linked: the same rows, no keys.
    await db.query('UPDATE cf_item_details SET link_group = NULL, link_apart = 0 WHERE owner_order_line_id = ?', [lineId]);
    const said = [];
    const dryRun = await rehearse(() => seedLinks(db, { companyId: COMPANY, orderCode: order.code, log: (s) => said.push(s) }));
    const g = dryRun.lines[0].groups;
    ok(`dry run proposes the designs that repeat (${g.length}): the webs (3), the flanges that still agree (2), the segments that still agree (2)`, g.length === 3 && JSON.stringify(g.map((x) => x.members.length).sort()) === JSON.stringify([2, 2, 3]), JSON.stringify(g.map((x) => [x.name, x.members.length])));
    ok('…each with where its rows sit, the code each will get, and what they share', g.every((x) => x.members.every((m) => m.label && m.code)) && said.some((s) => /shares: .*LENGTH 12000/.test(s)) && said.some((s) => /^ {2}g1 {2}line \d+ · \d rows of one design/.test(s)), said.slice(0, 6).join(' / '));
    ok('…and why the other rows were left alone', said.some((s) => /left alone: .*no equal on this line/.test(s)), said.find((s) => /left alone/.test(s)));
    ok('a dry run stores nothing', (await keyOf(S.web.id)) === null);
    const applied = await counted(db, () => seedLinks(db, { companyId: COMPANY, orderCode: order.code, log: () => {} }));
    ok('applied: the copies are linked, in ONE update for the line', (await keyOf(S.web.id)) && (await keyOf(S.web.id)) === (await keyOf(S3.web.id)) && (await keyOf(S.flange.id)) === (await keyOf(S2.flange.id)) && (await keyOf(S3.flange.id)) === null && applied.sql.filter((q) => /^UPDATE cf_item_details/.test(q)).length === 1 && applied.out.totals.written === 7, JSON.stringify(applied.out.totals));
    const twice = await counted(db, () => seedLinks(db, { companyId: COMPANY, orderCode: order.code, log: () => {} }));
    ok('again: nothing proposed, nothing written (idempotent)', twice.out.totals.groups === 0 && twice.out.totals.written === 0 && !twice.sql.some((q) => /^UPDATE/.test(q)));
    await db.query('UPDATE cf_item_details SET link_group = NULL WHERE owner_order_line_id = ?', [lineId]);
    const skip = await seedLinks(db, { companyId: COMPANY, orderCode: order.code, skip: [g.find((x) => x.members.length === 3).name], log: () => {} });
    ok('--skip leaves that group out', (await keyOf(S.web.id)) === null && (await keyOf(S.flange.id)) !== null && skip.totals.skipped === 1 && skip.totals.groups === 2);
    const oneLine = await seedLinks(db, { companyId: COMPANY, orderCode: order.code, lineNo: 9999, log: () => {} });
    ok('--line names one line (one that is not there: nothing)', oneLine.lines.length === 0);
    await db.query('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, order.id, lineId, r.girder.id]);
    const rel = []; const released = await seedLinks(db, { companyId: COMPANY, orderCode: order.code, log: (s) => rel.push(s) });
    ok('a released line is refused, in words', released.lines[0].status === 'released' && released.totals.written === 0 && rel.some((s) => /REFUSED — it is released/.test(s)));
    const none = await refusal(() => seedLinks(db, { companyId: COMPANY, orderCode: 'NO-SUCH-ORDER', log: () => {} }));
    ok('an order that is not there is an error, not an empty answer', /No order NO-SUCH-ORDER/.test(none?.message ?? ''));
  });

  /* ------------------------------------------------------------------ */
  section('9. Existing drawings: the rename helper');
  await rehearse(async () => {
    const said = [];
    const names = async () => (await getDrawings(db, COMPANY, order.id, lineId)).drawings.map((d) => ({ id: d.id, fileName: d.fileName, mark: d.mark, number: d.drawing?.number, rows: d.rows.map((x) => x.id).sort() }));
    const was = await names();
    const dryRun = await rehearse(() => codeNames(db, { companyId: COMPANY, orderCode: order.code, log: (s) => said.push(s) }));
    const web = dryRun.lines[0].files.find((f) => f.old === 'WPL-1.dxf');
    ok(`dry run: the web's file, saved by its mark, gets the shortest end of its rows' code that reaches only them, with its hints — ${web?.name}`, web?.status === 'rename' && /WPL1_12mm_E250\.dxf$/.test(web.name) && !web.name.includes(order.code) && web.rows.length === 3, JSON.stringify(web));
    const flangeOld = dryRun.lines[0].files.find((f) => /_25mm_E350\.dxf$/.test(f.old));
    ok(`…a file named by its WHOLE code is cut to the same shortest end; a bare number is never a name — ${flangeOld?.name}`, flangeOld?.status === 'rename' && /TFL1-2_25mm_E350\.dxf$/.test(flangeOld.name) && /^[A-Za-z]/.test(flangeOld.name) && !flangeOld.name.includes(order.code), JSON.stringify(flangeOld));
    const back = parseDrawingName(web.name);
    const rows3 = (await codeRowsOfLine(db, COMPANY, await lineRow())).rows;
    ok('…a name the upload reads back to exactly those rows, hints and all', JSON.stringify(matchCodePattern(back.pattern, rows3).map((h) => h.id).sort()) === JSON.stringify([...webs].sort()) && back.hints.thicknessMm === 12 && back.hints.grade === 'E250');
    ok('…old name → new name and the rows are printed', said.some((s) => s.includes('WPL-1.dxf  →  ') && s.includes(web.name)) && said.some((s) => /3 rows: /.test(s)), said.join(' / ').slice(0, 400));
    ok('the register number made from the mark follows the name', web.number?.from === `${order.code}/WPL-1` && web.number.to.startsWith(`${order.code}/`) && !/_12mm/.test(web.number.to), JSON.stringify(web.number));
    ok('a dry run renames nothing', JSON.stringify(await names()) === JSON.stringify(was));
    const bodyBefore = (await drawingFile(db, COMPANY, order.id, lineId, was.find((d) => d.fileName === 'WPL-1.dxf').id)).buffer;
    const applied = await counted(db, () => codeNames(db, { companyId: COMPANY, orderCode: order.code, log: () => {} }));
    const now = await names();
    const webNow = now.find((d) => d.fileName === web.name);
    ok('applied: the file carries the new name; its MARK is kept as the fallback', !!webNow && webNow.mark === 'WPL-1' && !now.some((d) => d.fileName === 'WPL-1.dxf'));
    ok('…nothing is unlinked: the same rows see the same drawing', JSON.stringify(webNow.rows) === JSON.stringify(was.find((d) => d.fileName === 'WPL-1.dxf').rows) && webNow.id === was.find((d) => d.fileName === 'WPL-1.dxf').id);
    ok('…its contents are untouched, and it downloads under the new name', (await drawingFile(db, COMPANY, order.id, lineId, webNow.id)).buffer.equals(bodyBefore) && (await drawingFile(db, COMPANY, order.id, lineId, webNow.id)).filename === web.name);
    ok('…the register drawing has the new number, the same revision', webNow.number === web.number.to && (await db.query('SELECT COUNT(*) n FROM cf_drawings WHERE company_id = ? AND number = ? AND deleted_at IS NULL', [COMPANY, `${order.code}/WPL-1`]))[0][0].n === 0);
    ok('…in ONE update of the names and ONE of the numbers', applied.sql.filter((q) => /^UPDATE cf_part_drawings SET file_name/.test(q)).length === 1 && applied.sql.filter((q) => /^UPDATE cf_drawings SET number/.test(q)).length === 1);
    ok('the copies are still linked (a name is not design)', (await keyOf(S.web.id)) === webKey && (await keyOf(S3.web.id)) === webKey);
    const twice = await counted(db, () => codeNames(db, { companyId: COMPANY, orderCode: order.code, log: () => {} }));
    ok('again: every file already named by its code, nothing written (idempotent)', twice.out.totals.renamed === 0 && !twice.sql.some((q) => /^UPDATE/.test(q)), JSON.stringify(twice.out.totals));
    const reup = await preview([file(web.name, webShape)]);
    ok('uploading the file again under its NEW name replaces it — matched by code, the same drawing, no conflict', reup.files[0].matchedBy === 'code' && reup.files[0].status === 'replaces' && reup.files[0].register.action === 'revise' && reup.files[0].rows.length === 3, JSON.stringify({ by: reup.files[0].matchedBy, s: reup.files[0].status, reg: reup.files[0].register }));
    const byMarkStill = await preview([file('WPL-1.dxf', webShape)]);
    ok('…and the old name still finds it by the mark', byMarkStill.files[0].matchedBy === 'mark' && byMarkStill.files[0].status === 'replaces');
    await db.query('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, order.id, lineId, r.girder.id]);
    const rel = []; const released = await codeNames(db, { companyId: COMPANY, orderCode: order.code, log: (s) => rel.push(s) });
    ok('a released line is refused, in words', released.lines[0].status === 'released' && released.totals.renamed === 0 && released.totals.refused > 0 && rel.some((s) => /REFUSED — it is released/.test(s)));
  });

  /* ------------------------------------------------------------------ */
  section('10. Round trips: the same at two sizes');
  const big = await buildLinkFixture(db, c, { tag: newTag('LDB'), parts: 24 });
  let br = await big.rows();
  await BC.applyBomChanges(db, c, { scope: { orderLineId: big.lineId }, changes: [{ op: 'paste', sourceLineId: br.segments[0].node.lineId, parentId: br.girder.id }] });
  br = await big.rows();
  const bigLine = (await db.query('SELECT * FROM cf_sales_order_lines WHERE id = ?', [big.lineId]))[0][0];
  const bigCodes = new Map((await codeRowsOfLine(db, COMPANY, bigLine)).rows.map((x) => [x.id, x.texts[0]]));
  const bigName = `${bigCodes.get(br.segments[0].flange.id)}_25mm.dxf`;
  const smallDry = await counted(db, () => preview([file(`${codes.get(S.web.id)}.dxf`, webShape)]));
  const bigDry = await counted(db, () => uploadDrawings(db, c, big.order.id, big.lineId, { files: [file(bigName, shape)], dryRun: true }));
  const rowsOf = async (id) => (await OV.readLineValues(db, COMPANY, id)).counts.rows;
  const sizes = [await rowsOf(lineId), await rowsOf(big.lineId)];
  ok(`a preview by code asks the same number of queries on ${sizes[0]} rows and on ${sizes[1]} (${smallDry.n}, ${bigDry.n})`, sizes[1] > 3 * sizes[0] && Math.abs(smallDry.n - bigDry.n) <= 3 && bigDry.out.files[0].matchedBy === 'code' && bigDry.out.files[0].fanOut.added.length === 1, `${smallDry.n} / ${bigDry.n}`);
  const three = await counted(db, () => preview([file(`${codes.get(S.web.id)}.dxf`, webShape), pdf('Q1.pdf', { rowId: S.node.id }), pdf('Q2.pdf', { rowId: r.girder.id })]));
  ok(`three files cost a preview at most two lookups each more than one (${smallDry.n} → ${three.n})`, three.n - smallDry.n <= 6, `${smallDry.n} → ${three.n}`);
  const bigSave = await counted(db, () => uploadDrawings(db, c, big.order.id, big.lineId, { files: [file(bigName, shape)], dryRun: false }));
  ok(`a save writes the values of every file and every copy in one bulk write (${bigSave.n} round trips), and the copies stay linked`, bigSave.sql.filter((q) => /^SAVEPOINT cf_order_values/.test(q)).length === 1 && bigSave.out.valuesWritten.written === 6 && (await keyOf(br.segments[0].flange.id)) === (await keyOf(br.segments[1].flange.id)) && (await keyOf(br.segments[0].flange.id)) !== null, JSON.stringify(bigSave.out.valuesWritten));
  const usesS = await counted(db, () => designUses(db, COMPANY, lineId, { group: webKey }));
  const usesB = await counted(db, () => designUses(db, COMPANY, big.lineId, { recordId: br.segments[0].flange.id }));
  ok(`design-uses: the same round trips at both sizes (${usesS.n}, ${usesB.n})`, Math.abs(usesS.n - usesB.n) <= 2, `${usesS.n} / ${usesB.n}`);
  console.log(`        upload preview ${smallDry.n} / ${bigDry.n} · save ${bigSave.n} · design-uses ${usesS.n} / ${usesB.n} (first group read in section 6: ${byGroup.n})`);
} catch (e) {
  state.failed += 1;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 4).join(' '));
} finally {
  detachNodeCache(db);
  await db.rollback();
  db.release();
  const after = await tableCounts(pool);
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.fails.length) console.log(`failed: ${state.fails.join(' | ')}`);
  process.exitCode = state.failed ? 1 : 0;
}
