/**
 * model3d-attach.mjs — keep a structure's model (`cf-erp-model3d` JSON, e.g. TM/drawing_bom/out/TCPL_TRUSS_75M/model.json) with a
 * standard drawing, so every order line made from it shows it in the drawing tool's 3D view (services/model3dService.js).
 * DRY RUN BY DEFAULT; --apply writes one cf_standard_drawing_files row (kind 'model'; a newer one wins). --remove takes
 * the standard's models off (soft delete).
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/model3d-attach.mjs --company 30005 --standard 6150003 --file ../drawing_bom/out/TCPL_TRUSS_75M/model3d.json --prod [--apply]
 *   node scripts/cf_kepl/model3d-attach.mjs --company 180005 --standard <id> --remove --prod --apply
 *
 * VALUES FROM THE MODEL (2026-11-08, services/modelValueService.js): when a model is saved, the values it gives (sizes,
 * holes, drawing facts, drilled thickness, welds) are written on the standard's CURRENT version, in their own transaction
 * (bom.json beside the model file gives the weld sizes). --values does it also when the same model is already live;
 * --no-values skips it. Lines already made from the standard are computed with model-values.mjs --line.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const STD = Number(arg('standard'));
const APPLY = process.argv.includes('--apply'); const REMOVE = process.argv.includes('--remove');
const VALUES = !process.argv.includes('--no-values'); const FORCE_VALUES = process.argv.includes('--values');
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
    if (!['cf-erp-model3d/1', 'cf-erp-model3d/2'].includes(m.schema) || !Array.isArray(m.elements)) throw new Error('Not a cf-erp-model3d model.');
    // Only when required (user, 2026-11-07): the same JSON already live is left as it is.
    const [[live]] = await pool.query("SELECT file_text FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [COMPANY, STD]);
    let saved = false;
    if (live && live.file_text === text) { console.log(`${s.number}: the same model is already live — nothing to do`); }
    else {
    console.log(`${s.number}: model "${m.title ?? ''}", ${m.elements.length} elements, ${(text.length / 1e3).toFixed(0)} kB — ${APPLY ? 'saved' : 'dry run'}`);
    if (APPLY) {
      // ONE JSON per structure (user, 2026-11-02 / 11-06): the older model is retired in the same commit, never left beside it.
      const db = await pool.getConnection();
      try {
        await db.beginTransaction();
        const [old] = await db.query("UPDATE cf_standard_drawing_files SET deleted_at = NOW() WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL", [COMPANY, STD]);
        await db.query(
          "INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, file_text) VALUES (?, NULL, ?, 'model', NULL, NULL, NULL, ?, 'json', ?)",
          [COMPANY, STD, path.basename(arg('file')), text]);
        await db.commit();
        saved = true;
        if (old.affectedRows) console.log(`  the older model (${old.affectedRows}) retired`);
      } catch (e) { await db.rollback().catch(() => {}); throw e; } finally { db.release(); }
    }
    }
    if (APPLY && VALUES && (saved || FORCE_VALUES)) {
      const [[cur]] = await pool.query('SELECT current_version_id FROM cf_standard_drawings WHERE company_id = ? AND id = ?', [COMPANY, STD]);
      if (!cur?.current_version_id) console.log('  no version yet — values come when a BOM is saved and model-values.mjs runs');
      else {
        const { applyModel } = await import(pathToFileURL(path.join(__dir, '..', '..', 'apps', 'cf_erp', 'services', 'modelValueService.js')).href);
        const bomFile = path.join(path.dirname(path.resolve(arg('file'))), 'bom.json');
        const bom = fs.existsSync(bomFile) ? JSON.parse(fs.readFileSync(bomFile, 'utf8')) : null;
        const [[u]] = await pool.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
        const db = await pool.getConnection();
        try {
          await db.beginTransaction();
          const r = await applyModel(db, { companyId: COMPANY, userId: u?.id ?? null }, { versionId: Number(cur.current_version_id), bom });
          await db.commit();
          console.log(`  values from the model on version #${cur.current_version_id}: ${r.written} written, ${r.cleared} cleared, ${r.unchanged} unchanged, ${r.kept} typed kept, ${r.disagreements.length} disagreements; open required ${r.openRequired?.before} → ${r.openRequired?.after}`);
        } catch (e) { await db.rollback().catch(() => {}); throw e; } finally { db.release(); }
      }
    }
  }
} finally { await pool.end(); }
