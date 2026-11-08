/**
 * model-values.mjs — the values a structure's 3D model gives (services/modelValueService.applyModel, init.sql §100), on a
 * standard's current version, one version, or one order line.
 *
 * REHEARSAL BY DEFAULT: everything runs in one transaction and is ROLLED BACK — the numbers are printed (values written,
 * typed values kept, disagreements, open required values before → after). --apply commits.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/model-values.mjs --company 30005 --standard 6300003 [--bom ../drawing_bom/out/TCPL_TRUSS_75M_R2] [--prod] [--apply]
 *   node scripts/cf_kepl/model-values.mjs --company 30005 --version <id> …
 *   node scripts/cf_kepl/model-values.mjs --company 30005 --line 1230003 … [--json] [--list]   (--list prints every disagreement)
 *
 * --bom <folder|bom.json>: the drawing set's bom.json, for the weld sizes it gives (optional). A locked line: the
 * differences only, nothing is written even with --apply.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const STD = arg('standard') ? Number(arg('standard')) : null; const VER = arg('version') ? Number(arg('version')) : null; const LINE = arg('line') ? Number(arg('line')) : null;
const APPLY = process.argv.includes('--apply'); const JSON_OUT = process.argv.includes('--json'); const LIST = process.argv.includes('--list');
if (!COMPANY || [STD, VER, LINE].filter(Boolean).length !== 1) {
  console.error('Usage: --company <id> (--standard <id> | --version <id> | --line <id>) [--bom <folder>] [--prod] [--apply] [--json] [--list]');
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
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { applyModel } = await imp('apps/cf_erp/services/modelValueService.js');

let bom = null;
if (arg('bom')) {
  const p = path.resolve(arg('bom')); const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'bom.json') : p;
  bom = JSON.parse(fs.readFileSync(f, 'utf8'));
}

const conn = await pool.getConnection();
let n = 0; const q = conn.query.bind(conn); conn.query = (...a) => { n++; return q(...a); };
let code = 0;
try {
  const [[u]] = await conn.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: arg('user') ? Number(arg('user')) : u?.id ?? null };
  let versionId = VER;
  if (STD) {
    const [[s]] = await conn.query('SELECT number, current_version_id FROM cf_standard_drawings WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [COMPANY, STD]);
    if (!s?.current_version_id) throw new Error(`Standard ${STD} has no version.`);
    versionId = Number(s.current_version_id);
  }
  const t0 = Date.now(); n = 0;
  await conn.beginTransaction();
  const r = await applyModel(conn, c, LINE ? { lineId: LINE, bom } : { versionId, bom });
  if (APPLY) await conn.commit(); else await conn.rollback();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (JSON_OUT) console.log(JSON.stringify({ ...r, roundTrips: n, seconds: Number(secs), applied: APPLY && r.applied }, null, 1));
  else {
    console.log(`${APPLY ? 'APPLIED' : 'REHEARSED (rolled back)'} — ${process.env.DB_HOST ?? 'local'}, company ${COMPANY}, ${r.target.label}${r.frozen ? ` (frozen: ${r.frozen} — differences only)` : ''}`);
    if (r.skipped) console.log(`  nothing done: ${r.skipped}`);
    else {
      console.log(`  model: ${r.model.fileName} (#${r.model.fileId}), ${r.model.elements} elements — "${r.model.title ?? ''}"`);
      console.log(`  rows ${r.rows}: values written ${r.written}${r.wouldWrite != null ? ` (would write ${r.wouldWrite})` : ''}, cleared ${r.cleared}, unchanged ${r.unchanged}, typed kept ${r.kept}, disagreements ${r.disagreements.length}, given but asked another way ${r.notAsked}`);
      console.log(`  worked out after them: ${r.values} value rows over ${r.records} rows; open required values ${r.openRequired.before} → ${r.openRequired.after}`);
      if (r.cutPieces) console.log(`  cut pieces: ${JSON.stringify(r.cutPieces)}`);
      if (r.pieces.length) console.log(`  piece counts differ from the BOM (${r.pieces.length}): ${r.pieces.slice(0, 15).map((p) => `${p.mark} model ${p.model} / BOM ${p.bom}`).join('; ')}`);
      const rep = r.replaced ?? []; const byRep = new Map(); for (const d of rep) byRep.set(d.code, (byRep.get(d.code) ?? 0) + 1);
      if (rep.length) console.log(`  typed values replaced by the model (${rep.length}): ${[...byRep].map(([k, v]) => `${k} ${v}`).join(', ')}`);
      for (const d of rep.slice(0, LIST ? 10000 : 12)) console.log(`    ${d.mark ?? '?'} ${d.code}: was ${d.wasText}, now ${d.modelText}`);
      if (!LIST && rep.length > 12) console.log(`    … ${rep.length - 12} more (--list)`);
      const byCode = new Map(); for (const d of r.disagreements) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
      if (byCode.size) console.log(`  disagreements by value: ${[...byCode].map(([k, v]) => `${k} ${v}`).join(', ')}`);
      for (const d of r.disagreements.slice(0, LIST ? 10000 : 12)) console.log(`    ${d.mark ?? '?'} ${d.code}: ${d.by === 'drawing' ? 'drawing' : 'typed'} ${d.heldText}, model ${d.modelText}`);
      if (!LIST && r.disagreements.length > 12) console.log(`    … ${r.disagreements.length - 12} more (--list)`);
      if (r.notDerivable.length) console.log(`  not derivable (${r.notDerivable.length}): ${r.notDerivable.slice(0, 10).map((x) => `${x.mark}${x.code ? ` ${x.code}` : ''} — ${x.why}`).join('; ')}`);
    }
    console.log(`  ${n} round trips, ${secs} s`);
  }
} catch (err) {
  code = 1;
  try { await conn.rollback(); } catch { /* none open */ }
  console.error(`FAILED — ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
} finally {
  conn.release();
  await pool.end();
}
process.exit(code);
