/**
 * part_drawings_test.mjs — part shapes (DXF) on an order line (partDrawingService, init.sql §51).
 * Upload by drawing mark (preview, save, replace, delete), the measure (true vs rectangle area),
 * the cut plate's cut length and piercings from the drawing, and the CNC file drawing the outline;
 * §52 the register: every file is a register revision, a drawing started from a row waits for its
 * file, uploading over an issued revision makes the next one and the old file stays downloadable.
 * THE ORDERING TRAP (2026-10-11): a plate part is one by its own CUT_FROM, not by having a cut
 * plate — on a fixture of this run's own (nodes, templates, order, two lines of different sizes,
 * NO cut pieces) with the real T&T 24 m files: shapes are read at upload, a drawing stored without
 * one is read late (list read, facts read, cut-piece derive, backfill script) and kept, assemblies
 * and the profile part stay plain, and the round trips do not grow with the line.
 * Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/part_drawings_test.mjs
 */
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { getDrawings, drawingTree, uploadDrawings, deleteDrawing, drawingFile, platePartsOfLine, rowsOfLine, drawingFactsOfLine, startDrawing, registerFile, shapesAfterCutPieces, NOT_ONE_PLATE } from '../../apps/cf_erp/services/partDrawingService.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as CLS from '../../apps/cf_erp/services/classificationService.js';
import * as MR from '../../apps/cf_erp/services/masterRecordService.js';
import * as B from '../../apps/cf_erp/services/bomService.js';
import * as SO from '../../apps/cf_erp/services/salesOrderService.js';
import * as V from '../../apps/cf_erp/services/valueService.js';
import * as PARTIES from '../../apps/cf_erp/modules/parties/service.js';
import { deriveCutPlates } from '../../apps/cf_erp/services/cutPlateService.js';
import { readShapes } from './drawings-read-shapes.mjs';
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

  // ── Any level (2026-10-11): a multi-loop DXF on a NON-plate row is a plain drawing; on a plate row it is still refused. ──
  const asm = rows.find((r) => !r.isPlatePart && r.depth > 0 && !aimedIds.includes(r.id) && !marked.slice(0, 2).some((m) => m.id === r.id));
  const asmMark = 'ASM-ANY-1';
  const multi = dxf([lw([[0, 0], [1000, 0], [1000, 500], [0, 500]]), lw([[2000, 0], [3000, 0], [3000, 500], [2000, 500]]), circle(500, 250, 20)]);
  const asmUp = await uploadDrawings(db, c, line.order_id, LINE, { files: [{ name: `${asmMark}.dxf`, content: Buffer.from(multi, 'latin1').toString('base64'), rowId: asm.id }], dryRun: false });
  const asmFile = asmUp.view.drawings.find((d) => d.mark === asmMark);
  ok('an assembly row takes a multi-loop DXF: accepted and stored, no plate geometry', asmUp.saved && asmFile && asmFile.geometry === null && asmFile.fileKind === 'dxf' && asmFile.rows.some((r) => r.id === asm.id), JSON.stringify(asmUp.files[0]).slice(0, 300));
  ok('…and it is stored as drawn', (await drawingFile(db, COMPANY, line.order_id, LINE, asmFile.id)).buffer.toString('latin1') === multi);
  const factsAfter = await drawingFactsOfLine(db, COMPANY, LINE);
  ok('…and gives no plate facts (no cut plate takes its cut length or piercings from it)', ![...factsAfter.values()].some((f) => f.marks?.has?.(asmFile.id)) && asmFile.geometry === null);
  const plateRow = parts.find((p) => !same.some((x) => x.id === p.id)) ?? part;
  const plateMulti = await uploadDrawings(db, c, line.order_id, LINE, { files: [{ name: 'PLT-MULTI.dxf', content: Buffer.from(multi, 'latin1').toString('base64'), rowId: plateRow.id }], dryRun: true });
  ok('a plate-part row still refuses a multi-loop DXF with the same sentence as before', plateMulti.files[0].status === 'error' && /more than one part/.test(plateMulti.files[0].problems.join(' ')), JSON.stringify(plateMulti.files[0]).slice(0, 300));
  // The count of queries a dry run asks does not depend on the row's kind.
  const log2 = []; const q1 = db.query.bind(db); db.query = (...a) => { log2.push(1); return q1(...a); };
  await uploadDrawings(db, c, line.order_id, LINE, { files: [{ name: 'K1.dxf', content: Buffer.from(multi, 'latin1').toString('base64'), rowId: asm.id }], dryRun: true }); const nAsm = log2.length; log2.length = 0;
  await uploadDrawings(db, c, line.order_id, LINE, { files: [{ name: 'K2.dxf', content: Buffer.from(shape, 'latin1').toString('base64'), rowId: plateRow.id }], dryRun: true }); const nPlate = log2.length; log2.length = 0;
  db.query = q1;
  ok(`a dry run asks the same number of queries for an assembly and a plate row (${nAsm} vs ${nPlate})`, Math.abs(nAsm - nPlate) <= 1);

  // ── The tree: every row with its parent and whether it has a drawing, in a fixed number of queries. ──
  const tree = await drawingTree(db, COMPANY, line.order_id, LINE);
  const byId = new Map(tree.rows.map((r) => [r.rowId, r]));
  ok(`the tree lists every row of the line (${tree.rows.length}) with the shape the viewer needs`, tree.rows.length === rows.length && tree.rows.every((r) => 'parentId' in r && 'hasDrawing' in r && 'drawingId' in r && 'fileKind' in r && 'revision' in r && r.name && r.level), JSON.stringify(tree.rows[0]));
  const roots = tree.rows.filter((r) => r.parentId == null);
  ok('exactly one top row, every other row has a parent that is on the line', roots.length === 1 && roots[0].depth === 0 && tree.rows.every((r) => r.parentId == null || byId.has(r.parentId)), `${roots.length} roots`);
  ok('a row drawing is flagged and points at its file', byId.get(asm.id).hasDrawing && byId.get(asm.id).drawingId === asmFile.id && byId.get(asm.id).fileKind === 'dxf' && tree.rows.some((r) => !r.hasDrawing && r.drawingId == null));
  ok('the walk up from any row reaches the top (breadcrumb)', tree.rows.every((r) => { let x = r, n = 0; while (x.parentId != null && n++ < 60) x = byId.get(x.parentId); return x.parentId == null && x.rowId === roots[0].rowId; }));
  let none = null; try { await drawingTree(db, 999999, line.order_id, LINE); } catch (e) { none = e.message; }
  ok('another company sees nothing of this line (not found)', /not found/i.test(none ?? ''), none);
  const countQ = async (lid, oid) => { const l = []; const o = db.query.bind(db); db.query = (...a) => { l.push(1); return o(...a); }; try { const t = await drawingTree(db, COMPANY, oid, lid); return { n: l.length, rows: t.rows.length }; } finally { db.query = o; } };
  // Never a borrowed line id: whichever other custom lines the tenant has today, the smallest tree among a few.
  const [others] = await db.query("SELECT id, order_id FROM cf_sales_order_lines WHERE company_id = ? AND deleted_at IS NULL AND line_type = 'custom' AND item_id IS NOT NULL AND id <> ? ORDER BY id DESC LIMIT 8", [COMPANY, LINE]);
  const big = await countQ(LINE, line.order_id);
  // The BOM explode asks once per level of depth, never per row — an absolute ceiling holds on its own.
  ok(`the tree is read in a fixed handful of queries (${big.rows} rows: ${big.n})`, big.n <= 25, String(big.n));
  let sm = null;
  for (const o of others) { try { const c = await countQ(o.id, o.order_id); if (c.rows > 0 && (!sm || c.rows < sm.rows)) sm = c; } catch { /* a line that cannot be read is no comparison */ } }
  if (sm && big.rows > 5 * sm.rows) ok(`…and they do not grow with rows (${sm.rows} rows: ${sm.n} queries, ${big.rows} rows: ${big.n})`, big.n - sm.n <= 6, `${sm.n} vs ${big.n}`);
  else console.log(`        no much smaller line to compare with today (${sm ? sm.rows : 'none'}) — the ceiling above stands alone`);

  view = await deleteDrawing(db, c, line.order_id, LINE, again.view.drawings[0].id);
  ok('deleted: the part drawing is gone, and its cut plate is back to the rectangle', !view.drawings.some((d) => d.mark === 'FST-P1') && Math.abs((await valueOf('CUT_LENGTH')) - cutBefore) < 1e-3, `${await valueOf('CUT_LENGTH')} vs ${cutBefore}`);

  // ══ THE ORDERING TRAP (2026-10-11): drawings uploaded BEFORE the line's cut pieces exist ══
  console.log('\n  the ordering trap — a fixture of this run\'s own, with the T&T 24 m files');
  attachNodeCache(db);
  const tag = `PDT${Date.now().toString(36).toUpperCase()}`;
  const DIR = fileURLToPath(new URL('../../../TT_24M_DXF/', import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(`${DIR}manifest.json`, 'utf8'));
  const real = (name, extra = {}) => ({ name, content: fs.readFileSync(`${DIR}${name}`).toString('base64'), ...extra });
  const plateFiles = manifest.parts.map((p) => ({ mark: p.mark, file: p.file, t: p.thicknessMm, l: p.lengthMm, w: p.widthMm }));
  ok(`the folder holds the plate files (${plateFiles.length}) and the assembly files`, plateFiles.length >= 38 && fs.existsSync(`${DIR}G1.dxf`) && fs.existsSync(`${DIR}ANG1.dxf`));

  // Own classification: a family with the CUT_FROM rule, and under it an assembly, a plate-part and a profile-part node.
  const fam = await CLS.createNode(db, c, { code: `${tag}-F`, name: `${tag} fabricated` });
  const mid = await CLS.createNode(db, c, { parentId: fam.id, code: `${tag}-M`, name: `${tag} kinds` });
  const nodeOf = async (code, name) => (await CLS.createNode(db, c, { parentId: mid.id, code: `${tag}-${code}`, name: `${tag} ${name}` })).id;
  const asmNode = await nodeOf('A', 'assembly'); const plateNode = await nodeOf('P', 'plate part'); const profNode = await nodeOf('S', 'profile part');
  const [[cfSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'CUT_FROM' AND deleted_at IS NULL", [COMPANY]);
  await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, sort_order) VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'defaulted', 0)", [COMPANY, cfSpec.id, fam.id]);
  await V.setValues(db, c, 'classification', plateNode, [{ specCode: 'CUT_FROM', value: 'PLATE' }]);
  await V.setValues(db, c, 'classification', profNode, [{ specCode: 'CUT_FROM', value: 'SECTION' }]);
  await V.setValues(db, c, 'classification', asmNode, [{ specCode: 'CUT_FROM', value: 'NONE' }]);

  // Templates: one per plate mark, the angle, and two girders (3 plates / every plate) of the same depth.
  const tpl = async (code, classificationId) => MR.setStatus(db, c, (await MR.createDefinition(db, c, { definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${tag} ${code}`, shortName: `${tag}${code}`.slice(0, 30) })).id, 'active');
  const markOfDef = new Map();
  const plateTpl = new Map();
  for (const p of plateFiles) { const t = await tpl(p.mark, plateNode); plateTpl.set(p.mark, t.id); markOfDef.set(Number(t.id), p.mark); }
  const angle = await tpl('ANG1', profNode); markOfDef.set(Number(angle.id), 'ANG1');
  const girder = async (key, marks) => {
    const seg = await tpl(`SEG${key}`, asmNode); markOfDef.set(Number(seg.id), 'G1-S1');
    for (const m of marks) await B.addLine(db, c, seg.id, { childId: plateTpl.get(m), quantity: 2 });
    await B.addLine(db, c, seg.id, { childId: angle.id, quantity: 4 });
    await B.setBomStatus(db, c, seg.id, 'active');
    const g = await tpl(`G${key}`, asmNode); markOfDef.set(Number(g.id), 'G1');
    await B.addLine(db, c, g.id, { childId: seg.id, quantity: 1 });
    await B.setBomStatus(db, c, g.id, 'active');
    return g;
  };
  const smallMarks = ['TF-S1', 'WEB-S1', 'BS1'];
  const gSmall = await girder('S', smallMarks);
  const gBig = await girder('L', plateFiles.map((p) => p.mark));
  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CU`, name: `${tag} bridge co`, roles: ['customer'] });
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: cust.id, code: `${tag}-SO`, committedDate: '2026-12-31' });
  const addLine = async (recordId) => { const o = await SO.addOrderLine(db, c, order.id, { recordId, quantity: 1 }); return o.lines[o.lines.length - 1]; };
  const smallL = await addLine(gSmall.id);
  const bigL = await addLine(gBig.id);
  // Each row's mark and (for plates) the size its file is drawn to — written as values, the way the Values screen leaves them.
  const [specRows] = await db.query("SELECT id, UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN ('LENGTH', 'WIDTH', 'THICKNESS', 'DRAWING_MARK')", [COMPANY]);
  const specId = Object.fromEntries(specRows.map((x) => [x.code, x.id]));
  const sizeOfMark = new Map(plateFiles.map((p) => [p.mark, p]));
  const [temps] = await db.query("SELECT m.id, i.source_definition_id AS def, i.owner_order_line_id AS line_id FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL WHERE i.company_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id IN (?)", [COMPANY, [smallL.id, bigL.id]]);
  const valueRows = [];
  for (const t of temps) {
    const mark = markOfDef.get(Number(t.def)); if (!mark) continue;
    valueRows.push([COMPANY, specId.DRAWING_MARK, 'master', t.id, null, mark, 'entered']);
    const sz = sizeOfMark.get(mark);
    if (sz) valueRows.push([COMPANY, specId.LENGTH, 'master', t.id, sz.l, null, 'entered'], [COMPANY, specId.WIDTH, 'master', t.id, sz.w, null, 'entered'], [COMPANY, specId.THICKNESS, 'master', t.id, sz.t, null, 'entered']);
  }
  await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND deleted_at IS NULL AND subject_id IN (?) AND specification_id IN (?)", [COMPANY, temps.map((t) => t.id), Object.values(specId)]);
  await db.query('INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, value_text, source) VALUES ?', [valueRows]);

  const lineRow = async (id) => (await db.query('SELECT * FROM cf_sales_order_lines WHERE id = ?', [id]))[0][0];
  const [bigLine, smallLine] = [await lineRow(bigL.id), await lineRow(smallL.id)];
  const bigRows = await rowsOfLine(db, COMPANY, bigLine);
  const plateRowsBig = bigRows.filter((r) => r.isPlatePart);
  ok(`no cut piece exists on the line, yet its ${plateRowsBig.length} plate rows are plate parts by their own CUT_FROM`, plateRowsBig.length === plateFiles.length && plateRowsBig.every((r) => r.cutFrom === 'PLATE' && r.cutPlateIds.length === 0), `${plateRowsBig.length} / ${plateFiles.length}`);
  const angRow = bigRows.find((r) => r.mark === 'ANG1'); const asmRows = bigRows.filter((r) => ['G1', 'G1-S1'].includes(r.mark));
  ok('the profile part (cut from a section) and the assemblies are not', angRow && angRow.cutFrom === 'SECTION' && !angRow.isPlatePart && asmRows.length === 2 && asmRows.every((r) => !r.isPlatePart && r.cutFrom === 'NONE'), JSON.stringify([angRow?.cutFrom, asmRows.map((r) => r.cutFrom)]));

  // (a) At upload: every plate file is read as its shape, the assemblies and the angle are kept plain.
  const allFiles = [...plateFiles.map((p) => real(p.file)), real('G1.dxf'), real('G1-S1.dxf'), real('ANG1.dxf')];
  const pre = await uploadDrawings(db, c, order.id, bigL.id, { files: allFiles, dryRun: true });
  const preBy = new Map(pre.files.map((x) => [x.name, x]));
  const platePre = plateFiles.map((p) => preBy.get(p.file));
  ok(`preview: all ${plateFiles.length} plate files read their shape and match their row's size`, platePre.every((x) => x.status === 'new' && x.geometry && x.rows.length === 1 && x.rows[0].isPlatePart && x.rows[0].sizeMatches === true), JSON.stringify(platePre.find((x) => !(x.status === 'new' && x.geometry && x.rows[0]?.sizeMatches === true)) ?? null).slice(0, 300));
  const web = preBy.get('WEB-S2.dxf').geometry;
  ok('…with the facts the take-off states (WEB-S2: 9450 × 1150, 180 drilled holes, one piercing)', Math.abs(web.lengthMm - 9450) < 0.2 && Math.abs(web.widthMm - 1150) < 0.2 && web.holes === 180 && web.piercings === 1, JSON.stringify({ l: web.lengthMm, w: web.widthMm, h: web.holes }));
  ok('preview: the assembly drawings (many outlines) and the angle are accepted as plain drawings', ['G1.dxf', 'G1-S1.dxf', 'ANG1.dxf'].every((n) => preBy.get(n).status === 'new' && preBy.get(n).geometry === null && preBy.get(n).problems.length === 0), JSON.stringify(['G1.dxf', 'G1-S1.dxf', 'ANG1.dxf'].map((n) => [preBy.get(n).status, preBy.get(n).problems])));
  const aimedMulti = await uploadDrawings(db, c, order.id, bigL.id, { files: [real('G1.dxf', { name: 'X-MULTI.dxf', rowId: plateRowsBig[0].id })], dryRun: true });
  ok('a file of many outlines aimed at a plate row is still refused, in the same sentence — though the row has no cut plate', aimedMulti.files[0].status === 'error' && /more than one part/.test(aimedMulti.files[0].problems.join(' ')), JSON.stringify(aimedMulti.files[0]).slice(0, 300));
  const savedBig = await uploadDrawings(db, c, order.id, bigL.id, { files: allFiles, dryRun: false });
  const shapesStored = async (lineId) => Number((await db.query('SELECT COUNT(*) n FROM cf_part_drawings WHERE order_line_id = ? AND deleted_at IS NULL AND geometry_json IS NOT NULL', [lineId]))[0][0].n);
  const sb = savedBig.view.summary;
  ok(`saved: ${plateFiles.length} shapes stored, the summary counts every plate part as shaped (${sb.partsWithShape} of ${sb.parts}, use ${sb.usePct}%)`, savedBig.saved && await shapesStored(bigL.id) === plateFiles.length && sb.parts === plateFiles.length && sb.partsWithShape === plateFiles.length && sb.usePct > 50 && sb.usePct < 100, JSON.stringify(sb));
  const plain = savedBig.view.drawings.filter((d) => ['G1', 'G1-S1', 'ANG1'].includes(d.mark));
  ok('saved: the assemblies and the angle are plain drawings, stored as drawn', plain.length === 3 && plain.every((d) => d.geometry === null && d.warnings.length === 0) && (await drawingFile(db, COMPANY, order.id, bigL.id, plain.find((d) => d.mark === 'G1').id)).buffer.equals(fs.readFileSync(`${DIR}G1.dxf`)));
  const savedSmall = await uploadDrawings(db, c, order.id, smallL.id, { files: [...smallMarks.map((m) => real(`${m}.dxf`)), real('G1.dxf'), real('G1-S1.dxf'), real('ANG1.dxf')], dryRun: false });
  ok('the small line the same: 3 shapes, 3 plain', savedSmall.saved && await shapesStored(smallL.id) === 3 && savedSmall.view.drawings.length === 6);

  // The state production is in: files saved by the old rule — a plain drawing, no shape.
  const forget = (lineId) => db.query('UPDATE cf_part_drawings SET geometry_json = NULL, length_mm = NULL, width_mm = NULL, area_mm2 = NULL, cut_length_mm = NULL, piercings = NULL, holes = NULL, inner_cuts = NULL, warnings_json = ? WHERE order_line_id = ? AND deleted_at IS NULL', ['[]', lineId]);
  const counted = async (fn) => { const log = []; const q = db.query.bind(db); db.query = (...a) => { log.push(String(a[0]).replace(/\s+/g, ' ').trim()); return q(...a); }; try { return { out: await fn(), n: log.length, sql: log }; } finally { db.query = q; } };
  const writesIn = (r) => r.sql.filter((x) => /^(UPDATE|INSERT|DELETE)/i.test(x));

  // (c) Lazily on the list read — shown at once, kept, and never parsed twice.
  await forget(bigL.id); await forget(smallL.id);
  // One row disagrees with its file, and one plate row's stored file is not one plate at all.
  const dsp = plateRowsBig.find((r) => r.mark === 'DSP'); const pad = plateRowsBig.find((r) => r.mark === 'PAD');
  await db.query("UPDATE cf_spec_values SET value_number = value_number + 25 WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, dsp.id, specId.WIDTH]);
  await db.query('UPDATE cf_part_drawings SET dxf_text = ? WHERE order_line_id = ? AND mark_norm = ? AND deleted_at IS NULL', [fs.readFileSync(`${DIR}G1-S1.dxf`, 'latin1'), bigL.id, 'PAD']);
  ok('the old state: no shape stored on either line', await shapesStored(bigL.id) === 0 && await shapesStored(smallL.id) === 0);
  const lazyBig = await counted(() => getDrawings(db, COMPANY, order.id, bigL.id));
  const lb = lazyBig.out.summary;
  ok(`list read: the shapes are there in the same answer (${lb.partsWithShape} of ${lb.parts}) and kept (${await shapesStored(bigL.id)} stored)`, lb.partsWithShape === plateFiles.length - 1 && await shapesStored(bigL.id) === plateFiles.length - 1, JSON.stringify(lb));
  ok('…with ONE read of the texts and ONE bulk update, whatever the number of drawings', lazyBig.sql.filter((x) => /SELECT id, dxf_text/.test(x)).length === 1 && writesIn(lazyBig).length === 1 && /^UPDATE cf_part_drawings SET/.test(writesIn(lazyBig)[0]), writesIn(lazyBig).map((x) => x.slice(0, 50)).join(' | '));
  const dspView = lazyBig.out.drawings.find((d) => d.mark === 'DSP');
  ok('…a row whose size disagrees with its file is warned in the upload\'s words, and sizeMatches says so', dspView.rows[0].sizeMatches === false && dspView.warnings.some((w) => /nesting lays out the order's size/.test(w)) && dspView.geometry, JSON.stringify(dspView.warnings));
  const padView = lazyBig.out.drawings.find((d) => d.mark === 'PAD');
  ok('…a stored file that is not one plate stays a plain drawing and says why', padView.geometry === null && padView.warnings.some((w) => w.startsWith(NOT_ONE_PLATE) && /more than one part/.test(w)), JSON.stringify(padView.warnings).slice(0, 300));
  ok('…the assemblies and the angle are untouched (no shape, no warning)', lazyBig.out.drawings.filter((d) => ['G1', 'G1-S1', 'ANG1'].includes(d.mark)).every((d) => d.geometry === null && d.warnings.length === 0));
  const [[storedDsp]] = await db.query("SELECT length_mm, cut_length_mm, piercings, warnings_json FROM cf_part_drawings WHERE order_line_id = ? AND mark_norm = 'DSP' AND deleted_at IS NULL", [bigL.id]);
  ok('…the columns beside the shape are filled too, and the warnings stored', Math.abs(Number(storedDsp.length_mm) - 575) < 0.2 && Number(storedDsp.cut_length_mm) > 1000 && Number(storedDsp.piercings) === 1 && /nesting lays out/.test(storedDsp.warnings_json), JSON.stringify(storedDsp).slice(0, 200));
  const againBig = await counted(() => getDrawings(db, COMPANY, order.id, bigL.id));
  ok(`a second list read parses and writes nothing (${againBig.n} queries, was ${lazyBig.n})`, writesIn(againBig).length === 0 && !againBig.sql.some((x) => /SELECT id, dxf_text/.test(x)) && againBig.n === lazyBig.n - 2 && againBig.out.summary.partsWithShape === plateFiles.length - 1, `${againBig.n} vs ${lazyBig.n}`);
  const lazySmall = await counted(() => getDrawings(db, COMPANY, order.id, smallL.id));
  const againSmall = await counted(() => getDrawings(db, COMPANY, order.id, smallL.id));
  ok(`the list read asks the same number of queries at 3 and at ${plateFiles.length} plate parts — late read ${lazySmall.n} = ${lazyBig.n}, plain read ${againSmall.n} = ${againBig.n}`, lazySmall.n === lazyBig.n && againSmall.n === againBig.n && lazySmall.out.summary.partsWithShape === 3);

  // (c) The same net under nesting / cut length / CNC: drawingFactsOfLine.
  await forget(smallL.id);
  const factsLate = await counted(() => drawingFactsOfLine(db, COMPANY, smallL.id));
  ok('the facts read (nesting, cut length, CNC) reads late shapes too and keeps them', await shapesStored(smallL.id) === 3 && writesIn(factsLate).length === 1 && factsLate.out.size === 0);

  // (b) When cut pieces are derived: the hook.
  await forget(smallL.id); await forget(bigL.id);
  const hookSmall = await counted(() => shapesAfterCutPieces(db, c, smallL.id));
  const hookBig = await counted(() => shapesAfterCutPieces(db, c, bigL.id));
  ok(`the cut-piece hook reads what lacks a shape (${hookSmall.out.read} and ${hookBig.out.read}) in the same number of queries at both sizes (${hookSmall.n} = ${hookBig.n})`, hookSmall.out.read === 3 && hookBig.out.read === plateFiles.length - 1 && hookBig.out.notOnePlate === 1 && hookSmall.n === hookBig.n && await shapesStored(bigL.id) === plateFiles.length - 1, JSON.stringify([hookSmall.out, hookBig.out, hookSmall.n, hookBig.n]));
  ok('…with one bulk update of the drawings at most', hookBig.sql.filter((x) => /^UPDATE cf_part_drawings/.test(x)).length === 1 && hookSmall.sql.filter((x) => /^UPDATE cf_part_drawings/.test(x)).length === 1);
  const hookAgain = await counted(() => shapesAfterCutPieces(db, c, bigL.id));
  ok(`…and run again it reads no file (${hookAgain.n} queries)`, hookAgain.out.read === 0 && !hookAgain.sql.some((x) => /SELECT id, dxf_text|^UPDATE cf_part_drawings/.test(x)));
  await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE order_line_id = ? AND deleted_at IS NULL', [LINE]);   // the borrowed line: no drawing left on it
  const hookNone = await counted(() => shapesAfterCutPieces(db, c, LINE));
  ok('…a line with no DXF costs the derive ONE query', hookNone.n === 1 && hookNone.out.drawings === 0, String(hookNone.n));

  // The hook inside a real derive — the borrowed line (it has cut plates, a plate selection and a nest): its part's
  // drawing sits there without a shape and its cut plate still says the rectangle, as on production today.
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [LINE]);
  const reup = await uploadDrawings(db, c, line.order_id, LINE, { files: [file('FST-P1.dxf', shape)], dryRun: false });
  const cutDrawn = await valueOf('CUT_LENGTH');
  ok('the borrowed line: the part has its drawing and its cut plate the drawing\'s cut length', reup.saved && Math.abs(cutDrawn - cutBefore) > 1, `${cutBefore} → ${cutDrawn}`);
  await forget(LINE);
  await db.query("UPDATE cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'CUT_LENGTH' SET v.value_number = ? WHERE v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL", [cutBefore, cpId]);
  ok('…put back into the old state: no shape, the rectangle\'s cut length', await shapesStored(LINE) === 0 && Math.abs((await valueOf('CUT_LENGTH')) - cutBefore) < 1e-3);
  const derived = await counted(() => deriveCutPlates(db, c, LINE));
  ok(`deriving the line's cut pieces reads the shape and gives the cut plate its cut length (${cutBefore} → ${await valueOf('CUT_LENGTH')})`, await shapesStored(LINE) === 1 && Math.abs((await valueOf('CUT_LENGTH')) - cutDrawn) < 1e-3 && derived.sql.filter((x) => /^UPDATE cf_part_drawings SET length_mm/.test(x)).length === 1, `${await shapesStored(LINE)} stored, ${await valueOf('CUT_LENGTH')} vs ${cutDrawn}`);

  // The backfill script: a dry run changes nothing, applying is idempotent.
  await forget(bigL.id); await forget(smallL.id);
  await db.query('SAVEPOINT backfill_dry');
  const said = [];
  const dryFill = await readShapes(db, { companyId: COMPANY, orderCode: order.code, log: (x) => said.push(x) });
  await db.query('ROLLBACK TO SAVEPOINT backfill_dry');
  const mine = dryFill.orders.find((o) => o.code === order.code);
  ok(`backfill dry run reports the order: ${mine?.looked} looked at, ${mine?.read.length} read, ${mine?.notOnePlate.length} not one plate, ${mine?.sizeMismatches.length} size mismatch — and rolled back leaves nothing`, dryFill.orders.length === 1 && mine.looked === plateFiles.length + 3 && mine.read.length === plateFiles.length - 1 + 3 && mine.notOnePlate.length === 1 && mine.notOnePlate[0].mark === 'PAD' && /more than one part/.test(mine.notOnePlate[0].why) && mine.sizeMismatches.length === 1 && await shapesStored(bigL.id) === 0 && await shapesStored(smallL.id) === 0, JSON.stringify({ ...mine, read: mine?.read.length }));
  ok('…in words a person can read', said.some((x) => x.startsWith(`${order.code}: `) && /shapes read/.test(x)) && said.some((x) => /not one plate part — PAD/.test(x)) && said.some((x) => /^ {4}size — /.test(x)), said.join(' / ').slice(0, 300));
  const applied = await counted(() => readShapes(db, { companyId: COMPANY, orderCode: order.code, log: () => {} }));
  ok('backfill applied: every shape stored, with ONE update of the drawings for the whole order (two lines)', await shapesStored(bigL.id) === plateFiles.length - 1 && await shapesStored(smallL.id) === 3 && applied.sql.filter((x) => /^UPDATE cf_part_drawings/.test(x)).length === 1);
  const twice = await counted(() => readShapes(db, { companyId: COMPANY, orderCode: order.code, log: () => {} }));
  ok('backfill again: nothing read, nothing written (the file that is not one plate is only named again)', twice.out.totals.read === 0 && writesIn(twice).length === 0 && twice.out.totals.notOnePlate === 1 && twice.out.orders[0].notOnePlate[0].known === true, JSON.stringify(twice.out.totals));
  const all = await counted(() => readShapes(db, { companyId: COMPANY, log: () => {} }));
  ok('backfill over the whole company finds nothing else to read here', all.out.totals.read === 0 && writesIn(all).length === 0, JSON.stringify(all.out.totals));
  // The script itself, as the user runs it (its own connection: it sees only committed rows — none lack a shape).
  const cli = spawnSync(process.execPath, ['scripts/cf_kepl/drawings-read-shapes.mjs', '--company', String(COMPANY)], { encoding: 'utf8' });
  ok('the script runs as a dry run by default and says so', cli.status === 0 && /DRY RUN — rolled back/.test(cli.stdout) && !/COMMITTED/.test(cli.stdout), (cli.stdout + cli.stderr).slice(-300));
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 3).join(' '));
} finally {
  detachNodeCache(db);
  await db.rollback();
  db.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
