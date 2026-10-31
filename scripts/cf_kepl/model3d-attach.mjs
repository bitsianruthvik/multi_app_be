/**
 * model3d-attach.mjs — keep a 3D model (`cf-erp-model3d/1` JSON, e.g. TM/drawing_bom/out/TCPL_TRUSS_75M/model3d.json) with a
 * standard drawing, so every order line made from it shows it in the drawing tool's 3D view (services/model3dService.js).
 * DRY RUN BY DEFAULT; --apply writes one cf_standard_drawing_files row (kind 'model'; a newer one wins). --remove takes
 * the standard's models off (soft delete).
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/model3d-attach.mjs --company 30005 --standard 6150003 --file ../drawing_bom/out/TCPL_TRUSS_75M/model3d.json --prod [--apply]
 *   node scripts/cf_kepl/model3d-attach.mjs --company 180005 --standard <id> --remove --prod --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const STD = Number(arg('standard'));
const APPLY = process.argv.includes('--apply'); const REMOVE = process.argv.includes('--remove');
if (!COMPANY || !STD || (!REMOVE && !arg('file'))) { console.error('Usage: --company <id> --standard <id> (--file <model.json> | --remove) [--prod] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);
try {
  const [[s]] = await pool.query('SELECT id, number FROM cf_standard_drawings WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [COMPANY, STD]);
  if (!s) throw new Error(`No standard #${STD} in company ${COMPANY}.`);
  if (REMOVE) {
    const [[n]] = await pool.query("SELECT COUNT(*) n FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL", [COMPANY, STD]);
    console.log(`${s.number}: ${n.n} model(s) ${APPLY ? 'removed' : 'would be removed'}`);
    if (APPLY) await pool.query("UPDATE cf_standard_drawing_files SET deleted_at = NOW() WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL", [COMPANY, STD]);
  } else {
    const text = fs.readFileSync(path.resolve(arg('file')), 'utf8');
    const m = JSON.parse(text);
    if (m.schema !== 'cf-erp-model3d/1' || !Array.isArray(m.elements)) throw new Error('Not a cf-erp-model3d/1 model.');
    console.log(`${s.number}: model "${m.title ?? ''}", ${m.elements.length} elements, ${(text.length / 1e3).toFixed(0)} kB — ${APPLY ? 'saved' : 'dry run'}`);
    if (APPLY) {
      await pool.query(
        "INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, file_text) VALUES (?, NULL, ?, 'model', NULL, NULL, NULL, ?, 'json', ?)",
        [COMPANY, STD, path.basename(arg('file')), text]);
    }
  }
} finally { await pool.end(); }
