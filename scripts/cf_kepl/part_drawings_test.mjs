/**
 * part_drawings_test.mjs — part shapes (DXF) on an order line (partDrawingService, init.sql §51).
 * Upload by drawing mark (preview, save, replace, delete), the measure (true vs rectangle area),
 * the cut plate's cut length and piercings from the drawing, and the CNC file drawing the outline;
 * §52 the register: every file is a register revision, a drawing started from a row waits for its
 * file, uploading over an issued revision makes the next one and the old file stays downloadable.
 * Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/part_drawings_test.mjs
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { getDrawings, uploadDrawings, deleteDrawing, drawingFile, platePartsOfLine, rowsOfLine, drawingFactsOfLine, startDrawing, registerFile } from '../../apps/cf_erp/services/partDrawingService.js';
import { getDrawing } from '../../apps/cf_erp/services/drawingService.js';
import { lotDxf } from '../../apps/cf_erp/services/cncExportService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = 2;
const LINE = 923;
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

const dxf = (entities) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n');
const lw = (pts) => ['0', 'LWPOLYLINE', '8', 'PART', '90', pts.length, '70', 1, ...pts.flatMap(([x, y]) => ['10', x, '20', y])].map(String);
const circle = (cx, cy, r) => ['0', 'CIRCLE', '8', 'PART', '10', cx, '20', cy, '40', r].map(String);
const file = (name, text) => ({ name, content: Buffer.from(text, 'latin1').toString('base64') });

const pdf0 = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(32, 5), Buffer.from('\n%%EOF\n')]);
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const c = { companyId: COMPANY, userId: null };
  const [[line]] = await db.query('SELECT * FROM cf_sales_order_lines WHERE id = ?', [LINE]);
  const parts = await platePartsOfLine(db, COMPANY, line);
  ok(`the line has plate parts (${parts.length})`, parts.length > 0);
  const part = parts.find((p) => p.lengthMm > 100 && p.widthMm > 100 && p.thicknessMm > 0);
  // Give it a drawing mark (the KEPL order on prod has them on its plate parts).
  const [[markSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'DRAWING_MARK' AND deleted_at IS NULL", [COMPANY]);
  // Every part cut into the same cut plate is the same shape — they all get the mark.
  const same = parts.filter((p) => p.cutPlateIds.includes(part.cutPlateIds[0]));
  await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id = ? AND deleted_at IS NULL", [COMPANY, same.map((p) => p.id), markSpec.id]);
  for (const p of same) await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_text, source) VALUES (?, ?, 'master', ?, 'Fst p1', 'entered')", [COMPANY, markSpec.id, p.id]);

  let view = await getDrawings(db, COMPANY, line.order_id, LINE);
  ok('no drawings yet: every row of every level is listed without one', view.drawings.length === 0 && view.rowsWithoutDrawing.length === view.summary.rows && view.summary.rows > view.summary.parts && view.summary.usePct === null);

  // The part's rectangle with two 40 mm snipes, two drilled holes and a 100 mm opening.
  const { lengthMm: L, widthMm: W } = part;
  const shape = dxf([lw([[40, 0], [L, 0], [L, W - 40], [L - 40, W], [0, W], [0, 40]]), circle(60, W / 2, 11), circle(L - 60, W / 2, 11), circle(L / 2, W / 2, 50)]);
  const up = [file('FST-P1.dxf', shape), file('NOPE-9.dxf', shape), file('broken.dxf', 'hello'), file('photo.pdf', 'x')];
  const dry = await uploadDrawings(db, c, line.order_id, LINE, { files: up, dryRun: true });
  const st = Object.fromEntries(dry.files.map((f) => [f.name, f.status]));
  ok('preview: matched by mark whatever the case and spaces → new', st['FST-P1.dxf'] === 'new' && dry.files[0].rows.some((r) => r.id === part.id), JSON.stringify(dry.files[0]).slice(0, 300));
  ok('preview: a mark no row carries is unmatched, said in words', st['NOPE-9.dxf'] === 'unmatched' && /No row on this line/.test(dry.files[1].warnings.join(' ')));
  ok('preview: a file that is not a DXF drawing is refused in words', st['broken.dxf'] === 'error' && st['photo.pdf'] === 'error' && dry.files[3].problems.length > 0);
  ok('preview writes nothing', !dry.saved && (await db.query('SELECT COUNT(*) n FROM cf_part_drawings WHERE order_line_id = ? AND deleted_at IS NULL', [LINE]))[0][0].n === 0);
  const g = dry.files[0].geometry;
  ok('the drawing is read: its rectangle is the row\'s size', Math.abs(g.lengthMm - L) < 0.2 && Math.abs(g.widthMm - W) < 0.2 && dry.files[0].rows[0].sizeMatches === true);
  ok('…two drilled holes, one opening: 2 piercings', g.holes === 2 && g.innerCuts === 1 && g.piercings === 2);

  // The cut plate this part is cut for, before.
  const cpId = part.cutPlateIds[0];
  const valueOf = async (code) => Number((await db.query(`SELECT v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id WHERE v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL AND s.code = ?`, [cpId, code]))[0][0]?.value_number ?? NaN);
  const { refreshPlateCuts } = await import('../../apps/cf_erp/services/plateCutsService.js');
  await refreshPlateCuts(db, c, LINE);                       // the rectangles' cut lengths, as a baseline
  const cutBefore = await valueOf('CUT_LENGTH');
  const [[lot]] = await db.query(`SELECT l.id FROM cf_plate_lots l JOIN cf_nest_placements p ON p.plate_lot_id = l.id AND p.deleted_at IS NULL WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND l.kind = 'plate' AND p.cut_plate_id = ? LIMIT 1`, [LINE, cpId]);
  const vertices = (buf) => (buf.toString('latin1').match(/VERTEX/g) ?? []).length;
  const dxfBefore = lot ? await lotDxf(db, COMPANY, LINE, lot.id) : null;

  const saved = await uploadDrawings(db, c, line.order_id, LINE, { files: up, dryRun: false });
  view = saved.view;
  ok('saved: one drawing (the unmatched and broken ones are not kept)', saved.saved && view.drawings.length === 1 && view.drawings[0].mark === 'FST-P1');
  const s = view.summary;
  ok(`the measure: its shape uses ${s.usePct}% of its rectangle, ${s.savingKg} kg is the most true-shape nesting could save`, s.usePct < 100 && s.usePct > 80 && s.savingKg > 0 && s.partsWithShape === same.length, JSON.stringify(s));

  const facts = (await drawingFactsOfLine(db, COMPANY, LINE)).get(cpId);
  ok('the cut plate takes the drawing: piercings 2, cut length its own', facts && Math.abs((await valueOf('PIERCINGS')) - facts.piercings) < 1e-6 && Math.abs(facts.piercings - 2) < 1e-6, JSON.stringify(facts));
  ok(`…and its cut length changed from the rectangle's (${cutBefore} → ${await valueOf('CUT_LENGTH')})`, Number.isFinite(await valueOf('CUT_LENGTH')) && Math.abs((await valueOf('CUT_LENGTH')) - cutBefore) > 1);
  ok('the CNC file is drawn from a single shape here', (await drawingFactsOfLine(db, COMPANY, LINE)).get(cpId)?.rings?.length === 4);
  ok('refreshing again writes nothing', (await refreshPlateCuts(db, c, LINE)).written === 0);
  if (lot) {
    const dxfAfter = await lotDxf(db, COMPANY, LINE, lot.id);
    ok('the CNC file draws the part by its outline, holes and opening', vertices(dxfAfter.buffer) > vertices(dxfBefore.buffer) + 6, `${vertices(dxfBefore.buffer)} → ${vertices(dxfAfter.buffer)}`);
  } else ok('a nest holds the cut plate', false);

  const again = await uploadDrawings(db, c, line.order_id, LINE, { files: [file('fst-p1.DXF', shape)], dryRun: false });
  ok('uploading the mark again replaces it', again.files[0].status === 'replaces' && again.view.drawings.length === 1);
  // The register: the first save created a drawing, the second made its next revision.
  const first = saved.view.drawings[0].drawing;
  ok('the saved file is a register drawing: order code / mark, rev A, issued, linked to its rows', first && first.number === `${(await db.query('SELECT code FROM cf_sales_orders WHERE id = ?', [line.order_id]))[0][0].code}/FST-P1` && first.revision === 'A' && first.status === 'issued' && (await getDrawing(db, COMPANY, first.id)).covers.length === same.length, JSON.stringify(first));
  const rev = again.view.drawings[0].drawing;
  ok('uploading over an issued revision makes the next one: A -> B, links carried', again.files[0].register?.action === 'revise' && rev.revision === 'B' && rev.number === first.number && rev.earlier.length === 1 && rev.earlier[0].hasFile && (await getDrawing(db, COMPANY, rev.id)).covers.length === same.length, JSON.stringify(again.files[0].register) + JSON.stringify(rev));
  ok('rev A is superseded and its file still downloads', (await getDrawing(db, COMPANY, first.id)).status === 'superseded' && (await registerFile(db, COMPANY, first.id)).buffer.toString('latin1') === shape && (await getDrawing(db, COMPANY, first.id)).file?.fileName === 'FST-P1.dxf');
  // Started from a row before any file exists — the row has no drawing mark at all.
  const bare = (await rowsOfLine(db, COMPANY, line)).find((r) => !r.mark && !r.isPlatePart);
  const started = await startDrawing(db, c, line.order_id, LINE, { rowIds: [bare.id], number: 'P103-VDB-401', revision: '0', source: 'customer', status: 'draft' });
  const wait = started.view.waiting.find((w) => w.drawing.id === started.drawing.id);
  ok('a drawing started from a row waits for its file, and the row counts as having one', wait && wait.rows.some((r) => r.id === bare.id) && !started.view.rowsWithoutDrawing.some((r) => r.id === bare.id) && started.drawing.status === 'draft', JSON.stringify(started.drawing));
  let refused = null; try { await startDrawing(db, c, line.order_id, LINE, { rowIds: [999999999], number: 'X' }); } catch (e) { refused = e.message; }
  ok('a row from another line is refused in words', /not on line/.test(refused ?? ''), refused);
  const att = await uploadDrawings(db, c, line.order_id, LINE, { files: [{ name: 'scan 12.pdf', content: pdf0.toString('base64'), drawingId: started.drawing.id }], dryRun: false });
  const onIt = att.view.drawings.find((d) => d.drawing?.id === started.drawing.id);
  ok('its file attached by hand, whatever the file is called: matched by the register link', att.files[0].register?.action === 'attach' && onIt && onIt.rows.some((r) => r.id === bare.id) && !att.view.waiting.some((w) => w.drawing.id === started.drawing.id), JSON.stringify(att.files[0]).slice(0, 400));
  const att2 = await uploadDrawings(db, c, line.order_id, LINE, { files: [{ name: 'scan 13.pdf', content: pdf0.toString('base64'), drawingId: started.drawing.id }], dryRun: true });
  ok('a draft takes a new file in place, no new revision', att2.files[0].register?.action === 'replace' && att2.files[0].register.revision === '0', JSON.stringify(att2.files[0].register));
  const back = await deleteDrawing(db, c, line.order_id, LINE, onIt.id);
  ok('deleting the file leaves the register drawing waiting again', back.waiting.some((w) => w.drawing.id === started.drawing.id));

  // Aimed at one row: no mark needed; the name becomes the mark; another mark is kept with a note.
  const lineRows = await rowsOfLine(db, COMPANY, line);
  const markless = lineRows.filter((r) => !r.mark && !r.isPlatePart && r.id !== bare.id);
  const withMark = lineRows.find((r) => r.mark && !r.isPlatePart);
  ok('the line has markless rows to aim at', markless.length >= 3, String(markless.length));
  const aimedIds = [];
  const tgtPdf = (name, rowId) => ({ name, content: pdf0.toString('base64'), rowId });
  const t1 = await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('Sheet 7.pdf', markless[0].id)], dryRun: true });
  ok('aimed preview: matched to that row though it has no mark, nothing written', t1.files[0].status === 'new' && t1.files[0].rows.length === 1 && t1.files[0].rows[0].id === markless[0].id && t1.files[0].markSet === true && !t1.saved, JSON.stringify(t1.files[0]).slice(0, 300));
  const t1s = await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('Sheet 7.pdf', markless[0].id)], dryRun: false });
  const after1 = (await rowsOfLine(db, COMPANY, line)).find((r) => r.id === markless[0].id);
  ok('aimed save on a markless row sets its DRAWING_MARK from the file name', t1s.saved && after1.mark === 'Sheet 7' && t1s.view.drawings.some((d) => d.mark === 'Sheet 7' && d.rows.some((r) => r.id === markless[0].id)), JSON.stringify(after1.mark));
  aimedIds.push(markless[0].id);
  const odd = await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('other-name.pdf', withMark.id)], dryRun: false });
  const oddRow = (await rowsOfLine(db, COMPANY, line)).find((r) => r.id === withMark.id);
  ok('aimed upload on a row with another mark is accepted, mark kept, the answer says the name differs', odd.saved && oddRow.mark === withMark.mark && /differs from this row's drawing mark/.test(odd.files[0].notes.join(' ')) && odd.files[0].status !== 'error', JSON.stringify(odd.files[0]).slice(0, 300));
  const bad = await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('x.pdf', 999999999)], dryRun: true });
  ok('aimed at a row that is not on the line: refused in words', bad.files[0].status === 'error' && /not on this line/.test(bad.files[0].problems.join(' ')));
  // Round trips: the mark write is one lookup + one update + one insert however many rows are aimed at.
  const sqlLog = []; const q0 = db.query.bind(db); db.query = (...a) => { sqlLog.push(String(a[0])); return q0(...a); };
  await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('Q1.pdf', markless[1].id)], dryRun: true }); const dry1 = sqlLog.length; sqlLog.length = 0;
  await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('Q1.pdf', markless[1].id), tgtPdf('Q2.pdf', markless[2].id), tgtPdf('Q3.pdf', markless[3].id)], dryRun: true }); const dry3 = sqlLog.length; sqlLog.length = 0;
  await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('Q1.pdf', markless[1].id), tgtPdf('Q2.pdf', markless[2].id), tgtPdf('Q3.pdf', markless[3].id)], dryRun: false });
  const markSql = sqlLog.filter((x) => /specification_id = [?] AND subject_id IN|INSERT INTO `?cf_spec_values|code = 'DRAWING_MARK'/.test(x));
  db.query = q0;
  ok(`preview adds one lookup per file at most (1 file: ${dry1} queries, 3 files: ${dry3}); marks for 3 aimed rows are written in 3 statements (${markSql.length})`, dry3 - dry1 <= 2 * 3 && markSql.length === 3, `${dry1} / ${dry3} / ${markSql.map((x) => x.slice(0, 60)).join(' | ')}`);
  aimedIds.push(...markless.slice(0, 4).map((r) => r.id), withMark.id);
  // A released line takes no file changes, aimed or not.
  await db.query('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, line.order_id, LINE, line.item_id]);
  let rel = null; try { await uploadDrawings(db, c, line.order_id, LINE, { files: [tgtPdf('R.pdf', markless[0].id)], dryRun: false }); } catch (e) { rel = e.message; }
  ok('a released line still refuses an aimed upload', /released to production/.test(rel ?? ''), rel);
  await db.query('UPDATE cf_production_releases SET deleted_at = NOW() WHERE order_line_id = ? AND deleted_at IS NULL', [LINE]);

  // Every level: a segment's PDF and an assembly's general-arrangement DXF (not one outline) are kept, not read.
  const rows = await rowsOfLine(db, COMPANY, line);
  const marked = rows.filter((r) => !r.isPlatePart && r.mark && !aimedIds.includes(r.id));
  ok(`rows above the parts carry marks too (${marked.length})`, marked.length >= 2);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj << >> endobj\n', 'latin1'), Buffer.alloc(64, 7), Buffer.from('\n%%EOF\n')]);
  const ga = dxf([lw([[0, 0], [1000, 0], [1000, 500], [0, 500]]), lw([[2000, 0], [3000, 0], [3000, 500], [2000, 500]])]);
  const levelUp = [
    { name: `${marked[0].mark}.PDF`, content: pdf.toString('base64') },
    file(`${marked[1].mark}.dxf`, ga),
    { name: 'FST-P1.pdf', content: pdf.toString('base64') },
  ];
  const lv = await uploadDrawings(db, c, line.order_id, LINE, { files: levelUp, dryRun: true });
  ok(`a ${marked[0].level}'s PDF matches by its mark, kept without a shape`, lv.files[0].status === 'new' && lv.files[0].fileKind === 'pdf' && lv.files[0].geometry === null && lv.files[0].rows.some((r) => r.level === marked[0].level), JSON.stringify(lv.files[0]).slice(0, 300));
  ok('an assembly\'s general-arrangement DXF (two outlines) is kept, not refused', lv.files[1].status === 'new' && lv.files[1].problems.length === 0 && lv.files[1].geometry === null, JSON.stringify(lv.files[1]).slice(0, 300));
  ok('a plate part\'s PDF replaces its DXF, saying it has no shape to read', lv.files[2].status === 'replaces' && /no shape to read/.test(lv.files[2].warnings.join(' ')));
  const lvSaved = await uploadDrawings(db, c, line.order_id, LINE, { files: levelUp.slice(0, 2), dryRun: false });
  const segDrawing = lvSaved.view.drawings.find((d) => d.fileKind === 'pdf' && d.mark === marked[0].mark);
  ok('saved on every level: the summary counts rows, not just parts', lvSaved.view.summary.rowsWithDrawing >= same.length + 2 && segDrawing?.levels.includes(marked[0].level), JSON.stringify(lvSaved.view.summary));
  const got = await drawingFile(db, COMPANY, line.order_id, LINE, segDrawing.id);
  ok('the PDF downloads exactly as uploaded', got.contentType === 'application/pdf' && got.buffer.equals(pdf) && /\.PDF$/i.test(got.filename));

  view = await deleteDrawing(db, c, line.order_id, LINE, again.view.drawings[0].id);
  ok('deleted: the part drawing is gone, and its cut plate is back to the rectangle', !view.drawings.some((d) => d.mark === 'FST-P1') && Math.abs((await valueOf('CUT_LENGTH')) - cutBefore) < 1e-3, `${await valueOf('CUT_LENGTH')} vs ${cutBefore}`);
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 3).join(' '));
} finally {
  await db.rollback();
  db.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
