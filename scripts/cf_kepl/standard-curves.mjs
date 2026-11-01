/**
 * standard-curves.mjs — put each RDSO series' curve rule (drawing_bom/out/<SET>/bom.json `curve`, from
 * src/rdso/curveMeta.mjs: girders on chords, eccentricity at the maximum degree) on the company's standard of that
 * number (cf_standard_drawings.curve_json, init.sql §98), so the order lines made from it can be set on a curve
 * (curveService.js). Standards imported after this get it from the importer. DRY RUN BY DEFAULT; --apply saves.
 *   node scripts/cf_kepl/standard-curves.mjs --company 30005 --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const APPLY = process.argv.includes('--apply');
if (!COMPANY) { console.error('Usage: --company <id> [--prod] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);
const OUT = path.join(__dir, '..', '..', '..', 'drawing_bom', 'out');
try {
  let n = 0;
  for (const set of fs.readdirSync(OUT).filter((d) => /^RDSO_/.test(d))) {
    const f = path.join(OUT, set, 'bom.json'); if (!fs.existsSync(f)) continue;
    const bom = JSON.parse(fs.readFileSync(f, 'utf8')); if (!bom.curve) continue;
    const number = `RDSO/B-${set.slice(5)}`;
    const [[std]] = await pool.query('SELECT id, curve_json FROM cf_standard_drawings WHERE company_id = ? AND number = ? AND deleted_at IS NULL', [COMPANY, number]);
    if (!std) { console.log(`  ${number.padEnd(16)} no such standard here`); continue; }
    const words = bom.curve.maxDeg ? `up to ${bom.curve.maxDeg}°, ${bom.curve.eccentricityAtMaxMm} mm + ${bom.curve.standardEccentricityMm}` : 'straight only';
    if (APPLY) await pool.query('UPDATE cf_standard_drawings SET curve_json = ? WHERE company_id = ? AND id = ?', [JSON.stringify(bom.curve), COMPANY, std.id]);
    n++; console.log(`  ${number.padEnd(16)} #${std.id} ${words}${std.curve_json ? ' (replaces the one there)' : ''}`);
  }
  console.log(`${n} standards — ${APPLY ? 'saved' : 'DRY RUN, nothing saved'}`);
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; } finally { await pool.end(); process.exit(process.exitCode ?? 0); }
