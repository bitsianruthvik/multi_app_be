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
const APPLY = process.argv.includes('--apply');
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
  const out = await STD.importStandard(conn, c, { bom, files, apply: APPLY, sourceUrl: arg('source-url') });
  if (APPLY) await conn.commit();
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
  line(`${APPLY ? 'APPLIED' : 'DRY RUN (read-only)'} — database ${host.d} at ${process.env.DB_HOST ?? host.h}, company ${co.id} ${co.name}`);
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
  line(`\nNew definitions (nothing in the catalog fits): ${r.newDefinitions.length ? '' : 'none'}`);
  for (const d of r.newDefinitions) line(`  + ${d.name} (${d.kind}) — for ${d.for.join('; ')}`);
  if (r.written?.newDefinitions?.length) for (const d of r.written.newDefinitions) line(`    created #${d.id} ${d.code ?? ''} ${d.name}`);
  if (r.fallbacks.length) { line('\nMapped to a second choice (the first name is not in the catalog):'); for (const f of r.fallbacks) line(`  ${f.what}: wanted "${f.asked}", took "${f.took}"`); }
  line(`\nBought out, not in the BOM (listed on the standard's notes): ${r.bought.length ? '' : 'none'}`);
  for (const b of r.bought) line(`  ${b.quantity} × ${b.mark} ${b.description}${b.profile ? ` (${b.profile})` : ''}`);
  line(`\nPart files: ${r.files.filter((f) => f.read).length} of ${r.files.length} read as shapes`);
  for (const f of r.files) line(`  ${f.mark.padEnd(6)} ${f.file.padEnd(28)} ${f.missing ? 'MISSING' : f.read ? `${f.sizeMm} mm, ${f.holes} holes` : 'NOT READ'}`);
  line(`\nWeight per span: ${r.totals.steelKg} kg steel (bom.json says ${r.totals.bomSteelKg ?? '—'}), + ${r.totals.studKg} kg studs (with studs bom.json says ${r.totals.bomSteelKgInclStuds ?? '—'})`);
  if (r.problems.length) { line('\nPROBLEMS:'); for (const p of r.problems) line(`  - ${p}`); }
  if (r.written) line(`\nWritten: standard #${r.written.standardId}, version #${r.written.versionId}, register drawing #${r.written.drawingId}, ${r.written.rows} rows, ${r.written.files} files.`);
  line(`\nRound trips: ${trips}${APPLY ? '' : ' (dry run reads)'}`);
  if (!APPLY) line('Nothing written. --apply writes it in one transaction.');
}
