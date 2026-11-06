/**
 * level-marks-from-model.mjs — give every LEVEL row with no drawing mark the mark its structure's ONE model uses for it
 * (user, 2026-11-06: "the drawings are only available at parts level and not at every other level … we just have one json").
 *
 * The importer used to leave the span and the girder line without a mark, so the screens could not find those levels in the
 * model (they draw a level by its mark: apps/cf_erp/lib/modelLevels.js). Here, for each standard with a model, its versions'
 * rows and every live, unlocked order line made from it: an assembly row with no mark gets the model's level for it — the
 * top row the model's top level, any other row the one level directly above all its children's marks (levelMarkFor; no
 * guess when the model does not say one). Only DRAWING_MARK values are written (cf_spec_values, source 'entered'); nothing
 * else changes. Rows the model has no level for (the seismic stopper the importer groups) are listed and left.
 *
 * DRY RUN BY DEFAULT. --apply commits one standard version or one order line at a time (small steps: a lost connection
 * loses one step, and re-running skips what is done). Re-running changes nothing.
 *   node scripts/cf_kepl/level-marks-from-model.mjs --company 30005 --prod [--standard <id>] [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); if (!COMPANY) { console.error('Usage: --company <id> [--standard <id>] [--prod] [--apply]'); process.exit(2); }
const ONLY = arg('standard') ? Number(arg('standard')) : null;
const APPLY = process.argv.includes('--apply');
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
const { levelParents, levelMarkFor, levelsOfModel } = await imp('apps/cf_erp/lib/modelLevels.js');
const { rowsOfLine } = await imp('apps/cf_erp/services/partDrawingService.js');
const { versionTree } = await imp('apps/cf_erp/services/standardDrawingService.js');

const [[spec]] = await pool.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'DRAWING_MARK' AND deleted_at IS NULL", [COMPANY]);
if (!spec) throw new Error('This company has no DRAWING_MARK specification.');

/** rows: [{ id, parentId, mark, name }] → [{ id, name, mark }] to write, and the rows left with none. Deepest first, so a
 *  girder line's mark is worked out from segments that already have theirs. PURE. */
function plan(model, rows) {
  const rel = levelParents(model); const levels = levelsOfModel(model);
  const kids = new Map(); for (const r of rows) if (r.parentId != null) { if (!kids.has(r.parentId)) kids.set(r.parentId, []); kids.get(r.parentId).push(r); }
  const markOf = new Map(rows.map((r) => [r.id, r.mark]));
  const depth = (r) => { let d = 0; for (let p = r.parentId, n = 0; p != null && n < 64; p = rows.find((x) => x.id === p)?.parentId, n++) d++; return d; };
  const todo = rows.filter((r) => !r.mark && kids.has(r.id)).sort((a, b) => depth(b) - depth(a));
  const write = []; const left = [];
  for (const r of todo) {
    const m = levelMarkFor(model, { isTop: r.parentId == null, childMarks: kids.get(r.id).map((k) => markOf.get(k.id)) }, rel);
    if (m && levels.has(m.toUpperCase())) { markOf.set(r.id, m); write.push({ id: r.id, name: r.name, mark: m }); } else left.push(r.name);
  }
  return { write, left };
}

async function writeMarks(db, list) {
  for (const w of list) {
    const [[have]] = await db.query("SELECT id, value_text FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND subject_type = 'master' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, spec.id, w.id]);
    if (have?.value_text) continue;   // someone gave it one meanwhile
    if (have) await db.query('UPDATE cf_spec_values SET value_text = ? WHERE company_id = ? AND id = ?', [w.mark, COMPANY, have.id]);
    else await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_text, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, spec.id, w.id, w.mark]);
  }
}

const [models] = await pool.query(
  `SELECT f.standard_id, MAX(f.id) AS id FROM cf_standard_drawing_files f WHERE f.company_id = ? AND f.kind = 'model' AND f.deleted_at IS NULL${ONLY ? ' AND f.standard_id = ?' : ''} GROUP BY f.standard_id ORDER BY f.standard_id`,
  ONLY ? [COMPANY, ONLY] : [COMPANY]);
let total = 0;
for (const m of models) {
  const [[f]] = await pool.query('SELECT file_text FROM cf_standard_drawing_files WHERE id = ?', [m.id]);
  let model; try { model = JSON.parse(f.file_text); } catch { console.log(`standard ${m.standard_id}: model unreadable, skipped`); continue; }
  const [[s]] = await pool.query('SELECT number FROM cf_standard_drawings WHERE company_id = ? AND id = ?', [COMPANY, m.standard_id]);
  console.log(`\n${s?.number ?? m.standard_id} (standard ${m.standard_id})`);
  // 1. the standard's live versions
  const [vers] = await pool.query('SELECT * FROM cf_standard_drawing_versions WHERE company_id = ? AND standard_id = ? AND deleted_at IS NULL ORDER BY version_no', [COMPANY, m.standard_id]);
  for (const v of vers) {
    const tree = (await versionTree(pool, COMPANY, v)).filter((r) => r.kind === 'row' && r.rowId);
    const idOfKey = new Map(tree.map((r) => [r.key, r.rowId]));
    const rows = tree.map((r) => ({ id: r.rowId, parentId: r.parentKey ? idOfKey.get(r.parentKey) ?? null : null, mark: r.mark, name: r.name }));
    const p = plan(model, rows);
    console.log(`  version ${v.version_no}: ${p.write.length} to mark${p.write.length ? ` (${p.write.map((w) => `${w.name} → ${w.mark}`).join(', ')})` : ''}${p.left.length ? `; left without: ${p.left.join(', ')}` : ''}`);
    if (APPLY && p.write.length) { const db = await pool.getConnection(); try { await db.beginTransaction(); await writeMarks(db, p.write); await db.commit(); console.log('    committed'); } catch (e) { await db.rollback().catch(() => {}); throw e; } finally { db.release(); } }
    total += p.write.length;
  }
  // 2. its live order lines (a locked line keeps what it was locked with)
  const [lines] = await pool.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.standard_id = ? AND l.deleted_at IS NULL ORDER BY l.id`, [COMPANY, m.standard_id]);
  for (const line of lines) {
    if (line.locked_at) { console.log(`  ${line.order_code} line ${line.id}: locked, left as it is`); continue; }
    const rows = (await rowsOfLine(pool, COMPANY, line)).map((r) => ({ id: r.id, parentId: r.parentId, mark: r.mark, name: r.name }));
    const p = plan(model, rows);
    console.log(`  ${line.order_code} line ${line.id}: ${p.write.length} to mark${p.write.length ? ` (${p.write.map((w) => `${w.name} → ${w.mark}`).join(', ')})` : ''}${p.left.length ? `; left without: ${p.left.join(', ')}` : ''}`);
    if (APPLY && p.write.length) { const db = await pool.getConnection(); try { await db.beginTransaction(); await writeMarks(db, p.write); await db.commit(); console.log('    committed'); } catch (e) { await db.rollback().catch(() => {}); throw e; } finally { db.release(); } }
    total += p.write.length;
  }
}
console.log(`\n${total} rows ${APPLY ? 'marked' : 'would be marked (DRY RUN — add --apply)'}`);
await pool.end();
