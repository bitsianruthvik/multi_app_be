/**
 * standard-import.mjs — loads a ready-made STANDARD DRAWING (e.g. an RDSO girder set made by TM/drawing_bom) into
 * Standard drawings: the sheet in the drawings register with its source link, version 1 of its BOM tree mapped onto
 * the catalog's EXISTING definitions with its values (grade, thickness, width, length, quantities, weight, drawing
 * marks), and its part DXFs (read by partGeometry.readPartDrawing, each on its own register revision). Notes a person
 * must see ("DRILL ON ASSEMBLY", an open decision, a drilling caution) go on the row's BOM line.
 * (init.sql §69, services/standardDrawingService.importStandard; format: TM/drawing_bom/out/IMPORT_FORMAT.md)
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/standard-import.mjs ../drawing_bom/out/RDSO_11751R3 --company 2            dry run: prints the plan
 *   node scripts/cf_kepl/standard-import.mjs ../drawing_bom/out/RDSO_11751R3 --company 2 --apply    writes it, ONE transaction
 *        [--source-url <url>]   when bom.json records none
 *        [--user <id>]          who it is written by (default: the company's first user)
 *        [--gap-fill]           OLD SETS ONLY: fill the gaps the drawing settles (segment lengths, girder type, segment holes /
 *                               drilled thickness, assembly surface) and flows by usage, row by row (lib/standardGaps.js,
 *                               2026-10-18). OFF by default since 2026-11-08 (user: "only when we upload the 3D json can it
 *                               infer most values … until then only manual fill"): the geometry comes from the 3D model
 *                               (modelValueService.applyModel). --no-gap-fill is still accepted (it is the default).
 *        [--section-class BR]   with --gap-fill: section parts take the catalog bar of this impact class
 *        [--model-values]       with --into: compute the new version's values from the standard's 3D model before the
 *                               line copy (ON by default when the standard has a model; --no-model-values skips it)
 *        [--allow-new "A,B"]    the new definitions agreed to, by name; --apply refuses any other new one (2026-11-06)
 *        [--json]               the report as JSON
 *        [--prod]               the production database: DB_* from TM/.env.tidb (the same way the other cf_kepl scripts reach it)
 *
 * Dry run reads only. --apply refuses a standard whose number is already there (nothing is written). A definition is
 * created only where no existing one fits, and the report lists each. Round trips are fixed: a handful of reads, the
 * tree in bulk inserts (treeCopyService.writeCopies), one insert each for the register drawings, links and files — the
 * count is printed (production is ~49 ms a round trip).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const folder = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
const COMPANY = Number(arg('company'));
// --into <standardId> --onto-line <lineId> (2026-11-08, user: "why not soft delete the previous BOM and add the new one fresh"):
// the package becomes the next VERSION of that standard (bulk writes), the line's old tree is soft-deleted and the new version is
// copied onto the line (bulk, as "line from standard" does). Only for a line nothing has started on (not locked, no nest/release).
// --rehearse runs all of it in the transaction and rolls back.
const INTO = arg('into') ? Number(arg('into')) : null; const ONTO = arg('onto-line') ? Number(arg('onto-line')) : null;
const REHEARSE = process.argv.includes('--rehearse');
const APPLY = process.argv.includes('--apply') || REHEARSE;
const JSON_OUT = process.argv.includes('--json');
if (!folder || !Number.isInteger(COMPANY) || COMPANY <= 0) {
  console.error('Usage: node scripts/cf_kepl/standard-import.mjs <folder with bom.json and dxf/> --company <id> [--apply] [--source-url <url>] [--user <id>] [--json] [--prod]');
  process.exit(2);
}
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}

const BE = path.join(__dir, '..', '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');   // the code generator's entities (drawing codes)
const STD = await imp('apps/cf_erp/services/standardDrawingService.js');

const bomPath = path.join(folder, 'bom.json');
if (!fs.existsSync(bomPath)) { console.error(`No bom.json in ${folder}`); process.exit(2); }
const bom = JSON.parse(fs.readFileSync(bomPath, 'utf8'));
const dxfDir = path.join(folder, 'dxf');
const files = fs.existsSync(dxfDir)
  ? fs.readdirSync(dxfDir).filter((f) => /\.dxf$/i.test(f)).map((name) => ({ name, text: fs.readFileSync(path.join(dxfDir, name)).toString('latin1') }))
  : [];

/** Every statement the import sends, counted — the round trips production pays for. */
function counting(conn) {
  let n = 0;
  const q = conn.query.bind(conn);
  conn.query = (...a) => { n++; return q(...a); };
  return { get: () => n, reset: () => { n = 0; } };
}

const conn = await pool.getConnection();
const count = counting(conn);
let code = 0;
try {
  const [[host]] = await conn.query('SELECT @@hostname AS h, DATABASE() AS d');
  const [[co]] = await conn.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
  if (!co) throw new Error(`No company ${COMPANY}.`);
  const userId = arg('user') ? Number(arg('user')) : ((await conn.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]))[0][0]?.id ?? null);
  const c = { companyId: COMPANY, userId };
  count.reset();
  if (APPLY) await conn.beginTransaction();
  // The setup step (options the standards need, the BO label) — in this same transaction when applying.
  const setup = await STD.importSetup(conn, c, { apply: APPLY });
  // --allow-new "A,B": the new definitions a person agreed to, by name, after the dry run showed each one's nearest
  // existing definition. Without it --apply refuses any new definition (user, 2026-11-06).
  const allowNew = arg('allow-new') ? String(arg('allow-new')).split(',').map((s) => s.trim()).filter(Boolean) : [];
  let lineBefore = null;
  if (ONTO) {
    const [[l]] = await conn.query(`SELECT l.id, l.item_id, l.locked_at, l.standard_id, l.line_type, o.status, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
                                     WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`, [COMPANY, ONTO]);
    if (!l) throw new Error(`No line ${ONTO}.`);
    if (l.locked_at) throw new Error(`Line ${ONTO} of ${l.code} is locked: its BOM is frozen.`);
    if (!['inquiry', 'draft', 'quoted'].includes(String(l.status))) throw new Error(`${l.code} is ${l.status}: replace only an order nothing has started on.`);
    if (INTO && Number(l.standard_id) !== INTO) throw new Error(`Line ${ONTO} is made from standard ${l.standard_id}, not ${INTO}.`);
    lineBefore = l;
  }
  const T0 = Date.now(); const tick = (k) => { (globalThis.__t ??= []).push(`${k} ${Math.round((Date.now() - T0) / 1000)} s`); };
  const out = await STD.importStandard(conn, c, { bom, files, apply: APPLY, sourceUrl: arg('source-url'), allowNew, intoStandardId: INTO });
  // --no-gap-fill: a set that carries every value itself skips the fill (on TiDB a write in it went through another
  // connection and waited on this transaction's own locks — 50 s a time — 2026-10-31).
  if (APPLY && out.standardId && process.argv.includes('--gap-fill')) {
    const { fillImportedGaps } = await imp('apps/cf_erp/services/standardGapFixService.js');
    try { out.report.gapFill = await fillImportedGaps(conn, c, { standardId: out.standardId, bom, sectionClass: arg('section-class') ? String(arg('section-class')).toUpperCase() : null }); } catch (e) { out.report.gapFill = { error: e.message }; }
  }
  tick('import + gap fill');
  // The new version's values from the standard's 3D model (one computation per drawing set), before the line copies it.
  if (APPLY && INTO && out.report.written?.versionId && !process.argv.includes('--no-model-values')) {
    const { applyModel } = await imp('apps/cf_erp/services/modelValueService.js');
    out.report.modelValues = await applyModel(conn, c, { versionId: out.report.written.versionId, bom });
    tick('values from the model');
  }
  out.report.setup = setup.actions;
  if (APPLY && ONTO) {
    const versionId = out.report.written?.versionId; if (!versionId) throw new Error('The import wrote no version.');
    const [[version]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE company_id = ? AND id = ?', [COMPANY, versionId]);
    // The old tree: every row the line owns, its BOMs and lines, values, and the line's part files. Soft-deleted.
    const [old] = await conn.query('SELECT m.id FROM cf_master_records m JOIN cf_item_details d ON d.company_id = m.company_id AND d.master_id = m.id WHERE m.company_id = ? AND d.owner_order_line_id = ? AND m.deleted_at IS NULL', [COMPANY, ONTO]);
    const ids = old.map((r) => Number(r.id)); const gone = { records: ids.length, boms: 0, lines: 0, values: 0, files: 0 };
    for (let i = 0; i < ids.length; i += 2000) {
      const part = ids.slice(i, i + 2000);
      const [bs] = await conn.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL', [COMPANY, part]);
      if (bs.length) { const [r1] = await conn.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND bom_id IN (?) AND deleted_at IS NULL', [COMPANY, bs.map((b) => b.id)]); gone.lines += r1.affectedRows;
        const [r2] = await conn.query('UPDATE cf_boms SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, bs.map((b) => b.id)]); gone.boms += r2.affectedRows; }
      const [r3] = await conn.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL", [COMPANY, part]); gone.values += r3.affectedRows;
      await conn.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, part]);
    }
    const [r4] = await conn.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, ONTO]); gone.files = r4.affectedRows;
    tick('old tree soft-deleted');
    const made = await STD.copyVersionToLine(conn, c, version, ONTO);
    tick('copied onto the line');
    out.report.replaced = { line: ONTO, order: lineBefore.code, oldRoot: Number(lineBefore.item_id), gone, newRoot: made.rootId, rows: made.rows, versionNo: Number(version.version_no), cutPieces: made.cutPieces };
  }
  if (REHEARSE) { await conn.rollback(); out.report.rehearsed = true; }
  else if (APPLY) await conn.commit();
  console.log('TIMES: ' + (globalThis.__t ?? []).join(', '));
  const trips = count.get();
  if (JSON_OUT) { console.log(JSON.stringify({ ...out.report, roundTrips: trips }, null, 1)); }
  else printReport(out.report, { host, co, trips });
} catch (err) {
  code = 1;
  try { await conn.rollback(); } catch { /* not in a transaction */ }
  console.error(`\nNOT IMPORTED — ${err.message}${err.extra ? ` ${JSON.stringify(err.extra)}` : ''}${err.problems ? `\n  ${err.problems.join('\n  ')}` : ''}`);
} finally {
  conn.release();
  await pool.end();
}
process.exit(code);

function printReport(r, { host, co, trips }) {
  const line = (s = '') => console.log(s);
  // DB_HOST, not @@hostname: TiDB Cloud answers "localhost" for that, which reads as the local database.
  if (r.replaced) line(`LINE REPLACED${r.rehearsed ? ' (REHEARSED, ROLLED BACK)' : ''}: ${r.replaced.order} line ${r.replaced.line} — old tree soft-deleted (${JSON.stringify(r.replaced.gone)}), new tree from version ${r.replaced.versionNo}: ${r.replaced.rows} rows, root ${r.replaced.newRoot}; cut pieces ${JSON.stringify(r.replaced.cutPieces)}`);
  line(`${REHEARSE ? 'REHEARSED (rolled back)' : APPLY ? 'APPLIED' : 'DRY RUN (read-only)'} — database ${host.d} at ${process.env.DB_HOST ?? host.h}, company ${co.id} ${co.name}`);
  line(`\n${r.standard.number} — ${r.standard.name}`);
  line(`  source: ${r.standard.sourceUrl ?? '(no link recorded)'}${r.standard.internal ? '   · INTERNAL USE ONLY (RDSO property)' : ''}`);
  if (r.standard.alreadyThere) line(`  ALREADY THERE as standard #${r.standard.alreadyThere} — --apply would refuse.`);
  line(`\nTree → definitions (${r.totals.rows} rows, ${r.totals.parts} parts):`);
  for (const x of r.rows) {
    const pad = '  '.repeat(x.depth + 1);
    const label = `${x.mark ? `${x.mark} ` : ''}${x.what ?? ''}`.trim();
    line(`${pad}${x.quantity} × ${label}  →  ${x.to}${x.chosen ? `  [${x.chosen}]` : ''}${x.weightKg != null ? `  · ${x.weightKg} kg` : ''}`);
    if (x.values) line(`${pad}    ${x.values}`);
    if (x.note) line(`${pad}    NOTE: ${x.note}`);
  }
  if (r.matchedBy?.length) {
    line('\nTaken by another name (check each):');
    for (const m of r.matchedBy) line(`  ${m.how.padEnd(9)} "${m.asked}" → ${m.took} #${m.id}${m.note ? `  (${m.note})` : ''}`);
  }
  line(`\nNew definitions (nothing in the catalog fits): ${r.newDefinitions.length ? '' : 'none'}`);
  for (const d of r.newDefinitions) {
    line(`  + ${d.name} (${d.kind}) — for ${d.for.slice(0, 3).join('; ')}${d.for.length > 3 ? ` … ${d.for.length} rows` : ''}`);
    line(`      nearest existing: ${d.nearest ? `${d.nearest.name} #${d.nearest.id} (${d.nearest.why}, likeness ${d.nearest.score})` : 'none'}`);
  }
  if (r.newNotAllowed?.length && !APPLY) line(`  --apply refuses these unless allowed by name: --allow-new "${r.newNotAllowed.join(',')}"  (or map them in lib/standardImport.js)`);
  if (r.written?.newDefinitions?.length) for (const d of r.written.newDefinitions) line(`    created #${d.id} ${d.code ?? ''} ${d.name}${d.rules ? ` — ${d.rules} spec rules from #${d.rulesFrom}` : ''}`);
  if (r.fallbacks.length) { line('\nMapped to a second choice (the first name is not in the catalog):'); for (const f of r.fallbacks) line(`  ${f.what}: wanted "${f.asked}", took "${f.took}"`); }
  line(`\nBought out, not in the BOM (listed on the standard's notes): ${r.bought.length ? '' : 'none'}`);
  for (const b of r.bought) line(`  ${b.quantity} × ${b.mark} ${b.description}${b.profile ? ` (${b.profile})` : ''}`);
  line(`\nPart files: ${r.files.filter((f) => f.read).length} of ${r.files.length} read as shapes`);
  for (const f of r.files) line(`  ${f.mark.padEnd(6)} ${f.file.padEnd(28)} ${f.missing ? 'MISSING' : f.read ? `${f.sizeMm} mm, ${f.holes} holes` : 'NOT READ'}`);
  line(`\nWeight per span: ${r.totals.steelKg} kg steel (bom.json says ${r.totals.bomSteelKg ?? '—'}), + ${r.totals.studKg} kg studs (with studs bom.json says ${r.totals.bomSteelKgInclStuds ?? '—'})`);
  if (r.setup?.length) { line(`\nSetup${APPLY ? '' : ' (would do)'}:`); for (const a of r.setup) line(`  ${a.problem ? 'PROBLEM: ' : ''}${a.what}${a.done ? ' — done' : ''}`); }
  if (r.grades) line(`\nGrades: ${Object.entries(r.grades).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none'}`);
  for (const x of r.definitionValues ?? []) line(`Definition value: ${x}`);
  for (const x of r.info ?? []) line(`Note: ${x}`);
  if (r.problems.length) { line('\nPROBLEMS:'); for (const p of r.problems) line(`  - ${p}`); }
  if (r.gapFill) line(r.gapFill.error ? `
Gaps left to fill (the fill failed: ${r.gapFill.error})` : `
Gaps filled from the drawing: ${r.gapFill.values} values, ${r.gapFill.sections} section bars, ${r.gapFill.flows} flows (of ${r.gapFill.before}); left for a person: ${r.gapFill.skipped.length}${r.gapFill.problems.length ? `; refused: ${r.gapFill.problems.join('; ')}` : ''}`);
  if (r.modelValues) line(r.modelValues.skipped ? `\nValues from the 3D model: none (${r.modelValues.skipped})` : `\nValues from the 3D model: ${r.modelValues.written} written, ${r.modelValues.kept} typed kept, ${r.modelValues.disagreements.length} disagreements; open required ${r.modelValues.openRequired.before} → ${r.modelValues.openRequired.after}`);
  if (r.written) line(`\nWritten: standard #${r.written.standardId}, version #${r.written.versionId}, register drawing #${r.written.drawingId}, ${r.written.rows} rows, ${r.written.files} files.`);
  line(`\nRound trips: ${trips}${APPLY ? '' : ' (dry run reads)'}`);
  if (!APPLY) line('Nothing written. --apply writes it in one transaction.');
}
