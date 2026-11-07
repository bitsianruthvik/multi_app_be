/**
 * physics-attach.mjs — keep each structure's PHYSICS VIEW with its standard drawing, beside its one model, so the app shows
 * it (services/physicsService.js; user, 2026-11-07: "build it into the app").
 *
 * For each standard with a model (all of a company's, or --standard <id>): the drawing_bom package whose model.json is
 * byte-for-byte the stored model is found (sha1) — the physics must describe the model the app draws, so a standard with
 * no such package is skipped and said. Its page is made by `node src/physics/viewData.mjs out/<SET>` (about a minute at
 * most) and stored as one cf_standard_drawing_files row (kind 'physics', file_kind 'html', version_id NULL; the older one is
 * retired). warnings_json keeps { set, generated, modelSha, summary }.
 *
 * DRY RUN BY DEFAULT (makes the pages, writes nothing). --apply commits one standard at a time; re-running skips a standard
 * whose stored physics was made from the same model AND the same physics code (its last commit), unless --force.
 *   node scripts/cf_kepl/physics-attach.mjs --company 30005 --prod [--standard <id>] [--live] [--apply] [--force]
 *   --live: only standards some live order line is made from.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); if (!COMPANY) { console.error('Usage: --company <id> [--standard <id>] [--live] [--prod] [--apply] [--force]'); process.exit(2); }
const ONLY = arg('standard') ? Number(arg('standard')) : null;
const APPLY = process.argv.includes('--apply'); const FORCE = process.argv.includes('--force'); const LIVE = process.argv.includes('--live');
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const BOM = path.resolve(__dir, '..', '..', '..', 'drawing_bom'); const OUT = path.join(BOM, 'out');
const sha = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
// Only when required (user, 2026-11-07): the physics code's version, so a page is rebuilt only when the model OR the physics changed.
// The last commit touching what the screen runs on; uncommitted edits there make it 'dirty' (always rebuilt).
const PHYS_PATHS = ['src/physics', 'src/model2', 'src/verify/plateRules.mjs'];
const physicsVersion = (() => { try { const h = execFileSync('git', ['log', '-1', '--format=%H', '--', ...PHYS_PATHS], { cwd: BOM }).toString().trim(); const dirty = execFileSync('git', ['status', '--porcelain', '--', ...PHYS_PATHS], { cwd: BOM }).toString().trim(); return dirty ? `${h}-dirty` : h; } catch { return null; } })();
const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);

// The packages, by their model's sha.
const bySha = new Map();
for (const d of fs.readdirSync(OUT)) { const f = path.join(OUT, d, 'model.json'); if (fs.existsSync(f)) bySha.set(sha(fs.readFileSync(f, 'utf8')), d); }

const [stds] = await pool.query(
  `SELECT f.standard_id, MAX(f.id) AS id FROM cf_standard_drawing_files f WHERE f.company_id = ? AND f.kind = 'model' AND f.deleted_at IS NULL
     ${ONLY ? 'AND f.standard_id = ?' : ''}
     ${LIVE ? 'AND f.standard_id IN (SELECT l.standard_id FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL WHERE l.company_id = f.company_id AND l.deleted_at IS NULL AND l.standard_id IS NOT NULL)' : ''}
   GROUP BY f.standard_id ORDER BY f.standard_id`, ONLY ? [COMPANY, ONLY] : [COMPANY]);
let done = 0; let skipped = 0;
for (const s of stds) {
  const [[m]] = await pool.query('SELECT file_text FROM cf_standard_drawing_files WHERE id = ?', [s.id]);
  const h = sha(String(m.file_text)); const set = bySha.get(h);
  const [[num]] = await pool.query('SELECT number FROM cf_standard_drawings WHERE company_id = ? AND id = ?', [COMPANY, s.standard_id]);
  const name = `${num?.number ?? ''} (standard ${s.standard_id})`;
  if (!set) { console.log(`skip ${name}: no package in drawing_bom/out has this exact model`); skipped++; continue; }
  const [[have]] = await pool.query("SELECT id, warnings_json FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'physics' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [COMPANY, s.standard_id]);
  let haveSha = null; try { haveSha = JSON.parse(have?.warnings_json ?? 'null')?.modelSha ?? null; } catch { /* none */ }
  let haveVer = null; try { haveVer = JSON.parse(have?.warnings_json ?? 'null')?.physicsVersion ?? null; } catch { /* none */ }
  if (have && haveSha === h && haveVer && haveVer === physicsVersion && !/dirty/.test(physicsVersion ?? '') && !FORCE) { console.log(`ok   ${name}: ${set}, physics already from this model and this physics code`); continue; }
  const t0 = Date.now();
  try { execFileSync(process.execPath, ['src/physics/viewData.mjs', `out/${set}`], { cwd: BOM, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 }); }
  catch (e) { console.log(`FAIL ${name}: ${set}: the physics did not run — ${String(e.stderr ?? e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`); skipped++; continue; }
  const html = fs.readFileSync(path.join(OUT, set, 'physics_view.html'), 'utf8');
  const data = JSON.parse(fs.readFileSync(path.join(OUT, set, 'physics_view.json'), 'utf8'));
  const counts = {}; for (const f of data.findings ?? []) counts[f.status] = (counts[f.status] ?? 0) + 1;
  const meta = { set, generated: data.generated, modelSha: h, physicsVersion, summary: { ...(data.summary ?? {}), findings: counts, type: data.type ?? null } };
  console.log(`${APPLY ? 'save' : 'would save'} ${name}: ${set}, ${(html.length / 1048576).toFixed(2)} MB, ${Math.round((Date.now() - t0) / 1000)} s${have ? ' (replaces the older one)' : ''}`);
  if (APPLY) {
    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      if (have) await db.query("UPDATE cf_standard_drawing_files SET deleted_at = NOW() WHERE company_id = ? AND standard_id = ? AND kind = 'physics' AND deleted_at IS NULL", [COMPANY, s.standard_id]);
      await db.query(
        "INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, drawing_id, mark, mark_norm, file_name, file_kind, warnings_json, file_text) VALUES (?, NULL, ?, 'physics', NULL, NULL, NULL, ?, 'html', ?, ?)",
        [COMPANY, s.standard_id, `physics_${set}.html`, JSON.stringify(meta), html]);
      await db.commit();
    } catch (e) { await db.rollback().catch(() => {}); throw e; } finally { db.release(); }
  }
  done++;
}
console.log(`\n${done} ${APPLY ? 'saved' : 'would be saved (DRY RUN — add --apply)'}, ${skipped} skipped`);
await pool.end();
